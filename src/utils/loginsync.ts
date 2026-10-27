import ConfigAPI from './config';

// Saved logins: an opt-in backup of the cookies and site data people keep in Persec, tied to their
// invite code, so they stay signed in to sites when they come back on any device.
//
// The backup is encrypted here with a key made from the invite code. The sign-in page makes the
// key (enterPage in serverlib/access.ts) and keeps only the key, which can't be read back out; the
// server only stores the encrypted backup (serverlib/logins.ts). Anyone with the invite code can
// unlock it, and that includes whoever runs the server, since they hand out the codes.

// Must match enterPage in serverlib/access.ts.
const KEY_DB = 'PersecLogins';
const KEY_SALT = 'persec/saved-logins/v1';
const KEY_ITERATIONS = 600_000;

const API = '/api/logins';
const FORMAT = 1;
// Matches MAX_BACKUP_BYTES in serverlib/logins.ts.
const MAX_BYTES = 1024 * 1024;
// Sites keep logins in small entries; big ones are caches that aren't worth backing up.
const MAX_STORAGE_VALUE = 8 * 1024;
const BACKUP_EVERY_MS = 60_000;

// 'notice' means the person saw the cookie notice on a Persec without invite codes.
export type Consent = 'saved' | 'essential' | 'notice';
export interface Status {
  saved: boolean;
  updated: number | null;
}
export type RestoreResult = 'restored' | 'none' | 'locked';

interface Snapshot {
  scramjet: Record<string, unknown>;
  uv: unknown[];
  storage: Record<string, string>;
}

// The proxy engines' databases. If one doesn't exist yet, it's created with the engine's own schema.
const SCRAMJET_STORES = [
  'config',
  'cookies',
  'redirectTrackers',
  'referrerPolicies',
  'publicSuffixList',
];
function createScramjetDb(db: IDBDatabase) {
  for (const s of SCRAMJET_STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
}
function createUvDb(db: IDBDatabase) {
  if (!db.objectStoreNames.contains('cookies')) {
    db.createObjectStore('cookies', { keyPath: 'id' }).createIndex('path', 'path');
  }
}

// Without `create`, a database that doesn't exist yet is left alone and null is returned.
function openDb(name: string, create?: (db: IDBDatabase) => void): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    const req = create ? indexedDB.open(name, 1) : indexedDB.open(name);
    req.onupgradeneeded = () => (create ? create(req.result) : req.transaction?.abort());
    req.onerror = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
  });
}

function inStore<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return new Promise(resolve => {
    if (!db.objectStoreNames.contains(store)) return resolve(undefined);
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => resolve(undefined);
  });
}

