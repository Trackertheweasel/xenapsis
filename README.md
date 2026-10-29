![Persec](./persec.svg)

**Persec** is a free, browser-like tabbed web proxy for people living under internet censorship. It runs in any modern browser, with nothing to install.

---

## Features

- Browser like UI and navigation
- Works on phones and tablets
- Fast performance
- `about:blank` cloaking
- Built in ad blocking
- Keeps WebRTC from revealing your real IP address (switch it off in Settings for game streaming such as GeForce NOW)
- No analytics or third-party trackers
- Self-served, tracking-free sponsor slot
- Tab system
- Keyboard shortcuts
- Optional saved logins: an encrypted backup of your site logins, tied to your invite code
- PerSec AI: a built-in chat assistant powered by OpenRouter, free models by default
- And much more

---

## Deployment Options

> **Note**  
> Persec **cannot** be deployed to Netlify, Vercel, GitHub Pages, or any other static hosting platform.

### Your own server (recommended)

Hosting platforms often shut down proxies. A small server of your own (a VPS) doesn't sleep, has no platform rules against proxies, and costs about $4–6 a month. Any Ubuntu or Debian server with 1 GB of memory works, for example a DigitalOcean Basic Droplet.

1. Create the server: choose **Ubuntu**, the 1 GB plan, and any region.
2. Optional but more reliable: get a free name at [duckdns.org](https://www.duckdns.org) (sign in, pick a name, and put your server's IP address in the **current ip** box). Without one, Persec uses a free `<your-ip>.sslip.io` address.
3. Open the server's console (on DigitalOcean: your Droplet → **Console**) and paste:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | bash
   ```

   With a DuckDNS name, paste this instead:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | PERSEC_DOMAIN=yourname.duckdns.org bash
   ```

4. After 5–10 minutes it prints your site's address and your own invite code (valid for a year).

The site runs over HTTPS (needed for the proxy to work) and is invite-only. Manage it from the same console:

| Command                       | What it does                                                             |
| ----------------------------- | ------------------------------------------------------------------------ |
| `persec add <name> <code>`    | Lets someone in with a code you choose (also changes their code)         |
| `persec invite <name> [days]` | Makes an invite code for someone (default 30 days)                       |
| `persec revoke <name>`        | Cancels that person's invites right away                                 |
| `persec domain add <name>`    | Adds another web address, e.g. a new DuckDNS name if one gets blocked    |
| `persec domain remove <name>` | Stops using a web address                                                |
| `persec domain`               | Lists the site's web addresses                                           |
| `persec export`               | Prints a command to set up a backup server that shares these invites     |
| `persec admin`                | Turns on a live usage page per person at `/admin` and shows its password |
| `persec status`               | Checks that each web address answers over HTTPS (fails if one doesn't)   |
| `persec logins export/import` | Copies saved-login backups to or from another server (still encrypted)   |
| `persec update`               | Updates to the latest version                                            |
| `persec rollback`             | Goes back to the version from before the last update                     |
| `persec logs`                 | Shows what the server is doing                                           |

`persec update` installs whatever is newest on the `master` branch. To stay on a known version instead, name a release tag (or another branch): `PERSEC_BRANCH=<tag> persec update`. If an update misbehaves, `persec rollback` switches back to the build that ran before it in seconds, without rebuilding.

If the site shows a certificate error with the `sslip.io` address, or a single name gets blocked, add another name with `persec domain add` (your settings and invites are kept) and share it. It is worth keeping a spare name or two added so a block never cuts everyone off.

#### When a whole dynamic-DNS provider is blocked

Filters and some browsers block entire free dynamic-DNS providers at once — all of `*.duckdns.org`, `*.sslip.io`, `*.nip.io`, `*.no-ip.*` — not just one name. If that happens, a _new_ DuckDNS (or sslip.io) name does **not** help; it is in the same blocked category. Switch to a domain that isn't:

1. Register a cheap domain from any registrar (the cheapest TLDs cost about $1–10 a year). A normal registered domain isn't in the dynamic-DNS category.
2. Add a DNS **A record** pointing it at your server's IP address.
3. Run `persec domain add yourdomain.com`, and once it works, `persec domain remove` the blocked one. Caddy fetches its HTTPS certificate automatically.

A spare domain is still worth keeping pre-added — but make it a registered domain (ideally at a different registrar), not another dynamic-DNS name. For a server whose **IP** is blocked, or to hide the IP, see below; putting the domain behind a free CDN such as Cloudflare (proxying on, SSL/TLS set to Full) also moves visitors onto the CDN's addresses and gives the name normal reputation.

#### Putting the domain behind Cloudflare

1. Add the domain to a free Cloudflare account and switch the registrar's nameservers to the two Cloudflare gives you.
2. Add an **A record** for the domain pointing at your server's IP, with the proxy **off** (grey cloud) for now.
3. Run `persec domain add yourdomain.com` and open `https://yourdomain.com` to check that Caddy got its certificate.
4. Turn the proxy **on** (orange cloud). Under **SSL/TLS**, choose **Full (strict)**.
5. Leave **Always Use HTTPS** off: Caddy already redirects to HTTPS, and leaving plain HTTP alone keeps its certificate renewals simple. Turn off **Rocket Loader** and **Bot Fight Mode**, which break the proxy's scripts and WebSocket.

Persec reads the visitor's real address from Cloudflare (only from Cloudflare's own address ranges), so the invite-code attempt limit still counts each visitor separately.

Cloudflare decrypts traffic to your domain before passing it on, so it can see Persec's own pages, invite codes and sign-in cookies. Sites opened through Persec stay encrypted end to end over HTTPS, because the proxy's TLS runs inside the browser. Cloudflare still sees how much traffic each visitor sends, and the tunnel's WebSocket. It may also close long-lived connections now and then, which the proxy reconnects from.

#### Choosing how people reach the server

|                                      | Direct HTTPS (the default)                                          | Behind a CDN (Cloudflare)                                                             | Independent backup server                                  |
| ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| What a filter has to block           | The domain name, or the server's IP                                 | The domain name (unless ECH hides it), or the CDN, which affects many unrelated sites | Each server separately                                     |
| Who can see Persec's pages and codes | Only your server                                                    | Your server and the CDN                                                               | Each server                                                |
| Hides the server's IP                | No                                                                  | Yes, from visitors (not from the CDN)                                                 | No                                                         |
| ECH                                  | Only with a custom Caddy build (below)                              | Automatic                                                                             | Per server                                                 |
| Certificates                         | Caddy, automatic; needs ports 80 and 443 open and DNS pointing here | Caddy behind the CDN (SSL/TLS **Full (strict)**); the CDN has its own                 | Caddy on each server                                       |
| Depends on                           | Your DNS provider and hosting provider                              | Also the CDN's account and its policies                                               | A second provider, and people knowing the backup's address |
| When it fails                        | Add a name (`persec domain add`), or move to a backup               | Turn the CDN off for that name (grey cloud) to go direct, or use a backup             | —                                                          |

These combine. A sensible setup is one name behind a CDN, one name direct, and a backup at another provider that is reached directly, not through the same CDN. Then a block on the CDN, or on ECH, still leaves a way in. See [docs/resilience.md](docs/resilience.md) for which blocks each one helps with.

#### Surviving a blocked server

Extra names all point at one server, so if its **IP address** is blocked (not just a name), every name goes down at once. The fix is a second server on a different provider or region.

1. On your current server's console, run `persec export`. It prints a ready-to-paste `curl ... | PERSEC_SECRET=... bash` command. If you hid the tunnel path, the command gives the backup its own random one.
2. Open a second server's console (a different host is best) and paste that command.
3. Run `persec domain add` on the second server to give it its own name.
4. Send people the backup's address together with their invite code, through the same private channel. If the main server is blocked, its pages can't tell anyone where to go instead.
5. Optional: copy saved logins across with `persec logins export > logins.tar` on the first server and `persec logins import < logins.tar` on the second. The files stay encrypted.

What the two servers share, and what they don't:

- **Minted invites** (`persec invite`) work on both, because both have the same `PERSEC_SECRET`.
- **Codes from `persec add` and revokes from `persec revoke` are copied once, by the export command, and never again.** Run them on every server; a revoke done only on one leaves that person able to use the other.
- **Each address is a separate site to the browser.** Someone moving to the backup's address signs in again, and starts with default settings and no bookmarks unless they bring them (Settings → Advanced → _Move to another address_: export the file at the old address, import it at the new one). Proxied sites' logins come back with **Restore my logins**, if the backups were copied.
- To avoid all that, keep one domain and move its DNS record to the backup when the main server's IP is blocked. Browsers then see the same site, so settings, bookmarks and sign-ins carry over. This needs a domain you control, and Caddy on the backup gets its certificate only after DNS points to it (a minute or two).

Run `persec status` on each server (or point an uptime monitor at `https://<your-domain>/enter`, which answers 200) to know when one is down. It checks from the server's side only; a block in one country shows up as reports from people there. Failover is a manual step on purpose; [docs/resilience.md](docs/resilience.md) explains why and has the full list of what is shared.

Keep the `export` command private: anyone with the secret can mint invites on every server that shares it. Changing the secret on one server signs everyone out there and stops the other servers' invites working on it.

#### Hiding the proxy endpoint

The proxy's traffic flows through a WebSocket at a fixed path, `/w/`. Because that path is the same on every install, a network that suspects your server is a proxy can confirm it just by probing that one URL. You can move the tunnel to a hard-to-guess path so there is nothing constant to probe — to anything that doesn't already have an invite, the server then looks like an ordinary website.

Set `PUBLIC_PERSEC_WISP_PATH` when you first install, for example:

```bash
curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | PUBLIC_PERSEC_WISP_PATH=/$(openssl rand -hex 6)/ bash
```

The value is built into the app, so set it at install time (changing it later means rebuilding, which `persec update` does). Leave it unset to keep the default `/w/`. This hides the endpoint from probing; it does not change the server's IP address or domain name, so pair it with a spare domain and a backup server (above) for blocks at those levels.

Proxied pages don't show the site's address in Persec's own URLs either: instead of `/v1/data/https%3A%2F%2Fexample.com`, the address is scrambled with a key that is new on every build. The key ships with the app, so this keeps URLs from giving the proxy away at a glance; it is not encryption. A rebuild (`persec update`) changes the key, so proxied tabs left open from before need reopening. To keep one key across builds or backup servers, set `PUBLIC_PERSEC_URL_KEY` in `deploy/.env`.

The paths themselves are randomised too. Fixed paths like `/v1/data/`, `/sw.js` or `/bm/worker.js` are the same on every Persec install, so a filter that sees the addresses a page requests could match them to recognise the proxy. Each build instead picks random names for the two proxied-URL prefixes, the service worker, the folder the proxy runtime is served from, and every file in it. They change on every rebuild along with the URL key, so the same caveat applies (open proxied tabs need reopening after an update). To keep them stable across builds or backup servers, set `PUBLIC_PERSEC_URL_KEY` and `PUBLIC_PERSEC_PROXY_KEY` in `deploy/.env`.

The files' contents are disguised too. The proxy runtime is the public Scramjet, Ultraviolet, bare-mux and libcurl code, full of their names (`scramjet`, `__uv$config`, `bare-mux`), which a filter can look for in what a page downloads. Each build replaces those names, everywhere in the site's code, with random stand-ins of the same length. Like the paths, they change on every rebuild unless `PUBLIC_PERSEC_PROXY_KEY` is set. Two things keep their names on purpose: links to the projects' websites, and Scramjet's `$scramjet` database, so an update doesn't sign everyone out of the sites they use. If a site ever breaks because of it, set `PUBLIC_PERSEC_SCRUB=off` in `deploy/.env` and run `persec update` to build without it.

Words in the pages themselves, such as "proxy", "unblocked" or "games", can be hidden from keyword scans with `PUBLIC_PERSEC_MASK_TEXT=1`. Each one gets invisible soft hyphens, so it looks the same but no longer matches the plain word. Find-in-page won't find those words any more, which is why this is off by default. It covers the text in Persec's pages, not text that scripts add later (pop-up messages, for example).

Treat all of this as a second line of defence. Still visible to a determined filter:

- **File contents, beyond names.** The runtime is still recognisably the same code; a filter that compares the structure of downloads, rather than hashes or names, could still match it.
- **The shape of the names.** Every random path is 8 hex characters, and the runtime is one folder of such files.
- **What the page does.** It registers a service worker for the whole site and opens a WebSocket, which a scanner that runs the page's scripts can see. The scripts also carry the URL key, so the scrambled URLs are obfuscation, not encryption.
- **Active probing.** Anyone can load the site and read its scripts to find the paths.

#### Hiding which site you're visiting (Encrypted Client Hello)

Even over HTTPS, the domain name your browser asks for is sent in the clear at the start of every connection (the TLS "SNI"). This is how many filters block a site: they never see the page, only the name, and drop the connection. **Encrypted Client Hello (ECH)** encrypts that name too, so a network watching the connection can't tell which site is being reached from the handshake.

ECH needs two things: the server (or a CDN in front of it) has to offer ECH and publish its key in a DNS record, and the **visitor's browser has to have ECH turned on**. In Chrome, Edge and Firefox that happens automatically once **Secure DNS (DNS-over-HTTPS)** is enabled, so it's worth telling people to switch Secure DNS on in their browser settings.

Two ways to get it:

1. **Through Cloudflare (recommended, no server changes).** Put the domain behind Cloudflare — the same free step that hides the server's IP (proxying on, SSL/TLS set to Full). Cloudflare turns ECH on automatically for proxied domains and publishes the DNS record for you. Nothing to configure on the server.
2. **In Caddy, on your own domain (advanced).** Caddy 2.10+ can do ECH itself, but it has to publish the key to your DNS, so it needs a Caddy build that includes **your DNS provider's module** plus an API token for it. The stock `caddy:2` image used here does not include DNS modules, so this means building a custom Caddy image. See the commented `ech` block in [`deploy/Caddyfile`](deploy/Caddyfile) for the shape of the config.

What ECH does not do: it hides only the name. A filter can still block the server's (or the CDN's) IP address, block the CDN altogether, or tell proxy traffic apart by its timing and volume. Browsers only use ECH when they find its DNS record, which usually needs Secure DNS. Support also differs between browsers and versions, so some visitors will connect without it.

