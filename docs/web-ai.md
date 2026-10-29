# Web AI: ChatGPT and Claude through Persec

Persec has two AI features that share nothing:

```
                         PERSEC
                            |
        +-------------------+-------------------+
        |                   |                   |
    Web proxy           PerSec AI        Browser runtime (optional)
        |                   |                   |
 Wisp/Scramjet/UV      OpenRouter           Camoufox
        |                   |                   |
    web sites           AI models        a real browser
        |                                       |
  +-----+-----+                           +-----+-----+
  |           |                           |           |
ChatGPT     Claude                     ChatGPT     Claude
```

- **PerSec AI** (`/ai`) sends messages through this server's `/api/ai/chat` to OpenRouter. It is an API integration and is not covered here.
- **Web AI** (`/webai`, `persec://webai`) opens the real `https://chatgpt.com/` and `https://claude.ai/` websites. In the standard proxy they load like any other site. Persec doesn't call either company's API, doesn't automate or watch sign-in, and never sees a password: the person uses the site itself.
- **Browser mode** is an optional server-side browser. It is off unless the owner runs one. See [browser-runtime.md](browser-runtime.md).

ChatGPT and Claude are also in the Apps list (`/sci`) with the same addresses.

## How a site loads through the standard proxy

```
your browser
  page (Scramjet or Ultraviolet rewrites it)  ->  service worker (src/sw.js)
  ->  bare-mux SharedWorker  ->  libcurl.js (TLS runs here, in your browser)
  ->  WebSocket to /w/ (Wisp)  ->  Persec server: a plain TCP connection  ->  chatgpt.com:443
```

The server never sees HTTP from the site. It moves TCP bytes. TLS starts in the visitor's browser and ends at chatgpt.com or claude.ai. Cookies, headers, redirects, CSP and streaming are all handled in the visitor's browser, by the proxy engine.

## Audit of what these sites need

Each item was checked against the code and the packages in `node_modules` (Scramjet 1.1.0, Ultraviolet 3.2.10, bare-mux 2.1, libcurl-transport 1.5.1 with libcurl.js 0.7.3, wisp-js 0.4.1).

| Need                             | Where it's handled                                                                                                                                                                                                          | Verdict                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS                            | libcurl.js in the browser, over the tunnel                                                                                                                                                                                  | Works. The server can't read or change it. A network that intercepts TLS breaks it on purpose, with "SSL peer certificate … not OK".                                                                                                                                                      |
| Long-lived tunnel                | `serverlib/wisp.ts`, wisp-js server                                                                                                                                                                                         | Works. wisp-js has no idle timeout on the TCP side. It pings the WebSocket every 30 s, which keeps proxies such as Cloudflare (100 s idle limit) from closing it. Node's socket timeout is 0. Caddy's `reverse_proxy` has no stream timeout by default. Tested in `tests/tunnel.test.ts`. |
| Streaming responses (SSE, fetch) | Server: TCP relay with Wisp flow control (128-packet window). Browser: libcurl.js hands the body over as a `ReadableStream`. Scramjet returns `response.body` as is for anything but documents, scripts, styles and workers | Works. Nothing buffers a whole reply. Tested: events reach the client as the site sends them, and a 1.5 s silence doesn't close the stream.                                                                                                                                               |
| Large responses                  | Wisp flow control, `ws` default 100 MiB max frame (Wisp frames are small)                                                                                                                                                   | Works. A 4 MiB reply arrives byte for byte in the test.                                                                                                                                                                                                                                   |
| Large requests (uploads)         | The service worker reads the request body before sending it                                                                                                                                                                 | Works, but uploads are held in browser memory first. Fetch with a streaming request body (`duplex: 'half'`) isn't streamed.                                                                                                                                                               |
| WebSockets                       | Scramjet and UV replace `WebSocket` in the page with bare-mux's. libcurl-transport opens it with `libcurl.WebSocket` over the same tunnel, passing the engine's headers and cookies                                         | Works. Tested over the tunnel, including after a quiet spell. One limit: libcurl-transport reports the negotiated subprotocol as empty, so a page reading `ws.protocol` sees `""`.                                                                                                        |
| EventSource                      | Scramjet rewrites the URL. The stream then goes through the service worker like any fetch                                                                                                                                   | Works.                                                                                                                                                                                                                                                                                    |
| Redirects, including sign-in     | libcurl-transport uses `redirect: "manual"`. The engine rewrites `Location` to a proxied URL and follows it in the page                                                                                                     | Works for redirect chains across hosts (auth.openai.com, accounts.google.com).                                                                                                                                                                                                            |
| Cookies                          | Emulated per site by the engine. Scramjet's jar is in the service worker and IndexedDB. Persec loads and saves it itself (`src/sw.js`), because Scramjet 1.1.0 forgot logins when the worker stopped                        | Works, HttpOnly included. Saved-logins backup covers it. Cookies set by a `fetch`/XHR reach `document.cookie` since the fix below.                                                                                                                                                        |
| localStorage, sessionStorage     | Scramjet prefixes keys with the site's host. UV wraps them                                                                                                                                                                  | Works.                                                                                                                                                                                                                                                                                    |
| IndexedDB                        | Scramjet prefixes database names with the site's origin (`IDBFactory.prototype.open`). UV wraps `open` as well                                                                                                              | Works.                                                                                                                                                                                                                                                                                    |
| Site service workers             | Scramjet runs with `serviceworkers: false` (`src/utils/pro.ts`)                                                                                                                                                             | Not supported. The sites work without one, but offline and push features don't.                                                                                                                                                                                                           |
| Strict security headers          | Scramjet strips CSP, COOP, COEP, CORP, HSTS, X-Frame-Options and similar from proxied responses, and rewrites `<meta http-equiv=CSP>`. Persec's own pages send COEP `credentialless` and COOP `same-origin`                 | Works. Both sites send `require-corp`/`same-origin`, which would otherwise block the frame. Sign-in popups stay on Persec's origin, so COOP doesn't cut them off.                                                                                                                         |
| iframe and navigation            | Each tab is an iframe registered with Scramjet (`tagFrame`). `window.open` is rewritten                                                                                                                                     | Works.                                                                                                                                                                                                                                                                                    |
| Server limits                    | Fastify's 1 MB body limit and compression apply only to Persec's own routes, not to the tunnel                                                                                                                              | No effect on proxied sites.                                                                                                                                                                                                                                                               |

