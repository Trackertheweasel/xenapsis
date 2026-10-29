// Served by src/pages/[sw].js.ts, which defines PERSEC_PATHS (this build's paths) above this line.
const { files } = PERSEC_PATHS;
importScripts(files.scramjetAll, files.uvConfig, files.uvBundle, files.uvSw);

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const v = new UVServiceWorker();

// null until read from settings. The browser stops idle service workers, so the settings are
// re-read from storage on restart instead of silently falling back to "off".
let adblockEnabled = null;
let webrtcBlocked = null;

// Scramjet 1.1.0 saves its cookie jar to IndexedDB but never reads it back (its load() skips the
// object it saved), and it only saves when a page writes document.cookie, not when a site's server
// sets a cookie. So every login was lost whenever the browser stopped this worker. Persec loads
// and saves the jar itself.
function withScramjetCookies(mode, fn) {
  return new Promise(resolve => {
    const req = indexedDB.open('$scramjet');
    // Scramjet creates this database with its full schema; never create an empty one here.
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cookies')) {
        db.close();
        return resolve(undefined);
      }
      const tx = db.transaction('cookies', mode);
      const request = fn(tx.objectStore('cookies'));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        resolve(undefined);
      };
    };
  });
}

const currentJar = () => JSON.parse(scramjet.cookieStore.dump());
// The jar as last read from or written to IndexedDB, so unchanged jars aren't rewritten.
let savedJar = null;
let jarLoaded = null;

function loadJar() {
  jarLoaded ??= withScramjetCookies('readonly', store => store.get('cookies')).then(saved => {
    saved = saved && typeof saved === 'object' ? saved : {};
    // Cookies set while the saved jar was loading win over older saved ones, and get saved too.
    scramjet.cookieStore.load(JSON.stringify({ ...saved, ...currentJar() }));
    savedJar = JSON.stringify(saved);
  });
  return jarLoaded;
}

function saveJar() {
  const jar = scramjet.cookieStore.dump();
  if (jar === savedJar) return Promise.resolve();
  savedJar = jar;
  return withScramjetCookies('readwrite', store => store.put(JSON.parse(jar), 'cookies'));
}

// Saves at most once a second while pages load, keeping the worker alive until it's written.
let saveTimer = null;
function scheduleSave(event) {
  if (saveTimer) return;
  event.waitUntil(
    new Promise(resolve => {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        saveJar().then(resolve, resolve);
      }, 1000);
    })
  );
}

// Trust boundary. Proxied sites run on Persec's own origin, so any page they load could message
// this worker and read or replace every site's cookies. Both engines remove navigator.serviceWorker
// from proxied pages; as a second line, only Persec's own pages that need these messages are
// answered: the home page (settings, cookie notice) and Settings, which opens in a tab frame.
// A proxied page's URL is under an engine prefix, so it never matches. This is not a wall against
// a site that escapes the engines' rewriting: with the origin's IndexedDB it could read the
// saved jar directly. Scramjet's own messages (scramjet$type) go to its own listener, not here.
const TRUSTED_PAGES = new Set(['/', '/st']);

function isTrustedSender(source) {
  if (source?.type !== 'window') return false;
  try {
    const url = new URL(source.url);
    return url.origin === self.location.origin && TRUSTED_PAGES.has(url.pathname);
  } catch {
    return false;
  }
}

const isJar = data => !!data && typeof data === 'object' && !Array.isArray(data);

async function handleMessage(event) {
  if (!isTrustedSender(event.source)) return;
  const { type, data } = event.data || {};
  const reply = event.ports[0];
  if (type === 'ADBLOCK') adblockEnabled = !!data?.enabled;
  if (type === 'WEBRTC') webrtcBlocked = !!data?.enabled;
  if (type === 'CLEAR_SITE_DATA') {
    // Scramjet keeps its cookie jar in memory as well as in IndexedDB, which the page clears.
    scramjet.cookieStore.load('{}');
    savedJar = '{}';
    jarLoaded = Promise.resolve();
    reply?.postMessage('done');
  }
  // Used by saved logins (src/utils/loginsync.ts) to back up and restore Scramjet's cookies.
  if (type === 'GET_COOKIES') {
    await loadJar();
    reply?.postMessage(currentJar());
  }
  if (type === 'SET_COOKIES' && isJar(data)) {
    await loadJar();
    scramjet.cookieStore.load(JSON.stringify({ ...currentJar(), ...data }));
    await saveJar();
    reply?.postMessage('done');
  }
}

