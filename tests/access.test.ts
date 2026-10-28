import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCode,
  createToken,
  loadAccess,
  mintInvite,
  readCookie,
  recordFailure,
  renewToken,
  tokenSubject,
  tooManyAttempts,
  verifyToken,
} from '../serverlib/access.ts';

const env = { PERSEC_INVITE_CODES: 'alice:abc123, bob:xyz789', PERSEC_SECRET: 'test-secret' };

test('Invite-only mode is off unless codes are set', () => {
  assert.equal(loadAccess({}), null);
  assert.equal(loadAccess({ PERSEC_INVITE_CODES: ' , ' }), null);
});

test('Valid codes sign people in, wrong ones do not', () => {
  const access = loadAccess(env)!;
  assert.equal(checkCode(access, 'abc123'), 'alice');
  assert.equal(checkCode(access, ' xyz789 '), 'bob');
  assert.equal(checkCode(access, 'abc12'), null);
  assert.equal(checkCode(access, ''), null);
});

test('Tokens verify, expire, and resist tampering', () => {
  const access = loadAccess(env)!;
  const token = createToken(access, 'alice');
  assert.ok(verifyToken(access, token));
  assert.ok(
    !verifyToken(access, token, Date.now() + 31 * 24 * 3600 * 1000),
    'expired after 30 days',
  );
  assert.ok(!verifyToken(access, token.slice(0, -2) + 'xx'), 'tampered signature');
  assert.ok(
    !verifyToken(access, createToken(loadAccess({ ...env, PERSEC_SECRET: 'other' })!, 'alice')),
  );
  assert.ok(!verifyToken(access, undefined));
});

test('Removing an invite revokes that person', () => {
  const token = createToken(loadAccess(env)!, 'bob');
  const withoutBob = loadAccess({ ...env, PERSEC_INVITE_CODES: 'alice:abc123' })!;
  assert.ok(!verifyToken(withoutBob, token));
});

test('Cookies are parsed and guessing is rate limited', () => {
  assert.equal(readCookie('a=1; persec_access=x.y.z; b=2', 'persec_access'), 'x.y.z');
  assert.equal(readCookie(undefined, 'persec_access'), undefined);
  const ip = '203.0.113.9';
  for (let i = 0; i < 10; i++) recordFailure(ip);
  assert.ok(tooManyAttempts(ip));
  assert.ok(!tooManyAttempts(ip, Date.now() + 16 * 60 * 1000));
});

test('Wrong codes from many addresses at once keep the attempt list capped', () => {
  const first = '198.51.100.1';
  for (let i = 0; i < 10; i++) recordFailure(first);
  // Fresh failures from 20,000 other addresses, none old enough to expire.
  for (let i = 0; i < 20_000; i++) recordFailure(`2001:db8::${i.toString(16)}`);
  const last = '2001:db8::4e1f'; // 19,999
  for (let i = 0; i < 9; i++) recordFailure(last);
  assert.ok(!tooManyAttempts(first), 'the oldest addresses are forgotten');
  assert.ok(tooManyAttempts(last), 'recent ones are still limited');
});

test('Removing an unnamed code does not hand its name to another code', () => {
  const before = loadAccess({ PERSEC_INVITE_CODES: 'aaa,bbb,ccc', PERSEC_SECRET: 's' })!;
  const after = loadAccess({ PERSEC_INVITE_CODES: 'aaa,ccc', PERSEC_SECRET: 's' })!;
  const bToken = createToken(before, checkCode(before, 'bbb')!);
  assert.ok(!verifyToken(after, bToken), 'removed code stays revoked');
  assert.ok(
    verifyToken(after, createToken(before, checkCode(before, 'ccc')!)),
    'others keep working',
  );
});

test('Minted invites work without being listed, expire, and can be revoked', () => {
  const day = 86400 * 1000;
  const access = loadAccess(env)!;
  const code = mintInvite('test-secret', 'sam', 7);
  const subject = checkCode(access, code)!;
  assert.ok(subject);
  assert.ok(verifyToken(access, createToken(access, subject)));
  assert.equal(checkCode(access, code, Date.now() + 8 * day), null, 'expired invite');
  assert.ok(
    !verifyToken(access, createToken(access, subject), Date.now() + 8 * day),
    'cookie ends with the invite',
  );
  assert.equal(checkCode(access, mintInvite('other-secret', 'sam', 7)), null, 'wrong secret');
  assert.equal(checkCode(access, code.replace('.', 'x.')), null, 'tampered');

  const revoked = loadAccess({ ...env, PERSEC_REVOKED: 'sam' })!;
  assert.equal(checkCode(revoked, code), null);
  assert.ok(!verifyToken(revoked, createToken(access, subject)));
  assert.throws(() => mintInvite('test-secret', 'bad:name', 7));
});

