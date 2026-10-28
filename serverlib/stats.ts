import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

// Per-person use of the proxy tunnel, for the admin page (routes/admin.ts). Kept in memory only, so
// it is gone on restart, and it never records which sites anyone visits: just amounts and times.

interface Usage {
  open: Map<Duplex, number>; // socket -> when it opened
  down: number;
  up: number;
  connectedMs: number;
  sessions: number;
  lastSeen: number;
}

export interface UsageRow {
  name: string;
  online: number;
  down: number;
  up: number;
  connectedMs: number;
  sessions: number;
  lastSeen: number;
}

const usage = new Map<string, Usage>();
// The tunnel socket is a net.Socket, which counts its own bytes.
const bytes = (socket: Duplex) => ({
  down: (socket as Partial<Socket>).bytesWritten ?? 0,
  up: (socket as Partial<Socket>).bytesRead ?? 0,
});

export function trackTunnel(name: string, socket: Duplex, now = Date.now()) {
  let u = usage.get(name);
  if (!u) {
    u = { open: new Map(), down: 0, up: 0, connectedMs: 0, sessions: 0, lastSeen: now };
    usage.set(name, u);
  }
  u.open.set(socket, now);
  u.sessions++;
  u.lastSeen = now;
  socket.once('close', () => {
    const { down, up } = bytes(socket);
    const end = Date.now();
    u.down += down;
    u.up += up;
    u.connectedMs += end - (u.open.get(socket) ?? end);
    u.lastSeen = end;
    u.open.delete(socket);
  });
}

export function usageSnapshot(now = Date.now()): UsageRow[] {
  return [...usage].map(([name, u]) => {
    let { down, up, connectedMs } = u;
    // Each open tab has its own tunnel, so time is summed across tabs and devices.
    for (const [socket, opened] of u.open) {
      const live = bytes(socket);
      down += live.down;
      up += live.up;
      connectedMs += now - opened;
    }
    const online = u.open.size;
    return {
      name,
      online,
      down,
      up,
      connectedMs,
      sessions: u.sessions,
      lastSeen: online ? now : u.lastSeen,
    };
  });
}
