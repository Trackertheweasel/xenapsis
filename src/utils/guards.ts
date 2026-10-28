// Privacy guards and site fixes applied to every page Scramjet opens in a tab, before the page's
// own scripts run (src/utils/tb.ts hooks them to the frame's contextInit event). Ported from
// InvisiProxy LTS (github.com/InvisiProxy/InvisiProxyLTS, src/browser/fingerprint.ts,
// leak-guard.ts, site-fixes.ts and search-url-guard.ts), AGPL-3.0 like Persec, and adapted to
// Scramjet 1.1. Ultraviolet pages get none of them: it has no hook that runs before a page's scripts.
//
// Settings, all saved in this browser: `userAgent` ('' for the browser's own, a preset id, or
// 'custom:<agent>'), `fingerprintNoise`, `leakGuard` and `siteFixes` ('on' or 'off').

export type PresetCategory = 'desktop' | 'mobile' | 'console' | 'bot';

export interface UserAgentPreset {
  id: string;
  label: string;
  category: PresetCategory;
  userAgent: string;
}

export interface BrowserProfile {
  userAgent: string;
  appVersion: string;
  platform: string;
  vendor: string;
  mobile: boolean;
  maxTouchPoints: number;
  chromium?: { version: string; platform: string };
}

export interface Guards {
  profile: BrowserProfile | null;
  noise: FingerprintNoise | null;
  leakGuard: boolean;
  siteFixes: boolean;
}

export interface FingerprintNoise {
  hardwareConcurrency: number;
  deviceMemory: number;
  seed: number;
}

// Versions follow the real browser's, so a preset never looks years out of date.
const realAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const realChrome = Number(/Chrome\/(\d+)/.exec(realAgent)?.[1]) || 0;
const realFirefox = Number(/Firefox\/(\d+)/.exec(realAgent)?.[1]) || 0;
const chromeMajor = Math.max(141, realChrome, realFirefox - 2);
const chrome = `${chromeMajor}.0.0.0`;
const firefox = `${Math.max(143, realFirefox, chromeMajor + 2)}.0`;

