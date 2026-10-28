import assert from 'node:assert/strict';
import test from 'node:test';
import {
  add,
  cleanName,
  DEFAULT_LOGO,
  has,
  remove,
  rename,
  safeLogo,
  toWebUrl,
} from '../src/utils/bookmarks.ts';
import { parseSettings } from '../src/utils/portable.ts';

const page = { name: 'Example', logo: 'data:image/png;base64,AA==', redir: 'https://example.com/' };

test('Adding a page that is already saved, by any spelling, keeps one bookmark', () => {
  const list = add([], page);
  assert.equal(add(list, { ...page, redir: 'https://example.com' }), list);
  assert.equal(add(list, { ...page, redir: 'https://example.com/%7E' }).length, 2);
  assert.ok(has(list, 'https://example.com'));
});

test('A bookmark always has a name and an icon, and only web addresses are saved', () => {
  const [b] = add([], { name: '   ', redir: 'https://news.test/a' });
  assert.equal(b.name, 'news.test');
  assert.equal(b.logo, DEFAULT_LOGO);
  assert.equal(cleanName('x'.repeat(400), 'https://a.test/').length, 300);
  for (const redir of ['javascript:alert(1)', 'data:text/html,hi', 'not a url']) {
    assert.throws(() => add([], { redir }), /isn’t a web address/, redir);
  }
});

test('Rename and remove change only the matching bookmark', () => {
  const other = { ...page, name: 'Other', redir: 'https://other.test/' };
  const list = [page, other];
  assert.deepEqual(rename(list, 'https://example.com', 'Mine'), [{ ...page, name: 'Mine' }, other]);
  assert.deepEqual(rename(list, page.redir, ''), [{ ...page, name: 'example.com' }, other]);
  assert.deepEqual(remove(list, 'https://example.com'), [other]);
});

test('Typed addresses become web addresses; anything else is refused', () => {
  assert.equal(toWebUrl(' example.com '), 'https://example.com/');
  assert.equal(toWebUrl('http://a.test/x?y=1'), 'http://a.test/x?y=1');
  for (const v of ['', 'hello', 'javascript:alert(1)', 'ftp://a.test/', 'file:///etc/passwd']) {
    assert.equal(toWebUrl(v), null, v);
  }
});

test('Only saved or local icons are shown, so no icon is fetched around the proxy', () => {
  assert.equal(safeLogo(page.logo), page.logo);
  assert.equal(safeLogo('/a/images/bm/yt.png'), '/a/images/bm/yt.png');
  for (const logo of ['https://tracker.test/x.png', '//evil.test/x.png', '']) {
    assert.equal(safeLogo(logo), DEFAULT_LOGO, logo);
  }
});

test('Old files’ new tab shortcuts import as bookmarks and are checked like them', () => {
  const file = (settings: Record<string, unknown>) =>
    JSON.stringify({ format: 'persec-settings', version: 1, settings });
  assert.deepEqual(parseSettings(file({ shortcuts: [page] })), { bm: [page] });
  assert.throws(
    () => parseSettings(file({ shortcuts: [{ ...page, redir: 'javascript:alert(1)' }] })),
    /"shortcuts" setting isn't valid/,
  );
});
