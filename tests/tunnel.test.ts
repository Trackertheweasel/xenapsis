import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import test, { after, before } from 'node:test';
import { client } from '@mercuryworkshop/wisp-js/client';
import { buildApp } from '../serverlib/app.ts';
import { wisp } from '../serverlib/wisp.ts';

// What ChatGPT and Claude need from the tunnel, end to end through the real server: a streamed reply
// arrives as it is sent (not when it ends), a quiet long-lived connection stays open, a large reply
// arrives whole, and a WebSocket works. The tunnel carries TCP, so in production all of this runs
// inside the browser's own TLS; here a plain local site stands in for the real one.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CHUNKS = 5;
const CHUNK_GAP_MS = 150;
const QUIET_MS = 1500;
const BIG = 4 * 1024 * 1024;

// The stand-in site: a server-sent-events stream with a long pause, a big download, and a
// WebSocket echo, written by hand so the test needs nothing beyond Node.
let endlessSent = 0;
const site = http.createServer(async (req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    for (let i = 0; i < CHUNKS; i++) {
      res.write(`data: ${i} ${Date.now()}\n\n`);
      await sleep(CHUNK_GAP_MS);
    }
    await sleep(QUIET_MS);
    res.end(`data: done ${Date.now()}\n\n`);
  } else if (req.url === '/endless') {
    // A download that never ends, counting what it managed to hand to the tunnel.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    const chunk = Buffer.alloc(64 * 1024, 7);
    const pump = () => {
      while (!res.destroyed) {
        endlessSent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
    };
    pump();
  } else if (req.url === '/big') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': BIG });
    res.end(Buffer.alloc(BIG, 7));
  } else res.writeHead(404).end();
});
const upgraded = new Set<Duplex>();
site.on('upgrade', (req, socket) => {
  upgraded.add(socket);
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  // Echo short masked text frames back unmasked.
  socket.on('data', (frame: Buffer) => {
    const len = frame[1] & 0x7f;
    const mask = frame.subarray(2, 6);
    const payload = Buffer.from(frame.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4]));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
});

let tunnelPort = 0;
let sitePort = 0;
const saved = { ...wisp.options };
let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
  sitePort = (site.address() as AddressInfo).port;
  // The stand-in site is on localhost, which the tunnel rightly refuses; allow it for this test only.
  wisp.options.allow_loopback_ips = true;
  app = await buildApp({
    access: null,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  tunnelPort = (app.server.address() as AddressInfo).port;
});

after(async () => {
  Object.assign(wisp.options, saved);
  for (const socket of upgraded) socket.destroy();
  site.closeAllConnections();
  site.close();
  app.server.closeAllConnections();
  await app.close();
});

// Opens a TCP stream to the stand-in site through the Wisp tunnel, as the browser's transport does.
async function openStream() {
  const conn = new client.ClientConnection(`ws://127.0.0.1:${tunnelPort}/w/`);
  await new Promise<void>((resolve, reject) => {
    conn.onopen = resolve;
    conn.onerror = reject;
  });
  const stream = conn.create_stream('127.0.0.1', sitePort);
  const received: { at: number; data: Buffer }[] = [];
  let closedAt: number | null = null;
  stream.onmessage = (data: Uint8Array) =>
    received.push({ at: Date.now(), data: Buffer.from(data) });
  stream.onclose = () => (closedAt = Date.now());
  return {
    conn,
    received,
    closedAt: () => closedAt,
    send: (text: string | Buffer) =>
      stream.send(typeof text === 'string' ? Buffer.from(text) : text),
    text: () => Buffer.concat(received.map(r => r.data)).toString('latin1'),
  };
}

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(20);
  return check();
}