async function withDb<T>(
  name: string,
  create: ((db: IDBDatabase) => void) | undefined,
  fn: (db: IDBDatabase) => Promise<T>,
): Promise<T | undefined> {
  const db = await openDb(name, create);
  if (!db) return undefined;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function getKey(): Promise<CryptoKey | null> {
  const key = await withDb(KEY_DB, undefined, db =>
    inStore<unknown>(db, 'keys', 'readonly', s => s.get('invite')),
  );
  return key instanceof CryptoKey ? key : null;
}

export const hasKey = async () => !!(await getKey());

export function forgetKey(): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(KEY_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// For people who signed in before saved logins existed, so the sign-in page never made their key.
// The code is checked with the server first, so a typo can't lock their backup with the wrong key.
// Returns an error message, or null once the key is kept.
export async function keepKeyFromCode(code: string): Promise<string | null> {
  code = code.trim();
  if (!code) return 'Enter your invite code.';
  if (!crypto.subtle) return 'This browser can’t save logins here (it needs HTTPS).';
  const res = await fetch('/enter', {
    method: 'POST',
    body: new URLSearchParams({ code }),
    redirect: 'manual',
  }).catch(() => null);
  if (!res) return 'Couldn’t reach Persec. Try again.';
  if (res.status === 429) return 'Too many attempts. Try again in 15 minutes.';
  // A correct code answers with a redirect into Persec.
  if (res.type !== 'opaqueredirect' && !res.redirected) return 'That code is not valid.';

  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(KEY_SALT), iterations: KEY_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const kept = await withDb(
    KEY_DB,
    db => db.createObjectStore('keys'),
    db => inStore(db, 'keys', 'readwrite', s => s.put(key, 'invite')),
  );
  return kept === undefined ? 'Couldn’t save the key in this browser.' : null;
}

export async function getConsent(): Promise<Consent | null> {
  return (await ConfigAPI.get('loginConsent')) ?? null;
}

// Saying no also forgets the key, so nothing beyond the sign-in cookie is kept.
export async function setConsent(consent: Consent): Promise<void> {
  await ConfigAPI.set('loginConsent', consent);
  if (consent === 'saved') navigator.storage?.persist?.().catch(() => {});
  else await forgetKey();
}

// Null when this Persec has no invite codes (or can't be reached), so there's nothing to save to.
export async function getStatus(): Promise<Status | null> {
  try {
    const res = await fetch(`${API}/status`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function deleteBackup(): Promise<void> {
  lastSent = null;
  await fetch(API, { method: 'DELETE' }).catch(() => {});
}

// Asks the service worker (public/sw.js), which keeps Scramjet's cookies in memory.
async function askWorker<T>(type: string, data?: unknown): Promise<T | undefined> {
  const worker = (await navigator.serviceWorker?.getRegistration())?.active;
  if (!worker) return undefined;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = e => resolve(e.data);
    worker.postMessage({ type, data }, [channel.port2]);
    setTimeout(() => resolve(undefined), 3000);
  });
}

async function collect(): Promise<Snapshot> {
  let scramjet = await askWorker<Record<string, unknown>>('GET_COOKIES');
  if (!scramjet || typeof scramjet !== 'object') {
    const saved = await withDb('$scramjet', undefined, db =>
      inStore<unknown>(db, 'cookies', 'readonly', s => s.get('cookies')),
    );
    scramjet = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  }
  const uv =
    (await withDb('__op', undefined, db =>
      inStore<unknown[]>(db, 'cookies', 'readonly', s => s.getAll()),
    )) ?? [];
  const storage: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = k === null ? null : localStorage.getItem(k);
    if (k !== null && v !== null && v.length <= MAX_STORAGE_VALUE) storage[k] = v;
  }
  return { scramjet, uv, storage };
}

const isEmpty = (s: Snapshot) =>
  !Object.keys(s.scramjet).length && !s.uv.length && !Object.keys(s.storage).length;

async function apply(s: Snapshot): Promise<void> {
  if (Object.keys(s.scramjet).length && (await askWorker('SET_COOKIES', s.scramjet)) !== 'done') {
    // No worker running yet: it loads the saved jar when it starts.
    await withDb('$scramjet', createScramjetDb, async db => {
      const current = await inStore<unknown>(db, 'cookies', 'readonly', st => st.get('cookies'));
      const merged = { ...(current && typeof current === 'object' ? current : {}), ...s.scramjet };
      await inStore(db, 'cookies', 'readwrite', st => st.put(merged, 'cookies'));
    });
  }
  if (s.uv.length) {
    await withDb('__op', createUvDb, db =>
      inStore(db, 'cookies', 'readwrite', st => {
        for (const cookie of s.uv) st.put(cookie);
      }),
    );
  }
  for (const [k, v] of Object.entries(s.storage)) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  }
}

async function pipe(data: Uint8Array<ArrayBuffer>, stream: GenericTransformStream) {
  const out = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// Layout: format byte, compressed flag, 12-byte IV, then AES-GCM ciphertext.
async function seal(key: CryptoKey, snapshot: Snapshot): Promise<Uint8Array<ArrayBuffer>> {
  let data = new TextEncoder().encode(JSON.stringify(snapshot));
  const compressed = typeof CompressionStream === 'function';
  if (compressed) data = await pipe(data, new CompressionStream('gzip'));
  const header = new Uint8Array([FORMAT, compressed ? 1 : 0]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, data),
  );
  const out = new Uint8Array(header.length + iv.length + sealed.length);
  out.set(header);
  out.set(iv, header.length);
  out.set(sealed, header.length + iv.length);
  return out;
}

// Null when the backup can't be unlocked with this key (it was saved with another invite code).
async function unseal(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>): Promise<Snapshot | null> {
  if (bytes[0] !== FORMAT || bytes.length < 14) return null;
  try {
    let data = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(2, 14), additionalData: bytes.subarray(0, 2) },
        key,
        bytes.subarray(14),
      ),
    );
    if (bytes[1] === 1) data = await pipe(data, new DecompressionStream('gzip'));
    const s = JSON.parse(new TextDecoder().decode(data));
    return { scramjet: s.scramjet ?? {}, uv: s.uv ?? [], storage: s.storage ?? {} };
  } catch {
    return null;
  }
}

export async function restore(): Promise<RestoreResult> {
  const key = await getKey();
  if (!key) return 'locked';
  const res = await fetch(API, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok || res.status === 204) return 'none';
  const snapshot = await unseal(key, new Uint8Array(await res.arrayBuffer()));
  if (!snapshot) return 'locked';
  await apply(snapshot);
  return 'restored';
}

// What was last sent, so an unchanged backup isn't uploaded again.
let lastSent: string | null = null;

export async function backUpNow({ keepalive = false } = {}): Promise<void> {
  if ((await getConsent()) !== 'saved') return;
  const key = await getKey();
  if (!key) return;
  const snapshot = await collect();
  const fingerprint = JSON.stringify(snapshot);
  if (fingerprint === lastSent) return;
  if (isEmpty(snapshot)) {
    await deleteBackup();
    lastSent = fingerprint;
    return;
  }
  let body = await seal(key, snapshot);
  // Too big with site storage: keep the cookies, which hold most logins.
  if (body.length > MAX_BYTES) body = await seal(key, { ...snapshot, storage: {} });
  if (body.length > MAX_BYTES) return;
  const res = await fetch(API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    // Lets the last backup finish as the page closes; browsers cap these at 64 KB.
    keepalive: keepalive && body.length < 60_000,
  }).catch(() => null);
  if (res?.ok) lastSent = fingerprint;
}

let started = false;
export function startAutoBackup(): void {
  if (started) return;
  started = true;
  const run = (keepalive = false) => backUpNow({ keepalive }).catch(() => {});
  setTimeout(run, 5000);
  setInterval(run, BACKUP_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') run(true);
  });
}
