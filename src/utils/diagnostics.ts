import { ensureTransport, pickTransport, TransportError, withTimeout } from './transport';

// Startup checks for everything the proxy needs, so a page that can't work says why instead of
// loading forever. Each check has a timeout; none changes a setting or retries without being asked.
// Problems are split into the browser (fix it on this device), the network or server (try another
// network or the backup address), and sign-in. A site that fails while every check passes is a
// problem with that site, which the engines report on their own error page.

export interface Problem {
  id: string;
  where: 'browser' | 'network' | 'sign-in';
  message: string;
}

const problem = (id: string, where: Problem['where'], message: string): Problem => ({
  id,
  where,
  message,
});
const step = <T>(p: Promise<T>, ms: number) =>
  withTimeout(p, ms, () => new Error(`no answer after ${ms / 1000}s`));
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function serviceWorker(): Promise<Problem | null> {
  if (!window.isSecureContext) {
    return problem(
      'insecure',
      'browser',
      "Persec needs HTTPS. Open this address with https:// (the proxy can't run on plain http).",
    );
  }
  if (!('serviceWorker' in navigator)) {
    return problem(
      'sw-missing',
      'browser',
      'This browser has service workers turned off, and the proxy needs them. Some private windows ' +
        'and some school or work browser policies turn them off. Try a normal window or another browser.',
    );
  }
  try {
    await step(navigator.serviceWorker.register(PERSEC_PATHS.sw), 10_000);
    await step(navigator.serviceWorker.ready, 20_000);
    return null;
  } catch (err) {
    return problem(
      'sw-failed',
      'browser',
      `The proxy's service worker didn't start (${reason(err)}). Reload the page. If it keeps ` +
        'happening, an extension or a browser policy may be blocking it: try with extensions off or in another browser.',
    );
  }
}

function sharedWorker(): Problem | null {
  return typeof SharedWorker === 'function'
    ? null
    : problem(
        'sharedworker',
        'browser',
        "This browser doesn't support shared workers, which the proxy's connection needs. " +
          'Update it, or use a current Chrome, Edge, Firefox or Safari.',
      );
}

