# Browser mode (optional Camoufox runtime)

Browser mode runs ChatGPT or Claude in a real browser on the server, in a session only the person who started it can reach. It is a third system, next to the web proxy and PerSec AI, and changes neither. **It is off by default.** No Persec install downloads a browser.

```
iPhone / desktop browser
        |   (signed in to Persec with an invite)
        v
Persec  /api/browser/*   ->  SessionManager  ->  Camoufox (separate service, private network)
                                                     |
                                              ChatGPT / Claude
```

It is not a way around a site's own checks. When ChatGPT or Claude shows a challenge, refuses the session, or asks the person to verify, Persec says so on the page and stops there. Neither mode makes anyone anonymous or undetectable, and the UI says that.

## What's implemented in this change

| Piece                                      | File                                              |
| ------------------------------------------ | ------------------------------------------------- |
| Config, session manager, limits, errors    | `serverlib/browser/index.ts`                      |
| Camoufox adapter (Playwright over Juggler) | `serverlib/browser/camoufox.ts`                   |
| URL and SSRF rules                         | `serverlib/browser/url.ts`                        |
| The two sites it may open                  | `serverlib/browser/sites.ts`                      |
| Routes                                     | `serverlib/routes/browser.ts`                     |
| UI (the "Browser mode" picker on Web AI)   | `src/pages/webai.astro`, `src/utils/webaipage.ts` |
| Tests (mocked runtime, no browser)         | `tests/browser.test.ts`                           |

What a person can do today: start a session on ChatGPT or Claude, see what it shows (a picture, refreshed every 5 seconds while the page is open), see where it is and whether it's being challenged, move to another page on the same site, and end the session. **Typing and clicking into the session are not implemented.** That is the remaining deployment work below, so for now the mode is a preview. Signing in, chatting and persistent logins need it.

### Routes

All are behind the invite gate, and every session belongs to the invite that started it.

| Route                                      | Does                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `GET /api/browser/status`                  | `{ enabled, runtime, reason? }`, and nothing else about the server            |
| `GET /api/browser/sessions/current`        | The caller's open session, if any                                             |
| `POST /api/browser/sessions`               | `{ "site": "chatgpt" \| "claude" }` starts a session on that site's home page |
| `GET /api/browser/sessions/:id`            | The page's address, title, and whether it looks like a challenge              |
| `POST /api/browser/sessions/:id/navigate`  | `{ "url" }`, on the same two sites only                                       |
| `GET /api/browser/sessions/:id/screenshot` | JPEG of the page, `Cache-Control: no-store`                                   |
| `DELETE /api/browser/sessions/:id`         | Ends it. The context and everything in it are deleted                         |

## Security boundaries

The browser is treated as highly privileged.

- **Nothing about the browser comes from a client.** The endpoint (`CAMOUFOX_WS_ENDPOINT`) is server config and must be `ws://` or `wss://`. There is no client-controlled executable path, binary, command, proxy, profile or file path, because the API has no parameter for any of them.
- **Access control.** Browser mode needs invite-only mode. On an open server it stays off, so nobody anonymous can start browsers. Sessions are looked up by owner and ID together (IDs are 144 random bits). Someone else's session answers exactly like one that doesn't exist (404), for status, navigation, screenshots and ending it.
- **CSRF.** Requests that change state must carry this site's own `Origin`, and bodies must be JSON. SameSite=Lax would still send the cookie from a sibling subdomain such as another `*.sslip.io` name.
- **Navigation.** The API only sends a session to `https://chatgpt.com` or `https://claude.ai` (and their subdomains). Credentials in URLs, odd ports, IP literals and internal names are refused (`checkNavigationUrl`).
- **SSRF from inside the page.** Every request the browser makes, the site's own included, goes through a Playwright route. Anything that isn't http(s) (`file:`, `chrome:`, `view-source:`) is aborted. So is an IP literal in a private, loopback, link-local or reserved range, any IPv6 literal, and names like `localhost`, `*.internal` or `*.local`. WebSockets get the same check where the Playwright client supports `routeWebSocket` (1.48+). This can't see what a public hostname resolves to. **The browser service's network must refuse private ranges itself** (see deployment).
- **No credential handling.** Persec never fills in, reads or watches sign-in fields. Responses contain the page's URL, title and a picture, never cookies or storage. Nothing is copied out of the browser (no `storageState`). Profiles aren't written to disk, and no profile file is ever served over HTTP.
- **Downloads** are refused (`acceptDownloads: false`). Dialogs are dismissed. A session may have at most 3 pages (for sign-in popups), and extra pages are closed.
- **Screenshots** go only to the session's owner, uncached.

