import crypto from 'node:crypto';

// Invite-only mode. Set PERSEC_INVITE_CODES to "name:code,name:code" to require a code
// before anyone can use Persec. Removing someone's entry revokes their access.
//
// With PERSEC_SECRET set, the owner can also mint invites offline (`pnpm invite <name> <days>`).
// Those expire on their own and need no restart; PERSEC_REVOKED="name,name" cancels one early.

export const ACCESS_COOKIE = 'persec_access';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const RENEW_AFTER_SECONDS = 24 * 60 * 60;
// Prefix for people signed in with a minted invite. Static names can't contain ':'.
const MINTED = 'invite:';
const NAME_RE = /^[\w-]{1,32}$/;

export interface AccessConfig {
  codes: Map<string, string>; // code -> name
  names: Set<string>;
  revoked: Set<string>;
  secret: string;
  // Only with a fixed PERSEC_SECRET: a random one would invalidate every minted invite on restart.
  minted: boolean;
  // Header holding the visitor's address, set by a reverse proxy that overwrites it (deploy/Caddyfile
  // does). Unset, the connection's own address is used: anyone can send this header themselves, and
  // trusting it would let a guesser pick a fresh address for every wrong code.
  clientIpHeader?: string;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? '');
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

export function loadAccess(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const codes = new Map<string, string>();
  for (const entry of list(env.PERSEC_INVITE_CODES)) {
    const sep = entry.indexOf(':');
    const code = sep > 0 ? entry.slice(sep + 1).trim() : entry;
    // Unnamed codes are named after the code itself, so removing one never shifts another's name.
    const name =
      sep > 0
        ? entry.slice(0, sep).trim()
        : `invite-${crypto.createHash('sha256').update(code).digest('hex').slice(0, 8)}`;
    if (code) codes.set(code, name);
  }
  if (!codes.size && !truthy(env.PERSEC_INVITE_ONLY)) return null;

  const fixedSecret = env.PERSEC_SECRET?.trim();
  // Without a fixed secret, everyone has to re-enter their code whenever the server restarts.
  const secret = fixedSecret || crypto.randomBytes(32).toString('hex');
  return {
    codes,
    names: new Set(codes.values()),
    revoked: new Set(list(env.PERSEC_REVOKED)),
    secret,
    minted: !!fixedSecret,
    clientIpHeader: env.PERSEC_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
  };
}

const sign = (secret: string, data: string) =>
  crypto.createHmac('sha256', secret).update(data).digest('base64url');
