import assert from 'node:assert/strict';
import test from 'node:test';
import {
	checkCode,
	createToken,
	loadAccess,
	readCookie,
	recordFailure,
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
	assert.ok(!verifyToken(access, token, Date.now() + 31 * 24 * 3600 * 1000), 'expired after 30 days');
	assert.ok(!verifyToken(access, token.slice(0, -2) + 'xx'), 'tampered signature');
	assert.ok(!verifyToken(access, createToken(loadAccess({ ...env, PERSEC_SECRET: 'other' })!, 'alice')));
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
