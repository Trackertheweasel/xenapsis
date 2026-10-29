import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { deployPaths } from '../serverlib/env.ts';
import { uvConfigSource } from '../src/pages/[runtime]/[uvconfig].js.ts';

const origin = 'https://persec.test';

// This build's paths, a build-time constant (see astro.config.ts). uvConfigSource() reads them as it
// generates the config source here in Node; the worker gets them on its ctx below, as
// src/pages/[sw].js.ts defines them. URL_KEY, which the embedded codec reads, is set there too.
const PATHS = deployPaths('test-key');
(globalThis as any).PERSEC_PATHS = PATHS;

// What a stubbed engine answers: the page in a request's `html`, as a site's page, or its name.
const page = (request: { html?: string }, engine: string) =>
  request.html === undefined
    ? new Response(engine)
    : new Response(request.html, { headers: { 'content-type': 'text/html; charset=utf-8' } });

// Runs src/sw.js with the proxy engines stubbed out, exposing its functions, its event
// listeners, and what reached each engine or the network (ctx.calls).
async function loadServiceWorker() {
  const calls = {
    scramjet: [] as { url: string; jar: string[] }[],
    uv: [] as string[],
    network: [] as string[],
    imported: [] as string[],
    configLoads: 0,
  };
  const ctx: any = {
    calls,
    listeners: {} as Record<string, (event: any) => void>,
    URL,
    Response,
    Headers,
    URL_KEY: 'test-key',
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    console,
    location: { origin },
    addEventListener: (type: string, fn: (event: any) => void) => (ctx.listeners[type] = fn),
    // Saves run on the next tick instead of after a second.
    setTimeout: (fn: () => void) => (queueMicrotask(fn), 1),
    fetch: async (request: { url: string }) => (
      calls.network.push(request.url),
      new Response('net')
    ),
    PERSEC_PATHS: PATHS,
    importScripts: (...urls: string[]) => calls.imported.push(...urls),
    $scramjetLoadWorker: () => ({
      ScramjetServiceWorker: class {
        config: { prefix: string } | undefined = { prefix: PATHS.scPrefix };
        // Like Scramjet's: reads the stored config (and builds its codec) only when it has none.
        async loadConfig() {
          if (!this.config) {
            calls.configLoads++;
            // Nothing saved yet leaves it undefined, as Scramjet's does.
            this.config = ctx.noSavedConfig ? undefined : { prefix: PATHS.scPrefix };
          }
        }
        // Like Scramjet's, which throws without a config.
        route(event: any) {
          return event.request.url.startsWith(`${origin}${this.config!.prefix}`);
        }
        // A request with setCookie stands in for a site's server setting that cookie.
        async fetch(event: any) {
          calls.scramjet.push({
            url: event.request.url,
            jar: Object.keys(this.cookieStore.cookies),
          });
          if (event.request.setCookie) this.cookieStore.cookies[event.request.setCookie] = {};
          return page(event.request, 'scramjet');
        }
        cookieStore = {
          cookies: {} as Record<string, unknown>,
          // Like Scramjet 1.1.0's, which skips objects: the format it saves the jar in.
          load(jar: unknown) {
            if (typeof jar === 'object') return jar;
            this.cookies = JSON.parse(jar as string);
          },
          dump() {
            return JSON.stringify(this.cookies);
          },
        };
      },
    }),
    UVServiceWorker: class {
      route(event: any) {
        return event.request.url.startsWith(`${origin}${ctx.__uv$config.prefix}`);
      }
      async fetch(event: any) {
        calls.uv.push(event.request.url);
        return page(event.request, 'uv');
      }
    },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(uvConfigSource(), ctx);
  vm.runInContext(await readFile(new URL('../src/sw.js', import.meta.url), 'utf8'), ctx);
  return ctx;
}

const sw = await loadServiceWorker();
const scramjet = (url: string) => `${origin}${PATHS.scPrefix}${sw.__uv$config.encodeUrl(url)}`;
const uv = (url: string) => `${origin}${sw.__uv$config.prefix}${sw.__uv$config.encodeUrl(url)}`;
const blocked = (proxied: string, request: Record<string, string> = { destination: 'script' }) => {
  const target = sw.targetUrl(proxied);
  return !!target && sw.isAdRequest(target, request);
};

test('Ad blocker decodes proxied URLs from both engines', () => {
  assert.equal(
    sw.targetUrl(scramjet('https://ad.doubleclick.net/x.js?a=1')).hostname,
    'ad.doubleclick.net',
  );
  assert.equal(sw.targetUrl(uv('https://ad.doubleclick.net/x.js')).hostname, 'ad.doubleclick.net');
});

test("Ad blocker never touches Persec's own requests", () => {
  assert.equal(sw.targetUrl(`${origin}/api/query?q=headphones`), null);
  assert.equal(sw.targetUrl(`${origin}/cdn-cgi/challenge-platform/x.js`), null);
});

test('Ad blocker blocks ad and tracker requests', () => {
  assert.ok(blocked(scramjet('https://securepubads.g.doubleclick.net/tag/js/gpt.js')));
  assert.ok(blocked(uv('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')));
  assert.ok(blocked(scramjet('https://www.googletagmanager.com/gtag/js?id=G-1')));
  assert.ok(blocked(scramjet('https://example.com/static/ads/banner.js')));
  assert.ok(blocked(scramjet('https://example.com/beacon'), { destination: 'ping' }));
});

test('Ad blocker leaves normal sites and pages alone', () => {
  assert.ok(!blocked(scramjet('https://www.reddit.com/app.js')));
  assert.ok(
    !blocked(scramjet('https://www.facebook.com/'), { destination: 'document', mode: 'navigate' }),
  );
  assert.ok(
    !blocked(scramjet('https://ad.doubleclick.net/click'), {
      destination: 'document',
      mode: 'navigate',
    }),
  );
  assert.ok(!blocked(scramjet('https://example.com/uploads/app.js')));
  assert.ok(
    !blocked(scramjet('https://example.com/img.png?utm_source=x'), { destination: 'image' }),
  );
  assert.ok(
    !blocked(scramjet('https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1')),
  );
});

test('Scramjet cookies saved before the worker stopped are loaded back and saved again', async () => {
  const cookie = (name: string) => ({ name, value: name, domain: '.example.com', path: '/' });
  const saved = { '.example.com@/@old': cookie('old') };
  const writes: unknown[] = [];
  sw.withScramjetCookies = async (_mode: string, fn: (store: unknown) => { result: unknown }) =>
    fn({
      get: () => ({ result: saved }),
      put: (jar: unknown) => (writes.push(jar), { result: 'cookies' }),
    }).result;
  const jar = () => JSON.parse(vm.runInContext('scramjet.cookieStore.dump()', sw));

  // A cookie set before the saved jar finished loading is kept.
  vm.runInContext(
    `scramjet.cookieStore.cookies['.example.com@/@new'] = ${JSON.stringify(cookie('new'))}`,
    sw,
  );
  await sw.loadJar();
  assert.deepEqual(Object.keys(jar()).sort(), ['.example.com@/@new', '.example.com@/@old']);

  await sw.saveJar();
  assert.equal(writes.length, 1, 'the merged jar is saved');
  await sw.saveJar();
  assert.equal(writes.length, 1, 'an unchanged jar is not rewritten');
  vm.runInContext(
    `scramjet.cookieStore.cookies['.example.com@/@sid'] = ${JSON.stringify(cookie('sid'))}`,
    sw,
  );
  await sw.saveJar();
  assert.equal(writes.length, 2);
  assert.ok('.example.com@/@sid' in (writes[1] as object));
});

// Behavior through the worker's real fetch and message listeners, each on a freshly started worker.

// Stands in for Scramjet's cookie jar in IndexedDB.
function cookieDb(worker: any, saved: Record<string, unknown> = {}) {
  const db = { saved, writes: [] as Record<string, unknown>[] };
  worker.withScramjetCookies = async (_mode: string, fn: (store: unknown) => { result: unknown }) =>
    fn({
      get: () => ({ result: db.saved }),
      put: (jar: Record<string, unknown>) => {
        db.writes.push(jar);
        db.saved = jar;
        return { result: 'cookies' };
      },
    }).result;
  return db;
}

async function request(worker: any, url: string, init: Record<string, string> = {}) {
  let response: Promise<Response> | undefined;
  const waits: Promise<unknown>[] = [];
  worker.listeners.fetch({
    request: { url, destination: '', ...init },
    respondWith: (p: Promise<Response>) => (response = p),
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  const res = await response!;
  await Promise.all(waits);
  return res;
}

// Settings, a trusted Persec page, unless another sender is given.
const settingsPage = { type: 'window', url: `${origin}/st` };

async function message(worker: any, type: string, data?: unknown, source: unknown = settingsPage) {
  let reply: unknown;
  const waits: Promise<unknown>[] = [];
  worker.listeners.message({
    source,
    data: { type, data },
    ports: [{ postMessage: (m: unknown) => (reply = m) }],
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });
  await Promise.all(waits);
  return reply;
}

async function freshWorker({ adblock = true, webrtc = true } = {}) {
  const worker = await loadServiceWorker();
  worker.reads = 0;
  worker.webrtcReads = 0;
  worker.readAdblockSetting = async () => (worker.reads++, adblock);
  worker.readWebrtcSetting = async () => (worker.webrtcReads++, webrtc);
  return worker;
}
const viaScramjet = (worker: any, url: string) =>
  `${origin}${PATHS.scPrefix}${worker.__uv$config.encodeUrl(url)}`;
const viaUv = (worker: any, url: string) =>
  `${origin}${worker.__uv$config.prefix}${worker.__uv$config.encodeUrl(url)}`;
const AD = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

test("Persec's own requests go to the network untouched, past the engines and the ad blocker", async () => {
  const worker = await freshWorker();
  cookieDb(worker);
  // /a/ad/ is Persec's own server-proxied ad, which the ad blocker must not eat.
  const own = [`${origin}/api/logins`, `${origin}/a/ad/img/1`, `${origin}/ads.js`];
  for (const url of own) {
    assert.equal(await (await request(worker, url, { destination: 'script' })).text(), 'net', url);
  }
  assert.deepEqual(worker.calls.network, own);
  assert.equal(worker.calls.scramjet.length + worker.calls.uv.length, 0);
});

test('Proxied requests reach the engine that encoded them', async () => {
  const worker = await freshWorker();
  cookieDb(worker);
  const site = 'https://example.com/';
  assert.equal(await (await request(worker, viaScramjet(worker, site))).text(), 'scramjet');
  assert.equal(await (await request(worker, viaUv(worker, site))).text(), 'uv');
  assert.deepEqual(worker.calls.network, []);
});

test('A blocked ad never reaches an engine, so no cookies go with it', async () => {
  const worker = await freshWorker();
  cookieDb(worker);
  for (const url of [viaScramjet(worker, AD), viaUv(worker, AD)]) {
    assert.equal((await request(worker, url, { destination: 'script' })).status, 204, url);
  }
  const { scramjet, uv, network } = worker.calls;
  assert.equal(scramjet.length + uv.length + network.length, 0);
});

test('After a restart the ad-block setting is read from storage once, then follows the toggle', async () => {
  const worker = await freshWorker({ adblock: false });
  cookieDb(worker);
  await request(worker, viaScramjet(worker, AD), { destination: 'script' });
  await request(worker, viaScramjet(worker, AD), { destination: 'script' });
  assert.equal(worker.calls.scramjet.length, 2, 'off, so ads load');
  assert.equal(worker.reads, 1);
  await message(worker, 'ADBLOCK', { enabled: true });
  assert.equal(
    (await request(worker, viaScramjet(worker, AD), { destination: 'script' })).status,
    204,
  );
  assert.equal(worker.reads, 1);
});

test('Saved cookies are loaded before the first proxied request, and new ones are saved', async () => {
  const worker = await freshWorker();
  const db = cookieDb(worker, { old: {} });
  await request(worker, viaScramjet(worker, 'https://example.com/login'), { setCookie: 'sid' });
  assert.deepEqual(worker.calls.scramjet[0].jar, ['old'], 'the saved login went with the request');
  assert.deepEqual(Object.keys(db.saved).sort(), ['old', 'sid']);
});

test('Clearing site data empties the jar, and saved cookies do not come back', async () => {
  const worker = await freshWorker();
  const db = cookieDb(worker, { old: {} });
  const url = viaScramjet(worker, 'https://example.com/');
  await request(worker, url);
  assert.equal(await message(worker, 'CLEAR_SITE_DATA'), 'done');
  // The page clears IndexedDB after this message; until it has, the worker must not reload it.
  await request(worker, url);
  assert.deepEqual(worker.calls.scramjet[1].jar, []);
  assert.deepEqual(db.writes, [], 'nothing old is written back');
});

test('Clearing site data before any request also stops the saved jar loading', async () => {
  const worker = await freshWorker();
  cookieDb(worker, { old: {} });
  await message(worker, 'CLEAR_SITE_DATA');
  await request(worker, viaScramjet(worker, 'https://example.com/'));
  assert.deepEqual(worker.calls.scramjet[0].jar, []);
});

test('Restoring saved logins merges the cookies into the jar and saves them', async () => {
  const worker = await freshWorker();
  const db = cookieDb(worker, { old: {} });
  assert.equal(await message(worker, 'SET_COOKIES', { restored: {} }), 'done');
  assert.deepEqual(Object.keys(db.saved).sort(), ['old', 'restored']);
  const jar = (await message(worker, 'GET_COOKIES')) as object;
  assert.deepEqual(Object.keys(jar).sort(), ['old', 'restored']);
  await request(worker, viaScramjet(worker, 'https://example.com/'));
  assert.deepEqual(worker.calls.scramjet[0].jar.sort(), ['old', 'restored']);
});

test('Only Persec pages that need them can use the cookie and settings messages', async () => {
  const worker = await freshWorker();
  const site = 'https://example.com/';
  const untrusted = {
    'a page proxied by Scramjet': { type: 'window', url: viaScramjet(worker, site) },
    'a page proxied by Ultraviolet': { type: 'window', url: viaUv(worker, site) },
    'a blank frame': { type: 'window', url: 'about:blank' },
    'another origin': { type: 'window', url: 'https://evil.test/st' },
    'a Persec page that never sends them': { type: 'window', url: `${origin}/new` },
    'a worker at a trusted URL': { type: 'worker', url: `${origin}/st` },
    'no sender': null,
  };
  for (const [who, source] of Object.entries(untrusted)) {
    const w = await freshWorker({ adblock: false });
    const db = cookieDb(w, { old: {} });
    assert.equal(await message(w, 'GET_COOKIES', undefined, source), undefined, `${who}: read`);
    assert.equal(await message(w, 'SET_COOKIES', { planted: {} }, source), undefined, who);
    assert.equal(await message(w, 'CLEAR_SITE_DATA', undefined, source), undefined, who);
    await message(w, 'ADBLOCK', { enabled: true }, source);
    assert.deepEqual(db.writes, [], `${who}: nothing written`);
    await request(w, viaScramjet(w, AD), { destination: 'script' });
    assert.deepEqual(w.calls.scramjet[0].jar, ['old'], `${who}: jar neither cleared nor planted`);
    assert.equal(w.reads, 1, `${who}: ad blocker not toggled`);
  }
  for (const page of ['/', '/st', '/?tab=1']) {
    const source = { type: 'window', url: `${origin}${page}` };
    cookieDb(worker, { old: {} });
    assert.ok(await message(worker, 'GET_COOKIES', undefined, source), page);
  }
});

test('A restore that is not a cookie jar is ignored', async () => {
  const worker = await freshWorker();
  const db = cookieDb(worker, { old: {} });
  for (const bad of ['abc', ['x'], null, 42]) {
    assert.equal(await message(worker, 'SET_COOKIES', bad), undefined);
  }
  assert.deepEqual(db.writes, []);
});

test("The worker loads the proxy runtime from this build's paths", async () => {
  const worker = await freshWorker();
  const { files } = PATHS;
  assert.deepEqual(worker.calls.imported, [
    files.scramjetAll,
    files.uvConfig,
    files.uvBundle,
    files.uvSw,
  ]);
  const uv = worker.__uv$config;
  assert.equal(uv.prefix, PATHS.uvPrefix);
  assert.deepEqual(
    [uv.handler, uv.client, uv.bundle, uv.config, uv.sw],
    [files.uvHandler, files.uvClient, files.uvBundle, files.uvConfig, files.uvSw],
  );
});

test("A page's new Scramjet config makes the worker reload it, codec included", async () => {
  const worker = await loadServiceWorker();
  worker.readAdblockSetting = async () => false;
  worker.withScramjetCookies = async () => undefined;
  await request(worker, scramjet('https://example.com/'));
  const before = worker.calls.configLoads;
  // Sent by Scramjet's controller from any Persec page (not only the trusted ones) after saving it.
  worker.listeners.message({
    data: { scramjet$type: 'loadConfig', config: { prefix: PATHS.scPrefix } },
    source: { type: 'window', url: `${origin}/welcome` },
    ports: [],
    waitUntil: () => {},
  });
  assert.equal(await (await request(worker, scramjet('https://example.com/'))).text(), 'scramjet');
  assert.equal(worker.calls.configLoads, before + 1, 'read back from storage');
});

test('Before Scramjet has a saved config, Persec still loads', async () => {
  const worker = await loadServiceWorker();
  worker.noSavedConfig = true;
  worker.readAdblockSetting = async () => false;
  worker.withScramjetCookies = async () => undefined;
  // The loadConfig message drops the config the stub started with, as a fresh worker has none.
  worker.listeners.message({
    data: { scramjet$type: 'loadConfig' },
    source: { type: 'window', url: `${origin}/welcome` },
    ports: [],
    waitUntil: () => {},
  });
  assert.equal(await (await request(worker, `${origin}/welcome`)).text(), 'net');
  assert.equal(await (await request(worker, uv('https://example.com/'))).text(), 'uv');
});

test('A new build takes over from the old worker straight away', async () => {
  let skipped = false;
  let claimed: Promise<unknown> | undefined;
  sw.skipWaiting = () => (skipped = true);
  sw.clients = { claim: async () => 'claimed' };
  sw.listeners.install({});
  sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => (claimed = p) });
  assert.ok(skipped);
  assert.equal(await claimed, 'claimed');
});

// The WebRTC guard (see webrtcGuard in src/sw.js).

const SITE_PAGE =
  '<!DOCTYPE html><html><head><script src="/engine.js"></script></head><body></body></html>';
const navigate = { destination: 'document', mode: 'navigate', html: SITE_PAGE };

test("The WebRTC guard goes first in proxied pages' <head>, from either engine", async () => {
  const worker = await freshWorker();
  cookieDb(worker);
  const site = 'https://example.com/';
  for (const url of [viaScramjet(worker, site), viaUv(worker, site)]) {
    const res = await request(worker, url, navigate);
    const html = await res.text();
    assert.ok(html.startsWith('<!DOCTYPE html><html><head><script>(function webrtcGuard'), url);
    assert.ok(html.endsWith('<script src="/engine.js"></script></head><body></body></html>'), url);
    assert.match(res.headers.get('content-type')!, /^text\/html/);
  }
  const frame = await request(worker, viaScramjet(worker, site), {
    ...navigate,
    destination: 'iframe',
  });
  assert.match(await frame.text(), /webrtcGuard/);
  assert.equal(worker.webrtcReads, 1);
});

test('The WebRTC guard leaves everything but pages alone', async () => {
  const worker = await freshWorker();
  cookieDb(worker);
  const url = viaScramjet(worker, 'https://example.com/app.js');
  // An HTML answer to a script or fetch() request is data, not a page that runs.
  for (const destination of ['script', '']) {
    const res = await request(worker, url, { destination, html: SITE_PAGE });
    assert.equal(await res.text(), SITE_PAGE, destination);
  }
  assert.equal(await (await request(worker, url, { destination: 'document' })).text(), 'scramjet');
  assert.equal(await (await request(worker, `${origin}/st`, navigate)).text(), 'net');
  assert.equal(worker.webrtcReads, 0, 'the setting is only read for a page');
});

test('With the WebRTC setting off pages are untouched, until the switch turns it on', async () => {
  const worker = await freshWorker({ webrtc: false });
  cookieDb(worker);
  const url = viaScramjet(worker, 'https://example.com/');
  assert.equal(await (await request(worker, url, navigate)).text(), SITE_PAGE);
  assert.equal(await (await request(worker, url, navigate)).text(), SITE_PAGE);
  assert.equal(worker.webrtcReads, 1);
  await message(worker, 'WEBRTC', { enabled: true });
  assert.match(await (await request(worker, url, navigate)).text(), /webrtcGuard/);
  // Only Persec's own pages can switch it.
  await message(worker, 'WEBRTC', { enabled: false }, { type: 'window', url: url });
  assert.match(await (await request(worker, url, navigate)).text(), /webrtcGuard/);
  await message(worker, 'WEBRTC', { enabled: false });
  assert.equal(await (await request(worker, url, navigate)).text(), SITE_PAGE);
});

// A window with a stand-in RTCPeerConnection that records the configuration it was given.
function fakeWindow() {
  class RTCPeerConnection {
    static generateCertificate = () => 'cert';
    config: any;
    constructor(config?: any) {
      if (!new.target) throw new TypeError("Please use the 'new' operator");
      this.config = config;
    }
    setConfiguration(config: any) {
      this.config = config;
    }
  }
  const frameWindows: any[] = [];
  class HTMLIFrameElement {
    get contentWindow() {
      return frameWindows[0];
    }
    get contentDocument() {
      return { defaultView: frameWindows[0] };
    }
  }
  const win: any = { HTMLIFrameElement, frameWindows, opened: [] as any[] };
  Object.defineProperty(win, 'RTCPeerConnection', {
    value: RTCPeerConnection,
    writable: true,
    configurable: true,
  });
  win.webkitRTCPeerConnection = RTCPeerConnection;
  win.open = () => win.opened[0];
  return { win, Native: RTCPeerConnection };
}

// Configs are made in the guard's realm, so they're compared as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function runGuard(win: any) {
  vm.runInNewContext(`(${sw.webrtcGuard})()`, { window: win, Object, Reflect, WeakSet, Map });
}

