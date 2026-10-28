import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEFAULT_LOGO, add, remove } from '../src/utils/bookmarks.ts';
import {
  THEME_SWATCHES,
  MAX_SHORTCUTS,
  PREF_DEFAULTS,
  STARTERS,
  THEMES,
  cleanDisplayName,
  clockParts,
  fillDefaults,
  greeting,
  initial,
  localIcon,
  move,
  nextQuote,
  readPrefs,
  saveShortcut,
  seedBookmarks,
} from '../src/utils/personalize.ts';
import { exportSettings, parseSettings } from '../src/utils/portable.ts';

// Stands in for the browser's settings store; values are copied like IndexedDB does, and the same
// store used again is a reload.
const memory = (initial: Record<string, unknown> = {}) => {
  const m = new Map(Object.entries(structuredClone(initial)));
  return {
    m,
    getItem: async (k: string) => (m.has(k) ? structuredClone(m.get(k)) : null),
    setItem: async (k: string, v: unknown) => m.set(k, structuredClone(v)),
    removeItem: async (k: string) => m.delete(k),
  };
};
const file = (settings: Record<string, unknown>) =>
  JSON.stringify({ format: 'persec-settings', version: 1, settings });
const site = (n: number) => ({
  name: `Site ${n}`,
  logo: DEFAULT_LOGO,
  redir: `https://s${n}.test/`,
});

test('Someone new gets the starter shortcuts once', async () => {
  const s = memory({ bm: [], shortcutsSeeded: false });
  assert.deepEqual(await seedBookmarks(s), STARTERS);
  assert.equal(s.m.get('shortcutsSeeded'), true);
  assert.deepEqual(await seedBookmarks(s), STARTERS, 'a reload changes nothing');
});

test('Removing every shortcut stays that way after a reload', async () => {
  const s = memory({ bm: [], shortcutsSeeded: false });
  let list = await seedBookmarks(s);
  for (const b of list) list = remove(list, b.redir);
  await s.setItem('bm', list);
  assert.deepEqual(await seedBookmarks(s), []);
  // A damaged flag never brings the starters back either.
  await s.setItem('shortcutsSeeded', 'yes');
  assert.deepEqual(await seedBookmarks(s), []);
});

test('Existing bookmarks are kept and the earlier start page tiles join them', async () => {
  const mine = { name: 'Mine', logo: 'data:image/png;base64,AA==', redir: 'https://mine.test/' };
  const s = memory({
    bm: [mine, STARTERS[0]],
    shortcuts: [STARTERS[0], { ...STARTERS[1], redir: 'javascript:alert(1)' }, STARTERS[2]],
    shortcutsSeeded: false,
  });
  assert.deepEqual(await seedBookmarks(s), [STARTERS[2], mine, STARTERS[0]]);
  assert.equal(s.m.has('shortcuts'), false, 'the old list is folded in, then gone');
});

test('Settings added later get their defaults without touching saved ones', async () => {
  const saved = { engine: 'https://search.test/?q=', bm: [site(1)], theme: 'ember' };
  const s = memory(saved);
  await fillDefaults(s, { engine: 'x', bm: [], shortcutsSeeded: false, ...PREF_DEFAULTS });
  assert.equal(s.m.get('engine'), saved.engine);
  assert.deepEqual(s.m.get('bm'), saved.bm);
  assert.equal(s.m.get('theme'), 'ember');
  assert.equal(s.m.get('showClock'), 'on');
  assert.equal(s.m.get('shortcutsSeeded'), false);
});

test('Saved look and clock choices are read back, and bad values fall back to defaults', () => {
  for (const theme of THEMES) assert.equal(readPrefs({ theme }).theme, theme);
  const prefs = {
    displayName: 'Sam',
    theme: 'aurora',
    showClock: 'off',
    showSeconds: 'off',
    timeFormat: '24',
    showQuote: 'off',
  } as const;
  assert.deepEqual(readPrefs(prefs), prefs);
  assert.deepEqual(readPrefs({}), PREF_DEFAULTS);
  assert.deepEqual(
    readPrefs({
      displayName: 'x'.repeat(41),
      theme: 'plaid',
      showClock: true,
      showSeconds: null,
      timeFormat: 24,
      showQuote: '<b>',
    }),
    PREF_DEFAULTS,
  );
});

