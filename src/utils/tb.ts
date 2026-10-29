import * as baremux from '@mercuryworkshop/bare-mux';
import ConfigAPI from './config';
import { GUARDS_CHANNEL, applyGuards, readGuards, type Guards } from './guards';
import { decodeProxyUrl, encodeProxyUrl, scramjetWrapper } from './pro';
import { internalName } from './routes';
import { ensureTransport } from './transport';

interface Tab {
  id: number;
  title: string;
  favicon: string;
  iframe: HTMLIFrameElement;
  el?: HTMLDivElement;
  titleTimer?: number;
  isReady: boolean;
}

const defaultIcon = '/a/persec.svg';
const faviconApi =
  'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=64&url=';
// Given the path: without one, bare-mux reads it from localStorage, which is empty on a first visit.
// Made on first use, so loading this module starts no worker.
let bmClient: baremux.BareClient | undefined;

const tabs: Tab[] = [];
let activeId: number | null = null;
let idCounter = 1;
let urlWatcher: ReturnType<typeof setInterval> | null = null;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let loadWatcher: ReturnType<typeof setInterval> | null = null;
let isLoading = false;
let prevHref = '';
let onUrlChange: ((href: string) => void) | null = null;
// Keys pressed inside a tab's page never reach this page's own listeners, so the menu's shortcuts
// (the panic key above all) are handed each one too.
let onFrameKeydown: ((e: KeyboardEvent) => void) | null = null;
let tabBar: HTMLDivElement | null = null;
let frameContainer: HTMLDivElement | null = null;
// Keyed by site origin, so each site's icon is fetched once rather than on every page.
const faviconCache = new Map<string, Promise<string>>();
// Recently closed tabs, newest first, for Reopen Closed Tab. Kept in memory only: just the address
// and title, never saved, so nothing outlives this page.
const closed: { src: string; title: string }[] = [];
const MAX_CLOSED = 10;

function nextId() {
  return idCounter++;
}

// A site's address as a tab opens it, with the engine chosen in Settings.
async function encodeForTab(url: string): Promise<string> {
  return encodeProxyUrl(url, await ConfigAPI.get('backend'));
}

function truncate(str: string, len = 12): string {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

async function loadFavicon(origin: string): Promise<string> {
  try {
    await ensureTransport();
    // Only the site's origin is sent to the favicon service, never the page's full URL.
    bmClient ??= new baremux.BareClient(PERSEC_PATHS.files.bareMuxWorker);
    const res = await bmClient.fetch(faviconApi + encodeURIComponent(origin));
    if (!res.ok) return defaultIcon;
    const blob = await res.blob();
    return await new Promise(r => {
      const reader = new FileReader();
      reader.onloadend = () => r(reader.result as string);
      reader.onerror = () => r(defaultIcon);
      reader.readAsDataURL(blob);
    });
  } catch {
    return defaultIcon;
  }
}

function fetchFavicon(url: string): Promise<string> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return Promise.resolve(defaultIcon);
  }
  if (!faviconCache.has(origin)) faviconCache.set(origin, loadFavicon(origin));
  return faviconCache.get(origin)!;
}

function updateTabEl(tab: Tab, field: 'title' | 'icon') {
  if (!tab.el) return;
  if (field === 'title') {
    const span = tab.el.querySelector('.tab-title');
    if (span) span.textContent = truncate(tab.title);
    // The visible title is cut short; screen readers get all of it.
    tab.el.querySelector('[role="tab"]')?.setAttribute('aria-label', tab.title);
    tab.el.querySelector('.tab-close')?.setAttribute('aria-label', `Close ${tab.title}`);
    tab.iframe?.setAttribute('title', tab.title);
  } else {
    const img = tab.el.querySelector('.tab-favicon') as HTMLImageElement | null;
    if (img && img.src !== tab.favicon) {
      img.src = tab.favicon;
    }
  }
}

function pollTitle(tab: Tab) {
  if (tab.titleTimer) clearInterval(tab.titleTimer);
  let lastTitle = tab.title;
  tab.titleTimer = window.setInterval(() => {
    try {
      const doc = tab.iframe.contentDocument;
      if (!doc) return;
      let title = doc.title || '';
      try {
        title = decodeURIComponent(title);
      } catch {}
      title = title.trim();
      if (title && title !== lastTitle) {
        lastTitle = title;
        tab.title = title;
        updateTabEl(tab, 'title');
      }
    } catch {}
  }, 1000);
}

