import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  inviteCode,
  inviteExpiry,
  recordFailure,
  safeEqual,
  tooManyAttempts,
  validInviteName,
} from '../access';
import type { AccessConfig } from '../access';
import { adNetwork } from '../ads';
import type { AiConfig } from '../ai/index';
import type { BrowserConfig } from '../browser/index';
import type { InviteStore } from '../invites';
import { usageSnapshot } from '../stats';
import { clientIp } from './access';

export interface AdminOptions {
  password: string;
  // Where minted invites are recorded (serverlib/invites.ts). Without it, /admin lists only the
  // codes in PERSEC_INVITE_CODES and can't create or revoke.
  invites?: InviteStore;
  ai: AiConfig;
  browser: BrowserConfig;
  // The app's version, for the setup check.
  version?: string;
}

export interface InviteRow {
  name: string;
  // 'listed': from PERSEC_INVITE_CODES. 'minted': made on /admin or with `persec invite`.
  source: 'listed' | 'minted';
  status: 'active' | 'expired' | 'revoked';
  created: number | null; // ms, unknown for listed codes
  expires: number | null; // seconds, as in the code; listed codes never expire
  via: 'admin' | 'cli' | 'env';
  // Revoked in PERSEC_REVOKED, which only the environment can lift.
  lockedRevoke: boolean;
  online: number;
  sessions: number;
  lastSeen: number | null;
}

const MAX_DAYS = 3650;

// The owner's view: each person's usage (serverlib/stats.ts), their invites, and which optional
// settings are in place. Registered after the invite gate, so it needs a sign-in cookie first,
// then PERSEC_ADMIN_PASSWORD (any username). Codes are shown only when the owner asks for one,
// and secrets (PERSEC_SECRET, keys, the password) never.
export function registerAdminRoutes(
  app: FastifyInstance,
  access: AccessConfig,
  { password, invites, ai, browser, version }: AdminOptions,
) {
  const allowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const ip = clientIp(access, req);
    reply.header('Cache-Control', 'no-store');
    if (tooManyAttempts(ip)) {
      reply.code(429).type('text/plain').send('Too many attempts. Try again in 15 minutes.');
      return false;
    }
    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString();
      if (safeEqual(decoded.slice(decoded.indexOf(':') + 1), password)) return true;
      recordFailure(ip);
    }
    reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="Persec admin", charset="UTF-8"')
      .type('text/plain')
      .send('Admin password required');
    return false;
  };

  // Browsers send Basic credentials to cross-site requests too. A JSON body can't be sent from
  // another site without a CORS preflight, which nothing here answers, and the Origin must match.
  const changeAllowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!allowed(req, reply)) return false;
    const origin = req.headers.origin;
    const json = String(req.headers['content-type'] ?? '').startsWith('application/json');
    if (!json || (origin !== undefined && hostOf(origin) !== req.headers.host)) {
      reply.code(403).type('text/plain').send('Not allowed');
      return false;
    }
    return true;
  };

  const rows = (now = Date.now()): InviteRow[] => {
    const usage = new Map(usageSnapshot(now).map(u => [u.name, u]));
    const seen = (name: string) => {
      const u = usage.get(name);
      return { online: u?.online ?? 0, sessions: u?.sessions ?? 0, lastSeen: u?.lastSeen ?? null };
    };
    const status = (name: string, expires: number | null): InviteRow['status'] =>
      access.revoked.has(name)
        ? 'revoked'
        : expires !== null && expires * 1000 <= now
          ? 'expired'
          : 'active';
    const listed: InviteRow[] = [...access.names].map(name => ({
      name,
      source: 'listed',
      status: status(name, null),
      created: null,
      expires: null,
      via: 'env',
      lockedRevoke: access.envRevoked.has(name),
      ...seen(name),
    }));
    const minted: InviteRow[] = (invites?.read().invites ?? []).map(r => ({
      name: r.name,
      source: 'minted',
      // Minted invites only work with a fixed PERSEC_SECRET.
      status: access.minted ? status(r.name, r.expires) : 'expired',
      created: r.created,
      expires: r.expires,
      via: r.via,
      lockedRevoke: access.envRevoked.has(r.name),
      ...seen(r.name),
    }));
    return [...minted.reverse(), ...listed];
  };

  app.get('/admin', (req, reply) => {
    if (allowed(req, reply)) reply.type('text/html').send(ADMIN_PAGE);
  });

  app.get('/admin/stats', (req, reply) => {
    if (allowed(req, reply)) reply.send({ now: Date.now(), people: usageSnapshot() });
  });

  app.get('/admin/invites', (req, reply) => {
    if (!allowed(req, reply)) return;
    const list = rows();
    const known = new Set(list.map(r => r.name));
    reply.send({
      now: Date.now(),
      canCreate: access.minted && !!invites,
      canRevoke: !!invites,
      invites: list,
      // Signed in since the server started, but minted before invites were recorded (or elsewhere).
      unlisted: usageSnapshot()
        .map(u => u.name)
        .filter(n => !known.has(n)),
    });
  });

  app.post('/admin/invites', (req, reply) => {
    if (!changeAllowed(req, reply)) return;
    if (!access.minted || !invites) {
      return reply.code(409).send({ error: 'Creating invites needs a fixed PERSEC_SECRET.' });
    }
    const { name, days } = (req.body ?? {}) as { name?: unknown; days?: unknown };
    const n = typeof name === 'string' ? name.trim() : '';
    const d = Number(days);
    if (!validInviteName(n)) {
      return reply
        .code(400)
        .send({ error: 'Names may only use letters, numbers, - and _ (max 32).' });
    }
    if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) {
      return reply.code(400).send({ error: `Days must be a whole number from 1 to ${MAX_DAYS}.` });
    }
    const now = Date.now();
    const expires = inviteExpiry(d, now);
    invites.add({ name: n, created: now, expires, via: 'admin' });
    reply.send({ name: n, expires, code: inviteCode(access.secret, n, expires) });
  });

  // Recreates a recorded invite's code from PERSEC_SECRET, for handing it out again.
  app.post('/admin/invites/code', (req, reply) => {
    if (!changeAllowed(req, reply)) return;
    const { name, expires } = (req.body ?? {}) as { name?: unknown; expires?: unknown };
    const record = invites
      ?.read()
      .invites.find(r => r.name === name && r.expires === Number(expires));
    if (!access.minted || !record) return reply.code(404).send({ error: 'No such invite.' });
    reply.send({ code: inviteCode(access.secret, record.name, record.expires) });
  });

  // Revoking a name signs out everyone using it, listed or minted, at their next request.
  app.post('/admin/revoke', (req, reply) => {
    if (!changeAllowed(req, reply)) return;
    if (!invites) return reply.code(409).send({ error: 'Revoking here needs a data folder.' });
    const { name, revoked } = (req.body ?? {}) as { name?: unknown; revoked?: unknown };
    if (typeof name !== 'string' || !validInviteName(name)) {
      return reply.code(400).send({ error: 'Unknown name.' });
    }
    if (!revoked && access.envRevoked.has(name)) {
      return reply
        .code(409)
        .send({ error: `${name} is in PERSEC_REVOKED. Remove it there and restart to restore.` });
    }
    invites.setRevoked(name, !!revoked);
    if (revoked) access.revoked.add(name);
    else access.revoked.delete(name);
    reply.send({ name, revoked: !!revoked });
  });

  // Which optional settings are in place, without their values, so the owner can see what's left.
  app.get('/admin/server', (req, reply) => {
    if (!allowed(req, reply)) return;
    reply.send({
      version,
      checks: serverChecks(access, { ai, browser, invites: !!invites }),
    });
  });
}

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

