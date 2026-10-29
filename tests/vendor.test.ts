import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';
import { fixScramjet, fixUvBundle, fixUvHandler } from '../build/vendor.ts';

const scramjetAll = path.join(scramjetPath, 'scramjet.all.js');
const fixedScramjet = fixScramjet(await readFile(scramjetAll, 'utf8'));
// The cookie parser Scramjet bundles, the same package Ultraviolet depends on.
const parseCookie = createRequire(path.join(uvPath, '..', 'package.json'))('set-cookie-parser');

// The text of the fixed code from `start` up to and including `end`.
function between(code: string, start: string, end: string) {
  const from = code.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = code.indexOf(end, from);
  assert.ok(to >= 0, `missing ${end}`);
  return code.slice(from, to + end.length);
}

test("Scramjet's worker sends the page each cookie a server sets, not its position", async () => {
  const original = await readFile(scramjetAll, 'utf8');
  const fixed = fixScramjet(original);
  assert.notEqual(fixed, original);
  assert.ok(!fixed.includes('for(let t in x)if(h)'));
  assert.ok(fixed.includes('for(let t of Array.isArray(x)?x:[x])if(h){'));

  // The fixed loop, run on its own: one message per cookie, carrying the cookie.
  const loop = /for\(let t of Array\.isArray\(x\)\?x:\[x\]\)if\(h\)\{/.exec(fixed)![0];
  const sent = (x: unknown) => {
    const out: unknown[] = [];
    new Function('x', 'h', 'out', `${loop}out.push(t)}`)(x, true, out);
    return out;
  };
  assert.deepEqual(sent(['a=1; Path=/', 'b=2; HttpOnly']), ['a=1; Path=/', 'b=2; HttpOnly']);
  assert.deepEqual(sent('cf_clearance=x; Secure'), ['cf_clearance=x; Secure']);
  assert.deepEqual(sent([]), []);
});

test('A runtime fix that no longer matches fails the build instead of being skipped', () => {
  assert.throws(() => fixScramjet('nothing to fix here'), /found it 0 times/);
  const twice = 'let x=v["set-cookie"]||[];for(let t in x)if(h){'.repeat(2);
  assert.throws(() => fixScramjet(twice), /found it 2 times/);
});

test('The build applies the fix to the Scramjet file it serves', async () => {
  const config = await readFile(new URL('../astro.config.ts', import.meta.url), 'utf8');
  assert.match(config, /RUNTIME_FIXES\[role\] && \{ transform: RUNTIME_FIXES\[role\] \}/);
});

// Scramjet's cookie jar, as fixed, run on its own.
function scramjetJar() {
  const source = between(
    fixedScramjet,
    'class a{cookies={};',
    'dump(){return JSON.stringify(this.cookies)}}',
  );
  const Jar = new Function('i', `return ${source}`)(() => parseCookie);
  return new Jar();
}

test('Scramjet sends cookie values back exactly as the site set them', () => {
  const jar = scramjetJar();
  const site = new URL('https://canvas.example.edu/courses/1');
  jar.setCookies(['_csrf_token=ab%2Bc%2F%3D%3D; Path=/; Secure', 'bad=%E0%A4%A; Path=/'], site);
  assert.equal(jar.getCookies(site, false), '_csrf_token=ab%2Bc%2F%3D%3D; bad=%E0%A4%A');
  // A page's own document.cookie writes are kept as written too.
  jar.setCookies(['pref=a%20b'], site);
  assert.match(jar.getCookies(site, true), /pref=a%20b/);
});

test('Scramjet deletes a cookie on Max-Age=0 and expires it after Max-Age seconds', () => {
  const jar = scramjetJar();
  const site = new URL('https://login.example.com/');
  jar.setCookies(['session=1; Path=/', 'step=2; Path=/; Max-Age=600'], site);
  assert.equal(jar.getCookies(site, false), 'session=1; step=2');
  jar.setCookies(['session=; Path=/; Max-Age=0', 'step=x; Path=/; Max-Age=-1'], site);
  assert.equal(jar.getCookies(site, false), '');

  // Max-Age wins over Expires: here a past Expires would delete it, but Max-Age keeps it an hour.
  jar.setCookies(['keep=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=3600'], site);
  const expires = new Date(jar.cookies['.login.example.com@/@keep'].expires).getTime();
  assert.ok(Math.abs(expires - (Date.now() + 3600_000)) < 5000);
  assert.equal(jar.getCookies(site, false), 'keep=1');
  // Without Max-Age, Expires still decides, as before.
  jar.setCookies(['old=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT'], site);
  assert.equal(jar.getCookies(site, false), 'keep=1');
});

// How Scramjet's worker splits a request's query into its own settings and the site's fields.
function splitQuery(proxied: string, mode: string, decoded: string) {
  const source = between(
    fixedScramjet,
    'let u="",d=[],$f="navigate"===e.mode;',
    'h.searchParams.append(e,t):h.searchParams.set(e,t);',
  );
  const run = new Function('e', 'o', 's', 'f', `let r,n;${source}return {h:h.href,u}`);
  return run({ mode }, new URL(proxied), { v2: () => decoded }, { warn() {} });
}

test('A GET form keeps every field, even ones named type or dest, and repeated ones', () => {
  const form = splitQuery(
    'https://persec.test/sc/ENCODED?q=cats&type=book&dest=x&tag=a&tag=b',
    'navigate',
    'https://library.example.org/search?page=2',
  );
  // As in browsers, the fields replace the action's own query.
  assert.equal(form.h, 'https://library.example.org/search?q=cats&type=book&dest=x&tag=a&tag=b');
  assert.equal(form.u, '');

  // A page opened with no fields keeps its own query.
  const plain = splitQuery('https://persec.test/sc/ENCODED', 'navigate', 'https://x.test/?a=1');
  assert.equal(plain.h, 'https://x.test/?a=1');
});

test("Scramjet's own ?type= on scripts and workers is still read and taken off", () => {
  const script = splitQuery(
    'https://persec.test/sc/ENCODED?type=module',
    'cors',
    'https://cdn.example.com/app.js?v=3',
  );
  assert.deepEqual(script, { h: 'https://cdn.example.com/app.js?v=3', u: 'module' });
  const worker = splitQuery(
    'https://persec.test/sc/ENCODED?dest=worker',
    'same-origin',
    'https://a.test/w.js',
  );
  assert.deepEqual(worker, { h: 'https://a.test/w.js', u: '' });
});

test("Scramjet's WebSockets carry the site's cookies for the socket's address", () => {
  const calls = [
    ...fixedScramjet.matchAll(
      /e\.bare\.createWebSocket\((n|r)\.args\[0\],\1\.args\[1\],null,(\{.*?\}\)\(\)\})\)/g,
    ),
  ];
  assert.equal(calls.length, 2, 'WebSocket and WebSocketStream');
  for (const [, args, headers] of calls) {
    const seen: [string, boolean][] = [];
    const client = {
      url: new URL('https://chat.example.com/room/1'),
      cookieStore: {
        getCookies: (url: URL, fromJs: boolean) => (seen.push([url.href, fromJs]), 'sid=s%3A1'),
      },
    };
    const build = new Function(args, 't', 'e', `return ${headers}`);
    const nav = { userAgent: 'UA' };
    assert.deepEqual(
      build({ args: ['wss://chat.example.com/socket?x=1'] }, { navigator: nav }, client),
      {
        'User-Agent': 'UA',
        Origin: 'https://chat.example.com',
        Cookie: 'sid=s%3A1',
      },
    );
    // HttpOnly cookies count: they are the ones a login usually is.
    assert.deepEqual(seen, [['https://chat.example.com/socket?x=1', false]]);
    // A relative address is read against the page's; no cookies means no header.
    client.cookieStore.getCookies = (url: URL) => (seen.push([url.href, false]), '');
    assert.deepEqual(build({ args: ['/live'] }, { navigator: nav }, client), {
      'User-Agent': 'UA',
      Origin: 'https://chat.example.com',
    });
    assert.equal(seen.at(-1)![0], 'https://chat.example.com/live');
  }
});

