import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToken, loadAccess } from '../serverlib/access.ts';
import { buildApp } from '../serverlib/app.ts';
import { createCamoufoxRuntime } from '../serverlib/browser/camoufox.ts';
import type { PwFirefox } from '../serverlib/browser/camoufox.ts';
import {
  BrowserError,
  CREATES_PER_WINDOW,
  SessionManager,
  loadBrowserConfig,
  looksBlocked,
} from '../serverlib/browser/index.ts';
import type {
  BrowserConfig,
  BrowserContextHandle,
  BrowserRuntime,
  PageState,
} from '../serverlib/browser/index.ts';
import { BROWSER_SITES, siteForHost } from '../serverlib/browser/sites.ts';
import { checkNavigationUrl, isBlockedRequest, isInternalHost } from '../serverlib/browser/url.ts';

// Browser mode against a stand-in runtime. No browser, Camoufox download or playwright-core needed.

interface FakeContext extends BrowserContextHandle {
  closed: boolean;
  visited: string[];
  title: string;
  die(): void;
}

function fakeRuntime() {
  const contexts: FakeContext[] = [];
  const runtime: BrowserRuntime & { contexts: FakeContext[]; closed: boolean; fail: boolean } = {
    id: 'fake',
    contexts,
    closed: false,
    fail: false,
    async newContext(onGone) {
      if (runtime.fail) throw new Error('service down');
      let url = 'about:blank';
      const ctx: FakeContext = {
        closed: false,
        visited: [],
        title: '',
        die() {
          ctx.closed = true;
          onGone();
        },
        async navigate(u) {
          if (ctx.closed) throw new Error('closed');
          url = u;
          ctx.visited.push(u);
          return ctx.state();
        },
        async state(): Promise<PageState> {
          if (ctx.closed) throw new Error('closed');
          return { url, title: ctx.title, blocked: looksBlocked(ctx.title, url) };
        },
        async screenshot() {
          if (ctx.closed) throw new Error('closed');
          return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        },
        async close() {
          ctx.closed = true;
        },
      };
      contexts.push(ctx);
      return ctx;
    },
    async close() {
      runtime.closed = true;
    },
  };
  return runtime;
}

const limits = { maxSessions: 2, sessionTimeoutMs: 60_000, idleTimeoutMs: 30_000 };
const enabled: BrowserConfig = {
  enabled: true,
  wsEndpoint: 'ws://camoufox.internal:8888/x',
  ...limits,
};

const env = {
  PERSEC_INVITE_CODES: 'alice:aaa111,bob:bbb222,carol:ccc333',
  PERSEC_SECRET: 'test-secret',
};
const access = loadAccess(env)!;
const cookie = (name: string) => `persec_access=${createToken(access, name)}`;

async function server(config: BrowserConfig = enabled, runtime = fakeRuntime(), open = false) {
  const app = await buildApp({
    access: open ? null : access,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
    browser: { config, runtime },
  });
  return { app, runtime };
}

const json = (body: unknown, who: string, extra: Record<string, string> = {}) => ({
  headers: { cookie: cookie(who), 'content-type': 'application/json', ...extra },
  payload: JSON.stringify(body),
});

test('Browser mode is off by default and says so', async () => {
  const config = loadBrowserConfig({});
  assert.equal(config.enabled, false);
  const { app, runtime } = await server(config);
  const status = await app.inject({
    url: '/api/browser/status',
    headers: { cookie: cookie('alice') },
  });
  assert.deepEqual(status.json(), { enabled: false, runtime: 'camoufox', reason: 'disabled' });
  assert.equal(status.headers['cache-control'], 'no-store');
  const create = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'chatgpt' }, 'alice'),
  });
  assert.equal(create.statusCode, 404);
  assert.equal(create.json().error.code, 'disabled');
  assert.equal(runtime.contexts.length, 0, 'no browser was asked for anything');
});

test('Config: only what the server sets, with sane floors', () => {
  const c = loadBrowserConfig({
    CAMOUFOX_ENABLED: 'true',
    CAMOUFOX_WS_ENDPOINT: 'ws://camoufox:8888/abc',
    CAMOUFOX_MAX_SESSIONS: '4',
    CAMOUFOX_SESSION_TIMEOUT_MS: '10',
    CAMOUFOX_IDLE_TIMEOUT_MS: 'soon',
  });
  assert.equal(c.enabled, true);
  assert.equal(c.wsEndpoint, 'ws://camoufox:8888/abc');
  assert.equal(c.maxSessions, 4);
  assert.equal(c.sessionTimeoutMs, 30 * 60_000, 'below the floor falls back to the default');
  assert.equal(c.idleTimeoutMs, 5 * 60_000);
  for (const bad of ['file:///usr/bin/firefox', 'http://camoufox', '/usr/bin/camoufox', 'ws://']) {
    assert.equal(loadBrowserConfig({ CAMOUFOX_WS_ENDPOINT: bad }).wsEndpoint, null, bad);
  }
});