test('Streamed replies pass through as they are sent, and a quiet stream stays open', async () => {
  const s = await openStream();
  try {
    const started = Date.now();
    s.send('GET /stream HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    assert.ok(await until(() => s.text().includes('data: 0 '), 3000), 'first event arrived');
    const firstAt = Date.now();
    assert.ok(
      firstAt - started < CHUNKS * CHUNK_GAP_MS,
      'the first event arrived before the site had sent them all: nothing buffered it',
    );
    assert.ok(await until(() => s.text().includes('data: done'), 10_000), 'last event arrived');
    // Each event reached us at about the time it was sent, not in one lump at the end.
    const events = [...s.text().matchAll(/data: (\d+|done) (\d+)/g)];
    assert.equal(events.length, CHUNKS + 1);
    const lastAt = s.received.at(-1)!.at;
    assert.ok(lastAt - firstAt >= QUIET_MS, 'the connection outlived a long silence');
    assert.equal(s.closedAt() === null || s.closedAt()! >= lastAt, true);
  } finally {
    s.conn.close();
  }
});

test('A large reply arrives whole', { timeout: 30_000 }, async () => {
  const s = await openStream();
  try {
    s.send('GET /big HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
    const total = () => s.received.reduce((n, r) => n + r.data.length, 0);
    assert.ok(await until(() => total() >= BIG, 15_000), `got ${total()} of ${BIG} bytes`);
    const body = Buffer.concat(s.received.map(r => r.data));
    const start = body.indexOf('\r\n\r\n') + 4;
    assert.equal(body.length - start, BIG);
    assert.ok(
      body.subarray(start).every(b => b === 7),
      'no byte changed on the way',
    );
  } finally {
    s.conn.close();
  }
});

test('A visitor who stops reading holds back the site, not server memory', async () => {
  const s = await openStream();
  try {
    s.send('GET /endless HTTP/1.1\r\nHost: example.test\r\n\r\n');
    assert.ok(await until(() => s.received.length > 0, 3000), 'the download started');
    // A phone on weak Wi-Fi, or a laptop that went to sleep: its end stops taking data.
    (s.conn as any).ws._socket.pause();
    await sleep(500);
    const before = endlessSent;
    await sleep(1500);
    // Only socket buffers and the tunnel's 1 MB send buffer fill up, then the site is made to wait.
    // Before, the server kept reading from the site and held everything in memory: hundreds of MB here.
    assert.ok(endlessSent < 64 * 1024 * 1024, `site handed over ${endlessSent >> 20} MB`);
    assert.ok(endlessSent - before < 8 * 1024 * 1024, 'the site was held back once buffers filled');
  } finally {
    s.conn.close();
  }
});

test('A WebSocket opens and carries messages through the tunnel', async () => {
  const s = await openStream();
  try {
    s.send(
      'GET /socket HTTP/1.1\r\nHost: example.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
    assert.ok(await until(() => s.text().includes('\r\n\r\n'), 3000));
    assert.match(s.text(), /^HTTP\/1\.1 101 /, 'the upgrade reached the site and back unchanged');
    assert.match(s.text(), /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);

    const mask = Buffer.from([1, 2, 3, 4]);
    const payload = Buffer.from('hello');
    s.received.length = 0;
    s.send(
      Buffer.concat([
        Buffer.from([0x81, 0x80 | payload.length]),
        mask,
        payload.map((b, i) => b ^ mask[i % 4]),
      ]),
    );
    assert.ok(await until(() => s.text().includes('hello'), 3000), 'echo came back');
    await sleep(QUIET_MS);
    s.received.length = 0;
    s.send(
      Buffer.concat([
        Buffer.from([0x81, 0x80 | 5]),
        mask,
        Buffer.from('again').map((b, i) => b ^ mask[i % 4]),
      ]),
    );
    assert.ok(
      await until(() => s.text().includes('again'), 3000),
      'still open after a quiet spell',
    );
  } finally {
    s.conn.close();
  }
});

test('The server sets no timeouts that would cut a long-lived tunnel', () => {
  // Node's own per-socket inactivity timeout is off; the tunnel pings every 30s (wisp-js), which
  // keeps proxies such as Cloudflare (100s idle limit) from closing it.
  assert.equal(app.server.timeout, 0);
  assert.equal(wisp.options.allow_tcp_streams, true);
});
