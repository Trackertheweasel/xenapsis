# Resilience: transports, failover and browser support

This is the design note behind Persec's connection handling, backup servers and startup checks. The README has the step-by-step procedures; this explains what each piece does and, as importantly, what it does not do.

## What Persec defends against, and what it doesn't

Persec helps someone on a filtered network reach sites the filter blocks. The filter sees only the connection to the Persec server. Persec does **not** make that connection look like something else, and it does not hide that the person is using a server they reach every day. Everything below works within those limits:

| Block                                                     | What helps                                                                | What doesn't                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| One domain name blocked (DNS or SNI)                      | Another name on the same server (`persec domain add`); ECH                | —                                   |
| A whole dynamic-DNS provider blocked                      | A registered domain                                                       | Another name from the same provider |
| The server's IP address blocked                           | A backup server at another provider; a CDN in front                       | More names on the same server       |
| WebSockets blocked on the person's network                | Another network; a CDN that carries WebSockets may or may not get through | Changing the proxy engine           |
| A CDN's addresses blocked, or ECH blocked (some regions)  | An independent backup that is reached directly, not through the CDN       | ECH                                 |
| The person's browser disables service workers, WASM, etc. | Another browser, or the browser's own per-site exception                  | Anything on the server              |
| Traffic analysis that spots proxy-like traffic patterns   | Nothing in Persec today                                                   | —                                   |

