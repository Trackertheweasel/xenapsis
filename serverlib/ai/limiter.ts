import type { RateLimit } from './index';

// Per-person limits on PerSec AI, so one invite can't use up the server's whole OpenRouter
// allowance. Kept in memory, like the sign-in attempt limit in serverlib/access.ts.
export class AiLimiter {
  private windows = new Map<string, { count: number; reset: number }>();
  private streams = new Map<string, number>();

  constructor(readonly limit: RateLimit) {}

  // Counts one request. Returns how many seconds to wait if over the limit, or 0.
  take(key: string, now = Date.now()): number {
    if (this.windows.size >= 10_000) {
      for (const [k, w] of this.windows) if (w.reset <= now) this.windows.delete(k);
      while (this.windows.size >= 5_000) this.windows.delete(this.windows.keys().next().value!);
    }
    const w = this.windows.get(key);
    if (!w || w.reset <= now) {
      this.windows.set(key, { count: 1, reset: now + this.limit.windowMs });
      return 0;
    }
    if (w.count >= this.limit.maxRequests) return Math.max(1, Math.ceil((w.reset - now) / 1000));
    w.count++;
    return 0;
  }

  // Reserves a slot for a reply in progress. Call the returned function exactly once when it ends.
  openStream(key: string): (() => void) | null {
    const open = this.streams.get(key) ?? 0;
    if (open >= this.limit.maxConcurrent) return null;
    this.streams.set(key, open + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.streams.get(key) ?? 1) - 1;
      if (left > 0) this.streams.set(key, left);
      else this.streams.delete(key);
    };
  }
}
