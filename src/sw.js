// Served by src/pages/[sw].js.ts, which defines PERSEC_PATHS (this build's paths) above this line.
const { files } = PERSEC_PATHS;
importScripts(files.scramjetAll, files.uvConfig, files.uvBundle, files.uvSw);

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const v = new UVServiceWorker();

// null until read from settings. The browser stops idle service workers, so the setting is
// re-read from storage on restart instead of silently falling back to "off".
let adblockEnabled = null;

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

// Reads Persec's adBlock setting without creating the settings database if it doesn't exist yet.
function readAdblockSetting() {
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
      const get = db.transaction('Settings').objectStore('Settings').get('adBlock');
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

async function handleFetch(event) {
  await scramjet.loadConfig();

  const target = targetUrl(event.request.url);
  if (target) {
    if (adblockEnabled === null) adblockEnabled = await readAdblockSetting();
    if (adblockEnabled && isAdRequest(target, event.request)) {
      return new Response(null, { status: 204 });
    }
  }

  if (scramjet.route(event)) {
    await loadJar();
    const response = await scramjet.fetch(event);
    scheduleSave(event);
    return response;
  }
  if (v.route(event)) return v.fetch(event);

  return fetch(event.request);
}

self.addEventListener('fetch', event => {
  event.respondWith(handleFetch(event));
});