## Resource limits

| Limit                   | Default          | Config                                    |
| ----------------------- | ---------------- | ----------------------------------------- |
| Sessions on the server  | 2                | `CAMOUFOX_MAX_SESSIONS`                   |
| Sessions per person     | 1                | fixed                                     |
| New sessions per person | 6 per 10 minutes | fixed                                     |
| Session lifetime        | 30 minutes       | `CAMOUFOX_SESSION_TIMEOUT_MS` (min 60000) |
| Idle timeout            | 5 minutes        | `CAMOUFOX_IDLE_TIMEOUT_MS` (min 30000)    |

Sessions still starting count against the limits, so concurrent requests can't overshoot. The page only polls while it's visible, so a forgotten tab lets the session idle out. **Crash recovery:** if a page crashes or the browser service drops, its sessions end and free their slots. The next session reconnects. **Shutdown:** on SIGTERM, Persec refuses new sessions, closes every context, then disconnects.

## Configuration

Add these to `deploy/.env` (Docker Compose) or the server's environment. None of them reach the client.

| Variable                      | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `CAMOUFOX_ENABLED`            | `true` to turn browser mode on. Off without it                                |
| `CAMOUFOX_WS_ENDPOINT`        | The browser service's Playwright endpoint, e.g. `ws://camoufox:8888/<random>` |
| `CAMOUFOX_MAX_SESSIONS`       | Browsers open at once, server-wide (default 2)                                |
| `CAMOUFOX_SESSION_TIMEOUT_MS` | Longest a session lives (default 1800000)                                     |
| `CAMOUFOX_IDLE_TIMEOUT_MS`    | How long an unused session stays open (default 300000)                        |

Persec also needs `playwright-core` installed next to it (`pnpm add playwright-core`, matching the Playwright version the browser service runs). It is deliberately not a dependency, so normal installs stay small. Without it, the status still says enabled, but starting a session reports "The browser service could not be reached" and the server logs why.

## Is Camoufox practical here? (evaluation, 2026-10-28)