test('Enabled without a browser service, or on an open server, it stays off', async () => {
  const noEndpoint = await buildApp({
    access,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
    browser: { config: { ...enabled, wsEndpoint: null } },
  });
  const a = await noEndpoint.inject({
    url: '/api/browser/status',
    headers: { cookie: cookie('alice') },
  });
  assert.equal(a.json().reason, 'not_configured');

  const { app } = await server(enabled, fakeRuntime(), true);
  const b = await app.inject({ url: '/api/browser/status' });
  assert.equal(b.json().reason, 'unavailable_open_mode');
  const c = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    headers: { 'content-type': 'application/json' },
    payload: '{"site":"claude"}',
  });
  assert.equal(c.statusCode, 503);
});

test('Without an invite, nothing about sessions is reachable', async () => {
  const { app, runtime } = await server();
  for (const [method, url] of [
    ['POST', '/api/browser/sessions'],
    ['GET', '/api/browser/sessions/current'],
    ['GET', '/api/browser/sessions/abc'],
    ['GET', '/api/browser/sessions/abc/screenshot'],
    ['DELETE', '/api/browser/sessions/abc'],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      payload: method === 'POST' ? '{"site":"chatgpt"}' : undefined,
    });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
  }
  assert.equal(runtime.contexts.length, 0);
});

test('ChatGPT and Claude presets start a session on their public site', async () => {
  const { app, runtime } = await server();
  const res = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'chatgpt' }, 'alice'),
  });
  assert.equal(res.statusCode, 201);
  const { session, state } = res.json();
  assert.match(session.id, /^[\w-]{24}$/);
  assert.equal(state.url, 'https://chatgpt.com/');
  assert.deepEqual(runtime.contexts[0].visited, ['https://chatgpt.com/']);

  const bob = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'claude' }, 'bob'),
  });
  assert.equal(bob.json().state.url, 'https://claude.ai/');
  assert.notEqual(runtime.contexts[0], runtime.contexts[1], 'each session gets its own context');

  for (const site of ['gemini', 'https://evil.example', '', null, { id: 'chatgpt' }]) {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/browser/sessions',
      ...json({ site }, 'carol'),
    });
    assert.equal(bad.statusCode, 400, JSON.stringify(site));
  }
});