test('Minted invites need a fixed secret and cookies are not invites', () => {
  const access = loadAccess(env)!;
  assert.equal(checkCode(access, createToken(access, 'alice')), null);
  const noSecret = loadAccess({ PERSEC_INVITE_CODES: 'abc123' })!;
  assert.equal(checkCode(noSecret, mintInvite(noSecret.secret, 'sam', 7)), null);
  const mintedOnly = loadAccess({ PERSEC_INVITE_ONLY: 'true', PERSEC_SECRET: 'k' })!;
  assert.ok(mintedOnly && checkCode(mintedOnly, mintInvite('k', 'sam', 1)));
  assert.equal(loadAccess({ PERSEC_SECRET: 'k' }), null, 'secret alone does not lock the site');
});

test('Sign-in cookies renew when people come back, at most once a day', () => {
  const day = 86400 * 1000;
  const now = Date.now();
  const access = loadAccess(env)!;
  assert.equal(
    renewToken(access, createToken(access, 'alice', now - 3600 * 1000), now),
    null,
    'not within a day',
  );
  const renewed = renewToken(access, createToken(access, 'alice', now - 2 * day), now)!;
  assert.equal(tokenSubject(access, renewed, now + 29 * day), 'alice', 'good for another 30 days');
  assert.equal(renewToken(access, 'not.a.token', now), null);
  const withoutBob = loadAccess({ ...env, PERSEC_INVITE_CODES: 'alice:abc123' })!;
  assert.equal(
    renewToken(withoutBob, createToken(access, 'bob', now - 2 * day), now),
    null,
    'revoked people stay out',
  );
});

test('Renewing never outlives a minted invite', () => {
  const day = 86400 * 1000;
  const now = Date.now();
  const access = loadAccess(env)!;
  const subject = checkCode(access, mintInvite('test-secret', 'sam', 7, now), now)!;
  const renewed = renewToken(access, createToken(access, subject, now - 2 * day), now)!;
  assert.ok(verifyToken(access, renewed, now + 6 * day));
  assert.equal(tokenSubject(access, renewed, now + 8 * day), null);
});

// What a backup server set up with `persec export` shares with the primary (README, "Surviving a
// blocked server"). Each server reads only its own environment; nothing syncs between them.
test('Servers sharing PERSEC_SECRET share minted invites and sign-ins, not later changes', () => {
  const secret = 'shared-secret-0123456789';
  const primary = loadAccess({ PERSEC_INVITE_CODES: 'alice:abc123', PERSEC_SECRET: secret })!;
  const backup = loadAccess({ PERSEC_INVITE_CODES: 'alice:abc123', PERSEC_SECRET: secret })!;
  const invite = mintInvite(secret, 'sam', 30);
  assert.ok(checkCode(backup, invite), 'minted on one, accepted on the other');
  // A cookie only reaches the backup if both answer on the same domain (DNS failover).
  assert.equal(tokenSubject(backup, createToken(primary, 'alice')), 'alice');

  // Changes made on the primary afterwards stay there.
  const primaryLater = loadAccess({
    PERSEC_INVITE_CODES: 'alice:abc123,lee:leecode1',
    PERSEC_SECRET: secret,
    PERSEC_REVOKED: 'sam',
  })!;
  assert.equal(checkCode(primaryLater, invite), null, 'revoked on the primary');
  assert.ok(checkCode(backup, invite), 'still accepted by the backup until revoked there too');
  assert.equal(checkCode(backup, 'leecode1'), null, 'a code added on the primary only');

  const stranger = loadAccess({
    PERSEC_INVITE_CODES: 'alice:abc123',
    PERSEC_SECRET: 'other-secret-0123',
  })!;
  assert.equal(checkCode(stranger, invite), null, 'a different secret shares nothing');
  assert.equal(tokenSubject(stranger, createToken(primary, 'alice')), null);
});
