import assert from 'node:assert/strict';
import test from 'node:test';
import { exportSettings, mergeBookmarks, parseSettings } from '../src/utils/portable.ts';

const bookmark = {
  name: 'Example',
  logo: 'data:image/png;base64,AA==',
  redir: 'https://example.com/',
};
const saved = {
  engine: 'https://duckduckgo.com/?q=',
  cloak: 'on',
  cloakFavicon: '/a/images/co/go.ico',
  backend: 'u',
  panicKey: '`',
  wispUrl: 'wss://old.test/w/',
  bm: [bookmark],
};

test('Exported settings import back, without the tunnel address', () => {
  const file = exportSettings(saved);
  assert.equal('wispUrl' in file.settings, false, 'specific to one server');
  assert.deepEqual(parseSettings(JSON.stringify(file)), {
    engine: saved.engine,
    cloak: 'on',
    cloakFavicon: '/a/images/co/go.ico',
    backend: 'u',
    panicKey: '`',
    bm: [bookmark],
  });
});

test('An imported file never sets the tunnel or anything unchecked', () => {
  const file = (settings: Record<string, unknown>) =>
    JSON.stringify({ format: 'persec-settings', version: 1, settings });
  assert.deepEqual(parseSettings(file({ wispUrl: 'wss://evil.test/', extra: 1 })), {});
  for (const settings of [
    { cloak: 'yes' },
    { backend: 'other' },
    { engine: 'javascript:alert(1)' },
    { panicLoc: 'data:text/html,hi' },
    { cloakFavicon: 'javascript:alert(1)' },
    { bm: [{ ...bookmark, redir: 'javascript:alert(1)' }] },
    { bm: [{ ...bookmark, logo: 'javascript:alert(1)' }] },
    { bm: [{ ...bookmark, logo: '//evil.test/x.png' }] },
    { bm: 'not a list' },
    { bm: Array(1001).fill(bookmark) },
  ]) {
    assert.throws(() => parseSettings(file(settings)), /isn't valid/, JSON.stringify(settings));
  }
  assert.throws(() => parseSettings('{'), /isn't a Persec settings file/);
  assert.throws(() => parseSettings('{"format":"other"}'), /isn't a Persec settings file/);
});

test('Importing bookmarks keeps the ones already there', () => {
  const other = { ...bookmark, redir: 'https://other.test/' };
  assert.deepEqual(mergeBookmarks([bookmark], [bookmark, other, other]), [bookmark, other]);
});
