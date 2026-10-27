import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
