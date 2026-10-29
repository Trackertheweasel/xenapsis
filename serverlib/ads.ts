// Server-proxied ads.
//
// Persec can show ads from a real ad network without ever letting the visitor's browser talk to
// that network. The server fetches an ad decision, downloads the creative image, and serves the
// image, the click and the impression through Persec's own origin:
//
//   render  ->  <img src="/a/ad/img/<id>">     bytes cached on this server, no third-party request
//   view    ->  <img src="/a/ad/px/<id>">      this server fires the network's impression callback
//   click   ->  <a href="/a/ad/click/<id>">    this server records the click, then 302s to the site
//
// So there are no third-party scripts, no third-party domains and no visitor data handed to the
// network: it only ever sees this server. Off unless PERSEC_AD_NETWORK is set; otherwise Persec
// falls back to the static, self-served sponsor list in public/a/json/sponsors.json.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import sponsors from '../public/a/json/sponsors.json';

export interface StaticSponsor {
  enabled: boolean;
  name: string;
  text?: string;
  url: string;
  image?: string;
}

// What the pages get to render the slot: the server hands it to Astro as `Astro.locals.ads` (see
// serverlib/app.ts, and astro.config.ts for the dev server), so the ad on the page and the /a/ad/*
// routes below share this one module's state.
export interface AdSlot {
  getCurrentAd(): Promise<ServedAd | null>;
}

// What Sponsor.astro renders. A "network" ad is served through the /a/ad/* routes below; a
// "static" ad is a self-served sponsor with its own local image and a direct link, unchanged.
export type ServedAd =
  | { kind: 'network'; id: string; name: string; text: string }
  | { kind: 'static'; name: string; text: string; image?: string; url: string };

// A normalized ad decision from an adapter. image/clickTarget/impression are the network's own
// URLs and are only ever fetched by this server, never by the visitor.
interface NormalizedAd {
  name: string;
  text: string;
  image: string; // remote creative URL
  clickTarget: string; // where the visitor should end up (the advertiser)
  clickTracking?: string; // optional network URL to fire on click (server-side)
  impression?: string; // optional network URL to fire on view (server-side)
}

interface Creative {
  buf: Buffer;
  type: string;
}

interface LiveAd {
  id: string;
  name: string;
  text: string;
  clickTarget: string;
  clickTracking?: string;
  impression?: string;
}

// Read live each time so the deployment's environment is picked up without a rebuild (and so tests
// can exercise both modes).
const env = (key: string) => (process.env[key] ?? '').trim();
const network = () => env('PERSEC_AD_NETWORK').toLowerCase();
const apiUrl = () => env('PERSEC_AD_API_URL');
const apiKey = () => env('PERSEC_AD_API_KEY');
const publisher = () => env('PERSEC_AD_PUBLISHER');
// How long a fetched ad is reused before asking the network again.
const ttlMs = () => Math.max(30, Number(process.env.PERSEC_AD_TTL) || 300) * 1000;
// A creative is only ever a small image; cap how many we keep so a misbehaving network can't grow
// memory without bound.
const MAX_CREATIVES = 8;
const MAX_CREATIVE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const creatives = new Map<string, Creative>();
const liveAds = new Map<string, LiveAd>();
const firedImpressions = new Set<string>();

let current: { ad: LiveAd; expires: number } | null = null;
// After the network had no ad (or failed), the static list is served until then instead of asking
// again on every page: the start page waits for the answer, up to a few timeouts long.
let emptyUntil = 0;
const EMPTY_RETRY_MS = 60_000;
let inflight: Promise<LiveAd | null> | null = null;

function configured(): boolean {
  const n = network();
  if (!n) return false;
  if (n === 'ethicalads') return !!apiKey() && !!publisher();
  if (n === 'generic') return !!apiUrl();
  return false;
}