A fallback only helps if the person knows it exists before the block. Hand out backup addresses together with invite codes, through the same private channel, not through the Persec site itself (a blocked site can't tell anyone where to go next).

## Transports

### How it fits together

```
 page ─► proxy engine (Scramjet or Ultraviolet, in the service worker)
          └─► BareMux (a SharedWorker) ─► transport (libcurl, WASM) ─► Wisp over one WebSocket ─► server ─► site
```

The proxy engine rewrites pages; the **transport** carries the bytes. Both engines send everything through whichever transport BareMux has, so switching engines in Settings never changes what the network sees. `src/utils/transport.ts` holds the transport list, and it is the only code that sets the transport. Before, the same block was copied into five files.

libcurl runs TLS inside the browser, so for HTTPS sites the Persec server, and any CDN in front of it, see only the destination host and port, not page contents. They do see Persec's own pages, invite codes and sign-in cookies, and plain-http sites in full.

### Failure handling

- **Setting the transport** (`ensureTransport`) gives up after 10 seconds. Without that limit, bare-mux re-pings a worker that never answers forever, and the page sits there loading. A failure isn't cached, so the next page the person opens tries again; nothing retries on its own in a loop.
- **The tunnel check** (`probeWisp`) opens one WebSocket and waits for the Wisp server's greeting (the INFO or CONTINUE packet it sends as soon as it accepts). It reports one of:
  - `refused`: the connection never opened. That is a network or browser block, or no invite (the server drops the connection).
  - `timeout`: nothing came back in 8 seconds, e.g. a middlebox that holds connections without passing them on.
  - `closed`: the server accepted, then hung up.
- **Selection** (`pickTransport`) tries each transport up to twice, with a short pause, and returns the first that works. A `closed` isn't retried. Each try has its own timeout, so the whole thing always ends.
- When the tunnel fails, the startup check also asks the server for `/` with `HEAD`. This separates three cases: _signed out_ (401), _server unreachable_ (the request fails, so the server is down or blocked as a whole), and _only the WebSocket is blocked_ (the site answers but the tunnel doesn't). That last case is common on school, work and public networks.

The saved tunnel address (Settings → Advanced → Wisp Server) is used only if it points at a different server. An address on this server always uses the path the current build was made for. Before, changing `PUBLIC_PERSEC_WISP_PATH` left everyone who had visited earlier with a dead tunnel, because the old address stayed saved in their browser.

### Why there is no second transport yet

There is still only one entry in `TRANSPORTS`. Every alternative studied needs new server infrastructure, and none could be tested end to end here. Wrapping the same WebSocket another way would be blocked by the same filter, so it isn't worth adding.

| Option                                   | What it would take                                                                                                                                                                                                                                                                                                                                                                                                                                              | Status                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Bare (plain HTTP requests)**           | A Bare server on Persec's server behind the same invite gate, with the same port and address limits as Wisp (`serverlib/wisp.ts`), and the Bare client transport for BareMux. Survives networks that block WebSocket upgrades. Proxied sites' own WebSockets would still need Wisp. The reference Node server has seen little work since the ecosystem moved to Wisp: check its maintenance status before adopting it, as it would be an internet-facing proxy. | Not implemented: needs a decision on adding and maintaining the dependency |
| **WebTransport (HTTP/3)**                | An HTTP/3 server that speaks WebTransport: Node has none built in, and Caddy here would have to forward WebTransport sessions, which it doesn't offer as a stable feature. Also needs UDP 443 open end to end. Many filtered networks block or throttle QUIC, and Safari support is recent.                                                                                                                                                                     | Not feasible with the current stack                                        |
| **Wisp through a CDN** (Cloudflare etc.) | Already works: it's a deployment choice, not a transport (see the README). It changes which addresses a filter must block, not what the traffic looks like.                                                                                                                                                                                                                                                                                                     | Supported                                                                  |

To add one: give it an entry in `TRANSPORTS` with a `probe` that proves data flows end to end, gate its server side with `routeWisp`'s invite rule, and add an end-to-end test like the Wisp one in `tests/transport.test.ts`. The client and server must agree on the transport's path the same way they do for Wisp (`serverlib/env.ts`).

## Several servers

### What a backup shares with the primary

`persec export` prints a command that sets up a backup with the primary's values. After that, **each server reads only its own `deploy/.env`; nothing syncs.**

| Setting                                            | Shared?                                                          | Effect                                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERSEC_SECRET`                                    | Yes, and must stay the same                                      | Minted invites (`persec invite`) work on every server. A sign-in cookie from one is valid on another, but the browser only sends it to the domain that set it. |
| `PERSEC_INVITE_CODES` (`persec add`)               | Copied once                                                      | Codes added later must be added on every server.                                                                                                               |
| `PERSEC_REVOKED` (`persec revoke`)                 | Copied once                                                      | **A revoke on one server doesn't reach the others.** Revoke on every server, or the person can still use a backup.                                             |
| `PUBLIC_PERSEC_WISP_PATH`                          | No; the backup gets its own random path when the primary has one | Finding one server's path tells nobody the other's.                                                                                                            |
| `DOMAIN`, Caddy certificates                       | No                                                               | Per server.                                                                                                                                                    |
| Saved-login backups (`data/logins`)                | No; copy with `persec logins`                                    | See below.                                                                                                                                                     |
| `PUBLIC_PERSEC_URL_KEY`, `PUBLIC_PERSEC_PROXY_KEY` | No                                                               | Only matter for keeping proxied-page URLs stable; bookmarks store the real address, so they work anywhere.                                                     |

Sharing the secret is what makes minted invites portable, and it also means anyone who gets it from any server can mint invites for all of them. Changing it on one server cuts that server off from the others' invites and signs out everyone on it.

### Saved logins on a backup

A backup is the person's cookies, encrypted in their browser with a key made from their invite code. The server stores it under a hash of the person's name, the same hash on every server. So copying the files is enough to make them available on a backup, and the plaintext is never exposed, because neither server has the key:

```bash
persec logins export > logins.tar    # on the primary
persec logins import < logins.tar    # on the backup; never replaces a newer backup there
```

Move `logins.tar` over a channel you trust (e.g. `scp`). It's ciphertext, but it reveals how many people have backups and when each changed. On the backup, the person signs in with the same invite code and taps **Restore my logins**. A minted invite's backup is tied to that exact invite: someone who gets a new invite starts a new backup, on any server.

### Same name or new name

Browsers keep everything per address (origin): the service worker, IndexedDB (settings, bookmarks, site cookies), the sign-in cookie, and saved passwords. Which failover you pick decides whether any of that comes along:

- **Same domain, new IP** (move the DNS record to the backup): the browser sees the same origin, so settings, bookmarks, site logins and the Persec sign-in all carry over (the cookie is valid because the secret is shared). Caddy on the backup only gets its certificate once DNS points at it, so expect a minute or two of certificate errors, longer while old DNS answers are still cached. This survives an IP block, not a name block.
- **A different domain** (a backup with its own name): the person starts fresh. They sign in with their invite code, import their settings file (Settings → Advanced → _Move to another address_), and restore saved logins. The file isn't encrypted; it holds settings and bookmarks only, never the tunnel address, saved logins or the invite code.

### Health checks and failover

`persec status` asks each of the server's addresses for its sign-in page over HTTPS and exits non-zero if one fails. That covers DNS, certificate, Caddy and Persec together. It runs from the server itself, so it can't see blocks on other networks. Run it from cron or point an outside monitor at `https://<domain>/enter` (200 when healthy) to learn when a server is down. A block in a particular country only shows up through reports from people there.

Failover is manual and that is deliberate. Automatic DNS failover would have to treat "unreachable from one country" as "down", which a monitor elsewhere can't see. Moving a shared name to a server the filter already knows about also gains nothing. The procedure:

1. Before anything breaks: set up the backup (`persec export`), give it its own name, and send people both addresses along with their code.
2. When the primary is down or blocked, tell people to use the backup address. Users see a startup check that says _"This Persec server can't be reached... try the backup address"_ when the primary is reachable but the tunnel isn't. When the primary can't be reached at all, the page doesn't load, so it can't help. That's why addresses go out ahead of time.
3. If you use one shared name, move its DNS record to the backup and wait for its certificate (`persec status` on the backup).

## Browser support

Persec needs, in the person's browser: HTTPS, service workers, SharedWorker (BareMux), IndexedDB, WebAssembly (libcurl and Scramjet), and an outgoing WebSocket to the server. The startup check tests each one, with a timeout, when the browser window opens, and **Settings → Advanced → Check connection** runs the same checks on demand. Results say whether the problem is the browser, the network or the sign-in. When everything passes but a site won't load, the site is the problem (it may block proxies), and the check says so.

The table lists what each browser setup supports according to its documentation. It has **not been verified on real devices for this change**. The startup check is the source of truth on any given device.

| Browser / setup                                      | Expected                 | Why                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome, Edge, Firefox, Safari 16+ (desktop, current) | Works                    | Everything needed is supported.                                                                                                                                                         |
| Safari on iOS / iPadOS 16+                           | Works                    | SharedWorker returned in Safari 16.                                                                                                                                                     |
| Chrome on Android                                    | Varies                   | SharedWorker came to Chrome on Android late; older versions fail the _shared workers_ check. Firefox for Android is the alternative.                                                    |
| Private / incognito windows                          | Usually                  | Some browsers limit service workers or storage in private windows; the check names which one failed.                                                                                    |
| Edge enhanced security mode, Safari Lockdown Mode    | May fail: no WebAssembly | Lockdown Mode turns WebAssembly off, and Edge's enhanced security mode can. Both let the person exclude a site; that is the supported fix. Persec doesn't try to get around it.         |
| Managed (school / work) browsers                     | Varies                   | Policies can turn off service workers or site storage, or block WebSockets or the site. The check shows which. The fix is a different device or browser, not working around the policy. |
| Extensions that block scripts, workers or WebSockets | Varies                   | Shows up as a service-worker or tunnel failure; try with extensions off.                                                                                                                |
| Plain `http://`                                      | Fails                    | Service workers need HTTPS (localhost aside).                                                                                                                                           |

Persec doesn't weaken anything to get further. The service worker's trust rules for proxied pages and saved cookies are unchanged. Without one of these features Persec stops and says why.
