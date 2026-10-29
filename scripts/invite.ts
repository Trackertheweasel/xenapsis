import fs from 'node:fs';
import path from 'node:path';
import { inviteCode, inviteExpiry } from '../serverlib/access.ts';
import { InviteStore } from '../serverlib/invites.ts';

// Usage: PERSEC_SECRET=<same secret as the server> pnpm invite <name> [days]
// Prints an invite code that works until it expires, with no server restart needed.
// On the server (`persec invite`), it is also recorded in the data folder so /admin lists it.

const [name, days = '30'] = process.argv.slice(2);
const secret = process.env.PERSEC_SECRET?.trim();

if (!name || !secret) {
  console.error('Usage: PERSEC_SECRET=<server secret> pnpm invite <name> [days, default 30]');
  console.error(
    'Use a different name for each person: revoking a name revokes every invite with it.',
  );
  process.exit(1);
}

try {
  if (!(Number(days) > 0)) throw new Error('Days must be a positive number.');
  const now = Date.now();
  const expires = inviteExpiry(Number(days), now);
  const code = inviteCode(secret, name, expires);
  const until = new Date(expires * 1000).toISOString().slice(0, 10);
  console.log(code);
  console.error(
    `Invite for "${name}", valid until ${until}. Revoke early with PERSEC_REVOKED=${name}`,
  );
  // Only where a data folder already exists (the server's), so running it elsewhere leaves no files.
  const dataDir = process.env.PERSEC_DATA_DIR || path.join(process.cwd(), 'data');
  if (fs.existsSync(dataDir)) {
    try {
      new InviteStore(path.join(dataDir, 'invites.json')).add({
        name,
        created: now,
        expires,
        via: 'cli',
      });
    } catch {
      console.error('(Could not add it to the list on /admin; the code works anyway.)');
    }
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
