import { randomBytes } from 'node:crypto';

// The optional browser runtime: a real browser (Camoufox) running server-side, which a signed-in
// person can open ChatGPT or Claude in, in a session nobody else can reach. It is a third system
// next to the web proxy (Wisp, Scramjet, Ultraviolet) and PerSec AI (OpenRouter), and shares
// nothing with either:
//
//   browser  ->  /api/browser/*  ->  SessionManager  ->  BrowserRuntime (camoufox.ts)  ->  site
//
// Off unless the deployment sets CAMOUFOX_ENABLED and points CAMOUFOX_WS_ENDPOINT at a browser
// service it runs separately (docs/browser-runtime.md). The browser is never started by this
// process, never downloaded by `pnpm install`, and nothing about it is chosen by a client: the
// endpoint, binary, profile and proxy all come from the server's environment or not at all.
//
// It is not a way around a site's own checks. When a site shows a challenge or refuses the
// session, Persec reports that (PageState.blocked) and does nothing else about it.

export interface BrowserConfig {
  enabled: boolean;
  // A Playwright server for Camoufox's Firefox (ws:// or wss://), on a private network.
  wsEndpoint: string | null;
  maxSessions: number;
  sessionTimeoutMs: number;
  idleTimeoutMs: number;
}

// One person may hold one session at a time, and start a few per window, so nobody can hold every
// slot or churn browsers.
export const MAX_SESSIONS_PER_PERSON = 1;
export const CREATES_PER_WINDOW = 6;
export const CREATE_WINDOW_MS = 10 * 60_000;

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? '');
const positive = (v: string | undefined, fallback: number, min: number) => {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

export function loadBrowserConfig(env: NodeJS.ProcessEnv = process.env): BrowserConfig {
  const endpoint = env.CAMOUFOX_WS_ENDPOINT?.trim() || null;
  return {
    enabled: truthy(env.CAMOUFOX_ENABLED),
    wsEndpoint: endpoint && /^wss?:\/\/[^/\s]+/i.test(endpoint) ? endpoint : null,
    maxSessions: positive(env.CAMOUFOX_MAX_SESSIONS, 2, 1),
    sessionTimeoutMs: positive(env.CAMOUFOX_SESSION_TIMEOUT_MS, 30 * 60_000, 60_000),
    idleTimeoutMs: positive(env.CAMOUFOX_IDLE_TIMEOUT_MS, 5 * 60_000, 30_000),
  };
}

export interface PageState {
  url: string;
  title: string;
  // The page looks like a bot check or a refusal ("Just a moment…", "Verify you are human"). Shown
  // to the person as it is; Persec never tries to get past one.
  blocked: boolean;
}

// One isolated browser context: its own cookies, storage and cache, gone when it closes.
export interface BrowserContextHandle {
  navigate(url: string): Promise<PageState>;
  state(): Promise<PageState>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface BrowserRuntime {
  readonly id: string;
  // onGone runs once if the context dies on its own (the page or the whole browser crashed).
  newContext(onGone: () => void): Promise<BrowserContextHandle>;
  close(): Promise<void>;
}

export type BrowserErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'unavailable_open_mode'
  | 'invalid_request'
  | 'invalid_url'
  | 'site_not_allowed'
  | 'not_found'
  | 'too_many_sessions'
  | 'server_busy'
  | 'rate_limited'
  | 'runtime_unavailable'
  | 'navigation_failed'
  | 'internal';

const ERRORS: Record<BrowserErrorCode, [status: number, message: string]> = {
  disabled: [404, 'Browser mode is not turned on for this server.'],
  not_configured: [503, 'Browser mode is turned on but no browser service is set up.'],
  unavailable_open_mode: [
    503,
    'Browser mode needs invite-only mode, so every session belongs to someone.',
  ],
  invalid_request: [400, 'That request is not valid.'],
  invalid_url: [400, 'That address can’t be opened in browser mode.'],
  site_not_allowed: [400, 'Browser mode only opens ChatGPT and Claude.'],
  not_found: [404, 'That browser session has ended.'],
  too_many_sessions: [409, 'You already have a browser session open. End it first.'],
  server_busy: [503, 'Every browser on this server is in use. Try again later.'],
  rate_limited: [429, 'Too many new sessions. Wait a few minutes.'],
  runtime_unavailable: [502, 'The browser service could not be reached.'],
  navigation_failed: [502, 'The page did not load.'],
  internal: [500, 'Something went wrong. Try again.'],
};

export class BrowserError extends Error {
  readonly status: number;
  constructor(readonly code: BrowserErrorCode) {
    const [status, message] = ERRORS[code];
    super(message);
    this.status = status;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const isBrowserError = (err: unknown): err is BrowserError => err instanceof BrowserError;

// Titles of interstitials that mean "this browser is being checked or refused". Matching only
// decides what to tell the person.
const BLOCKED_TITLE =
  /just a moment|attention required|verify (that )?you are (a )?human|checking (if the site connection is secure|your browser)|access denied|couldn['’]t verify|unable to verify/i;

export const looksBlocked = (title: string, url = '') =>
  BLOCKED_TITLE.test(title) || /\/cdn-cgi\/challenge-platform\//.test(url);

export interface SessionInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
}

interface Session extends SessionInfo {
  owner: string;
  ctx: BrowserContextHandle;
  lastUsed: number;
  idle: NodeJS.Timeout;
  lifetime: NodeJS.Timeout;
}

// Owns every session: who it belongs to, how long it may live, and closing it. Sessions are found
// by owner and ID together, so a guessed or leaked ID is no use to anyone else, and someone else's
// session looks exactly like one that doesn't exist.
export class SessionManager {
  private sessions = new Map<string, Session>();
  // Slots taken by sessions still starting, so concurrent requests can't overshoot the limits.
  private pending = new Map<string, number>();
  private creates = new Map<string, number[]>();
  private closed = false;

  constructor(
    readonly runtime: BrowserRuntime,
    readonly config: Pick<BrowserConfig, 'maxSessions' | 'sessionTimeoutMs' | 'idleTimeoutMs'>,
    private now: () => number = Date.now,
  ) {}

  get size() {
    return this.sessions.size;
  }

  private countFor(owner: string) {
    let n = this.pending.get(owner) ?? 0;
    for (const s of this.sessions.values()) if (s.owner === owner) n++;
    return n;
  }

  private totalPending() {
    let n = 0;
    for (const v of this.pending.values()) n += v;
    return n;
  }

  private takeCreate(owner: string) {
    const now = this.now();
    const recent = (this.creates.get(owner) ?? []).filter(t => t > now - CREATE_WINDOW_MS);
    if (recent.length >= CREATES_PER_WINDOW) throw new BrowserError('rate_limited');
    recent.push(now);
    this.creates.set(owner, recent);
  }

  async create(owner: string): Promise<SessionInfo> {
    if (this.closed) throw new BrowserError('server_busy');
    if (this.countFor(owner) >= MAX_SESSIONS_PER_PERSON)
      throw new BrowserError('too_many_sessions');
    if (this.sessions.size + this.totalPending() >= this.config.maxSessions) {
      throw new BrowserError('server_busy');
    }
    this.takeCreate(owner);
    this.pending.set(owner, (this.pending.get(owner) ?? 0) + 1);
    const id = randomBytes(18).toString('base64url');
    // A context can die before it is registered; then it never becomes a session.
    let gone = false;
    try {
      const ctx = await this.runtime.newContext(() => {
        gone = true;
        void this.destroy(id);
      });
      if (this.closed || gone) {
        await ctx.close().catch(() => {});
        throw new BrowserError(gone ? 'runtime_unavailable' : 'server_busy');
      }
      const now = this.now();
      const session: Session = {
        id,
        owner,
        ctx,
        createdAt: now,
        expiresAt: now + this.config.sessionTimeoutMs,
        lastUsed: now,
        idle: this.timer(id, this.config.idleTimeoutMs),
        lifetime: this.timer(id, this.config.sessionTimeoutMs),
      };
      this.sessions.set(id, session);
      return { id, createdAt: session.createdAt, expiresAt: session.expiresAt };
    } catch (err) {
      throw isBrowserError(err) ? err : new BrowserError('runtime_unavailable');
    } finally {
      const left = (this.pending.get(owner) ?? 1) - 1;
      if (left > 0) this.pending.set(owner, left);
      else this.pending.delete(owner);
    }
  }

  // Ends the session after ms, without keeping the process alive for it.
  private timer(id: string, ms: number) {
    const t = setTimeout(() => void this.destroy(id), ms);
    t.unref?.();
    return t;
  }

  // The session, if it exists and is this owner's. Using it counts as activity.
  private use(owner: string, id: unknown): Session {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!s || s.owner !== owner) throw new BrowserError('not_found');
    s.lastUsed = this.now();
    clearTimeout(s.idle);
    s.idle = this.timer(s.id, this.config.idleTimeoutMs);
    return s;
  }

  info(owner: string, id: unknown): SessionInfo {
    const { createdAt, expiresAt } = this.use(owner, id);
    return { id: id as string, createdAt, expiresAt };
  }

  // The owner's open session, if any, so a reloaded page can pick it up again.
  current(owner: string): SessionInfo | null {
    for (const s of this.sessions.values()) {
      if (s.owner === owner) return { id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt };
    }
    return null;
  }

  async navigate(owner: string, id: unknown, url: string): Promise<PageState> {
    const s = this.use(owner, id);
    try {
      return await s.ctx.navigate(url);
    } catch (err) {
      if (isBrowserError(err)) throw err;
      throw new BrowserError(this.sessions.has(s.id) ? 'navigation_failed' : 'not_found');
    }
  }

  async state(owner: string, id: unknown): Promise<PageState> {
    const s = this.use(owner, id);
    try {
      return await s.ctx.state();
    } catch {
      throw new BrowserError(this.sessions.has(s.id) ? 'runtime_unavailable' : 'not_found');
    }
  }

  async screenshot(owner: string, id: unknown): Promise<Buffer> {
    const s = this.use(owner, id);
    try {
      return await s.ctx.screenshot();
    } catch {
      throw new BrowserError(this.sessions.has(s.id) ? 'runtime_unavailable' : 'not_found');
    }
  }

  // Ends the owner's session. Ending one that's already gone is not an error.
  async end(owner: string, id: unknown): Promise<void> {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (s && s.owner === owner) await this.destroy(s.id);
  }

  private async destroy(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    clearTimeout(s.idle);
    clearTimeout(s.lifetime);
    // The context takes its cookies and storage with it; nothing is kept or copied out.
    await s.ctx.close().catch(() => {});
  }

  // On server shutdown: refuse new sessions, close every one, then the runtime.
  async shutdown() {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map(id => this.destroy(id)));
    await this.runtime.close().catch(() => {});
  }
}
