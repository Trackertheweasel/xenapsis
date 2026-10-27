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

// The URL path prefix each proxy engine uses (the defaults were /v1/data/ and /v1/tmp/). A fixed
// prefix is the same on every Persec install, so a filter can match it to spot the proxy. Derive
// two distinct prefixes per build instead, or keep them stable across builds/servers by setting
// PUBLIC_PERSEC_PROXY_KEY. They are client-side only; the server never routes these paths.
export function proxyPrefixes(raw = process.env.PUBLIC_PERSEC_PROXY_KEY): [string, string] {
  const seed = raw?.trim() || randomBytes(16).toString('hex');
  const h = createHash('sha256').update(seed).digest('hex');
  const sc = `/${h.slice(0, 8)}/`;
  const uv = `/${h.slice(8, 16)}/`;
  // Same length, so neither can be a prefix of the other; equal only on an impossible hash clash.
  if (sc === uv)
    throw new Error('proxy prefixes collided; set a different PUBLIC_PERSEC_PROXY_KEY');
  return [sc, uv];
}