test("One person can't see, drive, photograph or end another's session", async () => {
  const { app, runtime } = await server();
  const created = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'claude' }, 'alice'),
  });
  const { id } = created.json().session;
  const as = (who: string) => ({ headers: { cookie: cookie(who) } });

  // Bob gets exactly what he'd get for a session that doesn't exist.
  const missing = await app.inject({ url: '/api/browser/sessions/nope', ...as('bob') });
  for (const res of [
    await app.inject({ url: `/api/browser/sessions/${id}`, ...as('bob') }),
    await app.inject({ url: `/api/browser/sessions/${id}/screenshot`, ...as('bob') }),
    await app.inject({
      method: 'POST',
      url: `/api/browser/sessions/${id}/navigate`,
      ...json({ url: 'https://claude.ai/new' }, 'bob'),
    }),
  ]) {
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), missing.json());
  }
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/browser/sessions/${id}`,
    ...as('bob'),
  });
  assert.equal(del.statusCode, 204);
  assert.equal(runtime.contexts[0].closed, false, "bob's delete did nothing");
  assert.equal(
    (await app.inject({ url: '/api/browser/sessions/current', ...as('bob') })).json().session,
    null,
  );

  // Alice can do all of it.
  const mine = await app.inject({ url: `/api/browser/sessions/${id}`, ...as('alice') });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().state.url, 'https://claude.ai/');
  assert.equal(mine.json().state.blocked, false);
  const shot = await app.inject({ url: `/api/browser/sessions/${id}/screenshot`, ...as('alice') });
  assert.equal(shot.statusCode, 200);
  assert.equal(shot.headers['content-type'], 'image/jpeg');
  assert.equal(shot.headers['cache-control'], 'no-store');
  const nav = await app.inject({
    method: 'POST',
    url: `/api/browser/sessions/${id}/navigate`,
    ...json({ url: 'https://claude.ai/new' }, 'alice'),
  });
  assert.equal(nav.json().state.url, 'https://claude.ai/new');
  assert.equal(
    (await app.inject({ url: '/api/browser/sessions/current', ...as('alice') })).json().session.id,
    id,
  );
  const end = await app.inject({
    method: 'DELETE',
    url: `/api/browser/sessions/${id}`,
    ...as('alice'),
  });
  assert.equal(end.statusCode, 204);
  assert.equal(runtime.contexts[0].closed, true);
  assert.equal(
    (await app.inject({ url: `/api/browser/sessions/${id}`, ...as('alice') })).statusCode,
    404,
  );
});

test('Responses carry page address, title and picture only, never cookies', async () => {
  const { app } = await server();
  const res = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'chatgpt' }, 'alice'),
  });
  assert.deepEqual(Object.keys(res.json().state).sort(), ['blocked', 'title', 'url']);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('Navigation only goes to the Web AI sites, over the web', async () => {
  const { app, runtime } = await server();
  const { id } = (
    await app.inject({
      method: 'POST',
      url: '/api/browser/sessions',
      ...json({ site: 'chatgpt' }, 'alice'),
    })
  ).json().session;
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'chrome://settings',
    'about:config',
    'http://127.0.0.1:6060/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/',
    'http://2130706433/',
    'http://localhost/',
    'http://intranet/',
    'https://user:pass@chatgpt.com/',
    'https://chatgpt.com:8443/',
    'https://evil.example/',
    'https://chatgpt.com.evil.example/',
    'x'.repeat(3000),
    42,
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/browser/sessions/${id}/navigate`,
      ...json({ url }, 'alice'),
    });
    assert.equal(res.statusCode, 400, String(url).slice(0, 60));
  }
  assert.deepEqual(
    runtime.contexts[0].visited,
    ['https://chatgpt.com/'],
    'none reached the browser',
  );
  const ok = await app.inject({
    method: 'POST',
    url: `/api/browser/sessions/${id}/navigate`,
    ...json({ url: 'http://chatgpt.com/c/123' }, 'alice'),
  });
  assert.equal(ok.json().state.url, 'https://chatgpt.com/c/123', 'upgraded to HTTPS');
});

test('Changes from another site are refused even with a valid cookie', async () => {
  const { app, runtime } = await server();
  const res = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'chatgpt' }, 'alice', {
      origin: 'https://evil.sslip.io',
      host: 'persec.sslip.io',
    }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(runtime.contexts.length, 0);
  const form = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    headers: { cookie: cookie('alice'), 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'site=chatgpt',
  });
  assert.equal(form.statusCode, 400, 'only JSON bodies, which a plain form cannot send');
});

test('Session limits: one per person, a server-wide cap, and a cap on new ones', async () => {
  const runtime = fakeRuntime();
  const m = new SessionManager(runtime, limits);
  const a = await m.create('alice');
  await assert.rejects(m.create('alice'), (e: BrowserError) => e.code === 'too_many_sessions');
  await m.create('bob');
  await assert.rejects(m.create('carol'), (e: BrowserError) => e.code === 'server_busy');
  await m.end('alice', a.id);
  await m.create('carol');
  assert.equal(m.size, 2);

  // Concurrent requests can't overshoot while sessions are still starting.
  const m2 = new SessionManager(fakeRuntime(), limits);
  const results = await Promise.allSettled([
    m2.create('a'),
    m2.create('a'),
    m2.create('b'),
    m2.create('c'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(m2.size, 2);

  // Starting and ending over and over is limited too.
  const m3 = new SessionManager(fakeRuntime(), { ...limits, maxSessions: 10 });
  for (let i = 0; i < CREATES_PER_WINDOW; i++) {
    const s = await m3.create('dave');
    await m3.end('dave', s.id);
  }
  await assert.rejects(m3.create('dave'), (e: BrowserError) => e.code === 'rate_limited');
});

test('Sessions end when idle, when their time is up, and when the browser dies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runtime = fakeRuntime();
  const m = new SessionManager(runtime, {
    maxSessions: 5,
    sessionTimeoutMs: 60_000,
    idleTimeoutMs: 10_000,
  });

  const idle = await m.create('alice');
  t.mock.timers.tick(10_001);
  await Promise.resolve();
  assert.equal(m.size, 0, 'idle session closed');
  assert.equal(runtime.contexts[0].closed, true);
  assert.throws(
    () => m.info('alice', idle.id),
    (e: BrowserError) => e.code === 'not_found',
  );

  // Activity keeps it open, but never past its lifetime.
  const busy = await m.create('bob');
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(9_000);
    m.info('bob', busy.id);
  }
  assert.equal(m.size, 1, 'open after 54s of use, well past the idle timeout');
  t.mock.timers.tick(6_001);
  await Promise.resolve();
  assert.equal(m.size, 0);

  // A crash ends the session and frees its slot.
  const c = await m.create('carol');
  runtime.contexts.at(-1)!.die();
  await Promise.resolve();
  await assert.rejects(m.state('carol', c.id), (e: BrowserError) => e.code === 'not_found');
  assert.equal(m.size, 0);
});

test('Shutdown closes every session and the runtime, and takes no new ones', async () => {
  const runtime = fakeRuntime();
  const m = new SessionManager(runtime, limits);
  await m.create('alice');
  await m.create('bob');
  await m.shutdown();
  assert.equal(m.size, 0);
  assert.ok(runtime.contexts.every(c => c.closed));
  assert.equal(runtime.closed, true);
  await assert.rejects(m.create('carol'), (e: BrowserError) => e.code === 'server_busy');

  // And the server's own close does it.
  const { app, runtime: r2 } = await server();
  await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'claude' }, 'alice'),
  });
  await app.close();
  assert.equal(r2.contexts[0].closed, true);
  assert.equal(r2.closed, true);
});

