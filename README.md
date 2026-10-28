![Persec](./persec.svg)

**Persec** is a free, browser-like tabbed web proxy for people living under internet censorship. It runs in any modern browser, with nothing to install.

---

## Features

- Browser like UI and navigation
- Works on phones and tablets
- Fast performance
- `about:blank` cloaking
- Built in ad blocking
- No analytics or third-party trackers
- Self-served, tracking-free sponsor slot
- Tab system
- Keyboard shortcuts
- Optional saved logins: an encrypted backup of your site logins, tied to your invite code
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

| Command                       | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `persec add <name> <code>`    | Lets someone in with a code you choose (also changes their code)      |
| `persec invite <name> [days]` | Makes an invite code for someone (default 30 days)                    |
| `persec revoke <name>`        | Cancels that person's invites right away                              |
| `persec domain add <name>`    | Adds another web address, e.g. a new DuckDNS name if one gets blocked |
| `persec domain remove <name>` | Stops using a web address                                             |
| `persec domain`               | Lists the site's web addresses                                        |
| `persec export`               | Prints a command to set up a backup server that shares these invites  |
| `persec update`               | Updates to the latest version                                         |
| `persec logs`                 | Shows what the server is doing                                        |

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

#### Surviving a blocked server

Extra names all point at one server, so if its **IP address** is blocked (not just a name), every name goes down at once. The fix is a second server on a different provider or region. Because logins are signed with your `PERSEC_SECRET`, a second server that shares it accepts the same invite codes — and people's existing logins — with nothing to keep in sync.

1. On your current server's console, run `persec export`. It prints a ready-to-paste `curl ... | PERSEC_SECRET=... bash` command.
2. Open a second server's console (a different host is best) and paste that command.
3. Run `persec domain add` on the second server to give it its own name, and share that address as a backup.

Keep the `export` command private: anyone with the secret can mint invites. Minted invites (`persec invite`) work on every server sharing the secret automatically; codes added with `persec add` must be added on each server.

#### Hiding the proxy endpoint

The proxy's traffic flows through a WebSocket at a fixed path, `/w/`. Because that path is the same on every install, a network that suspects your server is a proxy can confirm it just by probing that one URL. You can move the tunnel to a hard-to-guess path so there is nothing constant to probe — to anything that doesn't already have an invite, the server then looks like an ordinary website.

Set `PUBLIC_PERSEC_WISP_PATH` when you first install, for example:

```bash
curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | PUBLIC_PERSEC_WISP_PATH=/$(openssl rand -hex 6)/ bash
```

The value is built into the app, so set it at install time (changing it later means rebuilding, which `persec update` does). Leave it unset to keep the default `/w/`. This hides the endpoint from probing; it does not change the server's IP address or domain name, so pair it with a spare domain and a backup server (above) for blocks at those levels.

Proxied pages don't show the site's address in Persec's own URLs either: instead of `/v1/data/https%3A%2F%2Fexample.com`, the address is scrambled with a key that is new on every build. The key ships with the app, so this keeps URLs from giving the proxy away at a glance; it is not encryption. A rebuild (`persec update`) changes the key, so proxied tabs left open from before need reopening. To keep one key across builds or backup servers, set `PUBLIC_PERSEC_URL_KEY` in `deploy/.env`.

The path those URLs start with is randomised too. A fixed prefix like `/v1/data/` is the same on every Persec install, so a filter could match it to recognise the proxy; each build instead picks two random prefixes. They change on every rebuild along with the URL key, so the same caveat applies (open proxied tabs need reopening after an update). To keep them stable across builds or backup servers, set `PUBLIC_PERSEC_URL_KEY` and `PUBLIC_PERSEC_PROXY_KEY` in `deploy/.env`. This only defeats a filter matching on the path; it can't hide that the page runs a service worker, which a scanner that executes the page's scripts can still see.

#### Hiding which site you're visiting (Encrypted Client Hello)

Even over HTTPS, the domain name your browser asks for is sent in the clear at the start of every connection (the TLS "SNI"). This is how many filters block a site: they never see the page, only the name, and drop the connection. **Encrypted Client Hello (ECH)** encrypts that name too, so a network watching the connection can't tell which site is being reached from the handshake.

ECH needs two things: the server (or a CDN in front of it) has to offer ECH and publish its key in a DNS record, and the **visitor's browser has to have ECH turned on**. In Chrome, Edge and Firefox that happens automatically once **Secure DNS (DNS-over-HTTPS)** is enabled, so it's worth telling people to switch Secure DNS on in their browser settings.

Two ways to get it:

