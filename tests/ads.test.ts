import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';
import { creativeFor, getCurrentAd, recordClick, recordImpression } from '../src/utils/ads.ts';

// A 1x1 PNG the fake network serves as its creative.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const CLICK_TARGET = 'https://advertiser.example/landing';

let server: http.Server;
let base = '';
let impressionHits = 0;

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
