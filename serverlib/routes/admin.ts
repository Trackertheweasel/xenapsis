import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordFailure, safeEqual, tooManyAttempts } from '../access';
import type { AccessConfig } from '../access';
import { usageSnapshot } from '../stats';
import { clientIp } from './access';

// The owner's live view of each person's usage (serverlib/stats.ts). Registered after the invite
// gate, so it needs a sign-in cookie first, then PERSEC_ADMIN_PASSWORD (any username).
export function registerAdminRoutes(app: FastifyInstance, access: AccessConfig, password: string) {
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

  app.get('/admin', (req, reply) => {
    if (allowed(req, reply)) reply.type('text/html').send(ADMIN_PAGE);
  });

  app.get('/admin/stats', (req, reply) => {
    if (allowed(req, reply)) reply.send({ now: Date.now(), people: usageSnapshot() });
  });
}

// Names are written with textContent, never as HTML.
const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Persec admin</title>
<style>body{margin:0;background:#11121c;color:#fff;font-family:system-ui,sans-serif;padding:16px}
main{max-width:900px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{color:#a8a3c7;font-size:14px;margin:0 0 16px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #2a2740;white-space:nowrap}th{color:#a8a3c7;font-weight:500}
td.num{font-variant-numeric:tabular-nums}.on{color:#4ade80}.off{color:#a8a3c7}</style></head>
<body><main><h1>Usage by person</h1>
<p id="summary">Loading…</p>
<div class="wrap"><table><thead><tr><th>Person</th><th>Status</th><th>Downloaded</th><th>Uploaded</th><th>Time connected</th><th>Tabs opened</th></tr></thead><tbody id="rows"></tbody></table></div>
<p style="margin-top:16px">Counted in memory since the server last started. Sites people visit are never recorded.</p></main>
<script>
const size = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const span = ms => { const m = Math.floor(ms / 60000); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'; };
const ago = ms => ms < 60000 ? 'just now' : span(ms) + ' ago';
async function refresh() {
  try {
    const res = await fetch('/admin/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const { now, people } = await res.json();
    people.sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen);
    const rows = people.map(p => {
      const tr = document.createElement('tr');
      const status = p.online ? 'Online' + (p.online > 1 ? ' (' + p.online + ' tabs)' : '') : 'Last seen ' + ago(now - p.lastSeen);
      for (const [text, cls] of [[p.name], [status, p.online ? 'on' : 'off'], [size(p.down), 'num'], [size(p.up), 'num'], [span(p.connectedMs), 'num'], [p.sessions, 'num']]) {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        tr.append(td);
      }
      return tr;
    });
    document.getElementById('rows').replaceChildren(...rows);
    const online = people.filter(p => p.online).length;
    document.getElementById('summary').textContent = online + ' online now, ' + people.length + ' seen since the server started. Updates every 5 seconds.';
  } catch {
    document.getElementById('summary').textContent = 'Could not load stats. Retrying…';
  }
}
refresh();
setInterval(refresh, 5000);
</script></body></html>`;
