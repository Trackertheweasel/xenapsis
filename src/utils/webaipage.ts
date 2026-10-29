// The Web AI page (/webai, persec://webai). Opens ChatGPT or Claude in a Persec tab (the standard
// proxy), or, when the server has browser mode, in a Camoufox session on the server. Talks to
// /api/browser/* only for browser mode, and never to PerSec AI's routes.
import { openInPersec } from './bookmarks';
import ConfigAPI from './config';
import {
  WEB_AI_SITES,
  browserModeOn,
  describeState,
  errorMessage,
  siteForUrl,
  verificationWarning,
  type BrowserMode,
  type PageState,
} from './webai';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const ui = {
  modes: $('[data-modes]'),
  status: $('[data-status]'),
  session: $('[data-session]'),
  where: $('[data-where]'),
  shot: $<HTMLImageElement>('[data-shot]'),
  blocked: $('[data-blocked]'),
  blockedText: $('[data-blocked-text]'),
  refresh: $<HTMLButtonElement>('[data-refresh]'),
  end: $<HTMLButtonElement>('[data-end]'),
  warning: $('[data-verify-warning]'),
  warningText: $('[data-verify-warning-text]'),
};

const say = (text: string) => (ui.status.textContent = text);

let session: { id: string; site: string } | null = null;
let poll: number | null = null;

const mode = (): BrowserMode =>
  !ui.modes.hidden &&
  document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value === 'camoufox'
    ? 'camoufox'
    : 'proxy';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`/api/browser${path}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function show(state: PageState | null) {
  if (!session) return;
  // A session picked up from an earlier visit is named after where it is.
  if (!session.site) session.site = (state && siteForUrl(state.url)?.name) || 'The site';
  ui.session.hidden = false;
  ui.where.textContent = state && !state.blocked ? describeState(session.site, state) : '';
  ui.blocked.hidden = !!state && !state.blocked;
  ui.blockedText.textContent = describeState(session.site, state);
  // A new URL each time, so the browser fetches the current picture instead of a cached one.
  ui.shot.src = `/api/browser/sessions/${encodeURIComponent(session.id)}/screenshot?t=${Date.now()}`;
}

function ended(message: string) {
  session = null;
  if (poll) clearInterval(poll);
  poll = null;
  ui.session.hidden = true;
  ui.shot.removeAttribute('src');
  say(message);
}

async function refresh() {
  if (!session) return;
  const res = await api('GET', `/sessions/${encodeURIComponent(session.id)}`);
  if (res.status === 404) return ended('The Camoufox session has ended.');
  if (!res.ok) return say(errorMessage(res.data, 'Couldn’t reach the session.'));
  show(res.data.state);
}

function watch() {
  if (poll) clearInterval(poll);
  // Only while the page is on screen, so a forgotten tab lets the session time out.
  poll = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, 5000);
}

async function openInBrowserMode(siteId: string, name: string) {
  if (session) {
    say('End your current Camoufox session first.');
    return;
  }
  say(`Starting a Camoufox session for ${name}…`);
  const res = await api('POST', '/sessions', { site: siteId });
  if (!res.ok) return say(errorMessage(res.data, 'Couldn’t start a session.'));
  session = { id: res.data.session.id, site: name };
  say('');
  if (res.data.error) say(errorMessage(res.data, ''));
  show(res.data.state);
  watch();
}

document.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(button => {
  const site = WEB_AI_SITES.find(s => s.id === button.dataset.open);
  if (!site) return;
  button.addEventListener('click', async () => {
    if (mode() === 'camoufox') {
      button.disabled = true;
      try {
        await openInBrowserMode(site.id, site.name);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (!window.parent.document.getElementById('urlbar')) {
      say(`Open this page in a Persec tab to open ${site.name}.`);
      return;
    }
    openInPersec(site.url);
  });
});

ui.refresh.addEventListener('click', () => void refresh());
ui.end.addEventListener('click', async () => {
  if (!session) return;
  ui.end.disabled = true;
  try {
    await api('DELETE', `/sessions/${encodeURIComponent(session.id)}`);
    ended('Session ended. Its cookies and data were deleted.');
  } finally {
    ui.end.disabled = false;
  }
});

(async () => {
  try {
    const [userAgent, fingerprintNoise] = await Promise.all([
      ConfigAPI.get('userAgent'),
      ConfigAPI.get('fingerprintNoise'),
    ]);
    const warning = verificationWarning({ userAgent, fingerprintNoise });
    ui.warning.hidden = !warning;
    ui.warningText.textContent = warning ?? '';
  } catch {}
})();

// Browser mode exists only where the server says so; otherwise the page is just the two sites.
(async () => {
  try {
    const status = await api('GET', '/status');
    if (!browserModeOn(status.data)) return;
    ui.modes.hidden = false;
    // Pick up a session left open by an earlier visit.
    const current = await api('GET', '/sessions/current');
    const open = current.ok ? current.data?.session : null;
    if (open?.id) {
      session = { id: open.id, site: '' };
      document.querySelector<HTMLInputElement>('input[value="camoufox"]')!.checked = true;
      await refresh();
      watch();
    }
  } catch {}
})();