> **Important, and region-dependent.** ECH helps where filtering is based on the domain name. But some censors respond by blocking **all** ECH traffic rather than reading it — Russia's filtering devices began dropping ECH connections to Cloudflare in late 2024. So ECH can _remove_ a block in one country and _cause_ one in another. Keep a non-ECH address available as a fallback, and test from the actual region before relying on it.

### Other options

<p>
  <a href="https://render.com/deploy?repo=https://github.com/Trackertheweasel/xenapsis"><img src="https://raw.githubusercontent.com/BinBashBanana/deploy-buttons/main/buttons/remade/render.svg" alt="Deploy to Render"></a>
  &nbsp;
  <a href="https://codespaces.new/Trackertheweasel/xenapsis"><img src="https://github.com/codespaces/badge.svg" alt="Open in GitHub Codespaces" height="32"></a>
</p>

All of these options are free to use.

| Platform          | Config file                       | Notes                                                                                                                   |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Render            | `render.yaml`                     | Free web service. Sleeps after 15 minutes without traffic and takes about a minute to wake up. Invite-only (see below). |
| GitHub Codespaces | `.devcontainer/devcontainer.json` | Free monthly hours for personal accounts. Run `pnpm build && pnpm start`, then open the forwarded port `6060`.          |
| Docker            | `Dockerfile`                      | Run it on your own computer or server (see below).                                                                      |

