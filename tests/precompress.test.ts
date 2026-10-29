import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliDecompressSync } from 'node:zlib';
import { buildApp } from '../serverlib/app.ts';
import { deployPaths } from '../serverlib/env.ts';
import { precompress } from '../build/precompress.ts';

// A stand-in for dist/client: a big script, a page, a tiny file and an image.
async function client() {
  const root = await mkdtemp(path.join(tmpdir(), 'persec-client-'));
  await mkdir(path.join(root, '_astro'));
  await writeFile(
    path.join(root, '_astro', 'app.AbC123.js'),
    'console.log("hello");\n'.repeat(500),
  );
  await writeFile(path.join(root, 'st.html'), `<!doctype html>${'<p>settings</p>'.repeat(200)}`);
  await writeFile(path.join(root, 'tiny.js'), 'export {};');
  await writeFile(path.join(root, 'logo.webp'), Buffer.alloc(4096, 1));
  return root;
}

test('The build writes compressed copies of text files only', async () => {
  const root = await client();
  assert.equal(precompress(root), 2);
  const js = path.join(root, '_astro', 'app.AbC123.js');
  assert.deepEqual(brotliDecompressSync(await readFile(js + '.br')), await readFile(js));
  assert.ok(existsSync(js + '.gz'));
  assert.ok(existsSync(path.join(root, 'st.html.br')));
  assert.ok(!existsSync(path.join(root, 'tiny.js.br')), 'too small to bother');
  assert.ok(!existsSync(path.join(root, 'logo.webp.br')), 'images are compressed already');
});

test('The server sends those copies instead of compressing each response', async () => {
  const root = await client();
  precompress(root);
  const app = await buildApp({
    access: null,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
    site: {
      clientRoot: root,
      handler: (_req, _res, next) => next(),
      paths: deployPaths('test-key'),
    },
  });
  const url = '/_astro/app.AbC123.js';
  const br = await app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(br.statusCode, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(String(br.headers['content-type']), /javascript/);
  assert.equal(br.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(br.rawPayload, await readFile(path.join(root, '_astro', 'app.AbC123.js.br')));
  const gz = await app.inject({ url, headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  const plain = await app.inject({ url });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.body, 'console.log("hello");\n'.repeat(500));
  // A page at its clean URL gets its copy too, and keeps a page's cache rule.
  const page = await app.inject({ url: '/st', headers: { 'accept-encoding': 'br' } });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['content-encoding'], 'br');
  assert.match(String(page.headers['content-type']), /html/);
  assert.equal(page.headers['cache-control'], 'no-cache, no-store, must-revalidate');
  await app.close();
});
