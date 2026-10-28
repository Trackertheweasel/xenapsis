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