export interface Check {
  name: string;
  ok: boolean;
  // Off on purpose is fine; shown in grey rather than as missing.
  optional: boolean;
  detail: string;
}

export function serverChecks(
  access: AccessConfig,
  { ai, browser, invites }: { ai: AiConfig; browser: BrowserConfig; invites: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Check[] {
  const ads = adNetwork();
  return [
    {
      name: 'PERSEC_SECRET',
      ok: access.minted,
      optional: false,
      detail: access.minted
        ? 'Fixed, so sign-ins survive restarts and minted invites work.'
        : 'Not set: everyone is signed out on every restart, and invites can’t be created.',
    },
    {
      name: 'Invite codes',
      ok: access.names.size > 0 || access.minted,
      optional: false,
      detail: `${access.names.size} in PERSEC_INVITE_CODES; minted invites ${access.minted ? 'on' : 'off'}.`,
    },
    {
      name: 'PERSEC_CLIENT_IP_HEADER',
      ok: !!access.clientIpHeader,
      optional: false,
      detail: access.clientIpHeader
        ? `Reads the visitor’s address from ${access.clientIpHeader}.`
        : 'Not set: behind a proxy, all visitors share one wrong-code limit.',
    },
    {
      name: 'Data folder',
      ok: invites,
      optional: false,
      detail: env.PERSEC_DATA_DIR?.trim()
        ? 'PERSEC_DATA_DIR is set.'
        : 'Using data/ (kept by the Docker volume on a VPS; lost on Render restarts).',
    },
    {
      name: 'OPENROUTER_API_KEY',
      ok: !!ai.apiKey,
      optional: true,
      detail: ai.apiKey
        ? `PerSec AI is on, with ${ai.allowedModels === 'all' ? 'every model (paid ones use your credits)' : ai.allowedModels === 'free' ? 'free models only' : `${ai.allowedModels.size} chosen models`}.`
        : 'Not set: PerSec AI is off.',
    },
    {
      name: 'Browser mode (Camoufox)',
      ok: browser.enabled && !!browser.wsEndpoint,
      optional: true,
      detail:
        browser.enabled && browser.wsEndpoint
          ? `On, up to ${browser.maxSessions} sessions.`
          : browser.enabled
            ? 'CAMOUFOX_ENABLED is on but CAMOUFOX_WS_ENDPOINT is missing or invalid.'
            : 'Off (needs a separate browser service; too heavy for a 1 GB server).',
    },
    {
      name: 'Ad network',
      ok: !!ads,
      optional: true,
      detail: ads ? `Live ads from ${ads}.` : 'Not set: the built-in sponsor list is shown.',
    },
    {
      name: 'Tunnel ad blocking',
      ok: env.PERSEC_WISP_ADBLOCK?.trim().toLowerCase() !== 'off',
      optional: true,
      detail:
        env.PERSEC_WISP_ADBLOCK?.trim().toLowerCase() === 'off'
          ? 'Turned off with PERSEC_WISP_ADBLOCK=off.'
          : 'On.',
    },
  ];
}

// Everything from the server is written with textContent, never as HTML.
const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Persec admin</title>
<style>body{margin:0;background:#11121c;color:#fff;font-family:system-ui,sans-serif;padding:16px}
main{max-width:960px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 4px}p{color:#a8a3c7;font-size:14px;margin:0 0 16px}
nav{display:flex;gap:8px;margin:0 0 16px;flex-wrap:wrap}nav a{color:#c7c3e6;text-decoration:none;padding:6px 12px;border:1px solid #2a2740;border-radius:8px;font-size:14px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #2a2740;white-space:nowrap}th{color:#a8a3c7;font-weight:500}
td.num{font-variant-numeric:tabular-nums}.on{color:#4ade80}.off{color:#a8a3c7}.bad{color:#f87171}
form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
input{padding:8px 10px;border-radius:8px;border:1px solid #2a2740;background:#1f1d2e;color:#fff;font-size:14px}
button{padding:8px 12px;border:0;border-radius:8px;background:#6366f1;color:#fff;font-size:14px;cursor:pointer}
button.small{padding:4px 8px;font-size:13px;background:#2a2740}button:disabled{opacity:.6;cursor:default}
code{background:#1f1d2e;padding:8px;border-radius:8px;display:block;word-break:break-all;margin:0 0 12px;user-select:all}
ul{padding-left:20px;margin:0;font-size:14px}li{margin:0 0 8px}li b{font-weight:600}li span{color:#a8a3c7}</style></head>
<body><main><h1>Persec admin</h1>
<nav><a href="#usage">Usage</a><a href="#invites">Invites</a><a href="#server">Server setup</a></nav>
<h2 id="usage">Usage by person</h2>
<p id="summary">Loading…</p>
<div class="wrap"><table><thead><tr><th>Person</th><th>Status</th><th>Downloaded</th><th>Uploaded</th><th>Time connected</th><th>Tabs opened</th></tr></thead><tbody id="rows"></tbody></table></div>
<p style="margin-top:16px">Counted in memory since the server last started. Sites people visit are never recorded.</p>
<h2 id="invites">Invites</h2>
<p id="invite-summary">Loading…</p>
<form id="create" hidden><input name="name" placeholder="Name (e.g. sam)" maxlength="32" pattern="[A-Za-z0-9_-]{1,32}" required><input name="days" type="number" min="1" max="3650" value="30" required style="width:90px" aria-label="Days valid"><span style="color:#a8a3c7;font-size:14px">days</span><button>Create invite</button></form>
<p id="created" hidden></p><code id="code" hidden></code>
<div class="wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Kind</th><th>Created</th><th>Expires</th><th>Last active</th><th>Tabs</th><th></th></tr></thead><tbody id="invite-rows"></tbody></table></div>
<p id="unlisted" style="margin-top:12px" hidden></p>
<h2 id="server">Server setup</h2>
<p id="version">Which optional settings are in place. Values are never shown.</p>
<ul id="checks"></ul>
</main>
<script>
const size = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const span = ms => { const m = Math.floor(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const ago = ms => ms < 60000 ? 'just now' : span(ms) + ' ago';
const day = ms => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const $ = id => document.getElementById(id);
const cell = (tr, text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; tr.append(td); return td; };
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed (' + res.status + ')');
  return data;
}
function showCode(text, code) {
  $('created').textContent = text; $('created').hidden = false;
  $('code').textContent = code; $('code').hidden = false;
}
async function refresh() {
  try {
    const res = await fetch('/admin/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const { now, people } = await res.json();
    people.sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
    const rows = people.map(p => {
      const tr = document.createElement('tr');
      const status = p.online ? 'Online' + (p.online > 1 ? ' (' + p.online + ' tabs)' : '') : 'Last seen ' + ago(now - p.lastSeen);
      for (const [text, cls] of [[p.name], [status, p.online ? 'on' : 'off'], [size(p.down), 'num'], [size(p.up), 'num'], [span(p.connectedMs), 'num'], [p.sessions, 'num']]) cell(tr, text, cls);
      return tr;
    });
    $('rows').replaceChildren(...rows);
    const online = people.filter(p => p.online).length;
    $('summary').textContent = online + ' online now, ' + people.length + ' seen since the server started. Updates every 5 seconds.';
  } catch {
    $('summary').textContent = 'Could not load stats. Retrying…';
  }
}
async function loadInvites() {
  try {
    const res = await fetch('/admin/invites', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const { now, canCreate, canRevoke, invites, unlisted } = await res.json();
    $('create').hidden = !canCreate;
    const active = invites.filter(i => i.status === 'active').length;
    $('invite-summary').textContent = invites.length + ' invites, ' + active + ' active.' + (canCreate ? '' : ' Creating invites here needs a fixed PERSEC_SECRET and a data folder (see Server setup).');
    $('invite-rows').replaceChildren(...invites.map(i => {
      const tr = document.createElement('tr');
      cell(tr, i.name);
      cell(tr, i.status[0].toUpperCase() + i.status.slice(1), i.status === 'active' ? 'on' : i.status === 'revoked' ? 'bad' : 'off');
      cell(tr, i.source === 'listed' ? 'Listed code' : i.via === 'admin' ? 'Made here' : 'persec invite');
      cell(tr, i.created ? day(i.created) : '—');
      cell(tr, i.expires ? day(i.expires * 1000) : 'Never');
      cell(tr, i.online ? 'Online now' : i.lastSeen ? ago(now - i.lastSeen) : 'Not since restart', i.online ? 'on' : 'off');
      cell(tr, i.sessions, 'num');
      const actions = cell(tr, '');
      if (i.source === 'minted' && i.status !== 'expired') {
        const b = document.createElement('button'); b.className = 'small'; b.textContent = 'Show code';
        b.onclick = () => post('/admin/invites/code', { name: i.name, expires: i.expires }).then(r => showCode('Code for ' + i.name + ', valid until ' + day(i.expires * 1000) + ':', r.code), e => alert(e.message));
        actions.append(b, ' ');
      }
      if (canRevoke && !(i.status === 'revoked' && i.lockedRevoke)) {
        const revoke = i.status !== 'revoked';
        const b = document.createElement('button'); b.className = 'small'; b.textContent = revoke ? 'Revoke' : 'Restore';
        b.onclick = () => {
          if (revoke && !confirm('Revoke every invite named ' + i.name + '? They are signed out at once.')) return;
          post('/admin/revoke', { name: i.name, revoked: revoke }).then(loadInvites, e => alert(e.message));
        };
        actions.append(b);
      }
      return tr;
    }));
    $('unlisted').hidden = !unlisted.length;
    $('unlisted').textContent = unlisted.length ? 'Also signed in since the restart, from invites made before this list existed: ' + unlisted.join(', ') : '';
  } catch {
    $('invite-summary').textContent = 'Could not load invites.';
  }
}
async function loadServer() {
  try {
    const res = await fetch('/admin/server', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const { version, checks } = await res.json();
    if (version) $('version').textContent = 'Persec v' + version + '. Which optional settings are in place. Values are never shown.';
    $('checks').replaceChildren(...checks.map(c => {
      const li = document.createElement('li');
      const mark = document.createElement('b');
      mark.textContent = (c.ok ? '✓ ' : c.optional ? '○ ' : '✗ ') + c.name;
      mark.className = c.ok ? 'on' : c.optional ? 'off' : 'bad';
      const detail = document.createElement('span');
      detail.textContent = ' ' + c.detail;
      li.append(mark, detail);
      return li;
    }));
  } catch {
    $('checks').textContent = 'Could not load the setup check.';
  }
}
$('create').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements, button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const r = await post('/admin/invites', { name: f.name.value.trim(), days: Number(f.days.value) });
    showCode('Invite for ' + r.name + ', valid until ' + day(r.expires * 1000) + '. Send it privately:', r.code);
    f.name.value = '';
    loadInvites();
  } catch (err) { alert(err.message); }
  button.disabled = false;
});
refresh();
loadInvites();
loadServer();
setInterval(refresh, 5000);
setInterval(loadInvites, 30000);
</script></body></html>`;
