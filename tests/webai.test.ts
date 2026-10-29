import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BROWSER_SITES } from '../serverlib/browser/sites.ts';
import { internalName, internalPath } from '../src/utils/routes.ts';
import {
  WEB_AI_SITES,
  browserModeOn,
  describeState,
  errorMessage,
  siteForUrl,
} from '../src/utils/webai.ts';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ChatGPT preset is the public ChatGPT website', () => {
  const chatgpt = WEB_AI_SITES.find(s => s.id === 'chatgpt')!;
  assert.equal(chatgpt.name, 'ChatGPT');
  assert.equal(chatgpt.url, 'https://chatgpt.com/');
});

test('Claude preset is the public Claude website', () => {
  const claude = WEB_AI_SITES.find(s => s.id === 'claude')!;
  assert.equal(claude.name, 'Claude');
  assert.equal(claude.url, 'https://claude.ai/');
});

test('Presets are home pages over HTTPS, never API endpoints', () => {
  for (const s of WEB_AI_SITES) {
    const u = new URL(s.url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.pathname, '/');
    assert.equal(u.search, '');
    assert.doesNotMatch(u.host, /^api\.|openrouter/);
  }
});

test("The page's sites and the server's browser-mode sites are the same two", () => {
  assert.deepEqual(
    WEB_AI_SITES.map(s => [s.id, s.url]),
    BROWSER_SITES.map(s => [s.id, s.start]),
  );
});

test('The Apps list opens the same public sites', async () => {
  const { aps } = JSON.parse(await read('public/a/json/lists.json'));
  for (const site of WEB_AI_SITES) {
    const app = aps.find((a: { name: string }) => a.name === site.name);
    assert.ok(app, site.name);
    assert.equal(new URL(app.url).host, new URL(site.url).host);
  }
});

test('Web AI has its own persec:// page, apart from PerSec AI', () => {
  assert.equal(internalPath('persec://webai'), '/webai');
  assert.equal(internalName('/webai'), 'persec://webai');
  assert.equal(internalPath('persec://ai'), '/ai', 'PerSec AI is untouched');
});

test('The Web AI page never calls PerSec AI or OpenRouter', async () => {
  for (const file of ['src/utils/webai.ts', 'src/utils/webaipage.ts', 'src/pages/webai.astro']) {
    const src = await read(file);
    assert.doesNotMatch(src, /\/api\/ai\//, file);
    assert.doesNotMatch(src, /openrouter\.ai/i, file);
  }
  // And PerSec AI's server code knows nothing of the browser runtime.
  for (const file of [
    'serverlib/routes/ai.ts',
    'serverlib/ai/index.ts',
    'serverlib/ai/openrouter.ts',
  ]) {
    assert.doesNotMatch(await read(file), /browser\/|camoufox/i, file);
  }
});

test('Browser mode is offered only on a clear yes from the server', () => {
  assert.equal(browserModeOn({ enabled: true }), true);
  for (const v of [
    null,
    undefined,
    {},
    { enabled: 'true' },
    { enabled: false, reason: 'disabled' },
    'yes',
  ]) {
    assert.equal(browserModeOn(v), false, JSON.stringify(v));
  }
});

test('A bot check is described plainly, with what to do instead', () => {
  const msg = describeState('Claude', {
    url: 'https://claude.ai/login',
    title: 'Just a moment...',
    blocked: true,
  });
  assert.match(msg, /checking or refusing/);
  assert.match(msg, /doesn’t try to get past/);
  assert.equal(
    describeState('ChatGPT', { url: 'https://chatgpt.com/c/1', title: 'ChatGPT', blocked: false }),
    'ChatGPT — chatgpt.com/c/1',
  );
  assert.match(describeState('ChatGPT', null), /didn’t finish loading/);
});

test('Helpers', () => {
  assert.equal(siteForUrl('https://auth.chatgpt.com/x')?.id, 'chatgpt');
  assert.equal(siteForUrl('https://claude.ai.evil.example/'), undefined);
  assert.equal(siteForUrl('nonsense'), undefined);
  assert.equal(errorMessage({ error: { message: 'Busy' } }, 'x'), 'Busy');
  assert.equal(errorMessage(null, 'fallback'), 'fallback');
});
