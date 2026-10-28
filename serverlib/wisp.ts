import { logging, server as wisp } from '@mercuryworkshop/wisp-js/server';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ACCESS_COOKIE, readCookie, verifyToken } from './access';
import type { AccessConfig } from './access';

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
  wisp_version: 2,
  // The MOTD is returned to anyone who completes the WebSocket handshake. The usual
  // "wisp server" string is a fixed value that lets automated fingerprinting identify the
  // endpoint as a Wisp proxy at a glance, so default to an empty, non-identifying value.
  // A deployment can set PERSEC_WISP_MOTD if it wants a custom string.
  wisp_motd: process.env.PERSEC_WISP_MOTD ?? '',
});

export { wisp };

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
  if (!access || verifyToken(access, readCookie(req.headers.cookie, ACCESS_COOKIE))) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
  return true;
}
