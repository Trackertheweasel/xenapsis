import { createHash, randomBytes } from 'node:crypto';

// Deployment settings that the client bundle (built by astro.config.ts) and the server (index.ts)
// must agree on are read here, so the two can never interpret the same variable differently.

// The path the proxy's WebSocket tunnel listens on. A fixed, well-known path (the usual "/w/")
// lets a network filter confirm the server is a proxy just by probing that one URL. A deployment
// can set PUBLIC_PERSEC_WISP_PATH to a hard-to-guess value so there is nothing constant to probe.
// It is baked into the client at build time and read again by the server at runtime.
export function wispPath(raw = process.env.PUBLIC_PERSEC_WISP_PATH): string {
  let p = (raw ?? '').trim();
  if (!p) return '/w/';
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/')) p = p + '/';
  return p;
}

// Key for the proxied-URL codec (src/utils/codec.ts). Random per build, so URLs look different on
// every deployment; set PUBLIC_PERSEC_URL_KEY to keep one across builds or servers. Build-time only.
export function urlKey(raw = process.env.PUBLIC_PERSEC_URL_KEY): string {
  return raw?.trim() || randomBytes(16).toString('base64url');
}

// The proxy runtime's files, by role, with the extension each must keep (browsers check the type of
// .wasm and module scripts). Every name the runtime loads another file by comes from Persec's own
// config (src/utils/pro.ts, the Ultraviolet config, the service worker), so they can all be renamed.
const RUNTIME_FILES = {
  scramjetAll: '.js',
  scramjetSync: '.js',
  scramjetWasm: '.wasm',
  uvBundle: '.js',
  uvHandler: '.js',
  uvClient: '.js',
  uvSw: '.js',
  uvConfig: '.js',
  bareMux: '.js',
  bareMuxWorker: '.js',
  libcurl: '.mjs',
} as const;
export type RuntimeFile = keyof typeof RUNTIME_FILES;

export interface DeployPaths {
  // Where proxied pages live, one prefix per engine (the defaults were /v1/data/ and /v1/tmp/).
  scPrefix: string;
  uvPrefix: string;
  // The service worker. At the root, so it can control every page.
  sw: string;
  // The directory the whole proxy runtime is served from, and each file's URL in it.
  runtime: string;
  files: Record<RuntimeFile, string>;
}

// Fixed paths (/sw.js, /bm/worker.js, /v1/data/...) are the same on every Persec install, so a
// filter can match them to spot the proxy. Every one is derived from a per-build seed instead, or
// kept stable across builds/servers by setting PUBLIC_PERSEC_PROXY_KEY. This only beats matching on
// paths: the files' contents are the public packages', and the browser can see every path.
export function deployPaths(raw = process.env.PUBLIC_PERSEC_PROXY_KEY): DeployPaths {
  const seed = raw?.trim() || randomBytes(16).toString('hex');
  const h = createHash('sha256').update(seed).digest('hex');
  // All names are 8 hex characters, so they clash only on an all-but-impossible hash collision.
  const used = new Set<string>();
  const unique = (n: string) => {
    if (used.has(n)) throw new Error('paths collided; set a different PUBLIC_PERSEC_PROXY_KEY');
    used.add(n);
    return n;
  };
  const name = (role: string) =>
    unique(createHash('sha256').update(`${seed}/${role}`).digest('hex').slice(0, 8));
  const runtime = `/${name('runtime')}/`;
  return {
    // Unchanged from earlier builds, so a kept PUBLIC_PERSEC_PROXY_KEY keeps proxied URLs working.
    scPrefix: `/${unique(h.slice(0, 8))}/`,
    uvPrefix: `/${unique(h.slice(8, 16))}/`,
    sw: `/${name('sw')}.js`,
    runtime,
    files: Object.fromEntries(
      Object.entries(RUNTIME_FILES).map(([role, ext]) => [role, `${runtime}${name(role)}${ext}`]),
    ) as Record<RuntimeFile, string>,
  };
}
