import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A record of the invites the owner has minted (on /admin or with `persec invite`), so /admin can
// list them. Minted codes work without it: it only keeps each invite's name and dates, never the
// code, which /admin can recreate from PERSEC_SECRET when asked. Revokes made on /admin are kept
// here too, so they survive a restart. A small JSON file, read on each admin request, so invites
// `persec invite` adds while the server runs show up at once.

export interface InviteRecord {
  name: string;
  created: number; // ms
  expires: number; // seconds, as in the code itself
  via: 'admin' | 'cli';
}

interface InviteFile {
  invites: InviteRecord[];
  revoked: string[];
}

// Plenty for one owner's invites, and keeps the file small on a 1 GB server.
const MAX_RECORDS = 2000;

export class InviteStore {
  constructor(readonly file: string) {}

  read(): InviteFile {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        invites: Array.isArray(data.invites) ? data.invites.filter(valid) : [],
        revoked: Array.isArray(data.revoked)
          ? data.revoked.filter((n: unknown) => typeof n === 'string')
          : [],
      };
    } catch {
      return { invites: [], revoked: [] };
    }
  }

  private write(data: InviteFile) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // Written to a temporary file first so a crash never leaves half a file.
    const tmp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  add(record: InviteRecord) {
    const data = this.read();
    data.invites.push(record);
    // The oldest go first; their codes keep working until they expire.
    data.invites = data.invites.slice(-MAX_RECORDS);
    this.write(data);
  }

  setRevoked(name: string, revoked: boolean) {
    const data = this.read();
    const names = new Set(data.revoked);
    if (revoked) names.add(name);
    else names.delete(name);
    data.revoked = [...names];
    this.write(data);
  }
}

const valid = (r: any): r is InviteRecord =>
  typeof r?.name === 'string' &&
  Number.isFinite(r.created) &&
  Number.isFinite(r.expires) &&
  (r.via === 'admin' || r.via === 'cli');
