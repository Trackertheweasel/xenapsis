import ConfigAPI from './config';
import { scramjetWrapper, vWrapper } from './pro';
import { TabManager, decodeProxyUrl } from './tb';
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
};

const reverseRoutes = Object.fromEntries(
  Object.entries(routes).map(([k, v]) => [v, k])
);

const sc = scramjetWrapper.getConfig();
const uv = vWrapper.getConfig();
const hist = new Map<string, { stack: string[]; idx: number }>();

let wisp: string;

async function setup() {
  wisp = await ConfigAPI.get('wispUrl');
  scramjetWrapper.init();
  await navigator.serviceWorker.register('./sw.js');
  
  const conn = new BareMux.BareMuxConnection('/bm/worker.js');
  const trans = await conn.getTransport();
  if (trans !== '/lc/index.mjs') {
    await conn.setTransport('/lc/index.mjs', [{ wisp }]);
  }
}

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

function norm(url: string): string {
  try {
    return decodeURIComponent(url).replace(/\/$/, '');
  } catch {
    return url.replace(/\/$/, '');
  }
}

async function sync() {
  const f = frame();
  if (!f) return;
  
  record(f.src);
  
  const d = currentUrl(f);
  const bm = (await ConfigAPI.get('bm')) || [];
  const active = bm.some((b: any) => norm(b.redir) === norm(d));
  
  const svg = favBtn?.querySelector('svg');
  if (svg) {
    svg.style.fill = active ? '#a8a3c7' : 'none';
    svg.style.stroke = active ? '#a8a3c7' : '';
  }
}

async function toggleFav() {
  if (!urlbar) return;
  
  const f = frame();
  if (!f || routes[urlbar.value]) return;
  
  const d = currentUrl(f);
  if (!d) return;
  const bm = (await ConfigAPI.get('bm')) || [];
  
  const i = bm.findIndex((b: any) => norm(b.redir) === norm(d));
  
  if (i !== -1) {
    bm.splice(i, 1);
  } else {
    bm.push({
      name: f.contentDocument?.title || d,
      logo: TabManager.activeFavicon,
      redir: d,
    });
  }
  
  await ConfigAPI.set('bm', bm);
  sync();
}

async function submit() {
  if (!urlbar) return;
  
  const v = urlbar.value.trim();
  
  if (routes[v]) {
    spin();
    nav(routes[v]);
    return;
  }
  
  const conn = new BareMux.BareMuxConnection('/bm/worker.js');
  const trans = await conn.getTransport();
  if (trans !== '/lc/index.mjs') {
    await conn.setTransport('/lc/index.mjs', [{ wisp }]);
  }
  
  const val = await validateUrl(v);
  const backend = await ConfigAPI.get('backend');
  
  const enc = backend === 'u'
    ? `${uv.prefix}${uv.encodeUrl(val)}`
    : `${sc.prefix}${sc.codec.encode(val)}`;
  
  spin();
  nav(enc);
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
  reloadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const h = history();
    if (h.idx >= 0) {
      nav(h.stack[h.idx], false);
    }
  });
}

if (backBtn) {
  backBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    spin();
    back();
  });
}

if (fwdBtn) {
  fwdBtn.addEventListener('click', (e) => {
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

if (homeBtn) {
  homeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    spin();
    nav('/new');
  });
}

if (favBtn) {
  favBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFav();
  });
}

if (urlbar) {
  urlbar.addEventListener('keydown', (e) => {
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