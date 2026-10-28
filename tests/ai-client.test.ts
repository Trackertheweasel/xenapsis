import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  LIMITS,
  contextLabel,
  historyFor,
  modelLabel,
  readEvents,
  splitCode,
  type StoredMessage,
} from '../src/utils/ai.ts';
import { loadAiConfig } from '../serverlib/ai/index.ts';

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

test("The page's limits match the server's", () => {
  const { limits } = loadAiConfig({});
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    assert.equal(LIMITS[key], limits[key], key);
  }
});

test('The page reads the server’s events, however the chunks fall', async () => {
  const seen: [string, unknown][] = [];
  await readEvents(
    streamOf(
      'event: meta\ndata: {"model":"a/b"}\n\n: ping\n\nevent: tok',
      'en\ndata: {"text":"Hi"}\n\nevent: token\ndata: {"text":" you"}\r\n\r\n',
      'event: done\ndata: {"finishReason":"stop","model":"a/b"}\n\n',
    ),
    (event, data) => seen.push([event, data]),
  );
  assert.deepEqual(seen, [
    ['meta', { model: 'a/b' }],
    ['token', { text: 'Hi' }],
    ['token', { text: ' you' }],
    ['done', { finishReason: 'stop', model: 'a/b' }],
  ]);
});

test('History sent upstream skips failed replies, ends with you, and is trimmed to fit', () => {
  const msgs: StoredMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: '', error: 'failed' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'partial', stopped: true },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: '' },
  ];
  assert.deepEqual(historyFor(msgs), [
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'partial' },
    { role: 'user', content: 'three' },
  ]);
  const long = Array.from({ length: 150 }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: 'x'.repeat(2000),
  }));
  long.push({ role: 'user', content: 'last' });
  const trimmed = historyFor(long, 100);
  assert.ok(trimmed.length <= LIMITS.maxMessages);
  assert.ok(trimmed.reduce((n, m) => n + m.content.length, 100) <= LIMITS.maxTotalChars);
  assert.equal(trimmed[0].role, 'user');
  assert.deepEqual(trimmed.at(-1), { role: 'user', content: 'last' });
});

test('Code blocks are split out of replies', () => {
  assert.deepEqual(splitCode('Try:\n```js\nconsole.log(1)\n```\nDone'), [
    { code: false, text: 'Try:\n' },
    { code: true, text: 'console.log(1)', lang: 'js' },
    { code: false, text: '\nDone' },
  ]);
  // Still streaming: an unclosed block is shown as code so far.
  assert.deepEqual(splitCode('```\nhalf'), [{ code: true, text: 'half', lang: undefined }]);
  assert.deepEqual(splitCode('<img src=x onerror=alert(1)>'), [
    { code: false, text: '<img src=x onerror=alert(1)>' },
  ]);
});

test('Model labels show name, provider and context', () => {
  assert.equal(contextLabel(131072), '131K');
  assert.equal(contextLabel(1_048_576), '1M');
  assert.equal(contextLabel(null), '');
  assert.equal(
    modelLabel({
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      provider: 'OpenAI',
      contextLength: 128000,
      free: false,
    }),
    'GPT-4o · OpenAI · 128K context',
  );
});

test('The AI page renders replies as text and keeps the key and OpenRouter out of the browser', async () => {
  const script = await readFile(new URL('../src/utils/aichat.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/pages/ai.astro', import.meta.url), 'utf8');
  for (const src of [script, page]) {
    assert.doesNotMatch(src, /openrouter\.ai|OPENROUTER_API_KEY|Authorization|localStorage\.\w/);
  }
  // Only the dots placeholder is ever written as HTML; messages use textContent.
  assert.deepEqual(
    [...script.matchAll(/innerHTML\s*=\s*(.+);/g)].map(m => m[1]),
    ['\'<span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span>\''],
  );
  assert.match(page, /go from this server to OpenRouter/);
  assert.match(page, /not end-to-end encrypted/);
});