A Render deploy starts invite-only with a generated `PERSEC_SECRET`. Copy that secret from the service's Environment page and mint your first invite on your own computer with `PERSEC_SECRET="<secret>" pnpm invite <name>` (see [Handing out invites without restarting](#handing-out-invites-without-restarting)), or add `PERSEC_INVITE_CODES` there.

### Docker

```bash
docker build -t persec .
docker run -d -p 8080:8080 --restart unless-stopped --name persec \
  -e PERSEC_INVITE_CODES="me:$(openssl rand -hex 8)" \
  -e PERSEC_SECRET="$(openssl rand -hex 32)" \
  persec
docker inspect persec --format '{{range .Config.Env}}{{println .}}{{end}}' | grep INVITE_CODES
```

Persec will be available at `http://localhost:8080`. Sign in with the code after `me:` that the last command prints. Without `PERSEC_INVITE_CODES` or `PERSEC_INVITE_ONLY`, Persec is open to everyone who finds it, so only leave them out on a computer nobody else can reach. The image has a health check at `/healthz`.

---

## Deployment via Terminal

> **Note**  
> Before deploying, install:
>
> - [Git](https://git-scm.com/downloads)
> - [Node.js](https://nodejs.org/en/download/prebuilt-installer) 22.23.4 or newer (the version in `.nvmrc`; with nvm, run `nvm install`). Astro refuses to build on anything older.
>
> Then install **pnpm**:
>
> ```bash
> npm install -g pnpm
> ```

### Production

1. Clone the repository:

   ```bash
   git clone https://github.com/Trackertheweasel/xenapsis
   cd xenapsis
   ```

2. Install dependencies, build, and start the server:
   ```bash
   pnpm install
   pnpm build
   pnpm start
   ```
   After pulling new code, run `pnpm build` again before `pnpm start`; the server only starts what was last built.

### Development

If you are actively developing Persec, use the development server to avoid constant rebuilds:

```bash
pnpm install
pnpm dev
```

The dev server has no sign-in page. If `PERSEC_INVITE_CODES` or `PERSEC_INVITE_ONLY` is set, it keeps the proxy connection closed, as production does without an invite. Unset them to browse through the proxy in dev.

---

## Invite-only mode

Most hosting providers forbid public proxies but allow private ones. In invite-only mode, nobody can use Persec (pages, files or the proxy connection) until they enter an invite code. Each person gets their own code, so you can remove one person without affecting the rest.

1. Make a code for each person (run once per person):

   ```bash
   node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"
   ```

2. Make a secret that keeps people signed in across server restarts:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Start Persec with both set. Codes are `name:code` pairs separated by commas; the names are only for you.

   ```bash
   docker run -d -p 8080:8080 --restart unless-stopped --name persec \
     -e PERSEC_INVITE_CODES="sam:Xq3...,lee:9fT..." \
     -e PERSEC_SECRET="<your secret>" \
     persec
   ```

If Persec runs behind a reverse proxy other than the bundled Caddy, set `PERSEC_CLIENT_IP_HEADER` to the header that proxy puts the visitor's address in (for example `x-real-ip`), and only if the proxy always overwrites it. Persec uses it to count wrong codes per visitor. Without it, Persec counts by the connection's address and ignores such headers, because anyone could otherwise send a different fake address with every guess. `deploy/compose.yml` sets it for Caddy.

`render.yaml` sets it to `true-client-ip`, the header Cloudflare (in front of Render) fills in, but Render doesn't document that a visitor can't supply their own. Check it once after deploying: send 11 wrong codes, each with a different made-up address, and the last one must still be refused with "Too many attempts":

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null -w '%{http_code}\n' -H "True-Client-IP: 203.0.113.$i" \
    -d code=wrong https://<your-app>.onrender.com/enter
done
```

If it ends in `401` instead of `429`, the header can be faked: delete `PERSEC_CLIENT_IP_HEADER` in the Render dashboard. Wrong codes are then counted for all visitors together, which is strict but can't be dodged. The check itself locks your own address out for 15 minutes.

With `PERSEC_ADMIN_PASSWORD` set (12+ characters; `persec admin` makes one), `/admin` shows each invite name's usage live: online now, data downloaded and uploaded, time connected, tabs opened and last seen. Open it signed in with your own code, then enter that password (any username). The counts are kept only in memory and reset on restart, sites visited are never recorded, and the privacy page tells people this can be on. Without the password, nothing is counted.

People enter their code once and stay signed in as long as they come back at least once every 30 days, and their browser's password manager can save the code for them. The new tab page greets each person by their invite's name (the part before the `:`, or the name given to `persec invite`), so pick names you're happy for them to see. To revoke someone, remove their entry and restart Persec. Without `PERSEC_INVITE_CODES`, Persec is open to everyone.

### Handing out invites without restarting

With `PERSEC_SECRET` set, you can also mint invites on your own computer. They need no restart or redeploy and stop working on their own:

```bash
PERSEC_SECRET="<your secret>" pnpm invite sam 30   # prints a code that works for 30 days
```

- A minted invite signs someone in for 30 days, or until the invite expires if that comes first.
- To cancel one early, add the name to `PERSEC_REVOKED` (for example `PERSEC_REVOKED="sam,lee"`) and restart. This works for listed codes too.
- Give each person their own name: revoking a name cancels every invite minted with it.
- To use only minted invites, set `PERSEC_INVITE_ONLY=true` instead of `PERSEC_INVITE_CODES`.
- Anyone with `PERSEC_SECRET` can mint invites, so keep it as private as the codes. It also recreates every minted code, so together with the backups it unlocks everyone's saved logins: treat `deploy/.env` and `persec export` output accordingly. Changing it signs everyone out and cancels every minted invite.

Share codes privately (in person or an encrypted messenger), never on a public page. After 10 wrong codes, an address has to wait 15 minutes.

### Saved logins

On an invite-only Persec, a cookie notice on the first visit asks people whether to save their logins. If they agree, Persec keeps an encrypted backup of the cookies and site data that sites save in Persec, so they are still signed in to those sites when they come back, even on a new device or after their browser was cleared: they enter their invite code and tap **Restore my logins**. They can turn it off, or restore, in Settings → Privacy & Cloaking. Without invite codes, the notice only explains Persec's cookies.

- The backup is encrypted in the browser with a key made from the person's invite code, so the server only stores data it can't read on its own. Anyone with the code can unlock it, and that includes you, since you hand out the codes, and anyone who gets hold of `PERSEC_SECRET` or `PERSEC_INVITE_CODES`, since those are enough to recreate every code. The cookie notice and privacy page say so.
- Proxied sites run on Persec's own address, so Persec relies on the proxy engines (Scramjet and Ultraviolet) to keep a site's scripts away from other sites' cookies and from saved logins. As a second line, the service worker only reads, restores or clears cookies when Persec's home page or Settings asks. A site that breaks out of the engines could still read what the browser stores for Persec. The privacy page warns about this.
- **Give each person their own code.** Everyone who signs in with the same code shares one backup.
- Backups are stored in `data/logins` (with Docker Compose, the `persec_data` volume, which `persec update` keeps). Set `PERSEC_DATA_DIR` to store them elsewhere. Render and Codespaces have no lasting disk, so backups there are lost on every restart.
- A backup is deleted when its owner turns saved logins off or clears site data, and automatically when it hasn't been updated for 90 days.
- Backup servers (`persec export`) share invites but not backups: each server keeps its own. Copy them across with `persec logins export` and `persec logins import`; neither server can read them.

---

## PerSec AI

PerSec AI is a chat assistant at `/ai` (`persec://ai`, or the sparkles button in the sidebar). It runs through [OpenRouter](https://openrouter.ai), one API that reaches models from many companies, including a pool of free ones:

```
browser  ->  Persec /api/ai/*  ->  OpenRouter  ->  the chosen model
```

The browser only ever talks to Persec. Persec holds the OpenRouter key and makes the request itself, so the key never reaches a page, a cookie, browser storage or a saved-logins backup. Clients pick a model by its ID and nothing else; they can't name an upstream address, header or provider, so the AI routes can't be used as a general proxy.

### Turning it on

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys). A free account works with the free models. Setting a credit limit on the key is a good idea.
2. Add it to the server's environment (with Docker Compose, `deploy/.env`) and restart:

   ```
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

Without a key, Persec runs normally and the AI page says PerSec AI isn't set up. PerSec AI also needs [invite-only mode](#invite-only-mode): on a server open to everyone, anyone who found it could spend your OpenRouter allowance, so it stays off unless you set `PERSEC_AI_ALLOW_OPEN=true` as well.

| Variable                     | What it does                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`         | Your OpenRouter key. Required; PerSec AI is off without it                                                                                                                              |
| `OPENROUTER_DEFAULT_MODEL`   | The model chosen until someone picks another (default `openrouter/free`, which lets OpenRouter pick whichever free model is available)                                                  |
| `OPENROUTER_ALLOWED_MODELS`  | Unset or `free`: free models only, so nobody can run up a bill. `all`: every model OpenRouter lists. Or a comma-separated list of model IDs                                             |
| `OPENROUTER_MAX_TOKENS`      | Longest reply, in tokens (unset: the model's own limit)                                                                                                                                 |
| `AI_RATE_LIMIT_WINDOW_MS`    | Length of the rate-limit window (default 60000, one minute)                                                                                                                             |
| `AI_RATE_LIMIT_MAX_REQUESTS` | Messages each invite may send per window (default 20). Each invite may also have two replies generating at once                                                                         |
| `AI_UPSTREAM_TIMEOUT_MS`     | How long to wait for a model to start answering (default 60000)                                                                                                                         |
| `PERSEC_AI_ALLOW_OPEN`       | `true` to run PerSec AI on a server with no invite codes, rate limited per address instead (behind a reverse proxy, set `PERSEC_CLIENT_IP_HEADER` so each visitor gets their own limit) |

The model picker lists what OpenRouter offers right now (fetched by the server and cached for 10 minutes), with each model's provider, context length and whether it's free. Only free models are offered unless you set `OPENROUTER_ALLOWED_MODELS=all` (or list the IDs you want); paid models use your OpenRouter credits.

### What happens to messages

- Conversations are kept in each person's own browser (IndexedDB), never on the Persec server. People can turn that off or clear a conversation on the page.
- The server logs no messages, replies or keys. Failures are logged by their error code only (for example `PerSec AI: upstream_auth` when the key is wrong).
- Each message, with the rest of its conversation, goes to OpenRouter and on to the company running the chosen model. OpenRouter sees the server's address, not the visitor's. The page and the privacy page say so; it is not local or end-to-end private.

The Astro dev server (`pnpm dev`) has no `/api/ai` routes; run `pnpm build && pnpm start` to try PerSec AI locally.

## Web AI (ChatGPT and Claude)

`/webai` (`persec://webai`, or **Web AI** at the top of the PerSec AI page) opens the real [ChatGPT](https://chatgpt.com/) and [Claude](https://claude.ai/) websites through the normal proxy. It is not PerSec AI and doesn't use OpenRouter. People use the sites themselves, with their own accounts. Persec doesn't touch either company's API, sign-in or credentials.

Both sites are behind Cloudflare and may show a "Just a moment…" or "couldn't verify your browser" check when opened through a proxy. Persec doesn't try to get past these; if one won't clear, the site can't be used through this server. [docs/web-ai.md](docs/web-ai.md) has the proxy audit (WebSockets, streaming, cookies, storage, security headers), the known limits, and a compatibility checklist to run on your deployment.

### Browser mode (optional, off by default)

An owner with a spare machine can also run [Camoufox](https://github.com/daijro/camoufox) as a separate browser service. Each signed-in person then gets an isolated server-side browser session for ChatGPT or Claude. It needs invite-only mode, at least 2 GB of RAM for the browser service, `playwright-core` installed next to Persec, and these settings:

| Variable                      | What it does                                                    |
| ----------------------------- | --------------------------------------------------------------- |
| `CAMOUFOX_ENABLED`            | `true` to turn browser mode on                                  |
| `CAMOUFOX_WS_ENDPOINT`        | The browser service's Playwright endpoint, on a private network |
| `CAMOUFOX_MAX_SESSIONS`       | Browsers open at once (default 2)                               |
| `CAMOUFOX_SESSION_TIMEOUT_MS` | Longest a session lives (default 30 minutes)                    |
| `CAMOUFOX_IDLE_TIMEOUT_MS`    | How long an unused session stays open (default 5 minutes)       |

Sessions can be viewed and moved between pages, but typing into them isn't implemented yet. See [docs/browser-runtime.md](docs/browser-runtime.md) for the evaluation, security model, deployment steps and remaining work.

---

## Sponsors (ads)

Persec shows at most one ad card on the new tab page. By default the card is a self-served sponsor: a plain image and link you add by hand, with no ad network, no scripts and no tracking.

You can also connect a real ad network **without** exposing your visitors to it. Persec fetches the ad on its own server, copies the image, and serves the image, the view count and the click through Persec's own address. So the visitor's browser never runs an ad script, never loads anything from the network, and the network is never told who the visitor is — it only ever sees your server. This matters for people using Persec to get around censorship, and it keeps the ad working even where the network's own domain or scripts are blocked.

### Self-served sponsors

To add a sponsor by hand:

1. Put the sponsor's image (square, at least 80×80) in `public/a/images/sponsors/`.
2. Add an entry to `public/a/json/sponsors.json` and set `"enabled": true`:

   ```json
   {
     "enabled": true,
     "name": "Sponsor name",
     "text": "One short line about the sponsor.",
     "url": "https://sponsor.example",
     "image": "/a/images/sponsors/sponsor.png"
   }
   ```

When more than one sponsor is enabled, each page load picks one at random. If none are enabled, no card is shown. Keep image URLs local (starting with `/`): the tests fail if a sponsor image is loaded from another site.

### Connecting an ad network (server-proxied)

Set these environment variables on the server to serve ads from a network instead. It is off unless `PERSEC_AD_NETWORK` is set, and if a fetch ever fails Persec falls back to the self-served sponsors above, so the card never breaks.

| Variable              | What it does                                                                         |
| --------------------- | ------------------------------------------------------------------------------------ |
| `PERSEC_AD_NETWORK`   | `ethicalads`, `generic`, or unset (off)                                              |
| `PERSEC_AD_API_KEY`   | Your network API key                                                                 |
| `PERSEC_AD_PUBLISHER` | Your publisher/site id (EthicalAds)                                                  |
| `PERSEC_AD_API_URL`   | API base. Optional for EthicalAds; for `generic`, the full URL of your JSON endpoint |
| `PERSEC_AD_TTL`       | Seconds to reuse a fetched ad before asking again (default 300, minimum 30)          |

- **`ethicalads`** uses [EthicalAds](https://www.ethicalads.io/)' server-to-server decision API — a good fit for a privacy-first, image-only ad.
- **`generic`** points Persec at any URL that returns the JSON `{ "name", "text", "image", "click", "impression" }` (`impression` optional). Use it to connect any other network through a small shim of your own, or to serve a rotating house ad. `image` and `click` are the network's own URLs; Persec fetches them, never the visitor.

Persec deliberately sends the network no visitor IP or user agent, so it cannot profile or target the people behind your server. With Docker Compose, pass these through in `deploy/.env`.

---

## Tunnel ad blocking

The server refuses to open connections to ad and tracker hosts on a public DNS blocklist, so ads stop loading for every visitor whichever engine they use (an idea from [Interstellar](https://github.com/UseInterstellar/Interstellar)). The list is [AdGuard DNS filter](https://github.com/AdguardTeam/AdGuardSDNSFilter), downloaded at start and once a day after; it takes about 25 MB of memory. If the download fails nothing is blocked, so browsing never breaks.

| Variable                    | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `PERSEC_WISP_ADBLOCK`       | `off` turns tunnel ad blocking off                                      |
| `PERSEC_WISP_BLOCKLIST_URL` | Another list in Adblock (`\|\|host^`) or hosts-file format, up to 10 MB |

---

## When Persec can't connect

When something Persec needs isn't available, the browser window shows what failed instead of loading forever. It covers service workers, shared workers, site storage, WebAssembly, the proxy engine, and the connection to the server. It also says whether to fix it in the browser, try another network or the backup address, or sign in again. **Settings → Advanced → Check connection** runs the same checks on demand. If they all pass and a site still won't load, that site is the problem; try the other proxy engine in Settings. Where a browser setting or a school or work policy turns off something Persec needs, the message says so and suggests another browser or device. Persec never tries to get around the policy. [docs/resilience.md](docs/resilience.md) lists which browsers are expected to work.

---

## Privacy

Users can read what Persec collects at `persec://privacy` (also linked from the new tab page and Settings → About). If you change what the server logs or add anything that contacts a third party, update `src/pages/privacy.astro` so the page stays accurate.

---

## Contributing

Please read the [Contributing Guide](CONTRIBUTING.md) before submitting changes.

---

## Support

Found a bug? Open a [GitHub Issue](https://github.com/Trackertheweasel/xenapsis/issues).

---

## Credits and license

Persec is based on [Lunar v2](https://github.com/lunar-proxy/lunar-v2) by Bearcattt and the Lunar contributors, and is licensed under the [GNU AGPL-3.0](LICENSE). Some features are ported from [Interstellar](https://github.com/UseInterstellar/Interstellar) (games and apps list, extra themes, the custom tile and the idea of tunnel ad blocking), [InvisiProxy LTS](https://github.com/InvisiProxy/InvisiProxyLTS) (privacy guards and site fixes), [Nebula](https://github.com/NebulaServices/Nebula) (themes and the build's name scrub) and [InvisiProxy](https://github.com/QuiteAFancyEmerald/Holy-Unblocker) (text masking), all AGPL-3.0. Games marked as served from a GitHub mirror are third-party files from the [3v1/V5-Assets](https://github.com/3v1/V5-Assets) and [xbubbo/V6-Assets](https://github.com/xbubbo/V6-Assets) repositories, pinned to one commit each; their copyright stays with their owners and Persec does not store them. Because Persec runs as a network service, the AGPL requires that its users can get the source code; the app links to this repository from Settings → About and from the privacy page.
