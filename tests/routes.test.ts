import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installDom } from './dom.ts';

const dom = installDom();
const { INTERNAL_ROUTES, internalName, internalPath } = await import('../src/utils/routes.ts');
const { decodeProxyUrl, encodeProxyUrl } = await import('../src/utils/pro.ts');

after(() => dom.close());

test("persec:// names and Persec's own paths map both ways", () => {
  for (const [name, path] of Object.entries(INTERNAL_ROUTES)) {
    assert.equal(internalPath(name), path);
    assert.equal(internalName(path), name);
  }
  assert.equal(internalPath('persec://nope'), undefined);
  assert.equal(internalName('/somewhere'), undefined);
});

test('Only real route names count, not what every object has', () => {
  assert.equal(internalPath('constructor'), undefined);
  assert.equal(internalPath('toString'), undefined);
});

test('Each engine encodes under its own prefix, and either decodes whatever it was opened with', () => {
  const url = 'https://example.com/a?q=a%2Bb';
  const sc = encodeProxyUrl(url, 'sc');
  const uv = encodeProxyUrl(url, 'u');
  assert.ok(sc.startsWith(dom.paths.scPrefix));
  assert.ok(uv.startsWith(dom.paths.uvPrefix));
  assert.equal(encodeProxyUrl(url, null), sc, 'Scramjet is the default');
  assert.equal(decodeProxyUrl(sc), url);
  assert.equal(decodeProxyUrl(`https://persec.test${uv}`), url);
  assert.equal(decodeProxyUrl('/st'), '', 'not a proxied address');
});
