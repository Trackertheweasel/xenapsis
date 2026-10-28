import { BareMuxConnection } from '@mercuryworkshop/bare-mux';
import ConfigAPI, { wispUrl } from './config';

// The transport is how BareMux reaches the network. It is separate from the proxy engine:
// Scramjet and Ultraviolet both send every request through whichever transport is set here, so
// switching engines never changes what the network sees. Persec has one transport, libcurl over a
// Wisp WebSocket to this server; docs/resilience.md covers why there is no second one yet and what
// one would need. A new one is an entry in TRANSPORTS with a probe that proves it works.
export interface Transport {
  name: string;
  // The BareMux transport module, served by this site.
  module: string;
  options(): Promise<unknown[]>;
  // Resolves once the transport has carried data end to end; rejects with a TransportError.
  probe(timeoutMs: number): Promise<void>;
}

export type FailureKind =
  // The browser refused or the network dropped the connection before it opened.
  | 'refused'
  // No answer in time, e.g. a filter that holds connections open without passing them on.
  | 'timeout'
  // The server accepted the connection, then closed it before answering.
  | 'closed'
  // Persec's own worker that runs the transport did not start.
  | 'init';

export class TransportError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

const SET_TIMEOUT_MS = 10_000;
export const PROBE_TIMEOUT_MS = 8_000;

export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(error()), ms))),
  ]).finally(() => clearTimeout(timer));
}

// The tunnel address from Settings, unless it points at this server: then the path this build was
// made for. The saved one goes stale when PUBLIC_PERSEC_WISP_PATH changes, which left the proxy
// dead for everyone who had visited before.
export function tunnelUrl(saved: unknown, current: string, host: string): string {
  try {
    if (typeof saved === 'string' && saved && new URL(saved).host !== host) return saved;
  } catch {}
  return current;
}

async function wispTarget(): Promise<string> {
  return tunnelUrl(await ConfigAPI.get('wispUrl'), wispUrl(), location.host);
}

// Opens a connection to a Wisp server and waits for its greeting (an INFO or CONTINUE packet, sent
// as soon as it accepts), which proves the tunnel works without opening a site through it.
export function probeWisp(
  url: string,
  timeoutMs: number,
  WS: typeof WebSocket = WebSocket,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch (err) {
      return reject(new TransportError('refused', `Invalid tunnel address: ${String(err)}`));
    }
    let opened = false;
    const done = (err?: TransportError) => {
      clearTimeout(timer);
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        done(
          new TransportError(
            'timeout',
            opened ? 'The tunnel connected but never answered.' : 'The tunnel did not connect.',
          ),
        ),
      timeoutMs,
    );
    ws.onopen = () => (opened = true);
    ws.onmessage = () => done();
    // Either ends it: browsers send error then close, but some clients (Node 22) only send error
    // when the server drops the connection during the handshake.
    ws.onerror = ws.onclose = () =>
      done(
        opened
          ? new TransportError('closed', 'The server closed the tunnel before answering.')
          : new TransportError('refused', 'The tunnel connection was refused or blocked.'),
      );
  });
}

export const TRANSPORTS: Transport[] = [
  {
    name: 'wisp',
    // Per-build path (serverlib/env.ts); read when used, as the constant only exists in the browser.
    get module() {
      return PERSEC_PATHS.files.libcurl;
    },
    options: async () => [{ wisp: await wispTarget() }],
    probe: async timeoutMs => probeWisp(await wispTarget(), timeoutMs),
  },
];

// Tries each transport in order, each up to `attempts` times, and returns the first that works.
// Bounded: at most transports × attempts probes, each with its own timeout, so it always ends.
export async function pickTransport(
  transports: Transport[] = TRANSPORTS,
  { attempts = 2, timeoutMs = PROBE_TIMEOUT_MS, retryDelayMs = 1000 } = {},
): Promise<Transport> {
  let last: unknown = new TransportError('init', 'No transports are configured.');
  for (const t of transports) {
    for (let i = 0; i < attempts; i++) {
      if (i) await new Promise(r => setTimeout(r, retryDelayMs * i));
      try {
        await withTimeout(
          t.probe(timeoutMs),
          timeoutMs + 1000,
          () => new TransportError('timeout', `The ${t.name} check did not finish.`),
        );
        return t;
      } catch (err) {
        last = err;
        // The server said no; trying again right away won't change its answer.
        if (err instanceof TransportError && err.kind === 'closed') break;
      }
    }
  }
  throw last;
}

let ready: Promise<void> | null = null;

// What this browser last gave BareMux, kept where every Persec tab can see it. BareMux's worker is
// shared by all of them and outlives any one page, and it only reports the transport's module,
// so without this a new tunnel address from Settings was ignored until every tab was closed.
const APPLIED_KEY = 'persec-transport';
const readApplied = () => {
  try {
    return localStorage.getItem(APPLIED_KEY);
  } catch {
    return null;
  }
};
const writeApplied = (key: string | null) => {
  try {
    if (key === null) localStorage.removeItem(APPLIED_KEY);
    else localStorage.setItem(APPLIED_KEY, key);
  } catch {}
};

type MuxConnection = Pick<BareMuxConnection, 'getTransport' | 'setTransport'>;
const connectMux = (): MuxConnection => new BareMuxConnection(PERSEC_PATHS.files.bareMuxWorker);

// Makes sure BareMux has a transport before a proxied page loads. Fails within SET_TIMEOUT_MS
// instead of hanging: bare-mux retries a worker that never answers forever. A failure is not
// cached, so the next attempt (the next page the person opens) tries again.
export function ensureTransport(
  transport: Transport = TRANSPORTS[0],
  connect: () => MuxConnection = connectMux,
): Promise<void> {
  ready ??= withTimeout(
    (async () => {
      const conn = connect();
      const options = await transport.options();
      const key = JSON.stringify([transport.module, options]);
      // Set again only when something changed: setting it restarts the transport for every tab.
      if ((await conn.getTransport()) !== transport.module || readApplied() !== key) {
        await conn.setTransport(transport.module, options);
        writeApplied(key);
      }
    })(),
    SET_TIMEOUT_MS,
    () => new TransportError('init', 'The proxy worker did not start.'),
  ).catch(err => {
    ready = null;
    throw err instanceof TransportError ? err : new TransportError('init', String(err));
  });
  return ready;
}

// After the tunnel address changes in Settings: gives BareMux the new one now, for every tab.
export function applyTransport(
  transport: Transport = TRANSPORTS[0],
  connect: () => MuxConnection = connectMux,
): Promise<void> {
  ready = null;
  writeApplied(null);
  return ensureTransport(transport, connect);
}
