import localForage from 'localforage';
import type { Bookmark } from './bookmarks';
import { PREF_DEFAULTS, fillDefaults, seedBookmarks, type Prefs } from './personalize';

interface ConfigDefaults extends Prefs {
  engine: string;
  cloak: 'on' | 'off';
  adBlock: 'on' | 'off';
  cloakTitle: string;
  cloakFavicon: string;
  autoCloak: 'on' | 'off';
  beforeUnload: 'on' | 'off';
  backend: string;
  panicLoc: string;
  panicKey: string;
  wispUrl: string;
  bm: Bookmark[];
  shortcutsSeeded: boolean;
  [key: string]: any;
}

type ConfigKey = string;

const isBrowser = typeof location !== 'undefined';

export function wispUrl(): string {
  if (!isBrowser) return '';
  const isHttps = location.protocol === 'https:';
  // WISP_PATH is injected at build time (see astro.config.ts) and must match the path the
  // server listens on. Defaults to '/w/' when PUBLIC_PERSEC_WISP_PATH is unset.
  const path = typeof WISP_PATH === 'string' && WISP_PATH ? WISP_PATH : '/w/';
  return `${isHttps ? 'wss' : 'ws'}://${location.host}${path}`;
}

const defaults: ConfigDefaults = {
  engine: 'https://duckduckgo.com/?q=',
  cloak: 'off',
  adBlock: 'on',
  cloakTitle: 'Google',
  cloakFavicon: 'https://www.google.com/favicon.ico',
  autoCloak: 'off',
  beforeUnload: 'off',
  backend: 'sc',
  panicLoc: 'https://google.com',
  panicKey: '`',
  wispUrl: wispUrl(),
  bm: [],
  // Whether the start page's first tiles have been added to `bm` (see loadBookmarks).
  shortcutsSeeded: false,
  ...PREF_DEFAULTS,
};

const store = localForage.createInstance({
  name: 'PersecDB',
  storeName: 'Settings',
});

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await fillDefaults(store, defaults);
  initialized = true;
}

const ConfigAPI = {
  config: store,

  async get(key: ConfigKey): Promise<any | null> {
    await ensureInit();
    return store.getItem(key);
  },

  async set(key: ConfigKey, value: any): Promise<any> {
    await ensureInit();
    return store.setItem(key, value);
  },

  async getIndecator(key: ConfigKey): Promise<any> {
    await ensureInit();
    const value = await store.getItem(key);
    if (value != null) return value;
    return defaults[key] ?? null;
  },

  async init(): Promise<void> {
    initialized = false;
    await ensureInit();
  },

  async reset(): Promise<void> {
    await store.clear();
    initialized = false;
    await ensureInit();
  },

  async getAll(): Promise<Record<string, any>> {
    await ensureInit();
    const keys = await store.keys();

    const entries = await Promise.all(
      keys.map(async function (key) {
        const value = await store.getItem(key);
        return [key, value] as const;
      }),
    );

    return Object.fromEntries(entries);
  },
};

// The saved bookmarks, which are also the start page's tiles (see seedBookmarks).
export async function loadBookmarks(): Promise<Bookmark[]> {
  await ensureInit();
  return seedBookmarks(store);
}

export default ConfigAPI;
