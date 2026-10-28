import { add, has, remove } from './bookmarks';
import ConfigAPI from './config';
import { checkAndShow } from './diagnostics';
import { scramjetWrapper, vWrapper } from './pro';
import { notify } from './status';
import { TabManager, decodeProxyUrl } from './tb';
import { ensureTransport } from './transport';
import { validateUrl } from './url';

const reloadBtn = document.getElementById('refresh') as HTMLButtonElement | null;
const backBtn = document.getElementById('back') as HTMLButtonElement | null;
const fwdBtn = document.getElementById('forward') as HTMLButtonElement | null;
const urlbar = document.getElementById('urlbar') as HTMLInputElement | null;
const favBtn = document.getElementById('fav') as HTMLButtonElement | null;
const homeBtn = document.getElementById('home') as HTMLElement | null;
const sidebar = document.querySelector('aside');

const routes: Record<string, string> = {
  'persec://settings': '/st',
  'persec://new': '/new',
  'persec://games': '/math',
  'persec://apps': '/sci',
  'persec://privacy': '/privacy',
  'persec://bookmarks': '/bm',
};

const reverseRoutes = Object.fromEntries(Object.entries(routes).map(([k, v]) => [v, k]));

const sc = scramjetWrapper.getConfig();
const uv = vWrapper.getConfig();
const hist = new Map<string, { stack: string[]; idx: number }>();

// Registers the service worker, starts the engine and sets the transport, showing what failed.
const setup = (onRecovered?: () => void) =>
  checkAndShow({ runtime: () => scramjetWrapper.init(), onRecovered });

function frame(): HTMLIFrameElement | null {
  const id = TabManager.activeTabId;
  if (!id) return null;
  return document.getElementById(`frame-${id}`) as HTMLIFrameElement | null;
}

function history() {
  const id = String(TabManager.activeTabId);
  if (!hist.has(id)) {
    hist.set(id, { stack: [], idx: -1 });
  }
  return hist.get(id)!;
}

function spin() {
  if (!reloadBtn) return;
  reloadBtn.style.animation = 'none';
  reloadBtn.offsetWidth;
  reloadBtn.style.animation = 'spin 0.4s linear';
}

function record(url: string) {
  const h = history();
  if (h.stack[h.idx] === url) return;

  h.stack = h.stack.slice(0, h.idx + 1);
  h.stack.push(url);
  h.idx++;
}

function nav(url: string, save = true) {
  const f = frame();
  if (!f) return;

  if (save) record(url);
  f.src = url;
}

function back() {
  const h = history();
  if (h.idx <= 0) return;

  h.idx--;
  nav(h.stack[h.idx], false);
}

function fwd() {
  const h = history();
  if (h.idx >= h.stack.length - 1) return;

  h.idx++;
  nav(h.stack[h.idx], false);
}

// The real URL of the page in the active tab, decoded by whichever engine loaded it
// (not the current setting, which may have changed since the page was opened).
function currentUrl(f: HTMLIFrameElement): string {
  try {
    const href = f.contentWindow?.location.href || f.src;
    return decodeProxyUrl(new URL(href, location.origin).pathname);
  } catch {
    return '';
  }
}

async function sync() {
  const f = frame();
  if (!f) return;

  record(f.src);

  const d = currentUrl(f);
  const active = !!d && has((await ConfigAPI.get('bm')) || [], d);

  const svg = favBtn?.querySelector('svg');
  if (svg) {
    svg.style.fill = active ? '#a8a3c7' : 'none';
    svg.style.stroke = active ? '#a8a3c7' : '';
  }
  if (favBtn) {
    const label = active ? 'Remove bookmark' : 'Bookmark this page';
    favBtn.setAttribute('aria-pressed', String(active));
    favBtn.setAttribute('aria-label', label);
    favBtn.title = label;
  }
}

async function toggleFav() {
  if (!urlbar) return;

  const f = frame();
  if (!f || routes[urlbar.value]) return;

  const d = currentUrl(f);
  if (!d) return notify('Open a website first, then bookmark it.');
  const bm = (await ConfigAPI.get('bm')) || [];
  const was = has(bm, d);
  try {
    await ConfigAPI.set(
      'bm',
      was
        ? remove(bm, d)
        : add(bm, { name: f.contentDocument?.title, logo: TabManager.activeFavicon, redir: d }),
    );
    notify(was ? 'Bookmark removed.' : 'Bookmarked. Find it in Menu → Bookmarks.');
  } catch {
    notify('That page can’t be bookmarked.');
  }
  sync();
}

function encode(url: string, backend: unknown) {
  return backend === 'u'
    ? `${uv.prefix}${uv.encodeUrl(url)}`
    : `${sc.prefix}${sc.codec.encode(url)}`;
}

// The person asked for this (Menu → Try the other engine), so it changes the saved engine and opens
// the same page again with it.
let switching = false;
async function retryOtherEngine() {
  const f = frame();
  const d = f && currentUrl(f);
  if (!d) return notify('Open a website first: this reloads it with the other proxy engine.');
  if (switching) return;
  switching = true;
  try {
    const next = (await ConfigAPI.get('backend')) === 'u' ? 'sc' : 'u';
    await ConfigAPI.set('backend', next);
    notify(
      `Trying ${next === 'u' ? 'Ultraviolet' : 'Scramjet'}… You can switch back in Settings → Browsing.`,
    );
    spin();
    nav(encode(d, next));
  } catch {
    notify('Couldn’t switch engines. Try again from Settings → Browsing.');
  } finally {
    switching = false;
  }
}

async function submit() {
  if (!urlbar) return;

  const v = urlbar.value.trim();

  if (routes[v]) {
    spin();
    nav(routes[v]);
    return;
  }

  try {
    await ensureTransport();
  } catch {
    // Opening the page now would only hang; say what is wrong instead, and open it once a retry
    // of the checks passes, unless the person has gone somewhere else by then.
    setup(() => {
      if (urlbar.value.trim() === v) submit();
    });
    return;
  }

  const val = await validateUrl(v);
  spin();
  nav(encode(val, await ConfigAPI.get('backend')));
}

function clickSide(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  const url = btn.dataset.url;
  if (!url || !urlbar) return;

  let r = reverseRoutes[url];
  if (!r && url === '/') {
    r = 'persec://new';
  }

  urlbar.value = r || url;
  const target = r ? routes[r] : url;

  spin();
  nav(target);
}

if (reloadBtn) {
  reloadBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const h = history();
    if (h.idx >= 0) {
      nav(h.stack[h.idx], false);
    }
  });
}

if (backBtn) {
  backBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    spin();
    back();
  });
}

if (fwdBtn) {
  fwdBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    spin();
    fwd();
  });
}

// Phones show Forward in the menu (src/layouts/tab.astro).
document.getElementById('menu-forward')?.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('menu')?.classList.add('hidden');
  document.getElementById('menubtn')?.setAttribute('aria-expanded', 'false');
  spin();
  fwd();
});

document.getElementById('menu-other-engine')?.addEventListener('click', retryOtherEngine);

if (homeBtn) {
  homeBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    spin();
    nav('/new');
  });
}

if (favBtn) {
  favBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    toggleFav();
  });
}

if (urlbar) {
  urlbar.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
}

if (sidebar) {
  sidebar.addEventListener('click', clickSide);
}

TabManager.onUrlChange(sync);

setup();
