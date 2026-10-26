import crypto from 'node:crypto';

// Invite-only mode. Set PERSEC_INVITE_CODES to "name:code,name:code" to require a code
// before anyone can use Persec. Removing someone's entry revokes their access.

export const ACCESS_COOKIE = 'persec_access';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AccessConfig {
  codes: Map<string, string>; // code -> name
  secret: string;
}

export function loadAccess(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const raw = env.PERSEC_INVITE_CODES?.trim();
  if (!raw) return null;

  const codes = new Map<string, string>();
  raw
    .split(',')
    .map(e => e.trim())
    .filter(Boolean)
    .forEach((entry, i) => {
      const sep = entry.indexOf(':');
      const name = sep > 0 ? entry.slice(0, sep).trim() : `invite${i + 1}`;
      const code = sep > 0 ? entry.slice(sep + 1).trim() : entry;
      if (code) codes.set(code, name);
    });
  if (!codes.size) return null;

  // Without a fixed secret, everyone has to re-enter their code whenever the server restarts.
  const secret = env.PERSEC_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
  return { codes, secret };
}

const sign = (secret: string, data: string) =>
  crypto.createHmac('sha256', secret).update(data).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function checkCode(config: AccessConfig, code: string): string | null {
  for (const [valid, name] of config.codes) {
    if (safeEqual(valid, code.trim())) return name;
  }
  return null;
}

export function createToken(config: AccessConfig, name: string, now = Date.now()): string {
  const data = `${Buffer.from(name).toString('base64url')}.${Math.floor(now / 1000) + MAX_AGE_SECONDS}`;
  return `${data}.${sign(config.secret, data)}`;
}

export function verifyToken(
  config: AccessConfig,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [encodedName, expiry, sig] = parts;
  if (!safeEqual(sign(config.secret, `${encodedName}.${expiry}`), sig)) return false;
  if (Number(expiry) * 1000 < now) return false;
  // The name must still be on the invite list, so removing an entry revokes access.
  const name = Buffer.from(encodedName, 'base64url').toString();
  return [...config.codes.values()].includes(name);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function accessCookie(token: string, secure: boolean): string {
  return `${ACCESS_COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// Slows down guessing: at most 10 wrong codes per address every 15 minutes.
const failures = new Map<string, { count: number; reset: number }>();
export function tooManyAttempts(ip: string, now = Date.now()): boolean {
  const f = failures.get(ip);
  return !!f && f.reset > now && f.count >= 10;
}
export function recordFailure(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  if (!f || f.reset <= now) failures.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
  else f.count++;
}

export function enterPage(error = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Persec</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#11121c;color:#fff;font-family:system-ui,sans-serif}
form{width:min(320px,90vw);display:flex;flex-direction:column;gap:12px;text-align:center}
input{padding:12px;border-radius:10px;border:1px solid #2a2740;background:#1f1d2e;color:#fff;font-size:16px}
button{padding:12px;border:0;border-radius:10px;background:#6366f1;color:#fff;font-size:16px;cursor:pointer}
p{margin:0;color:#a8a3c7;font-size:14px}.err{color:#f87171}</style></head>
<body><form method="post" action="/enter">
<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="align-self:center"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><circle cx="12" cy="11" r="2"/><path d="M12 13v3"/></svg>
<p>Enter your invite code</p>
<input name="code" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Continue</button>
${error ? `<p class="err">${error}</p>` : ''}
</form></body></html>`;
}
