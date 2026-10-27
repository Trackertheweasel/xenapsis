import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAccess } from '../serverlib/access.ts';
import { buildApp } from '../serverlib/app.ts';
import { cacheControlFor, staticFileOptions } from '../serverlib/static.ts';
import { wisp } from '../serverlib/wisp.ts';

// The real server without the built site, so it runs without `pnpm build`.
async function server(env: Record<string, string> = {}) {
	return buildApp({
		access: loadAccess(env),
		wispPath: '/w/',
		loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
	});
}
const inviteOnly = { PERSEC_INVITE_CODES: 'tester:abc123', PERSEC_SECRET: 'test-secret' };

test('Wisp only allows TCP to web ports and uses malware-blocking DNS', () => {
	assert.equal(wisp.options.allow_udp_streams, false);
	assert.deepEqual(wisp.options.port_whitelist, [80, 443, [1024, 2524], [2526, 65535]]);
	assert.deepEqual(wisp.options.dns_servers, ['1.1.1.2', '1.0.0.2']);
	assert.equal(wisp.options.wisp_motd, '', 'no fixed MOTD to fingerprint');
});

test('Server sends real 404s', async () => {
	const app = await server();
	const res = await app.inject({ url: '/definitely-not-here' });
	assert.equal(res.statusCode, 404);
});

test('Server allows cross-origin no-CORS resources with credentialless COEP and no X-Powered-By', async () => {
	const app = await server();
	const res = await app.inject({ url: '/' });
	assert.equal(res.headers['cross-origin-embedder-policy'], 'credentialless');
	assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
	assert.equal(res.headers['x-powered-by'], undefined);
});

test('Server prefers brotli', async () => {
	const app = await server(inviteOnly);
	const res = await app.inject({ url: '/enter', headers: { 'accept-encoding': 'br, gzip' } });
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['content-encoding'], 'br');
});

test('Static files get their own cache headers', () => {
	const root = path.join(tmpdir(), 'client');
	const at = (rel: string) => cacheControlFor(root, path.join(root, ...rel.split('/')));
	assert.equal(staticFileOptions(root).cacheControl, false, "not the plugin's max-age=0");
	assert.equal(at('st.html'), 'no-cache, no-store, must-revalidate');
	assert.equal(at('_astro/app.AbC123.js'), 'public, max-age=31536000, immutable');
	assert.equal(at('sw.js'), 'no-cache');
	assert.equal(at('tmp/config.js'), 'no-cache');
	assert.equal(at('a/images/logo.webp'), 'public, max-age=3600');
});

const twoPeople = { PERSEC_INVITE_CODES: 'alice:abc123, bob:xyz789', PERSEC_SECRET: 'test-secret' };
let nextIp = 0;
// The attempt limit is per address and shared across tests, so each sign-in gets its own.
const freshIp = () => `203.0.113.${++nextIp}`;

async function signIn(app: Awaited<ReturnType<typeof server>>, code: string) {
	const res = await app.inject({
		method: 'POST',
		url: '/enter',
		headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': freshIp() },
		payload: `code=${code}`,
	});
	const setCookie = String(res.headers['set-cookie'] ?? '');
	return { res, cookie: setCookie.split(';')[0] };
}

test('Without an invite, pages redirect to sign-in and everything else is refused', async () => {
	const app = await server(inviteOnly);
	const page = await app.inject({ url: '/', headers: { accept: 'text/html' } });
	assert.equal(page.statusCode, 302);
	assert.equal(page.headers.location, '/enter');
	// Static files, the search API (a middie middleware) and the saved-logins API are all gated.
	for (const url of ['/sw.js', '/api/query?q=hi', '/api/logins/status']) {
		assert.equal((await app.inject({ url })).statusCode, 401, url);
	}
	for (const url of ['/enter', '/favicon.ico', '/robots.txt']) {
		assert.notEqual((await app.inject({ url })).statusCode, 401, `${url} stays open`);
	}
});

test('Open mode has no gate', async () => {
	const app = await server();
	const page = await app.inject({ url: '/', headers: { accept: 'text/html' } });
	assert.notEqual(page.statusCode, 302);
	assert.equal((await app.inject({ url: '/api/query' })).statusCode, 400, 'reaches the search API');
});

