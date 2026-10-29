// The person's own tiles on the Games and Apps pages (the "Add your own" card, an idea from
// Interstellar's "Create custom game"). Saved in this browser only, under `customGames` and
// `customApps`. Pure, so the rules can be tested without a browser.
import { cleanName, sameUrl, toWebUrl } from './bookmarks';

export interface CustomTile {
  name: string;
  url: string;
}

export const MAX_CUSTOM_TILES = 100;
const MAX_URL = 2048;

export const customKey = (type: string) => (type === 'games' ? 'customGames' : 'customApps');

// A saved list with anything malformed (an old version, a hand edit) left out.
export function readCustom(saved: unknown): CustomTile[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(t => typeof t?.url === 'string' && toWebUrl(t.url) === t.url)
    .map(t => ({ name: cleanName(t.name, t.url), url: t.url }))
    .slice(0, MAX_CUSTOM_TILES);
}

// Adds a tile from the form. Returns the new list, or throws an Error whose message can be shown.
export function addCustom(list: CustomTile[], input: { name: string; url: string }): CustomTile[] {
  if (input.url.trim().length > MAX_URL) throw new Error('That address is too long.');
  const url = toWebUrl(input.url);
  if (!url) throw new Error('Enter a web address like example.com or https://example.com.');
  if (list.some(t => sameUrl(t.url, url))) throw new Error('You already added that address.');
  if (list.length >= MAX_CUSTOM_TILES) throw new Error(`You can add up to ${MAX_CUSTOM_TILES}.`);
  return [...list, { name: cleanName(input.name, url), url }];
}

export const removeCustom = (list: CustomTile[], url: string) => list.filter(t => t.url !== url);
