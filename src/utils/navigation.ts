import { add, has, remove } from './bookmarks';
import ConfigAPI from './config';
import { checkAndShow } from './diagnostics';
import { decodeProxyUrl, encodeProxyUrl, scramjetWrapper } from './pro';
import { internalName, internalPath } from './routes';
import { notify } from './status';
import { TabManager } from './tb';
import { ensureTransport } from './transport';
import { validateUrl } from './url';

// The browser's toolbar, found by initNavigation().
let reloadBtn: HTMLButtonElement | null = null;
let urlbar: HTMLInputElement | null = null;
let favBtn: HTMLButtonElement | null = null;

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
    return decodeProxyUrl(href);
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
  if (!f || internalPath(urlbar.value)) return;

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
    nav(encodeProxyUrl(d, next));
  } catch {
    notify('Couldn’t switch engines. Try again from Settings → Browsing.');
  } finally {
    switching = false;
  }
}

async function submit() {
  if (!urlbar) return;

  const v = urlbar.value.trim();

  const path = internalPath(v);
  if (path) {
    spin();
    nav(path);
    return;
  }

  try {
    await ensureTransport();
  } catch {
    // Opening the page now would only hang; say what is wrong instead, and open it once a retry
    // of the checks passes, unless the person has gone somewhere else by then.
    setup(() => {
      if (urlbar?.value.trim() === v) submit();
    });
    return;
  }

  const val = await validateUrl(v);
  spin();
  nav(encodeProxyUrl(val, await ConfigAPI.get('backend')));
}

function clickSide(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;

  e.preventDefault();
  e.stopPropagation();

  const url = btn.dataset.url;
  if (!url || !urlbar) return;

  const name = internalName(url) ?? (url === '/' ? 'persec://new' : undefined);

  urlbar.value = name || url;
  const target = (name && internalPath(name)) || url;

  spin();
  nav(target);
}

// Wires up the toolbar and sidebar of the browser page (src/pages/welcome.astro) and starts the
// proxy. Loading this module does nothing on its own.
export function initNavigation() {
  reloadBtn = document.getElementById('refresh') as HTMLButtonElement | null;
  urlbar = document.getElementById('urlbar') as HTMLInputElement | null;
  favBtn = document.getElementById('fav') as HTMLButtonElement | null;
  const backBtn = document.getElementById('back') as HTMLButtonElement | null;
  const fwdBtn = document.getElementById('forward') as HTMLButtonElement | null;
  const homeBtn = document.getElementById('home') as HTMLElement | null;
  const sidebar = document.querySelector('aside');

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
}