test('A valid code signs in with an HttpOnly cookie that opens the gate', async () => {
	const app = await server(inviteOnly);
	const wrong = await signIn(app, 'nope');
	assert.equal(wrong.res.statusCode, 401);
	assert.equal(wrong.res.headers['set-cookie'], undefined);

	const { res, cookie } = await signIn(app, 'abc123');
	assert.equal(res.statusCode, 302);
	assert.equal(res.headers.location, '/');
	assert.match(String(res.headers['set-cookie']), /^persec_access=[^;]+; .*HttpOnly; SameSite=Lax/);
	assert.equal((await app.inject({ url: '/api/query', headers: { cookie } })).statusCode, 400);

	const forged = cookie.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
	assert.equal((await app.inject({ url: '/api/query', headers: { cookie: forged } })).statusCode, 401);
});

test('Ten wrong codes from one address lock it out, even for the right code', async () => {
	const app = await server(inviteOnly);
	const ip = freshIp();
	const attempt = (code: string) =>
		app.inject({
			method: 'POST',
			url: '/enter',
			headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
			payload: `code=${code}`,
		});
	for (let i = 0; i < 10; i++) assert.equal((await attempt('nope')).statusCode, 401);
	assert.equal((await attempt('abc123')).statusCode, 429);
});

test('Saved-login backups round-trip and each person only reaches their own', async () => {
	const app = await server(twoPeople);
	const alice = (await signIn(app, 'abc123')).cookie;
	const bob = (await signIn(app, 'xyz789')).cookie;
	const status = async (cookie: string) =>
		JSON.parse((await app.inject({ url: '/api/logins/status', headers: { cookie } })).body);

	assert.deepEqual(await status(alice), { saved: false, updated: null });
	const backup = Buffer.from('encrypted bytes');
	const put = await app.inject({
		method: 'PUT',
		url: '/api/logins',
		headers: { cookie: alice, 'content-type': 'application/octet-stream' },
		payload: backup,
	});
	assert.equal(put.statusCode, 204);
	assert.equal((await status(alice)).saved, true);
	const got = await app.inject({ url: '/api/logins', headers: { cookie: alice } });
	assert.deepEqual(got.rawPayload, backup);

	assert.equal((await status(bob)).saved, false, "bob can't see alice's backup");
	assert.equal((await app.inject({ url: '/api/logins', headers: { cookie: bob } })).statusCode, 204);

	const empty = await app.inject({
		method: 'PUT',
		url: '/api/logins',
		headers: { cookie: alice, 'content-type': 'application/octet-stream' },
		payload: Buffer.alloc(0),
	});
	assert.equal(empty.statusCode, 400);

	await app.inject({ method: 'DELETE', url: '/api/logins', headers: { cookie: alice } });
	assert.equal((await status(alice)).saved, false);
});

// Resolves with the HTTP status the server answered the upgrade with, or 'closed' if it hung up.
function upgrade(port: number, path: string, cookie?: string): Promise<number | 'closed'> {
	return new Promise(resolve => {
		const req = http.request({
			host: '127.0.0.1',
			port,
			path,
			headers: {
				Connection: 'Upgrade',
				Upgrade: 'websocket',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				...(cookie ? { cookie } : {}),
			},
		});
		req.on('upgrade', (res, socket) => {
			socket.destroy();
			resolve(res.statusCode ?? 0);
		});
		req.on('response', res => resolve(res.statusCode ?? 0));
		req.on('error', () => resolve('closed'));
		req.end();
	});
}

test('The Wisp tunnel needs an invite and only answers on its own path', async () => {
	const app = await server(inviteOnly);
	const { cookie } = await signIn(app, 'abc123');
	await app.listen({ host: '127.0.0.1', port: 0 });
	const { port } = app.server.address() as AddressInfo;
	try {
		assert.equal(await upgrade(port, '/w/'), 'closed', 'no invite');
		assert.equal(await upgrade(port, '/w/', 'persec_access=forged'), 'closed', 'forged invite');
		assert.equal(await upgrade(port, '/other/', cookie), 'closed', 'wrong path');
		assert.equal(await upgrade(port, '/w/', cookie), 101);
	} finally {
		await app.close();
	}
});
