import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToken, loadAccess } from '../serverlib/access.ts';
import { buildApp } from '../serverlib/app.ts';
import {
  pickTransport,
  probeWisp,
  TransportError,
  tunnelUrl,
  withTimeout,
} from '../src/utils/transport.ts';
import type { Transport } from '../src/utils/transport.ts';

// A WebSocket stand-in that plays back one scripted connection.
function fakeSocket(script: 'greets' | 'refuses' | 'silent' | 'hangs-up') {
  return class {
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    closed = false;
    constructor() {
      setTimeout(() => {
        if (script === 'refuses') return this.onclose?.();
        this.onopen?.();
        if (script === 'greets') this.onmessage?.();
        if (script === 'hangs-up') this.onclose?.();
      });
    }
    close() {
      this.closed = true;
    }
  } as unknown as typeof WebSocket;
}

const kindOf = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: TransportError) => err.kind,
  );

test('The probe tells a working tunnel from a blocked, silent or closed one', async () => {
  assert.equal(await kindOf(probeWisp('ws://x/w/', 200, fakeSocket('greets'))), 'ok');
  assert.equal(await kindOf(probeWisp('ws://x/w/', 200, fakeSocket('refuses'))), 'refused');
  assert.equal(await kindOf(probeWisp('ws://x/w/', 50, fakeSocket('silent'))), 'timeout');
  assert.equal(await kindOf(probeWisp('ws://x/w/', 200, fakeSocket('hangs-up'))), 'closed');
  assert.equal(await kindOf(probeWisp('not a url', 200)), 'refused', 'a bad address fails cleanly');
});

test('A saved tunnel address on this server follows the build; another server is kept', () => {
  const current = 'wss://persec.test/new-path/';
  assert.equal(tunnelUrl('wss://persec.test/w/', current, 'persec.test'), current, 'stale path');
  assert.equal(tunnelUrl('wss://other.test/w/', current, 'persec.test'), 'wss://other.test/w/');
  assert.equal(
    tunnelUrl('wss://persec.test:8443/w/', current, 'persec.test'),
    'wss://persec.test:8443/w/',
  );
  assert.equal(tunnelUrl(null, current, 'persec.test'), current);
  assert.equal(tunnelUrl('garbage', current, 'persec.test'), current);
});

function scripted(name: string, results: (TransportError | null)[]) {
  const calls: number[] = [];
  const t: Transport = {
    name,
    module: `/${name}.mjs`,
    options: async () => [],
    probe: async () => {
      calls.push(Date.now());
      const r = results[calls.length - 1] ?? results.at(-1);
      if (r) throw r;
    },
  };
  return { t, calls };
}
const fast = { timeoutMs: 50, retryDelayMs: 1 };

test('Transport selection retries a bounded number of times, then falls back in order', async () => {
  const flaky = scripted('flaky', [new TransportError('timeout', 'slow'), null]);
  assert.equal((await pickTransport([flaky.t], fast)).name, 'flaky', 'a second try can succeed');
  assert.equal(flaky.calls.length, 2);

  const dead = scripted('dead', [new TransportError('refused', 'blocked')]);
  const backup = scripted('backup', [null]);
  assert.equal((await pickTransport([dead.t, backup.t], fast)).name, 'backup');
  assert.equal(dead.calls.length, 2, 'two tries, then the next transport');

  const closed = scripted('closed', [new TransportError('closed', 'no')]);
  await assert.rejects(pickTransport([closed.t], fast), { kind: 'closed' });
  assert.equal(closed.calls.length, 1, "a server's refusal isn't retried");

  await assert.rejects(pickTransport([], fast), { kind: 'init' }, 'nothing to try is an error');
});

test('A probe that never settles still ends the selection', async () => {
  const stuck: Transport = {
    name: 'stuck',
    module: '/stuck.mjs',
    options: async () => [],
    probe: () => new Promise(() => {}),
  };
  const started = Date.now();
  await assert.rejects(pickTransport([stuck], { ...fast, attempts: 2 }), { kind: 'timeout' });
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, () => new Error('late')),
    /late/,
  );
});

// End to end against the real server: the probe needs Wisp's greeting, which only comes once the
// server lets the tunnel open.
test('The probe passes against the real tunnel and fails cleanly without an invite', async () => {
  const env = { PERSEC_INVITE_CODES: 'tester:abc123', PERSEC_SECRET: 'test-secret' };
  const access = loadAccess(env)!;
  const app = await buildApp({
    access,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const { port } = app.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/w/`;
    const cookie = `persec_access=${createToken(access, 'tester')}`;
    // Node's WebSocket takes headers; a browser sends the sign-in cookie on its own.
    const SignedIn = class extends WebSocket {
      constructor(u: string | URL) {
        super(u, { headers: { cookie } } as any);
      }
    };
    await probeWisp(url, 3000, SignedIn as typeof WebSocket);
    assert.equal(await kindOf(probeWisp(url, 3000)), 'refused', 'no invite, no tunnel');
    assert.equal(
      await kindOf(probeWisp(`ws://127.0.0.1:${port}/elsewhere/`, 3000, SignedIn as any)),
      'refused',
    );
  } finally {
    await app.close();
  }
});