test('Your own name wins over the invite name, and clearing it brings the invite name back', () => {
  assert.equal(greeting(9, 'Sam', 'Invite Name'), 'Good morning, Sam');
  assert.equal(greeting(14, '', 'Invite Name'), 'Good afternoon, Invite Name');
  assert.equal(greeting(20, '', undefined), 'Good evening');
  assert.equal(cleanDisplayName('  Sam  '), 'Sam');
  assert.equal(cleanDisplayName('   '), '');
  assert.throws(() => cleanDisplayName('x'.repeat(41)), /up to 40/);
  assert.throws(() => cleanDisplayName('a\nb'), /up to 40/);
});

test('The clock shows 12- or 24-hour time', () => {
  const t = new Date(2026, 0, 1, 15, 4, 9);
  assert.deepEqual(clockParts(t, '12'), { hours: '03', minutes: '04', seconds: '09', ampm: 'PM' });
  assert.deepEqual(clockParts(t, '24'), { hours: '15', minutes: '04', seconds: '09', ampm: '' });
  assert.equal(clockParts(new Date(2026, 0, 1, 0, 0), '12').hours, '12');
});

test('Another quote is a different one, and an empty list gives none', () => {
  const quotes = [{ quote: 'a' }, { quote: 'b' }, { quote: '' }, { nope: 1 }];
  assert.equal(
    nextQuote(quotes, 'a', () => 0),
    'b',
  );
  assert.equal(nextQuote([{ quote: 'a' }], 'a'), 'a');
  assert.equal(nextQuote([], 'a'), '');
  assert.equal(nextQuote('not a list', ''), '');
});

test('The quote list ships with the app', async () => {
  const quotes = JSON.parse(
    await readFile(new URL('../public/a/json/quotes.json', import.meta.url), 'utf8'),
  );
  assert.ok(nextQuote(quotes, ''));
});

test('Shortcuts are added, edited and renamed with checked addresses', () => {
  let list = saveShortcut([], { name: ' Tube ', url: 'youtube.com' });
  assert.deepEqual(list, [{ name: 'Tube', logo: STARTERS[0].logo, redir: 'https://youtube.com/' }]);
  list = saveShortcut(list, { name: 'Video', url: 'https://youtube.com/' }, 'https://youtube.com/');
  assert.equal(list[0].name, 'Video');
  assert.equal(list[0].logo, STARTERS[0].logo);
  list = saveShortcut(list, { name: '', url: 'example.org' }, 'https://youtube.com/');
  assert.deepEqual(list, [
    { name: 'example.org', logo: DEFAULT_LOGO, redir: 'https://example.org/' },
  ]);
});

test('Unsafe, malformed, oversized and duplicate shortcuts are refused', () => {
  const list = [site(1)];
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://a.test/',
    'not a url',
    '',
    `https://a.test/${'x'.repeat(2048)}`,
  ]) {
    assert.throws(() => saveShortcut(list, { name: 'x', url }), Error, url.slice(0, 40));
  }
  assert.throws(() => saveShortcut(list, { name: 'x'.repeat(61), url: 'a.test' }), /name/);
  assert.throws(() => saveShortcut(list, { name: 'x', url: 'https://s1.test' }), /already/);
  // Editing one shortcut to another's address is a duplicate too; keeping its own isn't.
  const two = [site(1), site(2)];
  assert.throws(() => saveShortcut(two, { name: 'x', url: 's2.test' }, site(1).redir), /already/);
  assert.equal(saveShortcut(two, { name: 'x', url: 's1.test' }, site(1).redir)[0].name, 'x');
});

test('A shortcut added to a full start page is shown, not hidden among the other bookmarks', () => {
  const full = Array.from({ length: MAX_SHORTCUTS + 3 }, (_, i) => site(i));
  const next = saveShortcut(full, { name: 'New', url: 'new.test' });
  assert.equal(next.length, full.length + 1);
  assert.equal(next[MAX_SHORTCUTS - 1].name, 'New');
  assert.equal(saveShortcut([site(1)], { name: 'New', url: 'new.test' })[1].name, 'New');
});

