importScripts('/data/all.js', '/tmp/config.js', '/tmp/bundle.js', '/tmp/sw.js');

let playgroundData = null;

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

async function handleMessage(event) {
  const { type, data } = event.data || {};
  const reply = event.ports[0];
  if (type === 'playgroundData') playgroundData = event.data;
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
  if (type === 'SET_COOKIES') {
    await loadJar();
    scramjet.cookieStore.load(JSON.stringify({ ...currentJar(), ...data }));
    await saveJar();
    reply?.postMessage('done');
  }
}

self.addEventListener('message', event => {
  event.waitUntil(handleMessage(event));
});

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
    const scPrefix = scramjet.config?.prefix || '/v1/data/';
    if (u.pathname.startsWith(scPrefix)) {
      return new URL(decodeURIComponent(u.pathname.slice(scPrefix.length)));
    }
    const uv = self.__uv$config;
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
