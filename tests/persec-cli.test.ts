import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/persec.sh', import.meta.url));
const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;

// Runs deploy/persec.sh against a scratch install, with docker and curl replaced by stubs that log
// their arguments. The curl stub answers 200 for names starting with "up".
function persec(env: string, ...args: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'persec-cli-'));
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(root, 'deploy'));
  mkdirSync(bin);
  writeFileSync(path.join(root, 'deploy', '.env'), env);
  const log = path.join(root, 'calls.log');
  const stub = (name: string, body: string) => {
    writeFileSync(
      path.join(bin, name),
      `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`,
    );
    chmodSync(path.join(bin, name), 0o755);
  };
  stub('docker', '');
  stub('curl', 'case "$*" in *https://up*) printf 200 ;; *) printf 000; exit 7 ;; esac');
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PERSEC_DIR: root, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const read = (f: string) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  return { ...res, env: read(path.join(root, 'deploy', '.env')), calls: read(log) };
}

const install = [
  'DOMAIN=up.example.net down.example.org',
  'PERSEC_INVITE_ONLY=true',
  'PERSEC_SECRET=0123456789abcdef0123',
  'PERSEC_INVITE_CODES=sam:samcode123',
  'PERSEC_REVOKED=',
  'PUBLIC_PERSEC_WISP_PATH=/primarypath1/',
  '',
].join('\n');

test(
  'export shares the secret and codes but gives the backup its own tunnel path',
  { skip: !hasBash },
  () => {
    const { status, stdout } = persec(install, 'export');
    assert.equal(status, 0);
    assert.match(stdout, /PERSEC_SECRET=0123456789abcdef0123 PERSEC_INVITE_CODES=sam:samcode123/);
    assert.doesNotMatch(stdout, /primarypath1/, "the primary's hidden path stays private");
    assert.match(
      stdout,
      /PUBLIC_PERSEC_WISP_PATH=\/\$\(openssl rand -hex 6\)\//,
      'made on the backup',
    );
    assert.match(stdout, /NOT kept in sync/);
    assert.match(stdout, /persec logins export/);

    const plain = persec(install.replace(/^PUBLIC_PERSEC_WISP_PATH=.*$/m, ''), 'export');
    assert.doesNotMatch(plain.stdout, /PUBLIC_PERSEC_WISP_PATH/, 'default path stays default');
  },
);

test('revoke applies here and says the backups need it too', { skip: !hasBash }, () => {
  const { status, stdout, env, calls } = persec(install, 'revoke', 'sam');
  assert.equal(status, 0);
  assert.match(env, /^PERSEC_REVOKED=sam$/m);
  assert.match(calls, /docker compose .* up -d persec/);
  assert.match(stdout, /run 'persec revoke sam' on each of them/);
});

test('status checks every address and fails if one is down', { skip: !hasBash }, () => {
  const { status, stdout } = persec(install, 'status');
  assert.equal(status, 1);
  assert.match(stdout, /^ok {4}https:\/\/up\.example\.net$/m);
  assert.match(stdout, /^FAIL {2}https:\/\/down\.example\.org/m);
  const healthy = persec(install.replace(' down.example.org', ''), 'status');
  assert.equal(healthy.status, 0);
});

test('saved logins move as an archive, never replacing a newer backup', { skip: !hasBash }, () => {
  assert.match(
    persec(install, 'logins', 'export').calls,
    /exec -T persec .*find logins -name "\*\.bin" -print0 \| tar --null -T - -cf -/,
  );
  assert.match(
    persec(install, 'logins', 'import').calls,
    /tar --keep-newer-files --wildcards -xf - "logins\/\*\.bin"/,
  );
  assert.equal(persec(install, 'logins').status, 1);
});

test('admin makes a password once and keeps showing the same one', { skip: !hasBash }, () => {
  const first = persec(install, 'admin');
  assert.equal(first.status, 0);
  const [, password] = first.env.match(/^PERSEC_ADMIN_PASSWORD=([0-9a-f]{24})$/m) ?? [];
  assert.ok(password, 'a generated password is saved');
  assert.match(first.calls, /docker compose .* up -d persec/);
  assert.match(first.stdout, /https:\/\/up\.example\.net\/admin/);
  assert.ok(first.stdout.includes(password));

  const again = persec(first.env, 'admin');
  assert.ok(again.stdout.includes(password));
  assert.equal(again.calls, '', 'no restart when it was already on');
});