test('Shortcuts move one place at a time and never off the ends', () => {
  const list = [site(1), site(2), site(3)];
  assert.deepEqual(move(list, 0, 1), [site(2), site(1), site(3)]);
  assert.deepEqual(move(list, 2, -1), [site(1), site(3), site(2)]);
  assert.equal(move(list, 0, -1), list);
  assert.equal(move(list, 2, 1), list);
  assert.equal(move(list, -1, 1), list);
});

test('Tiles without an icon get a letter, and known sites reuse local icons', () => {
  assert.equal(initial({ name: 'example', logo: '', redir: 'https://e.test/' }), 'E');
  assert.equal(initial({ name: '★', logo: '', redir: 'https://www.zeta.test/' }), 'Z');
  assert.equal(localIcon('https://www.github.com/x'), '/a/images/bm/gh.ico');
  assert.equal(localIcon('https://tracker.test/'), DEFAULT_LOGO);
  for (const s of STARTERS) assert.match(s.logo, /^\/a\/images\/bm\//);
});

test('Start page choices move with exported settings and old files still import', () => {
  const prefs = {
    displayName: 'Sam',
    theme: 'minimal',
    showClock: 'off',
    showSeconds: 'off',
    timeFormat: '24',
    showQuote: 'off',
    shortcutsSeeded: true,
  };
  const exported = exportSettings({
    ...prefs,
    bm: [site(1)],
    wispUrl: 'wss://x/',
    inviteCode: 'c',
  });
  assert.equal('wispUrl' in exported.settings, false);
  assert.equal('inviteCode' in exported.settings, false);
  assert.deepEqual(parseSettings(JSON.stringify(exported)), { ...prefs, bm: [site(1)] });

  // A version 1 file from before: no new settings, and the tiles in their own `shortcuts` list.
  assert.deepEqual(
    parseSettings(file({ cloak: 'on', bm: [site(1)], shortcuts: [site(2), site(1)] })),
    {
      cloak: 'on',
      bm: [site(2), site(1)],
    },
  );
});

test('Imported start page settings are checked', () => {
  for (const settings of [
    { theme: 'plaid' },
    { theme: 1 },
    { showClock: true },
    { showSeconds: 'yes' },
    { showQuote: null },
    { timeFormat: 24 },
    { displayName: 'x'.repeat(41) },
    { displayName: '<img src=x onerror=alert(1)>'.repeat(2) },
    { displayName: 'a\u0000b' },
    { displayName: ['Sam'] },
    { shortcutsSeeded: 'true' },
  ]) {
    assert.throws(() => parseSettings(file(settings)), /isn't valid/, JSON.stringify(settings));
  }
});

test('The toolbar star and the start page share one bookmark list', async () => {
  const s = memory({ bm: [], shortcutsSeeded: true });
  // What the address bar's bookmark button saves (navigation.ts) is what the start page reads.
  await s.setItem('bm', add([], { name: 'Docs', redir: 'https://docs.test/' }));
  assert.deepEqual(
    (await seedBookmarks(s)).map(b => b.redir),
    ['https://docs.test/'],
  );
});

test('Start page shortcuts open through the address bar, never around the proxy', async () => {
  const src = await readFile(new URL('../src/utils/shortcuts.ts', import.meta.url), 'utf8');
  assert.match(src, /openInPersec\(b\.redir\)/);
  assert.doesNotMatch(src, /location\.(href|assign|replace)|window\.open|\.href\s*=/);
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  const page = await readFile(new URL('../src/pages/new.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /https?:\/\/(?!www\.w3\.org)/, 'no remote assets on the start page');
});

test('Every theme has a swatch in Customize and its colours in main.css', async () => {
  const css = await readFile(new URL('../src/main.css', import.meta.url), 'utf8');
  assert.deepEqual(
    THEME_SWATCHES.map(t => t.value),
    [...THEMES],
  );
  // Midnight is the :root look; every other theme overrides it.
  for (const theme of THEMES.filter(t => t !== 'midnight')) {
    assert.match(css, new RegExp(`:root\\[data-theme="${theme}"\\] \\{`), theme);
  }
});
