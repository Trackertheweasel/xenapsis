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

// Scramjet encodes a page's #fragment on its own, and decodes "<encoded URL>#<decoded fragment>"
// (and a fragment on its own), so a page reached through a sign-in redirect with #access_token=...,
// or a school app with hash routes, made every request after it fail with "Invalid URL".
test('A #fragment after the encoded URL is kept as it is, ? and all', () => {
  const encoded = encodeUrl('https://play.example.com/app');
  assert.equal(decodeUrl(encoded + '#/route?x=1'), 'https://play.example.com/app#/route?x=1');
  assert.equal(decodeUrl(encoded + '#top'), 'https://play.example.com/app#top');
  assert.equal(
    decodeUrl(encoded + '?q=1#access_token=abc'),
    'https://play.example.com/app?q=1#access_token=abc',
  );
  assert.ok(URL.canParse(decodeUrl(encoded + '#QxQ6EAM8Og4NWg')));
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
