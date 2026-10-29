import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCode, loadAccess } from '../serverlib/access.ts';
import { loadAiConfig } from '../serverlib/ai/index.ts';
import { buildApp } from '../serverlib/app.ts';
import { loadBrowserConfig } from '../serverlib/browser/index.ts';
import { InviteStore } from '../serverlib/invites.ts';
import { serverChecks } from '../serverlib/routes/admin.ts';

const PASSWORD = 'correct-horse-battery';
const env = {
  PERSEC_INVITE_CODES: 'alice:abc123',
  PERSEC_SECRET: 'test-secret',
  PERSEC_ADMIN_PASSWORD: PASSWORD,
  PERSEC_CLIENT_IP_HEADER: 'cf-connecting-ip',
  PERSEC_REVOKED: 'mallory',
};
let nextIp = 0;

async function setup(overrides: Record<string, string> = {}, withFile = true) {
  const dir = await mkdtemp(path.join(tmpdir(), 'persec-admin-'));
  const access = loadAccess({ ...env, ...overrides })!;
  const invitesFile = withFile ? path.join(dir, 'invites.json') : undefined;
  const app = await buildApp({
    access,
    wispPath: '/w/',
    loginsDir: path.join(dir, 'logins'),
    invitesFile,
    version: '9.9.9',
  });
  const signIn = await app.inject({
    method: 'POST',
    url: '/enter',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': `198.51.100.${++nextIp}`,
    },
    payload: 'code=abc123',
  });
  const cookie = String(signIn.headers['set-cookie']).split(';')[0];
  const headers = {
    cookie,
    authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`,
  };
  const get = (url: string) => app.inject({ url, headers });
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json', ...extra },
      payload: JSON.stringify(body),
    });
  return { app, access, invitesFile, get, post };
}

test('Invites made on /admin are listed with their dates, and their codes work', async () => {
  const { access, invitesFile, get, post } = await setup();
  const made = await post('/admin/invites', { name: 'sam', days: 7 });
  assert.equal(made.statusCode, 200);
  const { code, expires } = made.json();
  assert.equal(checkCode(access, code), `invite:sam:${expires}`);

  const list = (await get('/admin/invites')).json();
  assert.equal(list.canCreate, true);
  const sam = list.invites.find((i: any) => i.name === 'sam');
  assert.equal(sam.status, 'active');
  assert.equal(sam.source, 'minted');
  assert.equal(sam.via, 'admin');
  assert.ok(Math.abs(sam.expires - (Date.now() / 1000 + 7 * 86400)) < 5);
  const alice = list.invites.find((i: any) => i.name === 'alice');
  assert.deepEqual([alice.source, alice.status, alice.expires], ['listed', 'active', null]);

  // Codes are never stored, and the list never carries them.
  const file = await readFile(invitesFile!, 'utf8');
  assert.ok(!file.includes(code));
  assert.ok(!JSON.stringify(list).includes(code));
  assert.ok(!JSON.stringify(list).includes('abc123'), 'listed codes stay hidden');

  // The owner can see a recorded invite's code again, and only a recorded one.
  assert.equal((await post('/admin/invites/code', { name: 'sam', expires })).json().code, code);
  const unknown = await post('/admin/invites/code', { name: 'sam', expires: expires + 1 });
  assert.equal(unknown.statusCode, 404);
});

test('Bad invite requests are refused', async () => {
  const { post } = await setup();
  assert.equal((await post('/admin/invites', { name: 'no spaces', days: 7 })).statusCode, 400);
  assert.equal((await post('/admin/invites', { name: 'sam', days: 0 })).statusCode, 400);
  assert.equal((await post('/admin/invites', { name: 'sam', days: 99999 })).statusCode, 400);
});

test('Changes need a same-origin JSON request', async () => {
  const { app, post } = await setup();
  const evil = await post(
    '/admin/invites',
    { name: 'x', days: 1 },
    { origin: 'https://evil.test' },
  );
  assert.equal(evil.statusCode, 403);
  const form = await post(
    '/admin/invites',
    { name: 'x', days: 1 },
    { 'content-type': 'text/plain' },
  );
  assert.equal(form.statusCode, 403);
  const noAuth = await app.inject({
    method: 'POST',
    url: '/admin/invites',
    headers: { 'content-type': 'application/json' },
    payload: '{"name":"x","days":1}',
  });
  assert.equal(noAuth.statusCode, 401);
});

test('Revoking on /admin signs the name out at once and lasts across restarts', async () => {
  const { access, invitesFile, get, post } = await setup();
  const { code } = (await post('/admin/invites', { name: 'sam', days: 7 })).json();
  assert.equal((await post('/admin/revoke', { name: 'sam', revoked: true })).statusCode, 200);
  assert.equal(checkCode(access, code), null);
  assert.equal(
    (await get('/admin/invites')).json().invites.find((i: any) => i.name === 'sam').status,
    'revoked',
  );
  assert.deepEqual(new InviteStore(invitesFile!).read().revoked, ['sam']);

  // A restarted server reads the revoke back.
  const restarted = loadAccess(env)!;
  await buildApp({ access: restarted, wispPath: '/w/', loginsDir: tmpdir(), invitesFile });
  assert.equal(checkCode(restarted, code), null);

  assert.equal((await post('/admin/revoke', { name: 'sam', revoked: false })).statusCode, 200);
  assert.ok(checkCode(access, code));
  // PERSEC_REVOKED can only be lifted where it's set.
  assert.equal((await post('/admin/revoke', { name: 'mallory', revoked: false })).statusCode, 409);
});

test('Invites made with `persec invite` show up in the list', async () => {
  const { invitesFile, get } = await setup();
  new InviteStore(invitesFile!).add({ name: 'lee', created: 1, expires: 2, via: 'cli' });
  const lee = (await get('/admin/invites')).json().invites.find((i: any) => i.name === 'lee');
  assert.deepEqual([lee.via, lee.status], ['cli', 'expired']);
});

test('Without a fixed secret or data folder, /admin lists but cannot create', async () => {
  const noSecret = await setup({ PERSEC_SECRET: '' });
  const list = (await noSecret.get('/admin/invites')).json();
  assert.equal(list.canCreate, false);
  assert.equal((await noSecret.post('/admin/invites', { name: 'x', days: 1 })).statusCode, 409);

  const noFile = await setup({}, false);
  assert.equal((await noFile.get('/admin/invites')).json().canRevoke, false);
  assert.equal(
    (await noFile.post('/admin/revoke', { name: 'alice', revoked: true })).statusCode,
    409,
  );
});

test('The setup check says what is missing without showing any value', async () => {
  const { get } = await setup();
  const res = await get('/admin/server');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.version, '9.9.9');
  const text = JSON.stringify(body);
  for (const secret of ['test-secret', PASSWORD, 'abc123']) assert.ok(!text.includes(secret));

  const access = loadAccess(env)!;
  const checks = serverChecks(access, {
    ai: loadAiConfig({ OPENROUTER_API_KEY: 'sk-or-v1-secret' }),
    browser: loadBrowserConfig({ CAMOUFOX_ENABLED: 'true' }),
    invites: true,
  });
  const by = (name: string) => checks.find(c => c.name === name)!;
  assert.equal(by('OPENROUTER_API_KEY').ok, true);
  assert.match(by('OPENROUTER_API_KEY').detail, /free models only/);
  assert.ok(!JSON.stringify(checks).includes('sk-or-v1-secret'));
  assert.match(by('Browser mode (Camoufox)').detail, /CAMOUFOX_WS_ENDPOINT/);
  assert.equal(by('PERSEC_SECRET').ok, true);

  const bare = serverChecks(loadAccess({ PERSEC_INVITE_ONLY: 'true' })!, {
    ai: loadAiConfig({}),
    browser: loadBrowserConfig({}),
    invites: false,
  });
  assert.deepEqual(
    bare.filter(c => !c.ok && !c.optional).map(c => c.name),
    ['PERSEC_SECRET', 'Invite codes', 'PERSEC_CLIENT_IP_HEADER', 'Data folder'],
  );
});

test('The admin page has the invite and setup sections', async () => {
  const { get } = await setup();
  const page = (await get('/admin')).body;
  for (const id of ['usage', 'invites', 'server']) assert.match(page, new RegExp(`id="${id}"`));
});
