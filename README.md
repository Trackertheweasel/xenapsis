![Persec](./persec.svg)

**Persec** is a free, browser-like tabbed web proxy for people living under internet censorship. It runs in any modern browser, with nothing to install.

---

## Features

- Browser like UI and navigation
- Fast performance
- `about:blank` cloaking
- Built in ad blocking
- No analytics or third-party trackers
- Self-served, tracking-free sponsor slot
- Tab system
- Keyboard shortcuts
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

If the site shows a certificate error with the `sslip.io` address, or an address gets blocked, get a new DuckDNS name pointed at your server and run `persec domain add yourname.duckdns.org`. Your settings and invites are kept. It is worth keeping a spare name or two added so a block never cuts everyone off.

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

### Other options

<p>
  <a href="https://render.com/deploy?repo=https://github.com/Trackertheweasel/xenapsis"><img src="https://raw.githubusercontent.com/BinBashBanana/deploy-buttons/main/buttons/remade/render.svg" alt="Deploy to Render"></a>
  &nbsp;
  <a href="https://codespaces.new/Trackertheweasel/xenapsis"><img src="https://github.com/codespaces/badge.svg" alt="Open in GitHub Codespaces" height="32"></a>
</p>

All of these options are free to use.

| Platform          | Config file                       | Notes                                                                                            |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Render            | `render.yaml`                     | Free web service. Sleeps after 15 minutes without traffic and takes about a minute to wake up.   |
| GitHub Codespaces | `.devcontainer/devcontainer.json` | Free monthly hours for personal accounts. Run `pnpm start`, then open the forwarded port `6060`. |
| Docker            | `Dockerfile`                      | Run it on your own computer or server (see below).                                               |

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

2. Install dependencies and start the server:
   ```bash
   pnpm install
   pnpm start
   ```

### Development

If you are actively developing Persec, use the development server to avoid constant rebuilds:

```bash
pnpm install
pnpm dev
```

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

People enter their code once and stay signed in for 30 days. To revoke someone, remove their entry and restart Persec. Without `PERSEC_INVITE_CODES`, Persec is open to everyone.

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

---

## Sponsors (ads)

Persec shows at most one sponsor card on the new tab page. Ads are plain images and links served from your own server: no ad network, no scripts and no tracking.

To add a sponsor:

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