test('A browser service that is down is reported, not retried forever', async () => {
  const runtime = fakeRuntime();
  runtime.fail = true;
  const { app } = await server(enabled, runtime);
  const res = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'chatgpt' }, 'alice'),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error.code, 'runtime_unavailable');
  runtime.fail = false;
  const again = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'chatgpt' }, 'alice'),
  });
  assert.equal(again.statusCode, 201, 'the failed attempt took no slot');
});

test('Bot checks and refusals are reported as blocked, nothing more', async () => {
  for (const title of [
    'Just a moment...',
    'Attention Required! | Cloudflare',
    'Verify you are human',
    'We couldn’t verify your browser',
  ]) {
    assert.ok(looksBlocked(title), title);
  }
  assert.ok(looksBlocked('', 'https://claude.ai/cdn-cgi/challenge-platform/h/b'));
  for (const title of ['ChatGPT', 'Claude', 'New chat']) assert.ok(!looksBlocked(title), title);

  const runtime = fakeRuntime();
  const { app } = await server(enabled, runtime);
  const res = await app.inject({
    method: 'POST',
    url: '/api/browser/sessions',
    ...json({ site: 'claude' }, 'alice'),
  });
  runtime.contexts[0].title = 'Just a moment...';
  const s = await app.inject({
    url: `/api/browser/sessions/${res.json().session.id}`,
    headers: { cookie: cookie('alice') },
  });
  assert.equal(s.json().state.blocked, true);
  assert.deepEqual(runtime.contexts[0].visited, ['https://claude.ai/'], 'no retry, no workaround');
});

test('SSRF rules for every request the browser makes', () => {
  for (const url of [
    'file:///etc/passwd',
    'ftp://example.com/',
    'view-source:https://example.com',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://172.20.0.2:8080/',
    'http://192.168.1.1/',
    'http://169.254.169.254/',
    'http://100.100.100.200/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://localhost:6060/',
    'http://persec/',
    'http://db.internal/',
    'http://printer.local/',
    'not a url',
  ]) {
    assert.ok(isBlockedRequest(url), url);
  }
  for (const url of [
    'https://chatgpt.com/backend-api/x',
    'https://cdn.oaistatic.com/a.js',
    'https://auth.openai.com/log-in',
    'https://claude.ai/',
    'https://accounts.google.com/o/oauth2',
    'https://challenges.cloudflare.com/turnstile/v0/api.js',
    'http://93.184.215.14/',
    'data:image/png;base64,AAAA',
    'blob:https://claude.ai/123',
    'about:blank',
  ]) {
    assert.ok(!isBlockedRequest(url), url);
  }
  assert.ok(isInternalHost('LOCALHOST.'));
  assert.ok(!isInternalHost('claude.ai'));
});

