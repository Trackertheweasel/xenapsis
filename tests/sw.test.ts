import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { uvConfigSource } from '../src/pages/tmp/config.js.ts';

const origin = 'https://persec.test';

// Build-time constant (see astro.config.ts): uvConfigSource() reads UV_PREFIX as it generates the
// config source here in Node. URL_KEY, which the embedded codec reads, is set on the worker ctx below.
(globalThis as any).UV_PREFIX = '/v1/tmp/';

// Runs public/sw.js with the proxy engines stubbed out, exposing its functions.
async function loadServiceWorker() {
  const ctx: any = {
    URL,
    URL_KEY: 'test-key',
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    console,
    location: { origin },
    addEventListener: () => {},
    importScripts: () => {},
    $scramjetLoadWorker: () => ({
      ScramjetServiceWorker: class {
        config = { prefix: '/v1/data/' };
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
    UVServiceWorker: class {},
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(uvConfigSource(), ctx);
  vm.runInContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), ctx);
  return ctx;
}

const sw = await loadServiceWorker();
const scramjet = (url: string) => `${origin}/v1/data/${sw.__uv$config.encodeUrl(url)}`;
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