export const USER_AGENT_PRESETS: readonly UserAgentPreset[] = [
  {
    id: 'chrome-windows',
    label: 'Chrome on Windows',
    category: 'desktop',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
  },
  {
    id: 'chrome-mac',
    label: 'Chrome on macOS',
    category: 'desktop',
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
  },
  {
    id: 'chrome-linux',
    label: 'Chrome on Linux',
    category: 'desktop',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
  },
  {
    id: 'firefox-windows',
    label: 'Firefox on Windows',
    category: 'desktop',
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${firefox}) Gecko/20100101 Firefox/${firefox}`,
  },
  {
    id: 'firefox-linux',
    label: 'Firefox on Linux',
    category: 'desktop',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64; rv:${firefox}) Gecko/20100101 Firefox/${firefox}`,
  },
  {
    id: 'safari-mac',
    label: 'Safari on macOS',
    category: 'desktop',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  },
  {
    id: 'chrome-android',
    label: 'Chrome on Android',
    category: 'mobile',
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`,
  },
  {
    id: 'safari-iphone',
    label: 'Safari on iPhone',
    category: 'mobile',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'safari-ipad',
    label: 'Safari on iPad',
    category: 'mobile',
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  },
  {
    id: 'firefox-android',
    label: 'Firefox on Android',
    category: 'mobile',
    userAgent: `Mozilla/5.0 (Android 15; Mobile; rv:${firefox}) Gecko/${firefox} Firefox/${firefox}`,
  },
  {
    id: 'playstation',
    label: 'PlayStation 5',
    category: 'console',
    userAgent:
      'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15',
  },
  {
    id: 'xbox',
    label: 'Xbox Series X',
    category: 'console',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.82 Safari/537.36 Edge/20.02',
  },
  {
    id: 'switch',
    label: 'Nintendo Switch',
    category: 'console',
    userAgent:
      'Mozilla/5.0 (Nintendo Switch; WifiWebAuthApplet) AppleWebKit/606.4 (KHTML, like Gecko) NF/6.0.1.15.4 NintendoBrowser/5.1.0.20393',
  },
  {
    id: 'steam-deck',
    label: 'Steam Deck',
    category: 'console',
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36 Valve Steam Client`,
  },
  {
    id: 'googlebot',
    label: 'Googlebot',
    category: 'bot',
    userAgent: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/${chrome} Safari/537.36`,
  },
  {
    id: 'bingbot',
    label: 'Bingbot',
    category: 'bot',
    userAgent: `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/${chrome} Safari/537.36`,
  },
];

export const PRESET_CATEGORIES: { id: PresetCategory; label: string }[] = [
  { id: 'desktop', label: 'Computers' },
  { id: 'mobile', label: 'Phones and tablets' },
  { id: 'console', label: 'Game consoles' },
  { id: 'bot', label: 'Search engine bots' },
];

const CUSTOM = 'custom:';

// A user agent typed in Settings: one line, at most 512 characters, or null.
export function customUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export const customUserAgentValue = (userAgent: string) => CUSTOM + userAgent;

// The user agent a saved `userAgent` setting stands for, or null for the browser's own.
export function storedUserAgent(stored: unknown): string | null {
  if (typeof stored !== 'string') return null;
  if (stored.startsWith(CUSTOM)) return customUserAgent(stored.slice(CUSTOM.length));
  return USER_AGENT_PRESETS.find(({ id }) => id === stored)?.userAgent ?? null;
}

// What else a site can read about the browser, made to match the user agent.
export function profileFromUserAgent(userAgent: string): BrowserProfile {
  const mobile = /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent);
  const apple = /iPhone|iPad|iPod|Macintosh/.test(userAgent);
  const platform = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Linux armv81'
        : /Windows|Xbox/.test(userAgent)
          ? 'Win32'
          : /Macintosh/.test(userAgent)
            ? 'MacIntel'
            : /PlayStation/.test(userAgent)
              ? 'PlayStation 5'
              : /Nintendo/.test(userAgent)
                ? 'Nintendo Switch'
                : /Linux|X11/.test(userAgent)
                  ? 'Linux x86_64'
                  : '';
  const chromeVersion = /(?:Chrome|CriOS)\/(\d+)/.exec(userAgent)?.[1];
  const chromium =
    chromeVersion && !/Edge\/|Firefox|Googlebot|bingbot|Xbox/.test(userAgent) && !apple
      ? {
          version: chromeVersion,
          platform: /Android/.test(userAgent)
            ? 'Android'
            : /Windows/.test(userAgent)
              ? 'Windows'
              : /CrOS/.test(userAgent)
                ? 'Chrome OS'
                : 'Linux',
        }
      : chromeVersion && /Macintosh/.test(userAgent)
        ? { version: chromeVersion, platform: 'macOS' }
        : undefined;
  const vendor = chromium
    ? 'Google Inc.'
    : apple || /PlayStation/.test(userAgent)
      ? 'Apple Computer, Inc.'
      : '';
  return {
    userAgent,
    appVersion: userAgent.replace(/^Mozilla\//, ''),
    platform,
    vendor,
    mobile,
    maxTouchPoints: mobile ? 5 : 0,
    chromium,
  };
}

function brandList(version: string, full = false) {
  const value = full ? `${version}.0.0.0` : version;
  return [
    { brand: 'Chromium', version: value },
    { brand: 'Google Chrome', version: value },
    { brand: 'Not?A_Brand', version: full ? '99.0.0.0' : '99' },
  ];
}

// The request headers that carry the user agent, for the service worker to send instead of the
// browser's (src/sw.js reads them from the saved `userAgentHeaders`). Lower-case names.
export function userAgentHeaders(profile: BrowserProfile | null): Record<string, string> | null {
  if (!profile) return null;
  const headers: Record<string, string> = { 'user-agent': profile.userAgent };
  if (profile.chromium) {
    headers['sec-ch-ua'] = brandList(profile.chromium.version)
      .map(({ brand, version }) => `"${brand}";v="${version}"`)
      .join(', ');
    headers['sec-ch-ua-mobile'] = profile.mobile ? '?1' : '?0';
    headers['sec-ch-ua-platform'] = `"${profile.chromium.platform}"`;
  }
  return headers;
}

// Random values for this browser session, so a site sees the same ones on every page.
export function randomNoise(random = Math.random): FingerprintNoise {
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  return {
    hardwareConcurrency: pick([4, 6, 8, 12, 16]),
    deviceMemory: pick([4, 8]),
    seed: Math.floor(random() * 2 ** 31),
  };
}

export function sessionNoise(
  session: Pick<Storage, 'getItem' | 'setItem'>,
  random = Math.random,
): FingerprintNoise {
  const key = 'persec-fingerprint';
  try {
    const saved = JSON.parse(session.getItem(key) ?? 'null');
    if (
      Number.isInteger(saved?.hardwareConcurrency) &&
      Number.isInteger(saved?.deviceMemory) &&
      Number.isInteger(saved?.seed)
    )
      return saved;
  } catch {}
  const fresh = randomNoise(random);
  try {
    session.setItem(key, JSON.stringify(fresh));
  } catch {}
  return fresh;
}

// The guards the saved settings ask for.
export function readGuards(
  saved: Record<string, unknown>,
  session?: Pick<Storage, 'getItem' | 'setItem'>,
): Guards {
  const agent = storedUserAgent(saved.userAgent);
  return {
    profile: agent ? profileFromUserAgent(agent) : null,
    noise:
      saved.fingerprintNoise === 'on' ? (session ? sessionNoise(session) : randomNoise()) : null,
    leakGuard: saved.leakGuard !== 'off',
    siteFixes: saved.siteFixes !== 'off',
  };
}

type PageWindow = Window & typeof globalThis;

function define(target: object, name: string, value: () => unknown) {
  try {
    Object.defineProperty(target, name, { configurable: true, enumerable: true, get: value });
  } catch {}
}

export function spoofNavigator(win: Window, profile: BrowserProfile): void {
  const proto = (win as PageWindow).Navigator?.prototype;
  if (!proto) return;
  define(proto, 'userAgent', () => profile.userAgent);
  define(proto, 'appVersion', () => profile.appVersion);
  define(proto, 'platform', () => profile.platform);
  define(proto, 'vendor', () => profile.vendor);
  define(proto, 'maxTouchPoints', () => profile.maxTouchPoints);
  define(proto, 'oscpu', () => (/Firefox/.test(profile.userAgent) ? profile.platform : undefined));
  const chromium = profile.chromium;
  if (!chromium) {
    define(proto, 'userAgentData', () => undefined);
    define(proto, 'deviceMemory', () => undefined);
    return;
  }
  const low = () => ({
    brands: brandList(chromium.version),
    mobile: profile.mobile,
    platform: chromium.platform,
  });
  const data = {
    ...low(),
    getHighEntropyValues: async (hints: string[]) => ({
      ...low(),
      ...(hints.includes('fullVersionList') && {
        fullVersionList: brandList(chromium.version, true),
      }),
      ...(hints.includes('uaFullVersion') && { uaFullVersion: `${chromium.version}.0.0.0` }),
    }),
    toJSON: low,
  };
  define(proto, 'userAgentData', () => data);
}

function noisy(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

// Flips the lowest bit of a few pixels whenever a site reads a canvas back, the same pixels every
// time in a session, so canvas fingerprints differ between sessions but drawing looks the same.
function addCanvasNoise(win: PageWindow, seed: number) {
  const canvas = win.HTMLCanvasElement?.prototype;
  const context = win.CanvasRenderingContext2D?.prototype;
  if (!canvas || !context) return;
  const { getImageData } = context;
  const putImageData = context.putImageData as (
    this: CanvasRenderingContext2D,
    image: ImageData,
    x: number,
    y: number,
  ) => void;
  const { getContext } = canvas;
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  canvas.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    const result = (getContext as (...a: unknown[]) => unknown).apply(this, args);
    if (args[0] === '2d' && result) contexts.set(this, result as CanvasRenderingContext2D);
    return result;
  } as typeof getContext;
  const perturb = (data: Uint8ClampedArray) => {
    const random = noisy(seed);
    for (let i = 0; i < data.length; i += 4) if (random() < 0.02) data[i] ^= 1;
  };
  context.getImageData = function (
    this: CanvasRenderingContext2D,
    ...args: Parameters<typeof getImageData>
  ) {
    const image = getImageData.apply(this, args);
    perturb(image.data);
    return image;
  } as typeof getImageData;
  for (const method of ['toDataURL', 'toBlob'] as const) {
    const original = canvas[method] as (...a: unknown[]) => unknown;
    canvas[method] = function (this: HTMLCanvasElement, ...args: unknown[]) {
      const ctx = contexts.get(this);
      if (!ctx || !this.width || !this.height) return original.apply(this, args);
      const image = getImageData.call(ctx, 0, 0, this.width, this.height);
      const pristine = getImageData.call(ctx, 0, 0, this.width, this.height);
      perturb(image.data);
      putImageData.call(ctx, image, 0, 0);
      try {
        return original.apply(this, args);
      } finally {
        putImageData.call(ctx, pristine, 0, 0);
      }
    } as never;
  }
}

// The graphics card's name is one of the most identifying values a site can read.
function maskWebgl(win: PageWindow) {
  for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext'] as const) {
    const proto = win[name]?.prototype;
    if (!proto) continue;
    const getParameter = proto.getParameter;
    proto.getParameter = function (this: WebGLRenderingContext, parameter: number) {
      if (parameter === 0x9245) return 'Google Inc.'; // UNMASKED_VENDOR_WEBGL
      if (parameter === 0x9246) return 'ANGLE (Generic, Generic Renderer)'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    } as typeof getParameter;
  }
}

export function randomizeFingerprint(
  win: Window,
  noise: FingerprintNoise,
  profile?: BrowserProfile | null,
): void {
  const page = win as PageWindow;
  const proto = page.Navigator?.prototype;
  if (proto) {
    define(proto, 'hardwareConcurrency', () => noise.hardwareConcurrency);
    define(proto, 'deviceMemory', () =>
      profile && !profile.chromium ? undefined : noise.deviceMemory,
    );
  }
  addCanvasNoise(page, noise.seed);
  maskWebgl(page);
}

const guarded = Symbol.for('persec leak guard');
const opensNewTab = (target: string | null | undefined) =>
  target?.trim().toLowerCase() === '_blank';

// Links and forms that open a new window would leave Persec for a bare browser tab, outside the
// cloak and in the browser's history. They open in a new Persec tab instead (`open` gets the
// site's real address), as window.open already does.
export function leakGuard(win: Window, open: (url: string) => void): void {
  const page = win as PageWindow & { [guarded]?: boolean };
  if (page[guarded]) return;
  page[guarded] = true;

  page.open = ((url?: string | URL) => {
    if (url) open(new URL(String(url), page.location.href).href);
    return null;
  }) as typeof page.open;

  const handle = (event: Event) => {
    const click = event as MouseEvent;
    if (click.defaultPrevented || click.button > 1) return;
    const link = click
      .composedPath()
      .find(
        (node): node is HTMLAnchorElement | HTMLAreaElement =>
          ((node as Element).localName === 'a' || (node as Element).localName === 'area') &&
          (node as Element).hasAttribute('href'),
      );
    if (!link || link.hasAttribute('download')) return;
    const base = page.document.querySelector('base[target]');
    const target = link.getAttribute('target') ?? base?.getAttribute('target');
    // A middle click (auxclick) or Ctrl/Cmd-click means a new tab too.
    if (!opensNewTab(target) && click.button !== 1 && !click.ctrlKey && !click.metaKey) return;
    const href = link.href;
    if (!/^https?:/i.test(href)) return;
    click.preventDefault();
    open(href);
  };
  page.addEventListener('click', handle, true);
  page.addEventListener('auxclick', handle, true);
}

// Values some sites (DuckDuckGo, TikTok, Twitch) navigate to when their own script breaks under
// the proxy: /undefined, ?q=null and the like.
const GARBAGE = new Set(['undefined', 'null', 'nan', '[object object]']);
const isGarbage = (value: string) => GARBAGE.has(value.trim().toLowerCase());
const GUARDED_SEARCH = ['duckduckgo.com', 'tiktok.com', 'twitch.tv', 'fmhy.net'];
const SEARCH_INPUTS = [
  '#search_form_input',
  "input[name='q']",
  "input[type='search']",
  "input[name='query']",
  "textarea[name='q']",
];

const onSite = (href: string, sites: string[]) => {
  try {
    const { hostname } = new URL(href);
    return sites.some(site => hostname === site || hostname.endsWith(`.${site}`));
  } catch {
    return false;
  }
};

// What the person typed in the page's search box, to recover a broken search navigation.
export function searchBoxQuery(doc: Pick<Document, 'querySelector'> | null | undefined): string {
  for (const selector of SEARCH_INPUTS) {
    const value = (doc?.querySelector(selector) as HTMLInputElement | null)?.value?.trim();
    if (value && !isGarbage(value)) return value;
  }
  return '';
}

// A navigation to a broken address, repaired with the search box's query; null to stay put.
// Anything else is returned as it was.
export function fixSearchNavigation(
  raw: unknown,
  base: string,
  query: () => string,
): string | null {
  const recovered = () => {
    const q = query().trim();
    return q && !isGarbage(q) ? q : '';
  };
  if (raw == null) return recovered() ? `/?q=${encodeURIComponent(recovered())}` : null;
  const href = String(raw);
  if (!href.trim()) return null;
  if (isGarbage(href)) return recovered() ? `/?q=${encodeURIComponent(recovered())}` : null;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return href;
  }
  if (!/^https?:$/.test(url.protocol)) return href;
  const pathGarbage = url.pathname.split('/').some(isGarbage);
  const q = url.searchParams.get('q');
  if (!pathGarbage && (q == null || !isGarbage(q))) return href;
  const fixed = recovered();
  if (!fixed) return null;
  const next = new URL(url.href);
  if (pathGarbage) next.pathname = '/';
  next.search = '';
  next.searchParams.set('q', fixed);
  for (const [key, value] of url.searchParams)
    if (key !== 'q' && !isGarbage(value)) next.searchParams.set(key, value);
  return /^https?:\/\//i.test(href.trim())
    ? next.href
    : `${next.pathname}${next.search}${next.hash}`;
}

// The parts of Scramjet's page client the fixes use.
export interface PageClient {
  url: URL | string;
}

// history.pushState(state, title) with no address keeps the page's address. Under the proxy the
// address the browser would keep is the proxied one, which some sites then read back and break on.
function keepHistoryUrl(win: PageWindow, client: PageClient) {
  const proto = win.History.prototype;
  for (const name of ['pushState', 'replaceState'] as const)
    proto[name] = new Proxy(proto[name], {
      apply(target, history: History, args: unknown[]) {
        if (history === win.history && args[2] == null) args[2] = String(client.url);
        return Reflect.apply(target, history, args);
      },
    });
}

// Sites cache requests by their own relative URLs; resolving them against the real address keeps
// one key per request instead of one per proxied form of it.
function stableCacheKeys(win: PageWindow, client: PageClient) {
  if (!win.Cache) return;
  const cache = win.Cache.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['delete', 'match', 'matchAll', 'put'])
    cache[name] = new Proxy(cache[name], {
      apply(target, self, args: unknown[]) {
        if (typeof args[0] === 'string' || args[0] instanceof URL) {
          try {
            args[0] = new URL(args[0], String(client.url)).href;
          } catch {}
        }
        return Reflect.apply(target, self, args);
      },
    });
}

function guardSearchNavigation(win: PageWindow, client: PageClient) {
  const proto = Object.getPrototypeOf(client);
  const descriptor =
    Object.getOwnPropertyDescriptor(client, 'url') ??
    (proto ? Object.getOwnPropertyDescriptor(proto, 'url') : undefined);
  if (!descriptor?.get || !descriptor.set) return;
  const { get, set } = descriptor;
  Object.defineProperty(client, 'url', {
    configurable: true,
    enumerable: true,
    get() {
      return get.call(this);
    },
    set(value: unknown) {
      let base = 'https://example.com/';
      try {
        base = String(get.call(this));
      } catch {}
      const fixed = fixSearchNavigation(value, base, () => searchBoxQuery(win.document));
      if (fixed != null) set.call(this, fixed);
    },
  });
}

export function applySiteFixes(win: Window, client: PageClient): void {
  const page = win as PageWindow;
  const attempt = (fix: () => void) => {
    try {
      fix();
    } catch {}
  };
  attempt(() => keepHistoryUrl(page, client));
  attempt(() => stableCacheKeys(page, client));
  if (onSite(String(client.url), GUARDED_SEARCH))
    attempt(() => guardSearchNavigation(page, client));
}

// Everything above, for one page as Scramjet starts it.
export function applyGuards(
  win: Window,
  client: PageClient,
  guards: Guards,
  open: (url: string) => void,
): void {
  const attempt = (fix: () => void) => {
    try {
      fix();
    } catch {}
  };
  if (guards.profile) attempt(() => spoofNavigator(win, guards.profile!));
  if (guards.noise) attempt(() => randomizeFingerprint(win, guards.noise!, guards.profile));
  if (guards.leakGuard) attempt(() => leakGuard(win, open));
  if (guards.siteFixes) applySiteFixes(win, client);
}

// Settings and the tabs page are separate pages; a change in one reaches the other here.
export const GUARDS_CHANNEL = 'persec-guards';