self.addEventListener('message', event => {
  // Scramjet's own listener (added first) takes the config a page sends, but keeps the URL codec
  // from the first config it read, so after a rebuild (new URL key) every new URL was decoded with
  // the old key. The page saves the config to IndexedDB before sending it, so drop it here and the
  // next request reads it back from there, codec included. Not a trust decision: the stored config
  // is what any page of this origin wrote.
  if (event.data?.scramjet$type === 'loadConfig') scramjet.config = null;
  event.waitUntil(handleMessage(event));
});

// A new build ships new URL keys and prefixes. Take over at once, instead of leaving the old
// worker, with the old keys, in charge until every Persec tab has been closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Reads one of Persec's on/off settings without creating the settings database if it doesn't
// exist yet. Unset counts as on: both settings it reads (adBlock, blockWebRTC) default to on.
function readOnSetting(key) {
  return new Promise(resolve => {
    const req = indexedDB.open('PersecDB');
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => resolve(true);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('Settings')) {
        db.close();
        return resolve(true);
      }
      const get = db.transaction('Settings').objectStore('Settings').get(key);
      get.onsuccess = () => {
        db.close();
        resolve(get.result !== 'off');
      };
      get.onerror = () => {
        db.close();
        resolve(true);
      };
    };
  });
}

function readAdblockSetting() {
  return readOnSetting('adBlock');
}

function readWebrtcSetting() {
  return readOnSetting('blockWebRTC');
}

// Ad and tracker hosts, matched against the host and all its subdomains.
const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'google-analytics.com',
  'analytics.google.com',
  'media.net',
  'amazon-adsystem.com',
  'adcolony.com',
  'unityads.unity3d.com',
  'ads-twitter.com',
  'ads-api.twitter.com',
  'hotjar.com',
  'hotjar.io',
  'mouseflow.com',
  'freshmarketer.com',
  'luckyorange.com',
  '2o7.net',
  'stats.wp.com',
  'mc.yandex.ru',
  'mc.yandex.com',
  'static.cloudflareinsights.com',
  'bugsnag.com',
  'sentry.io',
  'sentry-cdn.com',
];

// Ad and tracking script paths that are safe to block on any host.
const AD_PATHS = [
  /\/(ads|ad|adsbygoogle|analytics|ga|gtm|fbevents|pixel)\.js$/i,
  /\/gtag\/js$/i,
  /\/cdn-cgi\/rum$/i,
];
const AD_SCRIPT_SEGMENTS = new Set(['ads', 'adserver', 'adservice', 'pagead']);

// Returns the real URL a proxied request is for, or null for Persec's own requests.
function targetUrl(requestUrl) {
  try {
    const u = new URL(requestUrl);
    if (u.origin !== self.location.origin) return null;
    const scPrefix = scramjet.config?.prefix || PERSEC_PATHS.scPrefix;
    const uv = self.__uv$config;
    // Both engines share one URL codec (src/utils/codec.ts), which the Ultraviolet config provides here.
    if (uv && u.pathname.startsWith(scPrefix)) {
      return new URL(uv.decodeUrl(u.pathname.slice(scPrefix.length)));
    }
    if (uv && u.pathname.startsWith(uv.prefix)) {
      return new URL(uv.decodeUrl(u.pathname.slice(uv.prefix.length) + u.search));
    }
  } catch {}
  return null;
}

