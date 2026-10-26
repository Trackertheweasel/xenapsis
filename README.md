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
