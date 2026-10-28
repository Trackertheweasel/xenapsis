import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { trackTunnel, usageSnapshot } from '../serverlib/stats.ts';

const fakeSocket = (down: number, up: number) =>
  Object.assign(new EventEmitter(), { bytesWritten: down, bytesRead: up }) as unknown as Duplex;

test('Usage adds up live and closed tunnels per person', () => {
  const t0 = Date.now();
  const tab1 = fakeSocket(1000, 100);
  const tab2 = fakeSocket(500, 50);
  trackTunnel('stats-dana', tab1, t0);
  trackTunnel('stats-dana', tab2, t0);
  const row = () => usageSnapshot(t0 + 60_000).find(r => r.name === 'stats-dana')!;

  assert.deepEqual(
    { ...row(), lastSeen: 0 },
    {
      name: 'stats-dana',
      online: 2,
      down: 1500,
      up: 150,
      connectedMs: 120_000,
      sessions: 2,
      lastSeen: 0,
    },
  );
  tab1.emit('close');
  tab2.emit('close');
  const closed = row();
  assert.equal(closed.online, 0);
  assert.equal(closed.down, 1500, 'bytes of closed tunnels are kept');
  assert.ok(closed.lastSeen >= t0 && closed.lastSeen <= Date.now());
});
