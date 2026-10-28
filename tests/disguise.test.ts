import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { disguiseBuild, maskHtml, SCRUB_WORDS, scrubText, scrubTokens } from '../build/disguise.ts';
import { disguiseSettings } from '../serverlib/env.ts';

test('Scrub tokens are the same length as their words, unique, and new to the build', () => {
  const corpus = 'const scramjet = 1; // aaaa';
  const tokens = scrubTokens('seed', corpus);
  const all = Object.values(tokens);
  assert.equal(new Set(all).size, SCRUB_WORDS.length);
  for (const word of SCRUB_WORDS) {
    const t = tokens[word];
    assert.equal(t.length, word.length, word);
    assert.ok(!corpus.toLowerCase().includes(t), word);
    assert.ok(!SCRUB_WORDS.some(w => t.includes(w)), word);
  }
  assert.match(tokens.__uv, /^__[a-z][a-z0-9]$/);
  assert.deepEqual(scrubTokens('seed', corpus), tokens, 'same seed, same tokens');
  assert.notDeepEqual(scrubTokens('other', corpus), tokens);
});

test('Scrubbing renames every tell, keeps case, and leaves web addresses and the cookie database', () => {
  const tokens = scrubTokens('seed', '');
  const src = [
    'self.__uv$config={};globalThis.$scramjetLoadController=()=>new ScramjetController;',
    'new BroadcastChannel("bare-mux");e.bareClient=new BareClient;libcurl.load();',
    'indexedDB.open("$scramjet");const re={$scramjet:["cookies"]};',
    '<a href="https://github.com/MercuryWorkshop/scramjet">Ultraviolet SCRAMJET</a> barely',
    't.barews.send();e.bare.createWebSocket();',
  ].join('\n');
  const out = scrubText(src, tokens);
  assert.equal(out.length, src.length);
  const left = out.replace(/https?:\/\/\S+?"/g, '').replace(/\$scramjet(?![\w$])/g, '');
  assert.doesNotMatch(left, /scram|ultraviolet|bare-?mux|libcurl|__uv|(?<![A-Za-z])bare(?!ly)/i);
  assert.ok(out.includes('indexedDB.open("$scramjet")'));
  assert.ok(out.includes('{$scramjet:["cookies"]}'));
  assert.ok(out.includes('https://github.com/MercuryWorkshop/scramjet'));
  assert.ok(out.includes(' barely'), 'ordinary words starting with "bare" are kept');
  const sc = tokens.scramjet;
  assert.ok(out.includes(`$${sc}LoadController`));
  assert.ok(out.includes(`${sc[0].toUpperCase()}${sc.slice(1)}Controller`));
  assert.ok(out.includes(sc.toUpperCase()));
});

test('Masking adds soft hyphens to page text only', () => {
  const html =
    '<title>Unblocked Games</title><a href="/proxy" data-x="games">Proxy</a>' +
    '<script>const proxy="games"</script><style>.game{}</style><!-- proxy --><p>VPN, bypass. Persec</p>';
  const out = maskHtml(html);
  assert.equal(out.replaceAll('­', ''), html, 'only soft hyphens are added');
  assert.ok(out.includes('<a href="/proxy" data-x="games">'));
  assert.ok(
    out.includes('<script>const proxy="games"</script><style>.game{}</style><!-- proxy -->'),
  );
  for (const word of ['Unblocked', 'Games', 'Proxy', 'VPN', 'bypass']) {
    assert.ok(!out.includes(`>${word}`) && !out.includes(` ${word}`), word);
  }
  assert.ok(out.includes('Persec'));
});

test('A build is scrubbed, its cached Astro files renamed everywhere, and its .wasm kept valid', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'persec-disguise-'));
  try {
    const client = path.join(root, 'client');
    const server = path.join(root, 'server');
    await mkdir(path.join(client, '_astro'), { recursive: true });
    await mkdir(path.join(client, 'rt'), { recursive: true });
    await mkdir(server);
    await writeFile(
      path.join(client, '_astro', 'pro.AbC123.js'),
      'import "./transport.XyZ789.js";$scramjetLoadController()',
    );
    await writeFile(path.join(client, '_astro', 'transport.XyZ789.js'), 'new BareMuxConnection');
    await writeFile(path.join(client, '_astro', 'font.Qq11.woff2'), Buffer.from([0, 1, 2]));
    await writeFile(
      path.join(client, 'index.html'),
      '<link href="/_astro/font.Qq11.woff2"><script src="/_astro/pro.AbC123.js"></script><p>Proxy</p>',
    );
    await writeFile(path.join(client, 'rt', 'a.js'), 'globalThis.$scramjetLoadController=1');
    // A minimal valid module whose custom section is named "scramjet".
    const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 9, 8, ...Buffer.from('scramjet')]);
    assert.ok(WebAssembly.validate(wasm));
    await writeFile(path.join(client, 'rt', 'b.wasm'), wasm);
    await writeFile(path.join(server, 'manifest.mjs'), 'const a="/_astro/pro.AbC123.js"');

    disguiseBuild({ client, server, scrub: true, seed: 'seed', mask: true });

    const names = await readdir(path.join(client, '_astro'));
    assert.equal(names.length, 3);
    assert.ok(
      !names.some(n => ['pro.AbC123.js', 'transport.XyZ789.js', 'font.Qq11.woff2'].includes(n)),
    );
    const pro = names.find(n => n.startsWith('pro.'))!;
    const transport = names.find(n => n.startsWith('transport.'))!;
    const font = names.find(n => n.startsWith('font.'))!;
    const html = await readFile(path.join(client, 'index.html'), 'utf8');
    assert.ok(html.includes(`/_astro/${pro}`) && html.includes(`/_astro/${font}`));
    assert.ok(html.includes('P­rox­y'), 'masked');
    const proSrc = await readFile(path.join(client, '_astro', pro), 'utf8');
    assert.ok(proSrc.includes(`./${transport}`));
    assert.doesNotMatch(proSrc, /scramjet/i);
    assert.equal(
      await readFile(path.join(server, 'manifest.mjs'), 'utf8'),
      `const a="/_astro/${pro}"`,
    );
    const rt = await readFile(path.join(client, 'rt', 'a.js'), 'utf8');
    assert.equal(rt, `globalThis.${proSrc.slice(proSrc.indexOf(';') + 1).replace('()', '')}=1`);
    const scrubbedWasm = await readFile(path.join(client, 'rt', 'b.wasm'));
    assert.equal(scrubbedWasm.length, wasm.length);
    assert.ok(WebAssembly.validate(scrubbedWasm));
    assert.ok(!scrubbedWasm.includes('scramjet'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('The scrub is on unless turned off; masking is opt-in; a proxy key fixes the names', () => {
  assert.deepEqual({ ...disguiseSettings({}), seed: '' }, { scrub: true, mask: false, seed: '' });
  assert.equal(disguiseSettings({ PUBLIC_PERSEC_SCRUB: 'off' }).scrub, false);
  assert.equal(disguiseSettings({ PUBLIC_PERSEC_MASK_TEXT: '1' }).mask, true);
  assert.notEqual(disguiseSettings({}).seed, disguiseSettings({}).seed);
  const keyed = disguiseSettings({ PUBLIC_PERSEC_PROXY_KEY: 'k' }).seed;
  assert.equal(disguiseSettings({ PUBLIC_PERSEC_PROXY_KEY: 'k' }).seed, keyed);
  assert.notEqual(keyed, 'k', 'derived, not the key itself');
});

test('Saved-login backups from before the scrub still restore their Scramjet cookies', async () => {
  const { seal, unseal } = await import('../src/utils/loginsync.ts');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const legacy = { scramjet: { 'example.com': 1 }, uv: [], storage: {} };
  const restored = await unseal(key, await seal(key, legacy as any));
  assert.deepEqual(restored?.sc, { 'example.com': 1 });
  const current = await unseal(key, await seal(key, { sc: { a: 2 }, uv: [], storage: {} }));
  assert.deepEqual(current?.sc, { a: 2 });
});

test('Engine names shown to people are written so the scrub leaves them readable', async () => {
  const tokens = scrubTokens('seed', '');
  const st = await readFile(new URL('../src/pages/st.astro', import.meta.url), 'utf8');
  const nav = await readFile(new URL('../src/utils/navigation.ts', import.meta.url), 'utf8');
  const labels = [
    ...st
      .matchAll(/font-medium">((?:Scr|Ult)[^<]*)</g)
      .map(m => m[1].replaceAll('&shy;', '\u00ad')),
    ...nav.matchAll(/'((?:Scr|Ult)[^']*)'/g).map(m => m[1].replaceAll('\\u00ad', '\u00ad')),
  ];
  assert.equal(labels.length, 4);
  for (const label of labels) {
    assert.match(label.replaceAll('\u00ad', ''), /^(Scramjet|Ultraviolet)$/);
    assert.equal(scrubText(label, tokens), label);
  }
});
