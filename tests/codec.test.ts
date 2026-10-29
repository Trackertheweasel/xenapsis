import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUrl, encodeUrl } from '../src/utils/codec.ts';

// Replaced with a literal at build time; a global stands in for it here.
(globalThis as any).URL_KEY = 'test-key';

const urls = [
  'https://example.com/',
  'https://www.google.com/search?q=a%2Bb&hl=en#top',
  'https://例え.jp/パス?q=ü',
  'https://example.com/' + 'x'.repeat(100_000),
];

test('Proxied URLs round-trip and do not reveal the real URL', () => {
  for (const url of urls) {
    const encoded = encodeUrl(url);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'only URL-safe characters');
    assert.ok(!encoded.includes('http') && !encoded.includes('aHR0c'), 'no plain or base64 "http"');
    assert.equal(decodeUrl(encoded), url);
  }
});

test('A different key gives different URLs', () => {
  const a = encodeUrl(urls[0]);
  (globalThis as any).URL_KEY = 'other-key';
  assert.notEqual(encodeUrl(urls[0]), a);
  (globalThis as any).URL_KEY = 'test-key';
});

test('Decoding keeps a query a GET form appended, and survives garbage', () => {
  assert.equal(decodeUrl(encodeUrl('https://example.com/s') + '?q=1'), 'https://example.com/s?q=1');
  assert.equal(decodeUrl('not*base64'), 'not*base64');
  assert.equal(decodeUrl(''), '');
});

// Scramjet 1.1.0's unrewriteUrl (src/shared/rewriters/url.ts), which the service worker runs on
// every request URL and on the requesting page's URL. It decodes the fragment first and passes it
// back to the codec behind the encoded URL. Request URLs keep their fragment in a service worker.
const scramjetRewrite = (url: string) => {
  const real = new URL(url);
  const hash = encodeUrl(real.hash.slice(1));
  real.hash = '';
  return encodeUrl(real.href) + (hash ? '#' + hash : '');
};
const scramjetUnrewrite = (proxied: string) => {
  const real = new URL(proxied, 'https://persec.test/');
  const hash = decodeUrl(real.hash.slice(1));
  return decodeUrl(real.pathname.slice(1) + (hash ? '#' + hash : ''));
};

test('URLs with a #fragment survive the round trip through Scramjet', () => {
  for (const url of [
    'https://play.geforcenow.com/mall/#/layout/games',
    'https://example.com/a?b=c#/route?x=1&y=#z',
    'https://example.com/#',
    ...urls,
  ]) {
    const back = scramjetUnrewrite('/' + scramjetRewrite(url));
    assert.equal(new URL(back).href, new URL(url).href.replace(/#$/, ''));
  }
});

test('A GET form query and a fragment both survive decoding', () => {
  assert.equal(
    decodeUrl(encodeUrl('https://example.com/s') + '?q=1#/top?a'),
    'https://example.com/s?q=1#/top?a',
  );
});

// A page that sets location.hash itself leaves a plain fragment in its address, which Scramjet
// still runs through the codec on its own. "/route?x=1" is valid base64 up to the "?", so it used to
// come back as garbage and hash-routed pages saw the wrong route.
test('A fragment the page set itself survives Scramjet as it is', () => {
  const page = '/' + encodeUrl('https://app.example.com/') + '#/route?x=1';
  assert.equal(scramjetUnrewrite(page), 'https://app.example.com/#/route?x=1');
});

test('A fragment is never scrambled, and never decoded as an address', () => {
  for (const fragment of [
    'top',
    '/route?x=1',
    'access_token=abc&state=xyz',
    'QxQ6EAM8Og4NWg',
    'abcd',
  ]) {
    assert.equal(encodeUrl(fragment), fragment);
    assert.equal(decodeUrl(fragment), fragment);
  }
  // Every short base64 string decodes to bytes; none of them is taken for an address.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const a of chars)
    for (const b of chars) for (const c of 'Aa0-') assert.equal(decodeUrl(a + b + c), a + b + c);
});
