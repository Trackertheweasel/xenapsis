// Web AI: the real ChatGPT and Claude websites, opened like any other site. This is not PerSec AI
// (the /ai page, which sends messages through this server to OpenRouter). Nothing here talks to
// either company's API or touches a sign-in: the person uses the site itself.
//
//   Standard proxy   the site runs in a Persec tab, through Scramjet/Ultraviolet and the tunnel
//   Browser mode     the site runs in a real browser on the server (only where the owner set one
//                    up; serverlib/browser/), and the page shows what it's showing
//
// The server's list (serverlib/browser/sites.ts) has the same two sites; tests keep them in step.

export interface WebAiSite {
  id: 'chatgpt' | 'claude';
  name: string;
  maker: string;
  // The site's ordinary public address.
  url: string;
  description: string;
}

export const WEB_AI_SITES: readonly WebAiSite[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    maker: 'OpenAI',
    url: 'https://chatgpt.com/',
    description: 'The ChatGPT website. Sign in with your own OpenAI account, or use it signed out.',
  },
  {
    id: 'claude',
    name: 'Claude',
    maker: 'Anthropic',
    url: 'https://claude.ai/',
    description: 'The Claude website. Sign in with your own Anthropic account.',
  },
];

// The Web AI site an address belongs to (its host or a subdomain of it), if any.
export function siteForUrl(url: string): WebAiSite | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return WEB_AI_SITES.find(s => {
      const own = new URL(s.url).hostname;
      return host === own || host.endsWith(`.${own}`);
    });
  } catch {
    return undefined;
  }
}

export type BrowserMode = 'proxy' | 'camoufox';

// What /api/browser/status says, read defensively: anything but a clear yes means it's off.
export function browserModeOn(status: unknown): boolean {
  return (
    !!status && typeof status === 'object' && (status as { enabled?: unknown }).enabled === true
  );
}

export interface PageState {
  url: string;
  title: string;
  blocked: boolean;
}

// The one line shown under a browser-mode session. A site checking or refusing the browser is
// said plainly, with what to do instead; Persec never tries to get past those checks.
export function describeState(site: string, state: PageState | null): string {
  if (!state) return `${site} didn’t finish loading. Try reloading, or end the session.`;
  if (state.blocked) {
    return `${site} is checking or refusing this browser. Persec doesn’t try to get past these checks. Try the standard proxy, or open ${site} directly.`;
  }
  let where = state.url;
  try {
    const u = new URL(state.url);
    where = u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {}
  return state.title ? `${state.title} — ${where}` : where;
}

// The message the server sent with a failure, or a fallback.
export function errorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message ? message : fallback;
}
