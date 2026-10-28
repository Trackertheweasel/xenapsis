import { logging, server as wisp } from '@mercuryworkshop/wisp-js/server';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ACCESS_COOKIE, displayName, readCookie, tokenSubject } from './access';
import type { AccessConfig } from './access';
import { blocklistMatcher } from './blocklist';
import { trackTunnel } from './stats';

logging.set_level(logging.ERROR);
Object.assign(wisp.options, {
  dns_method: 'resolve',
  // Cloudflare DNS with malware blocking only (1.1.1.3 would also block adult content).
  dns_servers: ['1.1.1.2', '1.0.0.2'],
  dns_result_order: 'ipv4first',
  // Browsing only needs TCP to web ports. Blocking UDP and low ports (SMTP, SSH, ...)
  // stops the server being used for spam or attacks; 2525 is a common alternate SMTP port.
  allow_udp_streams: false,
  port_whitelist: [80, 443, [1024, 2524], [2526, 65535]],
  // wisp-js refuses loopback and private addresses, but classifies IPv6 forms of IPv4 addresses
  // (::ffff:127.0.0.1, ::ffff:169.254.169.254) as neither, so they reached the host, the Docker
  // network and cloud metadata. Browsing never needs an IPv6 literal, so refuse every one.
  // Plus the tunnel's ad and tracker blocklist (serverlib/blocklist.ts), off with PERSEC_WISP_ADBLOCK=off.
  hostname_blacklist: [/:/, blocklistMatcher],
  wisp_version: 2,
  // The MOTD is returned to anyone who completes the WebSocket handshake. The usual
  // "wisp server" string is a fixed value that lets automated fingerprinting identify the
  // endpoint as a Wisp proxy at a glance, so default to an empty, non-identifying value.
  // A deployment can set PERSEC_WISP_MOTD if it wants a custom string.
  wisp_motd: process.env.PERSEC_WISP_MOTD ?? '',
});

export { wisp };

// A browser always sends Origin on a WebSocket, and a page can't change it or Host. A mismatch means
// another site is opening the tunnel with this visitor's cookie (SameSite=Lax still sends it from
// sibling subdomains, such as another *.sslip.io name). Non-browser clients send no Origin.
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = req.headers['x-forwarded-host'];
  return [req.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])].some(
    h => !!h && h.split(',')[0].trim().toLowerCase() === host.toLowerCase(),
  );
}

// The one rule for who may open the tunnel, shared by the production server (serverlib/app.ts) and
// the dev server (astro.config.ts). In invite-only mode it needs a valid sign-in cookie, or anyone
// could use the server as an open proxy. Returns false for upgrades on other paths, which the
// caller handles: production refuses them, the dev server leaves them to Vite's live reload.
export function routeWisp(
  access: AccessConfig | null,
  wispPath: string,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  if (!req.url?.endsWith(wispPath)) return false;
  // Only a sign-in cookie is worth hijacking; an open server's tunnel is meant for any page.
  if (access && !sameOrigin(req)) {
    socket.destroy();
    return true;
  }
  const subject = access && tokenSubject(access, readCookie(req.headers.cookie, ACCESS_COOKIE));
  if (!access || subject) {
    // Usage counts only exist where the owner turned on the admin page (see serverlib/stats.ts).
    if (subject && access?.adminPassword) trackTunnel(displayName(subject), socket);
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
  return true;
}
