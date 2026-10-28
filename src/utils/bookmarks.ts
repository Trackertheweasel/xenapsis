// Edits to the saved bookmark list (`bm`) and the new-tab shortcuts (`shortcuts`), both lists of
// { name, logo, redir }. Pure, so the same rules apply in the address bar, the bookmarks page and
// the new tab, and so they can be tested without a browser.
import { isWebUrl } from './portable';

export interface Bookmark {
  name: string;
  logo: string;
  redir: string;
}

export const DEFAULT_LOGO = '/a/persec.svg';
const MAX_NAME = 300;

// Two addresses for the same page: a trailing slash or percent-escapes don't make a new bookmark.
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      return decodeURIComponent(u).replace(/\/$/, '');
    } catch {
      return u.replace(/\/$/, '');
    }
  };
  return norm(a) === norm(b);
}

// What someone typed, as a web address: "example.com" becomes "https://example.com/".
// Returns null for anything that isn't an http(s) address.
export function toWebUrl(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(v) ? v : `https://${v}`;
  if (!isWebUrl(withScheme)) return null;
  const url = new URL(withScheme);
  // "https://hello" is a valid URL but not a site anyone means; require a dot or localhost.
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  return url.href;
}

// A blank or missing name falls back to the site's host, so every bookmark has a label.
export function cleanName(name: unknown, redir: string): string {
  const n = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
  if (n) return n;
  try {
    return new URL(redir).hostname;
  } catch {
    return redir.slice(0, MAX_NAME);
  }
}

export const has = (list: Bookmark[], redir: string) => list.some(b => sameUrl(b.redir, redir));

// Adds to the end; a page that's already there is left as it is. Throws on an invalid address.
export function add(list: Bookmark[], b: { name?: string; logo?: string; redir: string }) {
  if (!isWebUrl(b.redir))
    throw new Error('That isn’t a web address (it must start with http or https).');
  if (has(list, b.redir)) return list;
  return [
    ...list,
    { name: cleanName(b.name, b.redir), logo: b.logo || DEFAULT_LOGO, redir: b.redir },
  ];
}

export const remove = (list: Bookmark[], redir: string) =>
  list.filter(b => !sameUrl(b.redir, redir));

export const rename = (list: Bookmark[], redir: string, name: string) =>
  list.map(b => (sameUrl(b.redir, redir) ? { ...b, name: cleanName(name, b.redir) } : b));

// Saved icons are data: URLs or Persec's own files. Anything else (an imported web address) would
// be fetched straight from that site, around the proxy, so it gets Persec's icon instead.
export const safeLogo = (logo: string) =>
  /^data:image\//.test(logo) || /^\/(?!\/)/.test(logo) ? logo : DEFAULT_LOGO;

// For pages inside a Persec tab: the address bar's submit sets the transport and reports failures.
export function openInPersec(url: string) {
  const input = window.parent.document.getElementById('urlbar') as HTMLInputElement | null;
  if (!input) return;
  input.value = url;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}
