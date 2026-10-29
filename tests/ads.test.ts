import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  creativeFor,
  getCurrentAd,
  recordClick,
  recordImpression,
  resetAdCache,
} from '../serverlib/ads.ts';
import { buildApp } from '../serverlib/app.ts';
import { deployPaths } from '../serverlib/env.ts';

// A 1x1 PNG the fake network serves as its creative.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const CLICK_TARGET = 'https://advertiser.example/landing';

let server: http.Server;
let base = '';
let impressionHits = 0;
let emptyHits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/decision') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'Acme',
          text: 'Buy things',
          image: `${base}/img.png`,
          click: CLICK_TARGET,
          impression: `${base}/imp`,
        }),
      );
    } else if (req.url === '/empty') {
      emptyHits++;
      res.statusCode = 204;
      res.end();
    } else if (req.url === '/img.png') {
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
    } else if (req.url === '/imp') {
      impressionHits++;
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

test('a network ad is fetched once and served entirely through Persec', async () => {
  process.env.PERSEC_AD_NETWORK = 'generic';
  process.env.PERSEC_AD_API_URL = `${base}/decision`;

  const ad = await getCurrentAd();
  assert.equal(ad?.kind, 'network');
  if (!ad || ad.kind !== 'network') return;

  // The creative is cached on this server and served from our own origin, byte for byte.
  const creative = creativeFor(ad.id);
  assert.ok(creative, 'creative is cached');
  assert.match(creative!.type, /^image\//);
  assert.ok(creative!.buf.equals(PNG), 'cached bytes match the network creative');

  // A view fires the network's impression callback from the server, not the browser.
  await recordImpression(ad.id);
  assert.equal(impressionHits, 1, 'impression recorded server-side');
  // It only fires once per ad, however many times the pixel is loaded.
  await recordImpression(ad.id);
  assert.equal(impressionHits, 1, 'impression is not double-counted');

  // A click resolves to the advertiser, so the redirect never touches the network.
  assert.equal(await recordClick(ad.id), CLICK_TARGET);
});

test('the server serves the ad routes and hands pages the same ad slot', async () => {
  process.env.PERSEC_AD_NETWORK = 'generic';
  process.env.PERSEC_AD_API_URL = `${base}/decision`;
  let pageLocals: any;
  const app = await buildApp({
    access: null,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
    site: {
      clientRoot: await mkdtemp(path.join(tmpdir(), 'persec-client-')),
      // Stands in for Astro's handler: renders the ad the way Sponsor.astro asks for it.
      handler: async (_req, res, _next, locals) => {
        pageLocals = locals;
        const ad = await locals?.ads?.getCurrentAd();
        res.end(ad?.kind === 'network' ? ad.id : '');
      },
      paths: deployPaths('test-key'),
    },
  });

  const id = (await app.inject({ url: '/new' })).body;
  assert.ok(pageLocals?.ads, 'pages get the ad slot as locals.ads');
  assert.ok(id, 'the page rendered a network ad');

  const img = await app.inject({ url: `/a/ad/img/${id}` });
  assert.equal(img.statusCode, 200);
  assert.match(img.headers['content-type'] as string, /^image\//);
  assert.ok(img.rawPayload.equals(PNG), 'the creative the page points at is the one cached');
  assert.equal(img.headers['cache-control'], 'private, max-age=300');

  const px = await app.inject({ url: `/a/ad/px/${id}` });
  assert.equal(px.statusCode, 200);
  assert.equal(px.headers['content-type'], 'image/gif');

  const click = await app.inject({ url: `/a/ad/click/${id}` });
  assert.equal(click.statusCode, 302);
  assert.equal(click.headers.location, CLICK_TARGET);

  assert.equal((await app.inject({ url: '/a/ad/img/nope' })).statusCode, 404);
  const unknown = await app.inject({ url: '/a/ad/click/nope' });
  assert.equal(unknown.statusCode, 302);
  assert.equal(unknown.headers.location, '/new', 'an unknown click goes home, not anywhere');
});

test('an unknown ad id is handled safely', async () => {
  assert.equal(creativeFor('nope'), undefined);
  assert.equal(await recordClick('nope'), null);
});

test('falls back to the self-served sponsor list when no network is configured', async () => {
  delete process.env.PERSEC_AD_NETWORK;
  delete process.env.PERSEC_AD_API_URL;
  // sponsors.json ships a single disabled example, so with nothing enabled there is no card.
  assert.equal(await getCurrentAd(), null);
});

test('a network with no ad to show is not asked again on every page', async () => {
  resetAdCache();
  process.env.PERSEC_AD_NETWORK = 'generic';
  process.env.PERSEC_AD_API_URL = `${base}/empty`;
  await getCurrentAd();
  await getCurrentAd();
  await getCurrentAd();
  assert.equal(emptyHits, 1, 'the next pages get the static list without waiting on the network');
  resetAdCache();
  await getCurrentAd();
  assert.equal(emptyHits, 2, 'it asks again once the pause is over');
  delete process.env.PERSEC_AD_NETWORK;
  delete process.env.PERSEC_AD_API_URL;
});

// astro.config.ts prefetches every link on a page; a prefetched click route counts a click.
test('the ad link is never prefetched', async () => {
  const source = await readFile(
    new URL('../src/components/Sponsor.astro', import.meta.url),
    'utf8',
  );
  assert.match(source, /<a\s[^>]*data-astro-prefetch="false"/);
});