// Writes, reads back and deletes a value in a scratch database, apart from Persec's own data.
async function storage(): Promise<Problem | null> {
  const fail = (detail: string) =>
    problem(
      'storage',
      'browser',
      `Persec can't save data in this browser (${detail}). Blocking site data or cookies for this ` +
        'site, some private windows, and some browser policies cause this. Allow site data for this address.',
    );
  if (typeof indexedDB === 'undefined') return fail('IndexedDB is missing');
  try {
    await step(
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('PersecCheck', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('check');
        req.onblocked = () => reject(new Error('blocked by another tab'));
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('check', 'readwrite');
          const store = tx.objectStore('check');
          store.put('ok', 'ok');
          const get = store.get('ok');
          tx.oncomplete = () => {
            db.close();
            indexedDB.deleteDatabase('PersecCheck');
            if (get.result === 'ok') resolve();
            else reject(new Error('a saved value could not be read back'));
          };
          tx.onerror = tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
      5000,
    );
    return null;
  } catch (err) {
    return fail(reason(err));
  }
}

// The smallest valid module: the header and version, nothing else.
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

async function webAssembly(): Promise<Problem | null> {
  try {
    if (typeof WebAssembly !== 'object') throw new Error('missing');
    await step(WebAssembly.instantiate(EMPTY_WASM), 5000);
    return null;
  } catch {
    return problem(
      'wasm',
      'browser',
      "WebAssembly is turned off, and the proxy's connection needs it. Safari Lockdown Mode and Edge's " +
        'enhanced security mode can turn it off; both let you exclude a site, so add this address ' +
        'as an exception, or use another browser.',
    );
  }
}

async function runtime(init: () => Promise<unknown>): Promise<Problem | null> {
  try {
    await step(init(), 15_000);
    return null;
  } catch (err) {
    return problem(
      'runtime',
      'browser',
      `The proxy engine didn't load (${reason(err)}). Reload the page; if it keeps failing, clear ` +
        "this site's data in your browser's settings.",
    );
  }
}

async function proxyWorker(): Promise<Problem | null> {
  try {
    await ensureTransport();
    return null;
  } catch (err) {
    return problem(
      'proxy-worker',
      'browser',
      `The proxy's background worker didn't start (${reason(err)}). Close every Persec tab and open it again.`,
    );
  }
}

// HEAD is never treated as a page, so a signed-out visitor gets 401 rather than the sign-in page.
async function serverState(): Promise<'ok' | 'signed-out' | 'offline'> {
  try {
    const res = await step(fetch('/', { method: 'HEAD', cache: 'no-store' }), 8000);
    return res.status === 401 ? 'signed-out' : 'ok';
  } catch {
    return 'offline';
  }
}

export async function tunnel(): Promise<Problem | null> {
  let err: unknown;
  try {
    await pickTransport();
    return null;
  } catch (e) {
    err = e;
  }
  const state = await serverState();
  if (state === 'signed-out') {
    return problem(
      'signed-out',
      'sign-in',
      'Your sign-in has run out. Reload the page and enter your invite code again.',
    );
  }
  if (state === 'offline') {
    return problem(
      'offline',
      'network',
      "This Persec server can't be reached. It may be down, or blocked on this network: try the " +
        'backup address you were given, or another network.',
    );
  }
  const kind = err instanceof TransportError ? err.kind : 'refused';
  return problem(
    `tunnel-${kind}`,
    'network',
    kind === 'closed'
      ? 'The server closed the proxy connection. Reload to sign in again; if that does not help, the server may be overloaded.'
      : `The site loads, but the proxy connection to it ${kind === 'timeout' ? 'gets no answer' : 'is blocked'}. ` +
          'Some school, work and public networks, firewalls, antivirus web shields and extensions block ' +
          'WebSockets. Try another network (such as mobile data) or the backup address you were given.',
  );
}

export async function runDiagnostics(opts: { runtime?: () => Promise<unknown> } = {}) {
  // In parallel, as before these checks existed: the engine starts while the worker installs.
  const results = await Promise.all([
    serviceWorker(),
    sharedWorker(),
    storage(),
    webAssembly(),
    opts.runtime ? runtime(opts.runtime) : null,
    proxyWorker(),
    tunnel(),
  ]);
  return results.filter((p): p is Problem => !!p);
}

const PASSED =
  "Every check passed. If a site still doesn't load, the problem is likely that site (it may be " +
  'down or block proxies): open it, then choose Menu → Try the Other Engine.';

// Writes the results as text into `el` (never as HTML: messages include browser error text).
export function renderResults(el: HTMLElement, problems: Problem[]) {
  el.replaceChildren();
  const label = { browser: 'This browser', network: 'Connection', 'sign-in': 'Sign-in' };
  for (const p of problems.length ? problems : [null]) {
    const item = document.createElement('p');
    item.className = 'mt-1';
    if (p) {
      const b = document.createElement('b');
      b.textContent = `${label[p.where]}: `;
      item.append(b, p.message);
    } else {
      item.textContent = PASSED;
    }
    el.append(item);
  }
}

// Shows a banner while there are problems; Retry runs the checks again. `onRecovered` runs once a
// retry passes (e.g. to open the page the person asked for). Calls while checks are running share
// that run, so pressing Enter repeatedly doesn't stack banners.
let running: Promise<Problem[]> | null = null;
export function checkAndShow(
  opts: Parameters<typeof runDiagnostics>[0] & { onRecovered?: () => void } = {},
): Promise<Problem[]> {
  running ??= runDiagnostics(opts).finally(() => (running = null));
  return running.then(problems => {
    show(problems, opts);
    return problems;
  });
}

function show(problems: Problem[], opts: Parameters<typeof checkAndShow>[0] = {}) {
  document.getElementById('persec-diag')?.remove();
  if (!problems.length) return;

  const box = document.createElement('div');
  box.id = 'persec-diag';
  box.setAttribute('role', 'alert');
  box.className =
    // At the top: the first-visit cookie notice sits at the bottom, in the page around this one.
    'fixed inset-x-3 top-24 z-50 mx-auto max-w-xl rounded-xl border border-red-500/30 bg-[#1f1d2e] p-4 text-sm text-white shadow-lg';
  const title = document.createElement('h2');
  title.className = 'font-semibold text-red-300';
  title.textContent = "Persec can't connect";
  const list = document.createElement('div');
  renderResults(list, problems);
  const actions = document.createElement('div');
  actions.className = 'mt-3 flex gap-2';
  const button = (text: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className =
      'min-h-11 rounded-lg border border-white/10 bg-white/5 px-4 hover:bg-white/10 disabled:opacity-60';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  const retry = button('Retry', async () => {
    retry.disabled = true;
    retry.textContent = 'Checking again…';
    title.textContent = 'Checking the connection…';
    title.className = 'font-semibold text-white';
    let again: Problem[];
    try {
      again = await runDiagnostics(opts);
    } catch {
      again = problems;
    }
    if (again.length) return show(again, opts);
    title.textContent = 'Connected';
    title.className = 'font-semibold text-green-300';
    box.classList.replace('border-red-500/30', 'border-green-500/30');
    list.textContent = opts.onRecovered
      ? 'Every check passed. Opening your page…'
      : 'Every check passed. You can browse now.';
    actions.remove();
    setTimeout(() => box.remove(), 3000);
    opts.onRecovered?.();
  });
  actions.append(
    retry,
    button('Dismiss', () => box.remove()),
  );
  box.append(title, list, actions);
  document.body.append(box);
}