async function handleFrameLoad(tab: Tab) {
  try {
    const doc = tab.iframe.contentDocument;
    let pageTitle = doc?.title || '';
    try {
      pageTitle = decodeURIComponent(pageTitle);
    } catch {}
    tab.title = pageTitle.trim() || 'New Tab';
    updateTabEl(tab, 'title');
    pollTitle(tab);

    const decoded = decodeProxyUrl(doc?.location.href || '');
    if (decoded) {
      fetchFavicon(decoded).then(icon => {
        tab.favicon = icon;
        updateTabEl(tab, 'icon');
      });
    } else {
      tab.favicon = defaultIcon;
      updateTabEl(tab, 'icon');
    }

    tab.isReady = true;
    updateUrlBar(tab);
  } catch {
    tab.favicon = defaultIcon;
    updateTabEl(tab, 'icon');
    tab.isReady = true;
  }
}

function updateUrlBar(tab: Tab) {
  if (tab.id !== activeId) return;

  const urlInput = document.getElementById('urlbar') as HTMLInputElement | null;
  if (!urlInput) return;

  try {
    const doc = tab.iframe.contentDocument;
    if (!doc) return;

    const href = doc.location.href || '';
    const pathname = new URL(href, location.origin).pathname;
    urlInput.value = internalName(pathname) ?? decodeProxyUrl(href);
  } catch {}
}

function createFrame(id: number, src?: string): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.id = `frame-${id}`;
  frame.src = src ?? 'new';
  frame.className = 'w-full z-0 h-full hidden';
  frame.setAttribute(
    'sandbox',
    'allow-scripts allow-popups allow-modals allow-top-navigation allow-pointer-lock allow-same-origin allow-forms',
  );
  // Every page Scramjet starts in this frame, subframes too, gets the guards before its own
  // scripts run. Ultraviolet pages only get the window.open fix below, once loaded.
  scramjetWrapper
    .tagFrame(frame)
    .addEventListener('contextInit', ({ window: win, client }) =>
      applyGuards(win, client, guards, openInNewTab),
    );
  frame.addEventListener('load', () => {
    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc) return;
      // Every page is a new window: proxied sites run on Persec's origin, so this reaches them too.
      win.addEventListener('keydown', e => onFrameKeydown?.(e), true);
      // The leak guard (Settings) already sends every new window to a Persec tab.
      if ((win as any)[Symbol.for('persec leak guard')]) return;
      // The engine's own window.open proxies the address and returns a real window, which sign-in
      // pop-ups need: the site navigates it, watches it, and the pop-up messages its opener (GeForce
      // NOW gives up at once when it gets null). It also handles _self, _top and _parent, which
      // navigate this tab. Only when the browser blocks the pop-up does the address open in a new
      // Persec tab instead, as every window.open did before. A noopener pop-up opens but returns
      // null by design, so it never gets a second, Persec tab.
      const open = win.open;
      win.open = (...args: Parameters<typeof open>) => {
        const opened = open.apply(win, args);
        const [openUrl, , features] = args;
        if (!opened && openUrl && !/\bno(opener|referrer)\b/i.test(String(features ?? ''))) {
          openInNewTab(openUrl.toString());
        }
        return opened;
      };
    } catch {}
  });
  return frame;
}

// A site's address (or, should a page hand over its proxied one, that) in a new Persec tab.
function openInNewTab(url: string) {
  const real = decodeProxyUrl(new URL(url, location.href).href) || url;
  encodeForTab(real).then(proxyUrl => openTab(proxyUrl));
}

// The saved guards, kept current: Settings announces changes on GUARDS_CHANNEL.
let guards: Guards = readGuards({});
async function loadGuards() {
  const keys = ['userAgent', 'fingerprintNoise', 'leakGuard', 'siteFixes'] as const;
  const values = await Promise.all(keys.map(k => ConfigAPI.get(k)));
  guards = readGuards(Object.fromEntries(keys.map((k, i) => [k, values[i]])), sessionStorage);
}
if (typeof window !== 'undefined') {
  loadGuards().catch(() => {});
  try {
    const channel = new BroadcastChannel(GUARDS_CHANNEL);
    channel.onmessage = () => loadGuards().catch(() => {});
    // Node (the tests) would otherwise stay running for the channel.
    (channel as { unref?: () => void }).unref?.();
  } catch {}
}