// Domain-separated from cookie signatures so a cookie can never be used as an invite code.
const signInvite = (secret: string, data: string) =>
  crypto
    .createHmac('sha256', secret)
    .update(`invite.${data}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Creates an invite code for `name` that stops working after `days`.
export function mintInvite(secret: string, name: string, days: number, now = Date.now()): string {
  if (!NAME_RE.test(name))
    throw new Error('Names may only use letters, numbers, - and _ (max 32).');
  if (!(days > 0)) throw new Error('Days must be a positive number.');
  const data = `${Buffer.from(name).toString('base64url')}.${Math.floor(now / 1000 + days * 86400)}`;
  return `${data}.${signInvite(secret, data)}`;
}

function checkMinted(config: AccessConfig, code: string, now: number): string | null {
  if (!config.minted) return null;
  const parts = code.split('.');
  if (parts.length !== 3) return null;
  const [encodedName, expiry, sig] = parts;
  if (!safeEqual(signInvite(config.secret, `${encodedName}.${expiry}`), sig)) return null;
  const name = Buffer.from(encodedName, 'base64url').toString();
  if (!NAME_RE.test(name) || !(Number(expiry) * 1000 > now)) return null;
  return `${MINTED}${name}:${expiry}`;
}

// Returns who the code belongs to (stored in their cookie), or null.
export function checkCode(config: AccessConfig, code: string, now = Date.now()): string | null {
  code = code.trim();
  if (!code) return null;
  let subject: string | null = null;
  for (const [valid, name] of config.codes) {
    if (safeEqual(valid, code)) subject = name;
  }
  subject ??= checkMinted(config, code, now);
  return subject && isAllowed(config, subject, now) ? subject : null;
}

function isAllowed(config: AccessConfig, subject: string, now: number): boolean {
  if (subject.startsWith(MINTED)) {
    const [name, expiry] = subject.slice(MINTED.length).split(':');
    // The cookie lasts 30 days, but never longer than the invite it came from.
    return config.minted && !config.revoked.has(name) && Number(expiry) * 1000 > now;
  }
  // The name must still be on the invite list, so removing an entry revokes access.
  return config.names.has(subject) && !config.revoked.has(subject);
}

export function createToken(config: AccessConfig, name: string, now = Date.now()): string {
  const data = `${Buffer.from(name).toString('base64url')}.${Math.floor(now / 1000) + MAX_AGE_SECONDS}`;
  return `${data}.${sign(config.secret, data)}`;
}

// Returns who a valid sign-in cookie belongs to, or null.
export function tokenSubject(
  config: AccessConfig,
  token: string | undefined,
  now = Date.now(),
): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedName, expiry, sig] = parts;
  if (!safeEqual(sign(config.secret, `${encodedName}.${expiry}`), sig)) return null;
  if (Number(expiry) * 1000 < now) return null;
  const subject = Buffer.from(encodedName, 'base64url').toString();
  return isAllowed(config, subject, now) ? subject : null;
}

export function verifyToken(
  config: AccessConfig,
  token: string | undefined,
  now = Date.now(),
): boolean {
  return tokenSubject(config, token, now) !== null;
}

// People who keep coming back stay signed in: a valid cookie more than a day old is swapped for
// a fresh 30-day one. A minted invite's own expiry still applies (see isAllowed).
export function renewToken(
  config: AccessConfig,
  token: string | undefined,
  now = Date.now(),
): string | null {
  const subject = tokenSubject(config, token, now);
  if (subject === null) return null;
  const expiry = Number(token!.split('.')[1]);
  return expiry - now / 1000 < MAX_AGE_SECONDS - RENEW_AFTER_SECONDS
    ? createToken(config, subject, now)
    : null;
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
  // Drop expired entries now and then so random addresses can't grow the map forever.
  if (failures.size >= 10_000) {
    for (const [key, f] of failures) if (f.reset <= now) failures.delete(key);
  }
  const f = failures.get(ip);
  if (!f || f.reset <= now) failures.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
  else f.count++;
}

// The hidden username lets password managers save the invite code, so coming back is one tap.
// The script makes the key for saved logins (src/utils/loginsync.ts) from the code, here in the
// browser, so the server never has it. Only the key is kept, never the code, and nothing leaves
// the browser unless the person turns saved logins on. The salt, iteration count and database
// must match loginsync.ts.
export function enterPage(error = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>Persec</title>
<style>body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#11121c;color:#fff;font-family:system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{width:min(320px,100%);display:flex;flex-direction:column;gap:12px;text-align:center}
input{padding:12px;border-radius:10px;border:1px solid #2a2740;background:#1f1d2e;color:#fff;font-size:16px}
button{min-height:46px;padding:12px;border:0;border-radius:10px;background:#6366f1;color:#fff;font-size:16px;cursor:pointer}
button:disabled{opacity:.7;cursor:wait}
label,p{margin:0;color:#a8a3c7;font-size:14px}.err{color:#f87171}</style></head>
<body><form method="post" action="/enter">
<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="align-self:center" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><circle cx="12" cy="11" r="2"/><path d="M12 13v3"/></svg>
<label for="code">Enter your invite code</label>
<input name="username" autocomplete="username" value="Persec invite" hidden>
<input id="code" name="code" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Continue</button>
${error ? `<p class="err" role="alert">${error}</p>` : ''}
</form>
<script>
(() => {
  const form = document.querySelector('form');
  const button = form.querySelector('button');
  let sending = false;
  async function keepKey(code) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('persec/saved-logins/v1'), iterations: 600000 },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('PersecLogins', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(key, 'invite');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  form.addEventListener('submit', e => {
    const code = form.elements.code.value.trim();
    if (sending || !code || !window.crypto || !crypto.subtle || !window.indexedDB) return;
    e.preventDefault();
    sending = true;
    button.disabled = true;
    button.textContent = 'Signing in…';
    // A slow or broken key step never blocks signing in.
    Promise.race([keepKey(code), new Promise(r => setTimeout(r, 8000))])
      .catch(() => {})
      .then(() => form.submit());
  });
})();
</script></body></html>`;
}