test('Ultraviolet deletes a cookie on Max-Age=0', async () => {
  const fixed = fixUvBundle(await readFile(path.join(uvPath, 'uv.bundle.js'), 'utf8'));
  const check = between(fixed, 'r.set&&(Number.isFinite(r.maxAge)', '<t))');
  const expired = new Function('r', 't', `let n=!1;return ${check},n`);
  const now = new Date();
  const set = new Date(now.getTime() - 10_000);
  assert.equal(expired({ set, maxAge: 0 }, now), true);
  assert.equal(expired({ set, maxAge: 5 }, now), true);
  assert.equal(expired({ set, maxAge: 60 }, now), false);
  assert.equal(expired({ set, expires: new Date(now.getTime() + 60_000) }, now), false);
  assert.equal(expired({ set, expires: new Date(now.getTime() - 60_000) }, now), true);
});

// Ultraviolet's WebSocket fix, run on its own with a stubbed cookie database and transport. Node 22
// has no CloseEvent, which the fix makes as browsers do.
(globalThis as any).CloseEvent ??= class extends Event {
  code: number;
  constructor(type: string, init: { code?: number } = {}) {
    super(type);
    this.code = init.code ?? 0;
  }
};
async function uvSockets(cookies: string) {
  const fixed = fixUvHandler(await readFile(path.join(uvPath, 'uv.handler.js'), 'utf8'));
  const source = between(fixed, 'a.websocket.overrideWebSocket((function (uv, bare) {', '})(e,c))');
  const make = new Function(
    'e',
    'c',
    `return ${source.slice('a.websocket.overrideWebSocket('.length, -1)}`,
  );
  let release!: () => void;
  const ready = new Promise<void>(r => (release = r));
  const opened: { url: string; headers: Record<string, string>; socket: EventTarget & any }[] = [];
  const uv = {
    meta: { url: { href: 'https://game.example.com/play' } },
    cookie: {
      db: () => ready.then(() => 'db'),
      getCookies: async () => [{ name: 'sid', value: cookies }],
      serialize: (list: { name: string; value: string }[], meta: { url: URL }, js: boolean) =>
        !js && meta.url.protocol === 'https:'
          ? list.map(c => `${c.name}=${c.value}`).join('; ')
          : '',
    },
  };
  const bare = {
    createWebSocket(url: string, _p: unknown, _w: unknown, headers: Record<string, string>) {
      const socket: any = new EventTarget();
      socket.readyState = 0;
      socket.sent = [];
      socket.send = (data: unknown) => socket.sent.push(data);
      socket.close = () => (socket.closed = true);
      opened.push({ url, headers, socket });
      return socket;
    },
  };
  return { sockets: make(uv, bare), opened, release };
}