Nothing needed fixing on the server for these sites. This change adds tests that pin the behaviour down, so a later change can't quietly break it.

## Fixes for reports that ChatGPT is buggy and Claude never passes Cloudflare's check

Reported on a real deployment: ChatGPT took a message but misbehaved, and Claude never got past Cloudflare's check. Four causes on Persec's side were found and fixed. None of them gets a check passed. They stop Persec from being the reason one fails.

1. **Cookies a site's server set weren't visible to the page.** Scramjet 1.1.0's worker meant to send the page each cookie from a response's `Set-Cookie`, but it looped over the list's positions instead of its values. The page got a junk `=0` cookie, and a cookie set by a `fetch` or XHR (sign-in steps, consent banners, Cloudflare's check) stayed invisible to `document.cookie` until a reload. Persec now fixes that line as it copies Scramjet into the build (`build/vendor.ts`). If a Scramjet upgrade changes it, the build stops and says so.
2. **Pop-ups came back as `null`.** The leak guard (Settings → Privacy guards, on by default) sent every `window.open` to a new Persec tab and gave the page nothing back. "Continue with Google", Apple and Microsoft open a pop-up and need that window to watch it and hear from it. `window.open(url, '_self')` also opened a new tab instead of navigating. Now a pop-up (a size, position or `popup` given, and no `noopener`) and `_self`, `_top` and `_parent` get the engine's own window, which stays on Persec's origin. A plain new tab is still a Persec tab, and a blocked pop-up opens in one too.
3. **Persec changed the browser inside the check frames.** Cloudflare's check frames (`challenges.cloudflare.com`, which runs Turnstile and the "Just a moment…" check), hCaptcha and reCAPTCHA look closely at the browser and fail when something has changed it. They now get none of Persec's own changes: no WebRTC wrapper, fingerprint noise, leak guard or site fixes. A chosen user agent still applies, because it's in every request's headers too, and a frame that disagreed with them would fail for that instead.
4. **Settings that make a browser lie.** A different user agent, or fingerprint noise, makes the browser report something it isn't, which Cloudflare's check catches ("a User Agent that changes during the session" is on Cloudflare's own list of causes). The Web AI page now says so when either is on and links to Settings.

What's still out of Persec's hands, and stays that way, because getting around it would mean defeating Cloudflare's checks:

- **The TLS fingerprint.** TLS runs in libcurl.js, so Cloudflare sees libcurl's handshake under a User-Agent that names Chrome, Firefox or Safari. That mismatch is a strong bot signal, and the main reason the check can still fail.
- **The server's address.** Cloudflare sees the Persec server's IP. A data-centre or VPS range is challenged more often than a home connection.
- **The page isn't where it says it is.** Under the proxy, every site runs on Persec's origin with the engine's code around it, and Cloudflare's scripts can notice that.
- **The WebRTC guard can still reach a check frame** when the page around it opens the frame's window first, because the guard follows into same-origin frames. It only changes `RTCPeerConnection`.

If Claude still loops on the check, Browser mode (where the owner runs it) or opening the site directly are the options. If ChatGPT is still buggy after this change, the browser console of the tab (errors, and any request that fails in the Network panel) says which part breaks.

## Google and Apple sign-in ("This browser or app may not be secure")

Reported on a real deployment, after `persec update`, with no privacy guards or fingerprint noise on: signing in to Gemini with a Google account stops on Google's "Couldn't sign you in. This browser or app may not be secure" page, on both Scramjet and Ultraviolet, and "Sign in with Google" or Apple doesn't work either.

That page is Google's own decision, not a Persec error. Google's sign-in page checks the browser it runs in and refuses ones it can't trust: embedded browsers, automated ones, and pages running inside another site's code, which is what a proxy is. Under Persec, Google's script runs on Persec's origin, inside the engine's rewritten page, and its requests arrive from the server's data-centre address with libcurl's TLS handshake. Google is built to spot exactly that, because it's what an account-stealing phishing proxy looks like too. Persec doesn't try to get around it: there's no setting or fix that would, and defeating it would mean defeating a check that protects accounts. "Sign in with Google" on other sites goes through the same Google page, so it fails the same way. Apple's sign-in page checks the browser in a similar way.

What does work: sign in on the site directly, outside Persec. Browser mode ([browser-runtime.md](browser-runtime.md)) can't help yet, since it has no typing or clicking and doesn't fit on a 1 GB server.

Two cookie bugs in the engines that could break sign-ins that do get past that page were fixed alongside (`build/vendor.ts`):

- **Scramjet changed cookie values.** Its jar decoded every value, so `ab%2Bc%2F%3D%3D` went back to the site as `ab+c/==`, and tokens stopped matching. It now keeps the value as sent.
- **Deleted cookies came back.** Scramjet ignored `Max-Age` entirely, and Ultraviolet ignored `Max-Age=0`, so a cookie a site deleted that way was still sent. Both now honour it, and Scramjet drops an expired cookie instead of storing it.

## What will get in the way

These are limits of proxying, not bugs. Persec doesn't try to get around them.

1. **Cloudflare bot checks.** Both sites are behind Cloudflare. A plain request from a server address gets `403` with `cf-mitigated: challenge`, as checked on 2026-10-28. Through Persec, Cloudflare sees the Persec server's address (often a data-centre range) and libcurl's TLS fingerprint, which doesn't match the browser named in the User-Agent. Expect a "Just a moment…" page or "couldn't verify your browser". If the challenge passes in the page, the site works. If it doesn't, Persec shows the site's own page and goes no further. A server on a residential or less-flagged address gets fewer challenges, but that is down to the network, not Persec.
2. **"Sign in with Google/Apple/Microsoft."** These providers often refuse sign-in from embedded or unusual browsers ("This browser or app may not be secure"). Email sign-in (Claude's emailed code, OpenAI's email and password) is more likely to work.
3. **Passkeys and WebAuthn** are tied to the real origin. A page on Persec's origin can't use a passkey made for chatgpt.com.
4. **Shared origin.** Every proxied site runs on Persec's own origin. The engines keep each site's cookies and storage apart, but a site that escaped the engine's rewriting could read another site's data, including a ChatGPT or Claude session. Use **Settings → Clear site data** when done on a shared device.
5. **Account risk.** OpenAI and Anthropic may treat sign-ins from a proxy address as unusual and ask for extra verification. That is their call to make.

## Compatibility checklist

Run this on a real deployment (HTTPS, a real domain) in a normal desktop browser and on an iPhone. Run it in each engine (Settings → Proxy Backend: Scramjet, then Ultraviolet). Never automate typing credentials. If a challenge appears, record it and stop. Don't retry in a loop.

Record each row as pass, fail or "challenged".

| #   | Check                       | How                                                                 | Expected                                                                               | ChatGPT | Claude |
| --- | --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------- | ------ |
| 1   | Initial navigation          | Web AI → Open                                                       | The site's home page, or a Cloudflare check (then rows 2–17 depend on it passing)      |         |        |
| 2   | Redirects                   | Watch the address bar after opening                                 | Lands on the final page (`/` or a sign-in page), with no redirect loop                 |         |        |
| 3   | Static assets               | Page looks styled, icons and fonts load                             | No broken layout. DevTools shows no blocked `cdn.oaistatic.com` / claude.ai assets     |         |        |
| 4   | JavaScript                  | The page is interactive (menus open, the composer takes focus)      | Works                                                                                  |         |        |
| 5   | Cookies                     | Accept or decline the site's cookie banner, then reload             | The choice is remembered                                                               |         |        |
| 6   | localStorage                | Change a site setting (theme), reload                               | Kept                                                                                   |         |        |
| 7   | IndexedDB                   | DevTools → Application → IndexedDB                                  | Databases named `https://chatgpt.com@…` / `https://claude.ai@…` (Scramjet)             |         |        |
| 8   | WebSocket                   | DevTools → Network → WS, while using the site                       | Sockets the site opens connect (look for 101) and stay open                            |         |        |
| 9   | Streaming                   | Send a prompt (signed out where allowed, or after row 11)           | The reply appears word by word, not all at once at the end                             |         |        |
| 10  | Navigation                  | Open another conversation, settings, back/forward buttons           | Works, and the address bar follows                                                     |         |        |
| 11  | Login page rendering        | Press "Log in"                                                      | The sign-in page renders (auth.openai.com / claude.ai/login). Type credentials by hand |         |        |
| 12  | Session persistence         | After signing in by hand: close the tab, reopen from Web AI         | Still signed in                                                                        |         |        |
| 13  | Page refresh                | Reload the tab mid-conversation                                     | Same conversation, still signed in                                                     |         |        |
| 14  | Browser reload              | Close and reopen the browser, open Persec                           | Still signed in (also after the service worker restarted)                              |         |        |
| 15  | Long-running conversation   | Keep one conversation going for 10+ minutes with gaps of 2+ minutes | No disconnects. Replies still stream                                                   |         |        |
| 16  | Large response              | Ask for a very long answer (for example, 3,000 words)               | Arrives in full and keeps streaming                                                    |         |        |
| 17  | Logout                      | Log out in the site                                                 | Signed out. Reopening shows the signed-out page                                        |         |        |
| 18  | Behind Cloudflare (if used) | Repeat 9 and 15 through a domain proxied by Cloudflare              | Same results. Cloudflare may drop the tunnel now and then, and the page reconnects     |         |        |

What the automated tests cover (no network needed):

- `tests/webai.test.ts`: the ChatGPT and Claude presets are the public home pages, the client and server lists match, the Apps list agrees, the `persec://webai` route exists, and the Web AI page never calls PerSec AI.
- `tests/tunnel.test.ts`: through the real server and Wisp tunnel, a streamed reply arrives as it's sent, a quiet connection stays open, a 4 MiB reply arrives intact, and a WebSocket opens and keeps working.
- `tests/vendor.test.ts`: the Scramjet and Ultraviolet cookie fixes apply to the files the build serves (values kept as sent, `Max-Age` and `Max-Age=0` honoured), and the build stops if one no longer matches.
- `tests/guards.test.ts`, `tests/sw.test.ts`: pop-ups and same-tab opens get a real window, check frames get none of Persec's changes but the chosen user agent, and the page around them still gets the WebRTC guard.
- `tests/browser.test.ts`: browser mode (see [browser-runtime.md](browser-runtime.md)).

### Not verified live in this change

The development sandbox for this change sits behind an egress gateway that re-signs TLS. The in-browser TLS correctly refused it ("SSL peer certificate … not OK"), so neither site could be loaded end to end from there. The checklist above has to be run on a real deployment.