function getTabClass(active: boolean): string {
  const base =
    'tab flex items-center justify-between h-10 min-w-[130px] max-w-[160px] sm:min-w-[180px] sm:max-w-[200px] px-3 py-2 rounded-t-xl cursor-pointer select-none transition-all duration-200 relative z-10 mx-0.5 border border-b-0 border-[color:var(--border)] gap-2';
  return active
    ? `${base} bg-[color:var(--background)] shadow-[0_4px_16px_#23213660] text-[color:var(--text-header)]`
    : `${base} bg-[color:var(--background-overlay)] hover:bg-[color:var(--background)] text-[color:var(--text-secondary)] opacity-70 hover:opacity-90`;
}

// Each tab is a select button (role="tab") and a separate close button, so closing never also
// selects. Arrow keys, Home and End move between tabs; Delete closes the focused one.
function createTabEl(tab: Tab): HTMLDivElement {
  const el = document.createElement('div');
  el.className = getTabClass(tab.id === activeId);
  el.setAttribute('role', 'presentation');

  const left = document.createElement('button');
  left.type = 'button';
  left.setAttribute('role', 'tab');
  left.setAttribute('aria-label', tab.title);
  left.setAttribute('aria-controls', `frame-${tab.id}`);
  left.className =
    'flex items-center gap-2 flex-1 min-w-0 text-left rounded-md focus-visible:outline-2 focus-visible:outline-[#8b87ff]';
  left.style.height = '100%';

  const icon = document.createElement('img');
  icon.className = 'tab-favicon flex-shrink-0';
  icon.src = tab.favicon;
  icon.width = 16;
  icon.height = 16;
  icon.style.width = '16px';
  icon.style.height = '16px';
  icon.style.objectFit = 'contain';
  icon.style.display = 'block';

  const title = document.createElement('span');
  title.className = 'tab-title truncate text-sm font-normal flex-1 min-w-0';
  title.style.overflow = 'hidden';
  title.style.textOverflow = 'ellipsis';
  title.style.whiteSpace = 'nowrap';
  title.style.lineHeight = '1';
  title.style.display = 'flex';
  title.style.alignItems = 'center';
  title.textContent = truncate(tab.title, 14);

  left.append(icon, title);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className =
    'tab-close focus-visible:outline-2 focus-visible:outline-[#8b87ff] flex items-center justify-center w-7 h-7 -mr-1.5 sm:w-5 sm:h-5 sm:mr-0 flex-shrink-0 rounded-full bg-transparent hover:bg-[color:var(--background-disabled)] text-[color:var(--text-secondary)] hover:text-red-400 transition-all duration-200 text-base leading-none';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', `Close ${tab.title}`);
  closeBtn.style.fontWeight = '400';
  closeBtn.style.padding = '0';
  closeBtn.style.lineHeight = '1';
  closeBtn.onclick = e => {
    e.stopPropagation();
    closeTab(tab.id);
  };

  el.append(left, closeBtn);
  left.onclick = () => switchTab(tab.id);
  left.onkeydown = e => {
    const i = tabs.indexOf(tab);
    const to =
      e.key === 'ArrowRight'
        ? tabs[(i + 1) % tabs.length]
        : e.key === 'ArrowLeft'
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === 'Home'
            ? tabs[0]
            : e.key === 'End'
              ? tabs[tabs.length - 1]
              : null;
    if (to) {
      e.preventDefault();
      switchTab(to.id);
      to.el?.querySelector<HTMLElement>('[role="tab"]')?.focus();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      closeTab(tab.id);
      tabs
        .find(t => t.id === activeId)
        ?.el?.querySelector<HTMLElement>('[role="tab"]')
        ?.focus();
    }
  };
  tab.el = el;
  return el;
}

function renderTabs() {
  if (!tabBar) return;
  const existingTabs = tabBar.querySelectorAll('.tab');
  const hasChanges = existingTabs.length !== tabs.length;

  if (!hasChanges) return;

  tabBar.innerHTML = '';
  const wrapper = document.createElement('div');
  // Starts at the left: tabs overflowing a centered row can't be scrolled back to.
  wrapper.className = 'flex items-center justify-start w-full';
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'flex items-center gap-0';
  for (const tab of tabs) {
    tabsContainer.appendChild(tab.el ?? createTabEl(tab));
  }
  wrapper.appendChild(tabsContainer);
  tabBar.appendChild(wrapper);
}

