import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enterPage } from '../serverlib/access.ts';
import { BackupStore, MAX_BACKUP_BYTES } from '../serverlib/logins.ts';

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('Backups are kept per person, replaced whole, and never named after them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'persec-logins-'));
  try {
    const store = new BackupStore(dir);
    assert.equal(await store.get('alice'), null);
    await store.put('alice', Buffer.from('one'));
    await store.put('alice', Buffer.from('two'));
    await store.put('invite:sam:1767225600', Buffer.from('sam'));
    assert.equal((await store.get('alice'))?.data.toString(), 'two');
    assert.equal((await store.get('invite:sam:1767225600'))?.data.toString(), 'sam');
    assert.equal(await store.get('bob'), null);

    const files = await readdir(dir);
    assert.equal(files.length, 2, 'no leftover temporary files');
    assert.ok(files.every(f => /^[0-9a-f]{64}\.bin$/.test(f)));

    await assert.rejects(store.put('alice', Buffer.alloc(MAX_BACKUP_BYTES + 1)));
    await store.delete('alice');
    assert.equal(await store.get('alice'), null);
    await store.delete('alice');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Backups nobody has updated for 90 days are deleted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'persec-logins-'));
  try {
    const store = new BackupStore(dir);
    await store.put('old', Buffer.from('x'));
    await store.put('recent', Buffer.from('y'));
    const longAgo = new Date(Date.now() - 91 * 86400 * 1000);
    for (const f of await readdir(dir)) {
      if ((await readFile(path.join(dir, f), 'utf8')) === 'x')
        await utimes(path.join(dir, f), longAgo, longAgo);
    }
    assert.equal(await store.prune(), 1);
    assert.equal(await store.get('old'), null);
    assert.ok(await store.get('recent'));
    assert.equal(await new BackupStore(path.join(dir, 'missing')).prune(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('The sign-in page makes the same saved-logins key as the app', async () => {
  const page = enterPage();
  const client = await read('src/utils/loginsync.ts');
  const constant = (name: string) => client.match(new RegExp(`const ${name} = '?([^';]+)'?;`))![1];
  assert.ok(page.includes(`salt: enc.encode('${constant('KEY_SALT')}')`));
  assert.ok(page.includes(`iterations: ${constant('KEY_ITERATIONS').replace(/_/g, '')}`));
  assert.ok(page.includes(`indexedDB.open('${constant('KEY_DB')}', 1)`));
  // Non-extractable, so the key can't be read back out of the browser.
  assert.match(page, /\{ name: 'AES-GCM', length: 256 \},\s*false,/);
  assert.match(client, /\{ name: 'AES-GCM', length: 256 \},\s*false,/);
  // The app checks the size before uploading, so both ends must agree.
  assert.match(client, /const MAX_BYTES = 1024 \* 1024;/);
  assert.equal(MAX_BACKUP_BYTES, 1024 * 1024);
});

test('The sign-in page lets password managers remember the invite code', () => {
  const page = enterPage();
  assert.match(page, /autocomplete="username"/);
  assert.match(page, /autocomplete="current-password"/);
});

test('Clearing site data keeps the saved-logins key and deletes the backup', async () => {
  const src = await read('src/utils/sitedata.ts');
  assert.match(src, /KEEP_DATABASES = new Set\(\[[^\]]*'PersecLogins'/);
  assert.match(src, /await deleteBackup\(\);\n\}/, 'deletes the backup last');
});

test('A backup copied to another server is found there for the same person', async () => {
  const [a, b] = await Promise.all(
    [1, 2].map(() => mkdtemp(path.join(tmpdir(), 'persec-logins-'))),
  );
  try {
    await new BackupStore(a).put('alice', Buffer.from('ciphertext'));
    const [file] = await readdir(a);
    await writeFile(path.join(b, file), await readFile(path.join(a, file)));
    assert.equal((await new BackupStore(b).get('alice'))?.data.toString(), 'ciphertext');
    assert.equal(await new BackupStore(b).get('bob'), null);
  } finally {
    await Promise.all([a, b].map(d => rm(d, { recursive: true, force: true })));
  }
});

test('A backup that fails to download is never taken for no backup', async () => {
  // Just enough IndexedDB for loginsync.ts to find the key the sign-in page kept.
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const later = (fn: () => void) => setTimeout(fn);
  (globalThis as any).indexedDB = {
    open() {
      const req: any = {};
      later(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx: any = {};
            const get: any = { result: key };
            tx.objectStore = () => ({ get: () => get });
            later(() => tx.oncomplete());
            return tx;
          },
          close() {},
        };
        req.onsuccess();
      });
      return req;
    },
  };
  const { restore } = await import('../src/utils/loginsync.ts');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await restore(), 'none');
    globalThis.fetch = async () => new Response('', { status: 500 });
    await assert.rejects(restore());
    globalThis.fetch = async () => {
      throw new TypeError('offline');
    };
    await assert.rejects(restore());
  } finally {
    globalThis.fetch = realFetch;
    delete (globalThis as any).indexedDB;
  }
});
