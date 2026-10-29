// Ad and tracker blocking at the tunnel: the Wisp server refuses to connect to hosts on a public
// DNS blocklist, so ads stop loading for every visitor and every engine, with nothing to do in the
// browser. The idea is Interstellar's (github.com/UseInterstellar/Interstellar, src/filtering),
// AGPL-3.0 like Persec; this keeps only the list check, as Persec's DNS (serverlib/wisp.ts) already
// blocks malware.
//
// The list is AdGuard DNS filter by default (about 4.5 MB, some 185,000 hosts, around 70 MB of
// memory once loaded, measured 2026-10), refreshed once a day. Set PERSEC_WISP_ADBLOCK=off to turn it off, or
// PERSEC_WISP_BLOCKLIST_URL to use another list in the same (Adblock-style or hosts file) format.
// When the list can't be fetched nothing is blocked: a missing list never breaks browsing.

export const DEFAULT_BLOCKLIST_URL =
  'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt';
const MAX_LIST_BYTES = 10 * 1024 * 1024;
const REFRESH_MS = 24 * 60 * 60 * 1000;
const HOST = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;

export interface Blocklist {
  blocked: Set<string>;
  allowed: Set<string>;
}

// The hosts a list blocks (and unblocks, with @@). Only whole-host rules are taken: `||host^`,
// `@@||host^` and hosts-file lines. Rules with options ($...), paths or wildcards are skipped, as a
// tunnel only ever sees the host name.
export function parseBlocklist(text: string): Blocklist {
  const blocked = new Set<string>();
  const allowed = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('[')) continue;
    const rule = /^(@@)?\|\|([^/^$*|]+)\^(\|)?$/.exec(line);
    if (rule) {
      if (HOST.test(rule[2])) (rule[1] ? allowed : blocked).add(rule[2]);
      continue;
    }
    const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+([^\s#]+)/.exec(line);
    if (hosts && HOST.test(hosts[1]) && hosts[1] !== 'localhost') blocked.add(hosts[1]);
  }
  return { blocked, allowed };
}

// Whether a host, or a domain it is under, is on the list and not unblocked.
export function isBlocked(list: Blocklist | null, hostname: string): boolean {
  if (!list || !list.blocked.size) return false;
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  const suffixes = labels.map((_, i) => labels.slice(i).join('.'));
  // An @@ exception wins over any block, as in AdGuard's own rules.
  if (suffixes.some(s => list.allowed.has(s))) return false;
  return suffixes.some(s => list.blocked.has(s));
}

let current: Blocklist | null = null;

// What serverlib/wisp.ts puts in wisp-js's hostname_blacklist, which calls test() on each entry.
export const blocklistMatcher = { test: (hostname: string) => isBlocked(current, hostname) };

export function setBlocklist(list: Blocklist | null) {
  current = list;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Blocklist> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  // Read in chunks with a cap, so a wrong URL can't fill the server's memory.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LIST_BYTES) {
      await reader.cancel();
      throw new Error('list is over 10 MB');
    }
    chunks.push(value);
  }
  return parseBlocklist(Buffer.concat(chunks).toString('utf8'));
}

// Loads the list now and once a day after. Returns a stop function (for tests and shutdown).
export function startBlocklist(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  log: (message: string) => void = console.warn,
): () => void {
  if (env.PERSEC_WISP_ADBLOCK?.trim().toLowerCase() === 'off') {
    setBlocklist(null);
    return () => {};
  }
  const url = env.PERSEC_WISP_BLOCKLIST_URL?.trim() || DEFAULT_BLOCKLIST_URL;
  const load = () =>
    download(url, fetchImpl).then(
      list => setBlocklist(list),
      // Keep the list already loaded, if any.
      error => log(`Tunnel ad blocking: couldn't load ${url} (${error.message})`),
    );
  load();
  const timer = setInterval(load, REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}
