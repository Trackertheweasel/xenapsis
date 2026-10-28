// The start page's personal touches: name, theme, clock, quote and shortcuts. Pure, or given the
// settings store, so the rules can be tested without a browser. Everything here is saved in this
// browser only (config.ts), never sent.
import { add, has, sameUrl, toWebUrl, DEFAULT_LOGO, type Bookmark } from './bookmarks';
import { isWebUrl } from './portable';

export const THEMES = ['midnight', 'aurora', 'ember', 'minimal'] as const;
export type Theme = (typeof THEMES)[number];
export const MAX_DISPLAY_NAME = 40;
export const MAX_SHORTCUT_NAME = 60;
// Two rows of six on a wide screen; the rest of the bookmarks stay on the bookmarks page.
export const MAX_SHORTCUTS = 12;

export interface Prefs {
  displayName: string;
  theme: Theme;
  showClock: 'on' | 'off';
  showSeconds: 'on' | 'off';
  timeFormat: '12' | '24';
  showQuote: 'on' | 'off';
}

export const PREF_DEFAULTS: Prefs = {
  displayName: '',
  theme: 'midnight',
  showClock: 'on',
  showSeconds: 'on',
  timeFormat: '12',
  showQuote: 'on',
};

// The start page's tiles for someone new: Persec's own icons, so nothing is fetched.
export const STARTERS: Bookmark[] = [
  { name: 'YouTube', redir: 'https://youtube.com/', logo: '/a/images/bm/yt.png' },
  { name: 'X', redir: 'https://x.com/', logo: '/a/images/bm/x.svg' },
  { name: 'GitHub', redir: 'https://github.com/', logo: '/a/images/bm/gh.ico' },
  { name: 'Discord', redir: 'https://discord.com/', logo: '/a/images/bm/disc.ico' },
  { name: 'Google', redir: 'https://google.com/', logo: '/a/images/bm/goo.ico' },
  { name: 'Wikipedia', redir: 'https://wikipedia.org/', logo: '/a/images/bm/wiki.png' },
];

const onOff = (v: unknown): v is 'on' | 'off' => v === 'on' || v === 'off';
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isDisplayName = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_DISPLAY_NAME && !CONTROL.test(v);
export const isTheme = (v: unknown): v is Theme => THEMES.includes(v as Theme);

// What's saved, with anything missing or malformed (an old version, a hand edit) as its default.
export function readPrefs(saved: Record<string, unknown>): Prefs {
  return {
    displayName: isDisplayName(saved.displayName)
      ? saved.displayName.trim()
      : PREF_DEFAULTS.displayName,
    theme: isTheme(saved.theme) ? saved.theme : PREF_DEFAULTS.theme,
    showClock: onOff(saved.showClock) ? saved.showClock : PREF_DEFAULTS.showClock,
    showSeconds: onOff(saved.showSeconds) ? saved.showSeconds : PREF_DEFAULTS.showSeconds,
    timeFormat:
      saved.timeFormat === '12' || saved.timeFormat === '24'
        ? saved.timeFormat
        : PREF_DEFAULTS.timeFormat,
    showQuote: onOff(saved.showQuote) ? saved.showQuote : PREF_DEFAULTS.showQuote,
  };
}

// A name typed in Customize: trimmed, or an Error whose message can be shown.
export function cleanDisplayName(input: string): string {
  const name = input.trim();
  if (!isDisplayName(name))
    throw new Error(`Use up to ${MAX_DISPLAY_NAME} letters, numbers or symbols.`);
  return name;
}

// The name someone chose here wins over their invite's name; with neither, just the time of day.
export function greeting(hour: number, displayName: string, inviteName: unknown): string {
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const name = displayName || (typeof inviteName === 'string' ? inviteName.trim() : '');
  return name ? `Good ${part}, ${name}` : `Good ${part}`;
}

export function clockParts(now: Date, timeFormat: Prefs['timeFormat']) {
  const h = now.getHours();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return {
    hours: pad(timeFormat === '24' ? h : h % 12 || 12),
    minutes: pad(now.getMinutes()),
    seconds: pad(now.getSeconds()),
    ampm: timeFormat === '24' ? '' : h >= 12 ? 'PM' : 'AM',
  };
}

// Another quote than the one showing, when there is another.
export function nextQuote(quotes: unknown, current: string, rand = Math.random): string {
  const all = Array.isArray(quotes)
    ? quotes.map(q => q?.quote).filter((q): q is string => typeof q === 'string' && !!q.trim())
    : [];
  const others = all.filter(q => q !== current);
  if (!others.length) return all[0] ?? '';
  return others[Math.floor(rand() * others.length)];
}

