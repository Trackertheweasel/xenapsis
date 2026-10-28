import localForage from 'localforage';
import type { Bookmark } from './bookmarks';
import type { Consent } from './loginsync';
import type { Backend } from './pro';
import { PREF_DEFAULTS, fillDefaults, seedBookmarks, type Prefs } from './personalize';

type OnOff = 'on' | 'off';

// Every setting Persec saves, with its type: the one list to add a setting to. Those with a default
// are filled in on first use (see `defaults` below); the rest stay unset until someone sets them.
interface DefaultedSettings extends Prefs {
  engine: string;
  cloak: OnOff;
  adBlock: OnOff;
  cloakTitle: string;
  cloakFavicon: string;
  autoCloak: OnOff;
  beforeUnload: OnOff;
  backend: Backend;
  panicLoc: string;
  panicKey: string;
  wispUrl: string;
  bm: Bookmark[];
  shortcutsSeeded: boolean;
  // Page guards (src/utils/guards.ts): '' is the browser's own user agent.
  userAgent: string;
  fingerprintNoise: OnOff;
  leakGuard: OnOff;
  siteFixes: OnOff;
}

interface UnsetSettings {
  // The headers the service worker sends for `userAgent`, saved with it (src/utils/settings/guards.ts).
  userAgentHeaders: Record<string, string> | null;
  customGames: { name: string; url: string }[];
  customApps: { name: string; url: string }[];
  tabSwitchCloak: OnOff;
  loginConsent: Consent;
  guideDone: boolean;
}

export type Settings = DefaultedSettings & UnsetSettings;
export type SettingKey = keyof Settings;

// The settings the Settings page shows and applies (src/utils/st.ts).
export const PAGE_SETTINGS = [
  'cloak',
  'cloakTitle',
  'cloakFavicon',
  'tabSwitchCloak',
  'autoCloak',
  'beforeUnload',
  'backend',
  'adBlock',
  'engine',
  'wispUrl',
  'panicLoc',
  'panicKey',
] as const satisfies readonly SettingKey[];
export type PageSettings = { [K in (typeof PAGE_SETTINGS)[number]]: Settings[K] | null };

const isBrowser = typeof location !== 'undefined';

export function wispUrl(): string {
  if (!isBrowser) return '';
  const isHttps = location.protocol === 'https:';
  // WISP_PATH is injected at build time (see astro.config.ts) and must match the path the
  // server listens on. Defaults to '/w/' when PUBLIC_PERSEC_WISP_PATH is unset.
  const path = typeof WISP_PATH === 'string' && WISP_PATH ? WISP_PATH : '/w/';
  return `${isHttps ? 'wss' : 'ws'}://${location.host}${path}`;
}

const defaults: DefaultedSettings = {
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
  userAgent: '',
  fingerprintNoise: 'off',
  leakGuard: 'on',
  siteFixes: 'on',
  ...PREF_DEFAULTS,
};

const store = localForage.createInstance({
  name: 'PersecDB',
  storeName: 'Settings',
});

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await fillDefaults(store, defaults as unknown as Record<string, unknown>);
  initialized = true;
}

// Known keys are typed by Settings; any other string still works (a key read from the page, such
// as a toggle's data-toggle), and gives back unknown.
interface ConfigStore {
  config: LocalForage;
  get<K extends SettingKey>(key: K): Promise<Settings[K] | null>;
  get(key: string): Promise<unknown>;
  set<K extends SettingKey>(key: K, value: Settings[K]): Promise<Settings[K]>;
  set(key: string, value: unknown): Promise<unknown>;
  getIndecator(key: string): Promise<any>;
  init(): Promise<void>;
  reset(): Promise<void>;
  getAll(): Promise<Record<string, any>>;
}

const ConfigAPI: ConfigStore = {
  config: store,

  async get(key: string): Promise<any> {
    await ensureInit();
    return store.getItem(key);
  },

  async set(key: string, value: unknown): Promise<any> {
    await ensureInit();
    return store.setItem(key, value);
  },

  async getIndecator(key: string): Promise<any> {
    await ensureInit();
    const value = await store.getItem(key);
    if (value != null) return value;
    return (defaults as unknown as Record<string, unknown>)[key] ?? null;
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

// The page settings, each as saved (null if unset).
export async function loadPageSettings(): Promise<PageSettings> {
  const values = await Promise.all(PAGE_SETTINGS.map(key => ConfigAPI.get(key)));
  return Object.fromEntries(PAGE_SETTINGS.map((key, i) => [key, values[i]])) as PageSettings;
}

// The saved bookmarks, which are also the start page's tiles (see seedBookmarks).
export async function loadBookmarks(): Promise<Bookmark[]> {
  await ensureInit();
  return seedBookmarks(store);
}

export default ConfigAPI;
