import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToken, loadAccess } from '../serverlib/access.ts';
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
  assert.equal(
    (await app.inject({ url: '/api/query', headers: { cookie: forged } })).statusCode,
    401,
  );
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
  assert.equal(
    (await app.inject({ url: '/api/logins', headers: { cookie: bob } })).statusCode,
    204,
  );

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

// Sends raw bytes and resolves with whatever the server answered before hanging up.
function raw(port: number, text: string): Promise<string> {
  return new Promise(resolve => {
    let out = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.end(text));
    socket.on('data', d => (out += d));
    socket.on('close', () => resolve(out));
    socket.on('error', () => {});
    socket.setTimeout(1000, () => socket.destroy());
  });
}

const tunnelEnv = {
  PERSEC_INVITE_CODES: 'tester:abc123, gone:def456',
  PERSEC_SECRET: 'test-secret',
  PERSEC_REVOKED: 'gone',
};

// One rule for both servers (routeWisp); the path only hides the tunnel, the cookie guards it.
async function checkTunnelRule(port: number) {
  const access = loadAccess(tunnelEnv)!;
  const token = (name: string, now?: number) => `persec_access=${createToken(access, name, now)}`;
  const valid = token('tester');
  const otherSecret = loadAccess({ ...tunnelEnv, PERSEC_SECRET: 'other-secret' })!;
  const refused: Record<string, string | undefined> = {
    'no cookie': undefined,
    'empty cookie': 'persec_access=',
    'forged cookie': 'persec_access=forged',
    'malformed cookie': 'persec_access=%ZZ.not.base64',
    'tampered signature': valid.replace(/.$/, c => (c === 'a' ? 'b' : 'a')),
    'expired sign-in': token('tester', Date.now() - 31 * 24 * 3600 * 1000),
    'revoked name': token('gone'),
    'name no longer invited': token('stranger'),
    'signed with another secret': `persec_access=${createToken(otherSecret, 'tester')}`,
  };
  for (const [why, cookie] of Object.entries(refused)) {
    assert.equal(await upgrade(port, '/w/', cookie), 'closed', why);
  }
  const head = 'GET /w/ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n';
  for (const [why, request] of Object.entries({
    'no WebSocket key, no invite': head + '\r\n',
    'no WebSocket key, valid invite': head + `Cookie: ${valid}\r\n\r\n`,
    'not HTTP': 'garbage\r\n\r\n',
  })) {
    assert.doesNotMatch(await raw(port, request), /^HTTP\/1\.1 101/, why);
  }
  assert.equal(await upgrade(port, '/w/', valid), 101, 'still serving after all that');
}

test('The Wisp tunnel needs a valid invite and only answers on its own path', async () => {
  const app = await server(tunnelEnv);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const valid = `persec_access=${createToken(loadAccess(tunnelEnv)!, 'tester')}`;
  try {
    await checkTunnelRule(port);
    assert.equal(await upgrade(port, '/other/', valid), 'closed', 'wrong path');
  } finally {
    await app.close();
  }
});

// `pnpm dev` serves the tunnel from the Vite plugin in astro.config.ts, not from buildApp.
async function devServer(env: Record<string, string>) {
  const { default: config } = await import('../astro.config.ts');
  const plugin = (config.vite!.plugins as any[]).find(p => p?.name === 'vite-wisp-server');
  const httpServer = http.createServer();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    plugin.configureServer({ httpServer });
  } finally {
    process.env = saved;
  }
  // Stands in for Vite's live-reload socket, which shares the dev server.
  httpServer.on('upgrade', (req, socket) => {
    if (req.url === '/hmr') socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, port: (httpServer.address() as AddressInfo).port };
}

test('The dev server applies the same invite rule to the Wisp tunnel', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { httpServer, port } = await devServer(tunnelEnv);
  try {
    assert.equal(warn.mock.callCount(), 1, 'says why the tunnel is closed in dev');
    await checkTunnelRule(port);
    assert.equal(await upgrade(port, '/hmr'), 101, "Vite's own upgrades are left alone");
  } finally {
    httpServer.close();
  }
});

test('The dev server tunnel is open when the site is', async () => {
  const { httpServer, port } = await devServer({});
  try {
    assert.equal(await upgrade(port, '/w/'), 101);
  } finally {
    httpServer.close();
  }
});

test('Sign-in cookies are Secure behind an HTTPS proxy', async () => {
  const app = await server(inviteOnly);
  const res = await app.inject({
    method: 'POST',
    url: '/enter',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': freshIp(),
      'x-forwarded-proto': 'https',
    },
    payload: 'code=abc123',
  });
  assert.match(String(res.headers['set-cookie']), /; Secure$/);
});

test('An old sign-in is renewed on pages only, never on cacheable responses', async () => {
  const app = await server(inviteOnly);
  const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
  const cookie = `persec_access=${createToken(loadAccess(inviteOnly)!, 'tester', twoDaysAgo)}`;

  const page = await app.inject({ url: '/', headers: { cookie, accept: 'text/html' } });
  assert.match(String(page.headers['set-cookie']), /^persec_access=[^;]+; .*HttpOnly/);
  assert.notEqual(page.headers['set-cookie'], cookie);

  for (const url of ['/sw.js', '/api/query?q=hi']) {
    const res = await app.inject({ url, headers: { cookie } });
    assert.notEqual(res.statusCode, 401, url);
    assert.equal(res.headers['set-cookie'], undefined, url);
  }
});
