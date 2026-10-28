import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deployPaths } from '../serverlib/env.ts';

// Builds a real deployment with a known key, then checks what a browser would fetch from it.
const KEY = 'deploy-test-key';
const PATHS = deployPaths(KEY);
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = await mkdtemp(path.join(tmpdir(), 'persec-build-'));
after(() => rm(outDir, { recursive: true, force: true }));

process.env.PUBLIC_PERSEC_PROXY_KEY = KEY;
const { build } = await import('astro');
await build({ root, outDir, logLevel: 'error' });

const client = path.join(outDir, 'client');
const read = (url: string) => readFile(path.join(client, ...url.split('/')), 'utf8');

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else out.push('/' + path.relative(client, full).split(path.sep).join('/'));
  }
  return out;
}

// Persec's own code: the pages, their bundled scripts, the worker, the Ultraviolet config and
// robots.txt. Not the runtime's own files, which are the public packages' (see the README).
async function persecSources(): Promise<Record<string, string>> {
  const urls = (await files(client)).filter(
    u => /\.html$/.test(u) || u.startsWith('/_astro/') || u === PATHS.sw,
  );
  urls.push(PATHS.files.uvConfig, '/robots.txt');
  return Object.fromEntries(
    await Promise.all(
      urls.filter(u => !/\.(css|woff2?)$/.test(u)).map(async u => [u, await read(u)]),
    ),
  );
}

test('The build serves the runtime and the worker only from its own paths', async () => {
  for (const url of [PATHS.sw, ...Object.values(PATHS.files)]) {
    assert.ok(existsSync(path.join(client, ...url.split('/'))), url);
  }
  // Nothing at the root but pages, Astro's hashed assets, Persec's own assets and this build's paths.
  const top = (await readdir(client)).filter(
    n => !/\.html$/.test(n) && !['_astro', 'a', 'favicon.ico', 'robots.txt'].includes(n),
  );
  assert.deepEqual(top.sort(), [PATHS.runtime.slice(1, -1), PATHS.sw.slice(1)].sort());
  const runtime = await readdir(path.join(client, PATHS.runtime));
  assert.deepEqual(
    runtime.sort(),
    Object.values(PATHS.files)
      .map(f => path.basename(f))
      .sort(),
  );
});

test("The server gets the build's paths, and they are never served", async () => {
  const saved = JSON.parse(await readFile(path.join(outDir, 'server', 'paths.json'), 'utf8'));
  assert.deepEqual(saved, PATHS);
  assert.ok(!(await files(client)).some(u => u.endsWith('paths.json')));
});

test('The worker and Ultraviolet are pointed at the same paths', async () => {
  const sw = await read(PATHS.sw);
  const uv = await read(PATHS.files.uvConfig);
  for (const file of Object.values(PATHS.files)) assert.ok(sw.includes(file), `worker: ${file}`);
  for (const role of ['uvHandler', 'uvClient', 'uvBundle', 'uvConfig', 'uvSw'] as const) {
    assert.ok(uv.includes(PATHS.files[role]), `Ultraviolet config: ${role}`);
  }
  assert.ok(uv.includes(PATHS.uvPrefix));
});

// The fixed names Persec used to serve, and the packages' own file names. A filter that sees the
// URLs a page requests (a TLS-inspecting proxy, a browser extension) could match any of these.
const FINGERPRINTS = [
  /["'`(=\s]\/(bm|lc|data|tmp)\//,
  /["'`(=\s]\.?\/sw\.js/,
  /\/v1\/(data|tmp)\//,
  /\buv\.(bundle|handler|client|sw|config)\.js/,
  /\bscramjet\.(all|sync|wasm)\.(js|wasm)/,
  /\/(worker|index)\.m?js["'`]/,
];

test("Persec's pages and scripts request nothing by a fixed runtime name", async () => {
  const sources = await persecSources();
  assert.ok(Object.keys(sources).length > 10);
  for (const [url, source] of Object.entries(sources)) {
    for (const pattern of FINGERPRINTS) assert.doesNotMatch(source, pattern, url);
  }
  // ...and the client does initialize from this build's paths: worker, transport, runtime.
  const all = Object.values(sources).join('\n');
  for (const url of [
    PATHS.sw,
    PATHS.files.bareMuxWorker,
    PATHS.files.libcurl,
    PATHS.files.scramjetWasm,
  ]) {
    assert.ok(all.includes(url), url);
  }
});

test('Two deployments share no runtime path', () => {
  const other = deployPaths('another-deployment');
  const mine = [
    PATHS.scPrefix,
    PATHS.uvPrefix,
    PATHS.sw,
    PATHS.runtime,
    ...Object.values(PATHS.files),
  ];
  const theirs = [
    other.scPrefix,
    other.uvPrefix,
    other.sw,
    other.runtime,
    ...Object.values(other.files),
  ];
  assert.deepEqual(
    mine.filter(p => theirs.includes(p)),
    [],
  );
  assert.deepEqual(deployPaths(KEY), PATHS, 'the same key keeps the same paths');
});