function remember<T>(map: Map<string, T>, id: string, value: T, max: number) {
  map.set(id, value);
  while (map.size > max) {
    const oldest = map.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// --- Adapters: turn a network's response into a NormalizedAd. Neither forwards the visitor's IP
// or user agent, so the network cannot profile or target the person behind Persec. ---

async function fetchGeneric(): Promise<NormalizedAd | null> {
  // A plain endpoint that returns our own JSON contract, so Persec can point at any network through
  // a small shim, or at a hand-written list. Expected: { name, text, image, click, impression? }.
  const key = apiKey();
  const res = await fetch(apiUrl(), {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const d: any = await res.json();
  if (!d || !d.image || !d.click) return null;
  return {
    name: String(d.name ?? 'Sponsored'),
    text: String(d.text ?? ''),
    image: String(d.image),
    clickTarget: String(d.click),
    clickTracking: d.clickTracking ? String(d.clickTracking) : undefined,
    impression: d.impression ? String(d.impression) : undefined,
  };
}

async function fetchEthicalAds(): Promise<NormalizedAd | null> {
  // https://ethical-ad-server.readthedocs.io/ — server-to-server decision API. We ask for an image
  // ad and deliberately send no visitor IP or user agent.
  const base = apiUrl() || 'https://server.ethicalads.io';
  const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/decision/`, {
    method: 'POST',
    headers: { authorization: `Token ${apiKey()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ publisher: publisher(), ad_types: ['image-v1'] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const d: any = await res.json();
  // A decision with no ad to show comes back empty.
  if (!d || (!d.image && !d.copy?.image)) return null;
  const image = String(d.image ?? d.copy?.image);
  const clickTarget = await resolveClickTarget(String(d.link ?? d.clickthrough ?? ''));
  if (!clickTarget) return null;
  return {
    name: String(d.copy?.headline ?? d.headline ?? 'Sponsored'),
    text: String(d.copy?.content ?? d.body ?? d.text ?? ''),
    image,
    clickTarget,
    impression: d.view_url ? String(d.view_url) : undefined,
  };
}

// EthicalAds' `link` is itself a tracking redirect to the advertiser. Follow it here, on the
// server, so the visitor is sent straight to the advertiser and never hits the network's domain.
// If it can't be resolved, fall back to using the link directly as the click target.
async function resolveClickTarget(link: string): Promise<string> {
  if (!link) return '';
  try {
    const res = await fetch(link, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const loc = res.headers.get('location');
    if (loc) return loc;
  } catch {
    // fall through
  }
  return link;
}

async function decide(): Promise<NormalizedAd | null> {
  const n = network();
  if (n === 'ethicalads') return fetchEthicalAds();
  if (n === 'generic') return fetchGeneric();
  return null;
}

async function fetchCreative(url: string): Promise<Creative | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? 'image/png';
  if (!/^image\//i.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_CREATIVE_BYTES) return null;
  return { buf, type };
}

async function refresh(): Promise<LiveAd | null> {
  const decision = await decide();
  if (!decision) return null;
  const creative = await fetchCreative(decision.image);
  if (!creative) return null;
  const id = randomUUID();
  remember(creatives, id, creative, MAX_CREATIVES);
  const ad: LiveAd = {
    id,
    name: decision.name,
    text: decision.text,
    clickTarget: decision.clickTarget,
    clickTracking: decision.clickTracking,
    impression: decision.impression,
  };
  remember(liveAds, id, ad, MAX_CREATIVES);
  return ad;
}

// Pick the ad to show. Serves the cached network ad while it's fresh, fetches a new one when stale
// (single-flight, so one page load does the work and the rest reuse it), and falls back to the
// self-served sponsor list if the network isn't configured or the fetch fails.
export async function getCurrentAd(): Promise<ServedAd | null> {
  if (configured()) {
    const now = Date.now();
    if (current && current.expires > now) {
      return { kind: 'network', id: current.ad.id, name: current.ad.name, text: current.ad.text };
    }
    if (emptyUntil > now) return staticAd();
    try {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      const ad = await inflight;
      if (ad) {
        current = { ad, expires: Date.now() + ttlMs() };
        return { kind: 'network', id: ad.id, name: ad.name, text: ad.text };
      }
    } catch {
      // fall through to the static list
    }
    emptyUntil = Date.now() + EMPTY_RETRY_MS;
  }
  return staticAd();
}

function staticAd(): ServedAd | null {
  const active = (sponsors as StaticSponsor[]).filter(s => s.enabled);
  if (!active.length) return null;
  const s = active[Math.floor(Math.random() * active.length)];
  return { kind: 'static', name: s.name, text: s.text ?? '', image: s.image, url: s.url };
}

export const adSlot: AdSlot = { getCurrentAd };

// For tests: forget the cached ad and any "no ad" pause, as a restart would.
export function resetAdCache() {
  current = null;
  emptyUntil = 0;
}

// --- The /a/ad/* routes. ---

// Record a view by firing the network's impression URL from the server, once per ad.
export async function recordImpression(id: string): Promise<void> {
  const ad = liveAds.get(id);
  if (!ad?.impression || firedImpressions.has(id)) return;
  firedImpressions.add(id);
  try {
    await fetch(ad.impression, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    // an impression that fails to record is not worth surfacing
  }
}

// Record a click server-side and return where to send the visitor. Returns null for an unknown id.
export async function recordClick(id: string): Promise<string | null> {
  const ad = liveAds.get(id);
  if (!ad) return null;
  if (ad.clickTracking) {
    try {
      await fetch(ad.clickTracking, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      // still send the visitor on even if the network's click ping fails
    }
  }
  return ad.clickTarget;
}

export function creativeFor(id: string): Creative | undefined {
  return creatives.get(id);
}

// A 1x1 transparent GIF, returned by the impression pixel.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const AD_ROUTE = /^\/a\/ad\/(img|px|click)\/([^/?#]+)$/;

// Serves /a/ad/img/<id>, /a/ad/px/<id> and /a/ad/click/<id>, and passes anything else on. A plain
// Node handler so the production server and the dev server (astro.config.ts) run the same code.
export async function handleAd(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const match = AD_ROUTE.exec(pathname);
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
  const [, kind, id] = match;

  if (kind === 'img') {
    // Served from Persec's own origin, so the visitor's browser never requests it from the network.
    const creative = creativeFor(id);
    if (!creative) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res
      .writeHead(200, {
        'content-type': creative.type,
        // Private and short-lived: the slot rotates and creatives are per-session.
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      })
      .end(creative.buf);
    return;
  }

  if (kind === 'px') {
    // The ad card loads this pixel when it is shown, so the server fires the network's impression
    // callback and the visitor never contacts the network.
    await recordImpression(id);
    res
      .writeHead(200, {
        'content-type': 'image/gif',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      .end(PIXEL);
    return;
  }

  // A click: recorded here (firing the network's click callback if any), then the visitor goes
  // straight to the advertiser. Only ever to a real web address, never to javascript:/data: and
  // the like.
  const target = await recordClick(id);
  const location = target && /^https?:\/\//i.test(target) ? target : '/new';
  res.writeHead(302, { location }).end();
}
