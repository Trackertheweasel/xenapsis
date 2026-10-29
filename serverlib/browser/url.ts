import net from 'node:net';
import { BrowserError } from './index';
import { siteForHost } from './sites';

// URL rules for the server-side browser. It runs on (or next to) this server, so anything it loads
// comes from inside the server's network: a URL naming 127.0.0.1, the Docker network or a cloud
// metadata address would reach things no visitor should (SSRF). Two rules:
//
//   checkNavigationUrl  what Persec's own API may send a session to: http(s) on a Web AI site only
//   isBlockedRequest    every request the browser makes, the site's own included: never a non-web
//                       scheme, an IP literal in a private range, or an internal name
//
// The second can't see where a public name resolves, so a hostname pointing at a private address
// still gets through it. The browser service's network has to refuse those (docs/browser-runtime.md).

const MAX_URL = 2048;

// IPv4 ranges that are not the public internet: this host, private networks, carrier NAT,
// link-local (cloud metadata lives at 169.254.169.254), benchmarking, multicast and reserved.
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

const v4 = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

export function isPrivateIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const n = v4(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4(base);
    return n >= start && n < start + size;
  });
}

// Names that only mean something inside a network.
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

// URL keeps IPv6 hosts in brackets.
const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

// True for a host the browser must never be sent to. IPv6 literals are refused outright, as the
// tunnel does (serverlib/wisp.ts): browsing never needs one, and their IPv4-mapped forms
// (::ffff:127.0.0.1) name internal addresses.
export function isInternalHost(hostname: string): boolean {
  const host = bare(hostname.toLowerCase()).replace(/\.$/, '');
  if (!host) return true;
  if (net.isIPv6(host)) return true;
  if (net.isIPv4(host)) return isPrivateIPv4(host);
  // A single label ("intranet", "router") resolves through local search domains.
  if (!host.includes('.')) return true;
  return INTERNAL_NAME.test(host);
}

// Schemes a page may use for things it builds itself, which never leave the browser.
const IN_PAGE = new Set(['about:', 'data:', 'blob:']);

export function isBlockedRequest(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (IN_PAGE.has(url.protocol)) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return isInternalHost(url.hostname);
}

// Where Persec's own API may send a session. Returns the URL, normalized, or throws invalid_url.
export function checkNavigationUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL)
    throw new BrowserError('invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserError('invalid_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BrowserError('invalid_url');
  // user:pass@ in a URL is a credential; Persec never puts one into a site.
  if (url.username || url.password) throw new BrowserError('invalid_url');
  if (url.port && url.port !== '443' && url.port !== '80') throw new BrowserError('invalid_url');
  if (isInternalHost(url.hostname)) throw new BrowserError('invalid_url');
  if (!siteForHost(url.hostname)) throw new BrowserError('site_not_allowed');
  // The sites are HTTPS-only; asking for http:// would only add a redirect.
  url.protocol = 'https:';
  url.port = '';
  return url;
}