function isAdRequest(target, request) {
  // Never block a page the user is opening, only the things it loads.
  if (
    request?.mode === 'navigate' ||
    ['document', 'iframe', 'frame'].includes(request?.destination)
  ) {
    return false;
  }
  if (request?.destination === 'ping') return true;

  const host = target.hostname.toLowerCase();
  if (AD_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
  if (AD_PATHS.some(r => r.test(target.pathname))) return true;
  if (request?.destination === 'script') {
    return target.pathname.split('/').some(s => AD_SCRIPT_SEGMENTS.has(s.toLowerCase()));
  }
  return false;
}

// WebRTC is the one way a proxied page reaches the network without going through the proxy: the
// browser connects to the other side itself, over UDP, and a STUN server tells the page the
// visitor's real IP address. Neither engine wraps RTCPeerConnection, so with blockWebRTC on, every
// proxied page gets this first, ahead of the engine's own scripts and the site's. It keeps the API
// (sites that check for it still load) but makes every connection relay-only with no relay servers,
// so the browser gathers no addresses and never connects. Same-origin frames and windows the page
// opens get the same treatment. A site set on getting around it could still reach an untouched
// window (window.frames[0] before anything else touches it), so this keeps the address from sites
// using WebRTC the normal way, which is how it leaks in practice.
function webrtcGuard() {
  const guarded = new WeakSet();
  const relayOnly = config =>
    Object.assign({}, config, { iceServers: [], iceTransportPolicy: 'relay' });

  function guard(win) {
    try {
      if (!win || guarded.has(win)) return;
      guarded.add(win);
      const replaced = new Map();
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
        const desc = Object.getOwnPropertyDescriptor(win, name);
        const Native = desc?.value;
        if (typeof Native !== 'function') continue;
        if (!replaced.has(Native)) replaced.set(Native, wrapConstructor(Native));
        Object.defineProperty(win, name, { ...desc, value: replaced.get(Native) });
      }
      for (const Frame of [win.HTMLIFrameElement, win.HTMLFrameElement]) {
        if (!Frame) continue;
        wrapGetter(Frame.prototype, 'contentWindow', w => w);
        wrapGetter(Frame.prototype, 'contentDocument', d => d.defaultView);
      }
      const open = win.open;
      if (typeof open === 'function') {
        win.open = function (...args) {
          const opened = open.apply(this, args);
          guard(opened);
          return opened;
        };
      }
    } catch {}
  }

  // A stand-in that hands back real RTCPeerConnections, so instanceof, subclasses and every method
  // work as before. It shares the native prototype, whose constructor now points here, and nothing
  // on it leads back to the native constructor.
  function wrapConstructor(Native) {
    const Guarded = function RTCPeerConnection(config, ...rest) {
      if (!new.target) return Native(config, ...rest);
      const target = new.target === Guarded ? Native : new.target;
      return Reflect.construct(Native, [relayOnly(config), ...rest], target);
    };
    for (const key of Reflect.ownKeys(Native)) {
      if (!['length', 'name', 'prototype'].includes(key)) {
        Object.defineProperty(Guarded, key, Object.getOwnPropertyDescriptor(Native, key));
      }
    }
    Object.setPrototypeOf(Guarded, Object.getPrototypeOf(Native));
    Guarded.prototype = Native.prototype;
    Object.defineProperty(Native.prototype, 'constructor', {
      value: Guarded,
      writable: true,
      configurable: true,
    });
    const setConfiguration = Native.prototype.setConfiguration;
    if (typeof setConfiguration === 'function') {
      Native.prototype.setConfiguration = function (config) {
        return setConfiguration.call(this, relayOnly(config));
      };
    }
    return Guarded;
  }

  function wrapGetter(proto, prop, windowOf) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.get) return;
    Object.defineProperty(proto, prop, {
      ...desc,
      get() {
        const value = desc.get.call(this);
        if (value) guard(windowOf(value));
        return value;
      },
    });
  }

  guard(window);
}

const WEBRTC_GUARD = `<script>(${webrtcGuard})();</script>`;

// Puts the guard first in a proxied page's <head>. Both engines always write one, with their own
// scripts at its start, so going right after the tag puts the guard ahead of everything else.
// Without one it goes after the doctype, as anything before that would switch on quirks mode.
async function withWebrtcGuard(request, response) {
  if (!['document', 'iframe', 'frame'].includes(request?.destination)) return response;
  // Responses that can't carry a body can't be rebuilt with one.
  if (!response.body || [204, 205, 304].includes(response.status)) return response;
  if (!/^text\/html\b/i.test(response.headers.get('content-type') || '')) return response;
  if (webrtcBlocked === null) webrtcBlocked = await readWebrtcSetting();
  if (!webrtcBlocked) return response;
  const html = await response.text();
  const head = /<head\b[^>]*>/i.exec(html) || /^\s*<!doctype[^>]*>/i.exec(html);
  const at = head ? head.index + head[0].length : 0;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(html.slice(0, at) + WEBRTC_GUARD + html.slice(at), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleFetch(event) {
  await scramjet.loadConfig();

  const target = targetUrl(event.request.url);
  if (target) {
    if (adblockEnabled === null) adblockEnabled = await readAdblockSetting();
    if (adblockEnabled && isAdRequest(target, event.request)) {
      return new Response(null, { status: 204 });
    }
  }

  // Scramjet reads its config from IndexedDB, where a page saves it, and route() throws without
  // one (a first visit before a page has saved it, or a deleted database). That would fail every
  // request, Persec's own pages included, so until then nothing is Scramjet's.
  if (scramjet.config && scramjet.route(event)) {
    await loadJar();
    const response = await scramjet.fetch(event);
    scheduleSave(event);
    return withWebrtcGuard(event.request, response);
  }
  if (v.route(event)) return withWebrtcGuard(event.request, await v.fetch(event));

  return fetch(event.request);
}

self.addEventListener('fetch', event => {
  event.respondWith(handleFetch(event));
});