test('Navigation URL rules', () => {
  assert.equal(checkNavigationUrl('https://chatgpt.com/').href, 'https://chatgpt.com/');
  assert.equal(checkNavigationUrl('https://claude.ai/new?x=1').href, 'https://claude.ai/new?x=1');
  assert.equal(checkNavigationUrl('http://claude.ai:80/').href, 'https://claude.ai/');
  assert.throws(
    () => checkNavigationUrl('https://anthropic.com/'),
    (e: BrowserError) => e.code === 'site_not_allowed',
  );
  assert.throws(
    () => checkNavigationUrl('https://chatgpt.com@evil.example/'),
    (e: BrowserError) => e.code === 'invalid_url',
  );
});

test('Site presets are the public sites, with no API hosts', () => {
  assert.deepEqual(
    BROWSER_SITES.map(s => [s.id, s.start]),
    [
      ['chatgpt', 'https://chatgpt.com/'],
      ['claude', 'https://claude.ai/'],
    ],
  );
  assert.equal(siteForHost('www.chatgpt.com')?.id, 'chatgpt');
  assert.equal(siteForHost('notclaude.ai'), undefined);
  for (const s of BROWSER_SITES) {
    assert.doesNotMatch(s.start, /api\.|\/api\/|backend-api/);
    assert.equal(new URL(s.start).pathname, '/');
  }
});

// The Camoufox adapter against a stand-in Playwright: what it asks the browser for.
function fakePlaywright() {
  const calls: {
    contexts: Record<string, unknown>[];
    routes: string[];
    goto: string[];
    closed: number;
  } = {
    contexts: [],
    routes: [],
    goto: [],
    closed: 0,
  };
  let onDisconnect: (() => void) | null = null;
  let connects = 0;
  const firefox: PwFirefox = {
    async connect(endpoint) {
      connects++;
      assert.equal(endpoint, 'ws://camoufox.internal:8888/x');
      return {
        isConnected: () => true,
        on: (_e: string, fn: () => void) => (onDisconnect = fn),
        close: async () => {},
        async newContext(opts: Record<string, unknown>) {
          calls.contexts.push(opts);
          const pageHandlers: Record<string, () => void> = {};
          let url = 'about:blank';
          const page = {
            goto: async (u: string) => {
              calls.goto.push(u);
              url = u;
            },
            url: () => url,
            title: async () => 'ChatGPT',
            screenshot: async () => Buffer.from('jpeg'),
            close: async () => {},
            on: (e: string, fn: () => void) => (pageHandlers[e] = fn),
          };
          return {
            newPage: async () => page,
            pages: () => [page],
            route: async (pattern: string, fn: (r: any) => unknown) => {
              for (const u of [
                'file:///etc/passwd',
                'http://169.254.169.254/',
                'https://chatgpt.com/',
              ]) {
                await fn({
                  request: () => ({ url: () => u }),
                  abort: async () => calls.routes.push(`abort ${u}`),
                  continue: async () => calls.routes.push(`continue ${u}`),
                });
              }
              assert.equal(pattern, '**/*');
            },
            on: () => {},
            close: async () => {
              calls.closed++;
            },
          } as any;
        },
      } as any;
    },
  };
  return { firefox, calls, disconnect: () => onDisconnect?.(), connects: () => connects };
}

test('The Camoufox adapter makes a fresh, guarded context with downloads off', async () => {
  const pw = fakePlaywright();
  const runtime = createCamoufoxRuntime('ws://camoufox.internal:8888/x', async () => pw.firefox);
  let gone = 0;
  const ctx = await runtime.newContext(() => gone++);
  assert.equal(pw.calls.contexts[0].acceptDownloads, false);
  assert.equal('storageState' in pw.calls.contexts[0], false, 'no saved profile or cookies loaded');
  assert.deepEqual(pw.calls.routes, [
    'abort file:///etc/passwd',
    'abort http://169.254.169.254/',
    'continue https://chatgpt.com/',
  ]);
  assert.deepEqual(await ctx.navigate('https://chatgpt.com/'), {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT',
    blocked: false,
  });

  // The browser service going away ends the session, and the next one reconnects.
  pw.disconnect();
  assert.equal(gone, 1);
  await runtime.newContext(() => {});
  assert.equal(pw.connects(), 2);
  await ctx.close();
  await runtime.close();
});

test('Without playwright-core installed, browser mode reports the runtime unavailable', async t => {
  t.mock.method(console, 'warn', () => {});
  const runtime = createCamoufoxRuntime('ws://camoufox.internal:8888/x');
  await assert.rejects(
    runtime.newContext(() => {}),
    (e: BrowserError) => e.code === 'runtime_unavailable',
  );
});
