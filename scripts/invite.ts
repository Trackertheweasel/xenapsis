import { mintInvite } from '../serverlib/access.ts';

// Usage: PERSEC_SECRET=<same secret as the server> pnpm invite <name> [days]
// Prints an invite code that works until it expires, with no server restart needed.

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
  const code = mintInvite(secret, name, Number(days));
  const until = new Date(Date.now() + Number(days) * 86400 * 1000).toISOString().slice(0, 10);
  console.log(code);
  console.error(
    `Invite for "${name}", valid until ${until}. Revoke early with PERSEC_REVOKED=${name}`,
  );
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
