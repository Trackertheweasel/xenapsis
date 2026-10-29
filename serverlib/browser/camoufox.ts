import { BrowserError, looksBlocked } from './index';
import type { BrowserContextHandle, BrowserRuntime, PageState } from './index';
import { isBlockedRequest } from './url';

// Camoufox as a BrowserRuntime. Persec does not start or download the browser: the deployment
// runs Camoufox's Playwright server as its own service (docs/browser-runtime.md) and sets
// CAMOUFOX_WS_ENDPOINT to it. This connects with Playwright's Firefox client, which talks to
// Camoufox over Juggler like it would to any Firefox.
//
// playwright-core is not one of Persec's dependencies, so a normal install stays small. A
// deployment that turns browser mode on installs it next to Persec (`pnpm add playwright-core`,
// matching the Playwright version the browser service runs).

// The few parts of Playwright's API used here, so this builds without playwright-core installed.
interface PwRoute {
  request(): { url(): string };
  abort(code?: string): Promise<void>;
  continue(): Promise<void>;
}
interface PwWebSocketRoute {
  url(): string;
  close(opts?: { code?: number; reason?: string }): Promise<void>;
  connectToServer(): unknown;
}
interface PwPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  screenshot(opts: { type: 'jpeg'; quality: number; timeout: number }): Promise<Buffer>;
  close(): Promise<void>;
  on(event: 'crash' | 'close', fn: () => void): void;
  on(event: 'dialog', fn: (d: { dismiss(): Promise<void> }) => void): void;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  pages(): PwPage[];
  route(url: string, fn: (route: PwRoute) => unknown): Promise<void>;
  routeWebSocket?(url: RegExp, fn: (ws: PwWebSocketRoute) => unknown): Promise<void>;
  on(event: 'page', fn: (page: PwPage) => void): void;
  on(event: 'close', fn: () => void): void;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: Record<string, unknown>): Promise<PwContext>;
  isConnected(): boolean;
  on(event: 'disconnected', fn: () => void): void;
  close(): Promise<void>;
}
export interface PwFirefox {
  connect(wsEndpoint: string, opts: { timeout: number }): Promise<PwBrowser>;
}

const CONNECT_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;
// A site may open a sign-in popup; more pages than this in one session are closed.
const MAX_PAGES = 3;

// Loaded by name at run time so neither esbuild nor `astro check` look for it when it's absent.
async function loadFirefox(): Promise<PwFirefox> {
  const name = 'playwright-core';
  try {
    const pw = (await import(/* @vite-ignore */ name)) as { firefox?: PwFirefox };
    if (!pw.firefox) throw new Error('no firefox');
    return pw.firefox;
  } catch {
    console.warn('Browser mode: playwright-core is not installed, so no browser can start.');
    throw new BrowserError('runtime_unavailable');
  }
}

// Checks every request a context makes, the site's own included: refused when it would leave the
// web (file:, internal addresses), passed through untouched otherwise.
async function guard(context: PwContext) {
  await context.route('**/*', route =>
    isBlockedRequest(route.request().url()) ? route.abort('blockedbyclient') : route.continue(),
  );
  // Playwright 1.48+ can see WebSockets too; older clients leave them to the network's rules.
  await context.routeWebSocket?.(/.*/, ws =>
    isBlockedRequest(ws.url().replace(/^ws/i, 'http'))
      ? ws.close({ code: 1008, reason: 'blocked' })
      : ws.connectToServer(),
  );
}

async function pageState(page: PwPage): Promise<PageState> {
  const url = page.url();
  const title = (await page.title().catch(() => '')).slice(0, 300);
  return { url, title, blocked: looksBlocked(title, url) };
}

export function createCamoufoxRuntime(
  wsEndpoint: string,
  load: () => Promise<PwFirefox> = loadFirefox,
): BrowserRuntime {
  let browser: Promise<PwBrowser> | null = null;
  // What to tell each live session if the connection drops.
  const live = new Set<() => void>();

  // One connection to the browser service, made on first use and again after it drops (the
  // service restarted or the browser crashed), so a crash ends the sessions it took with it but
  // not browser mode.
  const connect = () => {
    browser ??= (async () => {
      const firefox = await load();
      const b = await firefox.connect(wsEndpoint, { timeout: CONNECT_TIMEOUT_MS });
      b.on('disconnected', () => {
        browser = null;
        for (const fn of [...live]) fn();
      });
      return b;
    })().catch(err => {
      browser = null;
      throw err instanceof BrowserError ? err : new BrowserError('runtime_unavailable');
    });
    return browser;
  };

  return {
    id: 'camoufox',

    async newContext(onGone) {
      const b = await connect();
      let ended = false;
      const gone = () => {
        live.delete(gone);
        if (ended) return;
        ended = true;
        onGone();
      };
      live.add(gone);
      // A fresh context per session: no cookies, storage or cache shared with any other, and
      // nothing written to a profile on disk. Downloads are refused.
      let context: PwContext;
      try {
        context = await b.newContext({
          acceptDownloads: false,
          viewport: { width: 1280, height: 800 },
          locale: 'en-US',
        });
      } catch {
        live.delete(gone);
        throw new BrowserError('runtime_unavailable');
      }
      try {
        await guard(context);
        context.on('close', gone);
        context.on('page', p => {
          if (context.pages().length > MAX_PAGES) void p.close().catch(() => {});
          // alert()/confirm() would otherwise hold the page until someone answers.
          p.on('dialog', d => void d.dismiss().catch(() => {}));
        });
        const page = await context.newPage();
        page.on('crash', gone);
        page.on('close', gone);

        const handle: BrowserContextHandle = {
          async navigate(url) {
            try {
              await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: NAVIGATION_TIMEOUT_MS,
              });
            } catch {
              // A page that loaded its document but kept going (or a site's error page) still has
              // a state worth showing; only a page that never answered is a failure.
              if (page.url() === 'about:blank') throw new BrowserError('navigation_failed');
            }
            return pageState(page);
          },
          state: () => pageState(page),
          screenshot: () =>
            page.screenshot({ type: 'jpeg', quality: 60, timeout: SCREENSHOT_TIMEOUT_MS }),
          async close() {
            ended = true;
            live.delete(gone);
            await context.close().catch(() => {});
          },
        };
        return handle;
      } catch (err) {
        ended = true;
        live.delete(gone);
        await context.close().catch(() => {});
        throw err;
      }
    },

    async close() {
      const b = browser;
      browser = null;
      // Connected over the network, close() disconnects; the service keeps running.
      if (b) await (await b.catch(() => null))?.close().catch(() => {});
    },
  };
}
