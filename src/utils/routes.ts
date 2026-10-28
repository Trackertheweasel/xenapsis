// Persec's own pages, by the persec:// name the address bar shows for them. The tab strip
// (tb.ts) and the address bar (navigation.ts) both read this, so a page is added in one place.
export const INTERNAL_ROUTES: Readonly<Record<string, string>> = {
  'persec://settings': '/st',
  'persec://new': '/new',
  'persec://games': '/math',
  'persec://apps': '/sci',
  'persec://privacy': '/privacy',
  'persec://bookmarks': '/bm',
};

// The path a persec:// name opens, or undefined for anything else.
export function internalPath(name: string): string | undefined {
  return Object.hasOwn(INTERNAL_ROUTES, name) ? INTERNAL_ROUTES[name] : undefined;
}

// The persec:// name of one of Persec's own paths, or undefined for anything else.
export function internalName(path: string): string | undefined {
  return Object.entries(INTERNAL_ROUTES).find(([, p]) => p === path)?.[0];
}
