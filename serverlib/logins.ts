import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Saved logins: an opt-in backup of the cookies and site data people keep in Persec, so they stay
// signed in to sites on any device where they enter their invite code. The browser encrypts the
// backup with a key made from the invite code (src/utils/loginsync.ts), so the server only ever
// stores bytes it can't read. Each signed-in person has one backup, found by who their sign-in
// cookie says they are.

export const MAX_BACKUP_BYTES = 1024 * 1024;
// Backups nobody has updated for this long are deleted, so data isn't kept forever for people who
// stopped using Persec or whose invite was revoked.
const KEEP_DAYS = 90;

export interface Backup {
  data: Buffer;
  updated: number;
}

export class BackupStore {
  constructor(readonly dir: string) {}

  // Hashed so a file name never contains anything a person typed.
  private file(subject: string): string {
    const id = crypto.createHash('sha256').update(`persec-logins:${subject}`).digest('hex');
    return path.join(this.dir, `${id}.bin`);
  }

  async get(subject: string): Promise<Backup | null> {
    const file = this.file(subject);
    try {
      const [data, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      return { data, updated: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  async put(subject: string, data: Buffer): Promise<void> {
    if (data.length > MAX_BACKUP_BYTES) throw new Error('Backup too large');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Written to a temporary file first so a crash never leaves half a backup.
    const file = this.file(subject);
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async delete(subject: string): Promise<void> {
    await fs.rm(this.file(subject), { force: true });
  }

  async prune(now = Date.now()): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > KEEP_DAYS * 86400 * 1000) {
          await fs.rm(file, { force: true });
          removed++;
        }
      } catch {}
    }
    return removed;
  }
}