// The letter shown on a tile with no icon of its own: drawn here, nothing fetched.
export function initial(b: Bookmark): string {
  const from = (s: string) => s.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase();
  let host = '';
  try {
    host = new URL(b.redir).hostname.replace(/^www\./, '');
  } catch {}
  return from(b.name) || from(host) || '?';
}

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// A starter site's local icon when the address is on that site, otherwise none (the letter).
export const localIcon = (redir: string) =>
  STARTERS.find(s => host(s.redir) === host(redir))?.logo ?? DEFAULT_LOGO;

// Adds (no `editing`) or changes (`editing` is the shortcut's current address) a shortcut from the
// start page's form. Returns the new list, or throws an Error whose message can be shown.
export function saveShortcut(
  list: Bookmark[],
  input: { name: string; url: string },
  editing?: string,
): Bookmark[] {
  if (input.name.trim().length > MAX_SHORTCUT_NAME)
    throw new Error(`Keep the name under ${MAX_SHORTCUT_NAME} characters.`);
  if (input.url.trim().length > 2048) throw new Error('That address is too long.');
  const redir = toWebUrl(input.url);
  if (!redir) throw new Error('Enter a web address like example.com or https://example.com.');
  const others = editing === undefined ? list : list.filter(b => !sameUrl(b.redir, editing));
  if (has(others, redir)) throw new Error('You already have a shortcut to that address.');

  if (editing === undefined) {
    // Put last among the shown tiles, so a long bookmark list doesn't hide it.
    const [added] = add([], { name: input.name, logo: localIcon(redir), redir });
    const at = Math.min(list.length, MAX_SHORTCUTS - 1);
    return [...list.slice(0, at), added, ...list.slice(at)];
  }
  return list.map(b => {
    if (!sameUrl(b.redir, editing)) return b;
    const [edited] = add([], {
      name: input.name,
      // The old icon belongs to the old address.
      logo: sameUrl(b.redir, redir) ? b.logo : localIcon(redir),
      redir,
    });
    return edited;
  });
}

// Moves the shortcut at `from` by `by` places (−1 earlier, +1 later), staying in the list.
export function move(list: Bookmark[], from: number, by: number): Bookmark[] {
  const to = from + by;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const out = [...list];
  [out[from], out[to]] = [out[to], out[from]];
  return out;
}

// Once per browser: the start page's earlier shortcuts (or the starters, for someone new) go in
// front of the saved bookmarks, which from then on are the start page's tiles. Saved bookmarks are
// kept exactly as they are; earlier shortcuts that are malformed or already bookmarked are skipped.
export function seedShortcuts(bm: unknown, previous: unknown): Bookmark[] {
  const saved: Bookmark[] = Array.isArray(bm) ? bm : [];
  const extra = (Array.isArray(previous) ? previous : []).reduce<Bookmark[]>(
    (list, b) =>
      typeof b?.name === 'string' &&
      typeof b.logo === 'string' &&
      isWebUrl(b.redir) &&
      !has(list, b.redir) &&
      !has(saved, b.redir)
        ? [...list, { name: b.name, logo: b.logo, redir: b.redir }]
        : list,
    [],
  );
  return [...extra, ...saved];
}

interface Store {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

// Saves the default for every setting that has none yet, so settings added in a later version
// reach browsers that set up Persec before. Saved values are never touched.
export async function fillDefaults(s: Store, defaults: Record<string, unknown>): Promise<void> {
  await Promise.all(
    Object.keys(defaults).map(async key => {
      if ((await s.getItem(key)) == null) await s.setItem(key, defaults[key]);
    }),
  );
}

// The saved bookmarks. The first time, the start page's earlier `shortcuts` list (or the
// starters, for someone new) joins them; after that an emptied list stays empty.
export async function seedBookmarks(s: Store): Promise<Bookmark[]> {
  const bm = await s.getItem('bm');
  // Anything but a saved `false` counts as done, so a damaged value never brings back the starters.
  if ((await s.getItem('shortcutsSeeded')) !== false) return Array.isArray(bm) ? bm : [];
  const seeded = seedShortcuts(bm, (await s.getItem('shortcuts')) ?? STARTERS);
  await s.setItem('bm', seeded);
  await s.setItem('shortcutsSeeded', true);
  await s.removeItem('shortcuts');
  return seeded;
}