test("Ultraviolet's WebSockets carry the site's cookies, waiting for the jar if they must", async () => {
  const { sockets, opened, release } = await uvSockets('a%2Bb');
  // Opened as the page starts: the socket waits for the cookies, and can't send yet.
  const early = sockets.createWebSocket('wss://game.example.com/ws', [], null, { Origin: 'o' });
  assert.equal(early.readyState, 0);
  assert.throws(() => early.send('hi'), /CONNECTING/);
  const events: string[] = [];
  early.addEventListener('open', () => events.push('open'));
  early.addEventListener('message', (ev: MessageEvent) => events.push(`message ${ev.data}`));
  release();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(
    opened.map(o => [o.url, o.headers]),
    [['wss://game.example.com/ws', { Origin: 'o', Cookie: 'sid=a%2Bb' }]],
  );
  const real = opened[0].socket;
  real.dispatchEvent(new Event('open'));
  real.dispatchEvent(new MessageEvent('message', { data: 'hello' }));
  real.readyState = 1;
  assert.deepEqual(events, ['open', 'message hello']);
  assert.equal(early.readyState, 1);
  early.send('hi');
  assert.deepEqual(real.sent, ['hi']);

  // Once the jar is loaded, sockets open at once, with cookies; plain ws:// gets no secure ones here.
  const later = sockets.createWebSocket('/ws2', [], null, {});
  assert.equal(later, opened[1].socket);
  assert.deepEqual(opened[1].headers, { Cookie: 'sid=a%2Bb' });
  sockets.createWebSocket('ws://game.example.com/insecure', [], null, {});
  assert.deepEqual(opened[2].headers, {});
});

test('An Ultraviolet socket closed before the jar loaded never opens', async () => {
  const { sockets, opened, release } = await uvSockets('x');
  const early = sockets.createWebSocket('wss://game.example.com/ws', [], null, {});
  const closes: number[] = [];
  early.addEventListener('close', (ev: CloseEvent) => closes.push(ev.code));
  early.close();
  assert.equal(early.readyState, 3);
  release();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(opened.length, 0);
  assert.deepEqual(closes, [1000]);
});
