// Settings and bookmarks a person can carry to another Persec address. Browsers keep storage per
// address, so a backup server or a new domain starts empty; an exported file is the way across.
// An imported file comes from outside, so every value is checked. The tunnel address (wispUrl) is
// never carried: it is specific to one server, and a file that set it could send all of someone's
// traffic to a server of the sender's choosing. Nothing tied to the invite (codes, the saved-logins
// key) is a setting here, so none of it can be exported.
import { isDisplayName, isTheme } from './personalize';

const FORMAT = 'persec-settings';
const TOGGLES = [
  'cloak',
  'adBlock',
  'autoCloak',
  'beforeUnload',
  'tabSwitchCloak',
  'showClock',
  'showSeconds',
  'showQuote',
];
const URLS = ['engine', 'panicLoc'];
const MAX_BOOKMARKS = 1000;

interface Bookmark {
  name: string;
  logo: string;
  redir: string;
}

export const isWebUrl = (v: unknown) => {
  try {
    return typeof v === 'string' && v.length <= 2048 && /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
};
const isText = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
// Favicons are saved as data: URLs; local paths and web addresses are allowed too, nothing else.
const isLogo = (v: unknown) =>
  isText(v, 200_000) &&
  (/^data:image\//.test(v as string) || /^\/(?!\/)/.test(v as string) || isWebUrl(v));

export function exportSettings(all: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  for (const key of [
    ...TOGGLES,
    ...URLS,
    'cloakTitle',
    'cloakFavicon',
    'panicKey',
    'backend',
    'bm',
    'shortcutsSeeded',
    'displayName',
    'theme',
    'timeFormat',
  ]) {
    if (all[key] != null) settings[key] = all[key];
  }
  return { format: FORMAT, version: 1, exported: new Date().toISOString(), settings };
}

// Returns the settings to save, or throws an Error whose message can be shown to the person.
export function parseSettings(text: string): Record<string, unknown> {
  let file: any;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a Persec settings file.");
  }
  if (file?.format !== FORMAT || file.version !== 1 || typeof file.settings !== 'object') {
    throw new Error("That file isn't a Persec settings file.");
  }
  const s = file.settings ?? {};
  const out: Record<string, unknown> = {};
  const bad = (key: string) => new Error(`The file's "${key}" setting isn't valid.`);

  for (const key of TOGGLES) {
    if (s[key] === undefined) continue;
    if (s[key] !== 'on' && s[key] !== 'off') throw bad(key);
    out[key] = s[key];
  }
  for (const key of URLS) {
    if (s[key] === undefined) continue;
    if (!isWebUrl(s[key])) throw bad(key);
    out[key] = s[key];
  }
  if (s.cloakTitle !== undefined) {
    if (!isText(s.cloakTitle, 200)) throw bad('cloakTitle');
    out.cloakTitle = s.cloakTitle;
  }
  // The cloak presets in Settings use local icons (/a/images/co/...).
  if (s.cloakFavicon !== undefined) {
    if (!isLogo(s.cloakFavicon)) throw bad('cloakFavicon');
    out.cloakFavicon = s.cloakFavicon;
  }
  if (s.panicKey !== undefined) {
    if (!isText(s.panicKey, 64)) throw bad('panicKey');
    out.panicKey = s.panicKey;
  }
  if (s.backend !== undefined) {
    if (s.backend !== 'sc' && s.backend !== 'u') throw bad('backend');
    out.backend = s.backend;
  }
  if (s.displayName !== undefined) {
    if (!isDisplayName(s.displayName)) throw bad('displayName');
    out.displayName = s.displayName.trim();
  }
  if (s.theme !== undefined) {
    if (!isTheme(s.theme)) throw bad('theme');
    out.theme = s.theme;
  }
  if (s.timeFormat !== undefined) {
    if (s.timeFormat !== '12' && s.timeFormat !== '24') throw bad('timeFormat');
    out.timeFormat = s.timeFormat;
  }
  if (s.shortcutsSeeded !== undefined) {
    if (typeof s.shortcutsSeeded !== 'boolean') throw bad('shortcutsSeeded');
    out.shortcutsSeeded = s.shortcutsSeeded;
  }
  // Files from before the start page used the bookmarks carry its tiles as `shortcuts`.
  const lists: Record<string, Bookmark[]> = {};
  for (const key of ['bm', 'shortcuts']) {
    if (s[key] === undefined) continue;
    if (!Array.isArray(s[key]) || s[key].length > MAX_BOOKMARKS) throw bad(key);
    lists[key] = s[key].map((b: any): Bookmark => {
      if (!isText(b?.name, 300) || !isLogo(b.logo) || !isWebUrl(b.redir)) throw bad(key);
      return { name: b.name, logo: b.logo, redir: b.redir };
    });
  }
  if (lists.bm || lists.shortcuts) out.bm = mergeBookmarks(lists.shortcuts ?? [], lists.bm ?? []);
  return out;
}

// Bookmarks are added to the ones already here, so importing never loses any.
export function mergeBookmarks(current: Bookmark[], incoming: Bookmark[]): Bookmark[] {
  const seen = new Set(current.map(b => b.redir));
  return [...current, ...incoming.filter(b => !seen.has(b.redir) && seen.add(b.redir))];
}