function updateActive() {
  for (const tab of tabs) {
    if (!tab.el) continue;
    const active = tab.id === activeId;
    tab.el.className = getTabClass(active);
    // Only the selected tab and its close button are in the Tab order; arrows reach the rest.
    const select = tab.el.querySelector('[role="tab"]');
    select?.setAttribute('aria-selected', String(active));
    select?.setAttribute('tabindex', active ? '0' : '-1');
    tab.el.querySelector('.tab-close')?.setAttribute('tabindex', active ? '0' : '-1');
  }
  // On narrow screens the tab row scrolls, so keep the active tab in view.
  tabs.find(t => t.id === activeId)?.el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// What to open to bring a tab back: an internal page's path, or the site's real address (encoded
// again when reopened, with whichever engine is set then).
function tabSource(tab: Tab): string {
  try {
    const href = tab.iframe.contentWindow?.location.href || '';
    const path = new URL(href, location.origin).pathname;
    return internalName(path) ? path : decodeProxyUrl(href);
  } catch {
    return '';
  }
}

function closeTab(id: number) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const src = tabSource(tabs[idx]);
  // A blank new tab isn't worth bringing back.
  if (src && src !== '/new') {
    closed.unshift({ src, title: tabs[idx].title });
    closed.length = Math.min(closed.length, MAX_CLOSED);
  }

  if (tabs.length === 1) {
    openTab();
    requestAnimationFrame(() => {
      const [removed] = tabs.splice(idx, 1);
      if (removed.titleTimer) clearInterval(removed.titleTimer);
      removed.iframe.remove();
      renderTabs();
    });
    return;
  }

  const [removed] = tabs.splice(idx, 1);
  if (removed.titleTimer) clearInterval(removed.titleTimer);
  removed.iframe.remove();
  if (activeId === id && tabs.length) {
    const newActiveId = tabs[Math.max(0, idx - 1)].id;
    switchTab(newActiveId);
  }
  renderTabs();
}

function showLoader() {
  const bar = document.getElementById('loading-bar') as HTMLDivElement | null;
  if (!bar || isLoading) return;
  isLoading = true;
  bar.style.cssText = 'display:block;opacity:1;width:0%;transition:none';
  requestAnimationFrame(() => {
    if (!isLoading) return;
    bar.style.cssText =
      'display:block;opacity:1;width:80%;transition:width .5s cubic-bezier(.4,0,.2,1)';
  });
  loadTimer = setTimeout(() => {
    if (isLoading && bar) {
      bar.style.transition = 'width .3s cubic-bezier(.4,0,.2,1)';
      bar.style.width = '90%';
    }
  }, 1200);
}

function hideLoader() {
  const bar = document.getElementById('loading-bar') as HTMLDivElement | null;
  if (!bar || !isLoading) return;
  bar.style.cssText =
    'display:block;opacity:1;width:100%;transition:width .2s cubic-bezier(.4,0,.2,1)';
  setTimeout(() => {
    bar.style.cssText = 'display:none;opacity:0;width:0%';
    isLoading = false;
  }, 180);
}

function resetLoader() {
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  hideLoader();
}

function openTab(src?: string) {
  const id = nextId();

  if (!frameContainer) {
    document.addEventListener('DOMContentLoaded', () => openTab(src), { once: true });
    return;
  }

  const tab: Tab = {
    id,
    title: 'New Tab',
    favicon: defaultIcon,
    iframe: null as any,
    isReady: false,
  };

  tabs.push(tab);

  const tabEl = createTabEl(tab);
  if (tabBar) {
    const wrapper =
      tabBar.querySelector('.flex.items-center.justify-start') || document.createElement('div');
    wrapper.className = 'flex items-center justify-start w-full';
    const container =
      wrapper.querySelector('.flex.items-center.gap-0') || document.createElement('div');
    container.className = 'flex items-center gap-0';
    container.appendChild(tabEl);
    if (!wrapper.parentElement) {
      wrapper.appendChild(container);
      tabBar.appendChild(wrapper);
    }
  }

  requestAnimationFrame(() => {
    const frame = createFrame(id, src);
    tab.iframe = frame;
    frameContainer!.appendChild(frame);

    switchTab(id);

    const urlInput = document.getElementById('urlbar') as HTMLInputElement | null;
    if (urlInput && (!src || src === 'new')) urlInput.value = '';

    frame.onload = () => {
      handleFrameLoad(tab);
      resetLoader();
    };
    frame.onerror = resetLoader;
  });
}