1. **Through Cloudflare (recommended, no server changes).** Put the domain behind Cloudflare — the same free step that hides the server's IP (proxying on, SSL/TLS set to Full). Cloudflare turns ECH on automatically for proxied domains and publishes the DNS record for you. Nothing to configure on the server.
2. **In Caddy, on your own domain (advanced).** Caddy 2.10+ can do ECH itself, but it has to publish the key to your DNS, so it needs a Caddy build that includes **your DNS provider's module** plus an API token for it. The stock `caddy:2` image used here does not include DNS modules, so this means building a custom Caddy image. See the commented `ech` block in [`deploy/Caddyfile`](deploy/Caddyfile) for the shape of the config.

> **Important, and region-dependent.** ECH helps where filtering is based on the domain name. But some censors respond by blocking **all** ECH traffic rather than reading it — Russia's filtering devices began dropping ECH connections to Cloudflare in late 2024. So ECH can _remove_ a block in one country and _cause_ one in another. Keep a non-ECH address available as a fallback, and test from the actual region before relying on it.

### Other options

<p>
  <a href="https://render.com/deploy?repo=https://github.com/Trackertheweasel/xenapsis"><img src="https://raw.githubusercontent.com/BinBashBanana/deploy-buttons/main/buttons/remade/render.svg" alt="Deploy to Render"></a>
  &nbsp;
  <a href="https://codespaces.new/Trackertheweasel/xenapsis"><img src="https://github.com/codespaces/badge.svg" alt="Open in GitHub Codespaces" height="32"></a>
</p>

All of these options are free to use.

| Platform          | Config file                       | Notes                                                                                                          |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Render            | `render.yaml`                     | Free web service. Sleeps after 15 minutes without traffic and takes about a minute to wake up.                 |
| GitHub Codespaces | `.devcontainer/devcontainer.json` | Free monthly hours for personal accounts. Run `pnpm build && pnpm start`, then open the forwarded port `6060`. |
| Docker            | `Dockerfile`                      | Run it on your own computer or server (see below).                                                             |

### Docker

```bash
docker build -t persec .
docker run -d -p 8080:8080 --restart unless-stopped --name persec persec
```

Persec will be available at `http://localhost:8080`.

---

## Deployment via Terminal

> **Note**  
> Before deploying, install:
>
> - [Git](https://git-scm.com/downloads)
> - [Node.js](https://nodejs.org/en/download/prebuilt-installer)
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

People enter their code once and stay signed in as long as they come back at least once every 30 days, and their browser's password manager can save the code for them. To revoke someone, remove their entry and restart Persec. Without `PERSEC_INVITE_CODES`, Persec is open to everyone.

### Handing out invites without restarting

With `PERSEC_SECRET` set, you can also mint invites on your own computer. They need no restart or redeploy and stop working on their own:

```bash
PERSEC_SECRET="<your secret>" pnpm invite sam 30   # prints a code that works for 30 days
```

- A minted invite signs someone in for 30 days, or until the invite expires if that comes first.
- To cancel one early, add the name to `PERSEC_REVOKED` (for example `PERSEC_REVOKED="sam,lee"`) and restart. This works for listed codes too.
- Give each person their own name: revoking a name cancels every invite minted with it.
- To use only minted invites, set `PERSEC_INVITE_ONLY=true` instead of `PERSEC_INVITE_CODES`.
- Anyone with `PERSEC_SECRET` can mint invites, so keep it as private as the codes. Changing it signs everyone out and cancels every minted invite.

Share codes privately (in person or an encrypted messenger), never on a public page. After 10 wrong codes, an address has to wait 15 minutes.

### Saved logins

On an invite-only Persec, a cookie notice on the first visit asks people whether to save their logins. If they agree, Persec keeps an encrypted backup of the cookies and site data that sites save in Persec, so they are still signed in to those sites when they come back, even on a new device or after their browser was cleared: they enter their invite code and tap **Restore my logins**. They can turn it off, or restore, in Settings → Privacy & Cloaking. Without invite codes, the notice only explains Persec's cookies.

- The backup is encrypted in the browser with a key made from the person's invite code, so the server only stores data it can't read on its own. Anyone with the code can unlock it, and that includes you, since you hand out the codes. The cookie notice and privacy page say so.
- **Give each person their own code.** Everyone who signs in with the same code shares one backup.
- Backups are stored in `data/logins` (with Docker Compose, the `persec_data` volume, which `persec update` keeps). Set `PERSEC_DATA_DIR` to store them elsewhere. Render and Codespaces have no lasting disk, so backups there are lost on every restart.
- A backup is deleted when its owner turns saved logins off or clears site data, and automatically when it hasn't been updated for 90 days.
- Backup servers (`persec export`) share invites but not backups: each server keeps its own.

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

Persec is based on [Lunar v2](https://github.com/lunar-proxy/lunar-v2) by Bearcattt and the Lunar contributors, and is licensed under the [GNU AGPL-3.0](LICENSE). Because Persec runs as a network service, the AGPL requires that its users can get the source code; the app links to this repository from Settings → About and from the privacy page.