test('Under the guard, peer connections get no servers and may only use relays', () => {
  const { win, Native } = fakeWindow();
  runGuard(win);
  const stun = { iceServers: [{ urls: 'stun:stun.gamestream.nvidia.com:19302' }] };
  const pc = new win.RTCPeerConnection({ ...stun, bundlePolicy: 'max-bundle' });
  assert.deepEqual(plain(pc.config), {
    iceServers: [],
    iceTransportPolicy: 'relay',
    bundlePolicy: 'max-bundle',
  });
  pc.setConfiguration({ ...stun, iceTransportPolicy: 'all' });
  assert.deepEqual(plain(pc.config), { iceServers: [], iceTransportPolicy: 'relay' });
  assert.deepEqual(plain(new win.RTCPeerConnection().config), {
    iceServers: [],
    iceTransportPolicy: 'relay',
  });

  // Still the real thing to the site, with no way back to the unguarded constructor.
  assert.ok(pc instanceof win.RTCPeerConnection);
  assert.equal(win.webkitRTCPeerConnection, win.RTCPeerConnection);
  assert.equal(win.RTCPeerConnection.name, 'RTCPeerConnection');
  assert.equal(win.RTCPeerConnection.generateCertificate(), 'cert');
  assert.notEqual(pc.constructor, Native);
  assert.notEqual(Object.getPrototypeOf(win.RTCPeerConnection), Native);
  assert.throws(() => win.RTCPeerConnection(stun), TypeError);

  // A subclass (adapter.js wraps it this way) is guarded too.
  class Wrapped extends (win.RTCPeerConnection as new (config?: unknown) => { config: unknown }) {}
  const sub = new Wrapped(stun);
  assert.ok(sub instanceof Wrapped);
  assert.deepEqual(plain(sub.config), { iceServers: [], iceTransportPolicy: 'relay' });
});

test('The guard follows into frames and windows the page opens', () => {
  const { win } = fakeWindow();
  const stun = { iceServers: [{ urls: 'stun:example.com' }] };
  const frame = fakeWindow().win;
  const popup = fakeWindow().win;
  win.frameWindows.push(frame);
  win.opened.push(popup);
  runGuard(win);
  const element = new win.HTMLIFrameElement();
  assert.equal(element.contentDocument.defaultView, frame);
  assert.equal(new frame.RTCPeerConnection(stun).config.iceTransportPolicy, 'relay');
  assert.equal(win.open('about:blank'), popup);
  assert.equal(new popup.RTCPeerConnection(stun).config.iceTransportPolicy, 'relay');
});