function switchTab(id: number) {
  activeId = id;

  if (urlWatcher) {
    clearInterval(urlWatcher);
    urlWatcher = null;
  }

  prevHref = '';

  for (const tab of tabs) {
    if (tab.iframe) tab.iframe.classList.toggle('hidden', tab.id !== id);
  }

  updateActive();
  resetLoader();

  const activeTab = tabs.find(t => t.id === id);
  if (activeTab && activeTab.isReady) {
    updateUrlBar(activeTab);

    try {
      const doc = activeTab.iframe?.contentDocument;
      if (doc) {
        let title = doc.title || '';
        try {
          title = decodeURIComponent(title);
        } catch {}
        title = title.trim();
        activeTab.title = title || 'New Tab';
        updateTabEl(activeTab, 'title');

        const decoded = decodeProxyUrl(doc.location.href || '');
        if (decoded) {
          fetchFavicon(decoded).then(icon => {
            activeTab.favicon = icon;
            updateTabEl(activeTab, 'icon');
          });
        }
      }
    } catch {}
  }

  urlWatcher = setInterval(() => {
    if (activeId !== id) return;

    try {
      const tab = tabs.find(t => t.id === id);
      if (!tab?.iframe) return;
      const href = tab.iframe.contentWindow?.location.href;
      if (!href || href === prevHref) return;
      prevHref = href;

      const urlInput = document.getElementById('urlbar') as HTMLInputElement | null;
      if (urlInput) {
        const pathname = new URL(href, location.origin).pathname;
        urlInput.value = internalName(pathname) ?? decodeProxyUrl(href);
      }

      if (tab) {
        const doc = tab.iframe.contentDocument;
        if (doc) {
          let title = doc.title || '';
          try {
            title = decodeURIComponent(title);
          } catch {}
          title = title.trim();
          if (title && title !== tab.title) {
            tab.title = title;
            updateTabEl(tab, 'title');
          }

          const decoded = decodeProxyUrl(doc.location.href || '');
          if (decoded) {
            fetchFavicon(decoded).then(icon => {
              tab.favicon = icon;
              updateTabEl(tab, 'icon');
            });
          }
        }
      }
      if (onUrlChange) onUrlChange(href);
    } catch {}
  }, 150);
}

function start() {
  tabBar = document.getElementById('tcontainer') as HTMLDivElement | null;
  frameContainer = document.getElementById('fcontainer') as HTMLDivElement | null;
  document.getElementById('add')?.addEventListener('click', () => openTab());
  const urlbar = document.getElementById('urlbar') as HTMLInputElement | null;
  urlbar?.addEventListener('keydown', e => {
    if (e.key === 'Enter') showLoader();
  });
  loadWatcher = setInterval(() => {
    if (!isLoading) return;
    const tab = tabs.find(t => t.id === activeId);
    if (tab?.iframe?.contentDocument?.readyState === 'complete') resetLoader();
  }, 400);
  openTab();
}

function cleanup() {
  if (urlWatcher) {
    clearInterval(urlWatcher);
    urlWatcher = null;
  }
  if (loadTimer) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  if (loadWatcher) {
    clearInterval(loadWatcher);
    loadWatcher = null;
  }
  for (const tab of tabs) {
    if (tab.titleTimer) clearInterval(tab.titleTimer);
  }
}

export const TabManager = {
  get activeTabId() {
    return activeId;
  },
  get activeFavicon() {
    return tabs.find(t => t.id === activeId)?.favicon ?? defaultIcon;
  },
  set activeTabId(id: number | null) {
    if (id !== null) switchTab(id);
  },
  openTab,
  // Returns false when there's nothing to reopen.
  async reopenClosed(): Promise<boolean> {
    const last = closed.shift();
    if (!last) return false;
    openTab(last.src.startsWith('/') ? last.src : await encodeForTab(last.src));
    return true;
  },
  onUrlChange: (cb: (href: string) => void) => {
    onUrlChange = cb;
  },
  onFrameKeydown: (cb: (e: KeyboardEvent) => void) => {
    onFrameKeydown = cb;
  },
};

// Sets up the tab strip in the page that has it (src/layouts/tab.astro). Loading this module does
// nothing on its own, so other modules (and tests) can import TabManager without a tab strip.
export function initTabs() {
  // Read by pages in the tabs, which can't import this module (src/components/CookieBanner.astro).
  (globalThis as any).TabManager = TabManager;
  window.addEventListener('unload', cleanup);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