| Question                | Finding                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node/TypeScript support | No official Node package. The official interface is the Python package (`camoufox` on PyPI, 0.5.8, Oct 2026). `camoufox-js` (github.com/apify/camoufox-js) is a community port that calls itself experimental and has no published releases. Persec therefore doesn't embed either. It connects to Camoufox's **remote server mode** with Playwright's own Firefox client, which works from any language. |
| Maturity                | The upstream README warns it "may not be suitable for stable production use", mentions a year-long maintenance gap, and says performance has dropped. The remote server mode is documented as experimental ("uses a hacky workaround to gain access to undocumented Playwright methods"), and one server runs one browser instance.                                                                       |
| Linux / Docker          | Builds for Linux x86_64 and arm64. Run it in its own container with Python 3.10+, `pip install camoufox`, `camoufox fetch`, and Firefox's usual system libraries (GTK, X11/Wayland client libraries, fonts). Headless works without a display.                                                                                                                                                            |
| Download / disk         | The PyPI page's sample `camoufox version` shows a ~1.2 GB browser directory, plus ~116 MB for the optional GeoIP database. Budget 1.5 GB of disk for the image.                                                                                                                                                                                                                                           |
| Memory                  | The project claims about 200 MB for the browser. ChatGPT and Claude are heavy single-page apps, so budget 300–500 MB per open session on top. With the default 2 sessions, plan for at least 1.5 GB free for the browser service alone.                                                                                                                                                                   |
| Startup                 | The service starts once and stays up. A new session is a new context in the running browser, typically a second or two plus the site's own load time. A cold container start (browser launch) takes several seconds.                                                                                                                                                                                      |
| Persistent profiles     | Playwright's remote `connect` doesn't support persistent contexts, and copying `storageState` out would mean taking cookies out of the browser, which this design refuses. **Sessions are ephemeral.** Persistent, user-controlled profiles would need a per-person persistent browser on the service side, with profile storage that never leaves it. Not implemented.                                   |
| Playwright integration  | Standard: `firefox.connect(wsEndpoint)`. Client and server Playwright versions should match.                                                                                                                                                                                                                                                                                                              |
| Licensing               | The browser is MPL-2.0 (Firefox-derived). The Python wrapper is MIT. Running it as a separate, unmodified service puts no obligations on Persec's code. Persec is AGPL-3.0, which is compatible.                                                                                                                                                                                                          |
| Fingerprinting defaults | Camoufox's launcher injects fingerprints by default. Persec adds no evasion of its own and doesn't use `humanize`, GeoIP spoofing or proxies. The adapter works with **any Playwright Firefox server**, so an owner who only wants isolation can run stock Playwright Firefox instead.                                                                                                                    |

**Verdict.** The recommended 1 GB VPS (`deploy/setup.sh`) can't run it next to Persec, and neither can Render's free tier. So it stays behind the feature flag, as a separate service the owner chooses to run, on a machine with at least 2 GB of RAM. Nothing about Persec's normal install changes.

## Running the browser service (outline)

1. Run Camoufox in its own container on a **private network** that only Persec can reach. Never publish its port. The Playwright endpoint is unauthenticated, so anyone who reaches it controls the browser.
2. Start it with a fixed port and a long random path, for example `python -m camoufox server`, or a small script calling `camoufox.server.launch_server(headless=True, port=8888, ws_path='<random>')`. Check the docs for the version you install, since this mode is experimental.
3. **Egress firewall:** let the container reach the internet on 80/443 and refuse 10/8, 172.16/12, 192.168/16, 169.254/16, 127/8, 100.64/10 and IPv6 private ranges. This is what makes the SSRF rules complete, because Persec can't see DNS answers. With Docker, put it on an internal network behind an egress proxy, or add iptables rules on the host.
4. Set `CAMOUFOX_ENABLED=true` and `CAMOUFOX_WS_ENDPOINT=ws://camoufox:8888/<random>` for Persec, add `playwright-core`, and restart.
5. Check: `/api/browser/status` says `enabled: true`. Starting a ChatGPT session from Web AI shows a picture. A second invite can't open the first one's session ID. Ending the session removes it.

## Remaining work: interactive sessions

Typing and clicking need a real remote-browser viewer. Persec deliberately doesn't invent one: a home-made protocol forwarding mouse and keyboard events would be a new, unaudited attack surface carrying people's passwords. The workable design:

- Run Camoufox **headful** in the browser-service container, one display per session (Xvfb), with an existing, maintained streaming stack: KasmVNC or noVNC/websockify over VNC, or a WebRTC browser-streaming server such as neko.
- Persec reverse-proxies the viewer at `/browser/session/:id/view` only after the same owner check as the API, never exposing the streaming server directly. The viewer's own auth stays on, with a per-session secret Persec holds.
- Keystrokes then pass through Persec to the browser. Persec must not log, record or inspect them, and the privacy page has to say they transit the server.
- Persistent profiles: a per-person profile directory on the service's own volume, chosen by the person ("keep me signed in"), with a delete button. It is never mounted into Persec and never served.

Until that exists, browser mode is useful for checking whether a site loads and whether it's being challenged from the server, and for future work. For actually using ChatGPT or Claude, the standard proxy is the way.
