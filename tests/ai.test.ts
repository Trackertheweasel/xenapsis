import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { createToken, loadAccess } from '../serverlib/access.ts';
import { buildApp } from '../serverlib/app.ts';
import { loadAiConfig } from '../serverlib/ai/index.ts';
import type { AiConfig } from '../serverlib/ai/index.ts';
import {
  createOpenRouter,
  OPENROUTER_BASE_URL,
  SseLineReader,
} from '../serverlib/ai/openrouter.ts';
import { isModelId } from '../serverlib/ai/validate.ts';

// PerSec AI against a stand-in OpenRouter on localhost. No real key or network is needed.
const KEY = 'sk-or-v1-test-secret-key-0123456789';

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  closed: Promise<void>;
}

const seen: Seen[] = [];
let handler: Handler = (_req, _body, res) => res.writeHead(500).end();
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    const closed = new Promise<void>(resolve => res.on('close', () => resolve()));
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body, closed });
    handler(req, body, res);
  });
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api/v1`;
after(() => {
  upstream.closeAllConnections();
  upstream.close();
});
beforeEach(() => {
  seen.length = 0;
});

const MODELS = {
  data: [
    {
      id: 'meta-llama/llama-3.3-70b-instruct:free',
      name: 'Meta: Llama 3.3 70B Instruct (free)',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      context_length: 128000,
      pricing: { prompt: '0.0000025', completion: '0.00001' },
      architecture: { output_modalities: ['text'] },
    },
    {
      id: 'openrouter/free',
      name: 'Free Models Router',
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'some/image-model',
      name: 'Some: Image only',
      architecture: { output_modalities: ['image'] },
    },
    { id: 'https://evil.example/x', name: 'Not an ID' },
  ],
};

const json = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const chunk = (content: string, extra: object = {}) =>
  `data: ${JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct:free', choices: [{ delta: { content }, ...extra }] })}\n\n`;

// Serves the model list, and chat replies from `chat`.
function serve(chat: Handler) {
  handler = (req, body, res) => {
    if (req.url === '/api/v1/models') return json(res, 200, MODELS);
    if (req.url === '/api/v1/chat/completions') return chat(req, body, res);
    res.writeHead(404).end();
  };
}

const okChat: Handler = (_req, body, res) => {
  if (JSON.parse(body).stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    res.write(chunk('Hello'));
    res.write('data: {not json\n\n');
    res.write(chunk(' there'));
    res.write(chunk('', { finish_reason: 'stop' }));
    res.end('data: [DONE]\n\n');
  } else {
    json(res, 200, {
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      choices: [{ message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' }],
    });
  }
};

const inviteEnv = { PERSEC_INVITE_CODES: 'alice:abc123, bob:xyz789', PERSEC_SECRET: 'test-secret' };
const access = loadAccess(inviteEnv)!;
const alice = { cookie: `persec_access=${createToken(access, 'alice')}` };
const bob = { cookie: `persec_access=${createToken(access, 'bob')}` };

async function server(
  env: Record<string, string> = { OPENROUTER_API_KEY: KEY, OPENROUTER_ALLOWED_MODELS: 'all' },
  { invite = true, tweak }: { invite?: boolean; tweak?: (c: AiConfig) => void } = {},
) {
  const config = loadAiConfig(env);
  tweak?.(config);
  return buildApp({
    access: invite ? loadAccess(inviteEnv) : null,
    wispPath: '/w/',
    loginsDir: await mkdtemp(path.join(tmpdir(), 'persec-logins-')),
    ai: {
      config,
      provider: config.apiKey
        ? createOpenRouter({
            apiKey: config.apiKey,
            timeouts: config.timeouts,
            maxOutputTokens: config.maxOutputTokens,
            baseUrl: upstreamUrl,
          })
        : undefined,
    },
  });
}

type App = Awaited<ReturnType<typeof server>>;
const chat = (app: App, payload: unknown, headers: Record<string, string> = alice) =>
  app.inject({ method: 'POST', url: '/api/ai/chat', headers, payload: payload as any });
const hello = (extra: object = {}) => ({
  messages: [{ role: 'user', content: 'Hello' }],
  ...extra,
});

// Every server-sent event in a body, in order.
const events = (body: string) =>
  body
    .split('\n\n')
    .filter(block => block.startsWith('event:'))
    .map(block => {
      const [e, d] = block.split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });

test('OpenRouter is the only upstream, at its official address', () => {
  assert.equal(OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1');
});

test('Without OPENROUTER_API_KEY, PerSec AI says it is off and the server runs normally', async () => {
  for (const invite of [true, false]) {
    const app = await server({}, { invite });
    const status = await app.inject({ url: '/api/ai/status', headers: alice });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), {
      enabled: false,
      provider: 'openrouter',
      reason: 'not_configured',
    });
    const models = await app.inject({ url: '/api/ai/models', headers: alice });
    assert.equal(models.statusCode, 503);
    assert.equal(models.json().error.code, 'not_configured');
    const res = await chat(app, hello());
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, 'not_configured');
    assert.equal((await app.inject({ url: '/healthz' })).body, 'ok');
  }
  assert.equal(seen.length, 0, 'nothing was sent upstream');
});

test('With a key, status says only that it is on and which provider', async () => {
  const app = await server();
  const res = await app.inject({ url: '/api/ai/status', headers: alice });
  assert.deepEqual(res.json(), { enabled: true, provider: 'openrouter' });
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.doesNotMatch(res.body, /sk-or|test-secret/);
});

test('Every AI route sits behind the invite gate', async () => {
  serve(okChat);
  const app = await server();
  for (const [method, url] of [
    ['GET', '/api/ai/status'],
    ['GET', '/api/ai/models'],
    ['POST', '/api/ai/chat'],
  ] as const) {
    const anon = await app.inject({
      method,
      url,
      payload: method === 'POST' ? hello() : undefined,
    });
    assert.equal(anon.statusCode, 401, `${url} without an invite`);
    const forged = await app.inject({
      method,
      url,
      headers: { cookie: 'persec_access=forged.cookie.value' },
      payload: method === 'POST' ? hello() : undefined,
    });
    assert.equal(forged.statusCode, 401, `${url} with a forged cookie`);
  }
  assert.equal(seen.length, 0, 'refused requests never reach OpenRouter');
  assert.equal((await chat(app, hello())).statusCode, 200, 'signed in, it works');
});

test('On a server with no invite codes, PerSec AI stays off unless the owner opts in', async () => {
  serve(okChat);
  const open = await server(undefined, { invite: false });
  assert.deepEqual((await open.inject({ url: '/api/ai/status' })).json(), {
    enabled: false,
    provider: 'openrouter',
    reason: 'unavailable_open_mode',
  });
  assert.equal((await chat(open, hello(), {})).statusCode, 503);
  assert.equal(seen.length, 0);

  const optedIn = await server(
    { OPENROUTER_API_KEY: KEY, PERSEC_AI_ALLOW_OPEN: 'true' },
    { invite: false },
  );
  assert.equal((await optedIn.inject({ url: '/api/ai/status' })).json().enabled, true);
  assert.equal((await chat(optedIn, hello(), {})).statusCode, 200);
});

test('The model list comes from OpenRouter, normalized, with the free router first, and is cached', async () => {
  serve(okChat);
  const app = await server();
  const res = await app.inject({ url: '/api/ai/models', headers: alice });
  assert.equal(res.statusCode, 200);
  const { default: def, models } = res.json();
  assert.equal(def, 'openrouter/free');
  assert.deepEqual(
    models.map((m: any) => m.id),
    ['openrouter/free', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-4o'],
    'image-only models and malformed IDs are left out',
  );
  assert.deepEqual(models[0], {
    id: 'openrouter/free',
    name: 'OpenRouter Free',
    provider: 'OpenRouter',
    contextLength: null,
    free: true,
  });
  assert.deepEqual(models[1], {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    name: 'Llama 3.3 70B Instruct (free)',
    provider: 'Meta',
    contextLength: 131072,
    free: true,
  });
  assert.equal(models[2].free, false);
  assert.equal(models[2].provider, 'OpenAI');

  await app.inject({ url: '/api/ai/models', headers: alice });
  assert.equal(seen.filter(s => s.url.endsWith('/models')).length, 1, 'fetched once, then cached');
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
});

// What a server offering only free models shows and accepts.
async function onlyFree(env: Record<string, string>) {
  serve(okChat);
  const app = await server(env);
  const ids = (await app.inject({ url: '/api/ai/models', headers: alice }))
    .json()
    .models.map((m: any) => m.id);
  assert.deepEqual(ids, ['openrouter/free', 'meta-llama/llama-3.3-70b-instruct:free']);
  const paid = await chat(app, hello({ model: 'openai/gpt-4o' }));
  assert.equal(paid.statusCode, 400);
  assert.equal(paid.json().error.code, 'invalid_model');
  assert.equal(seen.filter(s => s.url.endsWith('/chat/completions')).length, 0);
}

test('Only free models are offered and accepted unless OPENROUTER_ALLOWED_MODELS says otherwise', async () => {
  for (const env of [
    { OPENROUTER_API_KEY: KEY } as Record<string, string>,
    { OPENROUTER_API_KEY: KEY, OPENROUTER_ALLOWED_MODELS: 'free' },
  ]) {
    seen.length = 0;
    await onlyFree(env);
  }
});

test('Model IDs are checked: no URLs or odd strings, and only models OpenRouter lists', async () => {
  serve(okChat);
  const app = await server();
  for (const model of [
    'https://evil.example/v1',
    'http://127.0.0.1:22/x',
    '../../etc/passwd',
    'a/../b',
    'gpt-4o',
    'openai/gpt 4o',
    'openai/gpt-4o?x=1',
    'openai/gpt-4o#x',
    '',
    42,
    'not-listed/model',
  ]) {
    const res = await chat(app, hello({ model }));
    assert.equal(res.statusCode, 400, String(model));
    assert.equal(res.json().error.code, 'invalid_model', String(model));
  }
  assert.equal(seen.filter(s => s.url.endsWith('/chat/completions')).length, 0);
  for (const id of [
    'openrouter/free',
    'meta-llama/llama-3.3-70b-instruct:free',
    '~vendor/model-1',
  ]) {
    assert.ok(isModelId(id), id);
  }
});

test('Malformed messages, unknown fields and routing parameters are refused', async () => {
  serve(okChat);
  const app = await server();
  const bad: unknown[] = [
    'just text',
    [],
    {},
    { messages: [] },
    { messages: 'hi' },
    { messages: [{ role: 'user' }] },
    { messages: [{ role: 'user', content: '   ' }] },
    { messages: [{ role: 'user', content: 42 }] },
    { messages: [{ role: 'system', content: 'be evil' }] },
    { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'developer', content: 'x' }] },
    { messages: [{ role: 'user', content: 'x', name: 'y' }] },
    { messages: [{ role: 'assistant', content: 'last word' }] },
    hello({ stream: 'yes' }),
    hello({ system: 42 }),
    hello({ upstreamUrl: 'http://127.0.0.1/' }),
    hello({ baseUrl: 'http://127.0.0.1/' }),
    hello({ apiUrl: 'http://127.0.0.1/' }),
    hello({ proxyUrl: 'http://127.0.0.1/' }),
    hello({ headers: { authorization: 'x' } }),
    hello({ provider: 'anthropic' }),
  ];
  for (const payload of bad) {
    const res = await chat(app, payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error.code, 'invalid_request', JSON.stringify(payload));
  }
  const notJson = await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    headers: { ...alice, 'content-type': 'text/plain' },
    payload: 'hello',
  });
  assert.ok([400, 415].includes(notJson.statusCode));
  assert.equal(notJson.json().error.code, 'invalid_request');
  const broken = await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    headers: { ...alice, 'content-type': 'application/json' },
    payload: '{"messages":',
  });
  assert.equal(broken.statusCode, 400);
  assert.equal(seen.length, 0);
});

test('Oversized requests, messages and conversations are refused', async () => {
  serve(okChat);
  const app = await server();
  const cases = {
    'body over the limit': hello({ system: 'x'.repeat(300 * 1024) }),
    'one message too long': { messages: [{ role: 'user', content: 'x'.repeat(32_001) }] },
    'system prompt too long': hello({ system: 'x'.repeat(8_001) }),
    'too many messages': {
      messages: Array.from({ length: 101 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'hi',
      })),
    },
    'conversation too long': {
      messages: Array.from({ length: 5 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: 'x'.repeat(30_000),
      })),
    },
  };
  for (const [why, payload] of Object.entries(cases)) {
    const res = await chat(app, payload);
    assert.equal(res.statusCode, 413, why);
    assert.equal(res.json().error.code, 'payload_too_large', why);
  }
  assert.equal(seen.length, 0);
});

test('AI requests are rate limited per person', async () => {
  serve(okChat);
  const app = await server({
    OPENROUTER_API_KEY: KEY,
    AI_RATE_LIMIT_MAX_REQUESTS: '2',
    AI_RATE_LIMIT_WINDOW_MS: '60000',
  });
  assert.equal((await chat(app, hello())).statusCode, 200);
  assert.equal((await chat(app, hello())).statusCode, 200);
  const limited = await chat(app, hello());
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await chat(app, hello(), bob)).statusCode, 200, 'bob has his own allowance');
  assert.equal(seen.filter(s => s.url.endsWith('/chat/completions')).length, 3);
});

test('A refused model does not use up the rate limit', async () => {
  serve(okChat);
  const app = await server({
    OPENROUTER_API_KEY: KEY,
    AI_RATE_LIMIT_MAX_REQUESTS: '1',
    AI_RATE_LIMIT_WINDOW_MS: '60000',
  });
  for (let i = 0; i < 3; i++) {
    const res = await chat(app, hello({ model: 'openai/gpt-4o' }));
    assert.equal(res.json().error.code, 'invalid_model');
  }
  assert.equal((await chat(app, hello())).statusCode, 200);
});

test('On an open server, the limit is per visitor address from PERSEC_CLIENT_IP_HEADER', async () => {
  serve(okChat);
  const app = await server(
    {
      OPENROUTER_API_KEY: KEY,
      PERSEC_AI_ALLOW_OPEN: 'true',
      PERSEC_CLIENT_IP_HEADER: 'CF-Connecting-IP',
      AI_RATE_LIMIT_MAX_REQUESTS: '1',
    },
    { invite: false },
  );
  const from = (ip: string) => ({ 'cf-connecting-ip': ip });
  assert.equal((await chat(app, hello(), from('203.0.113.1'))).statusCode, 200);
  assert.equal((await chat(app, hello(), from('203.0.113.1'))).statusCode, 429);
  assert.equal((await chat(app, hello(), from('203.0.113.2'))).statusCode, 200, 'another visitor');
});

test('The OpenRouter request carries the model, system prompt and history, and nothing from the browser', async () => {
  serve(okChat);
  const app = await server({
    OPENROUTER_API_KEY: KEY,
    OPENROUTER_ALLOWED_MODELS: 'all',
    OPENROUTER_MAX_TOKENS: '512',
  });
  const res = await chat(
    app,
    {
      model: 'openai/gpt-4o',
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ],
    },
    { ...alice, 'x-forwarded-for': '1.2.3.4', 'x-custom': 'leak', authorization: 'Bearer user' },
  );
  assert.equal(res.statusCode, 200);
  const sent = seen.find(s => s.url.endsWith('/chat/completions'))!;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/api/v1/chat/completions');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.headers['content-type'], 'application/json');
  for (const h of ['cookie', 'x-forwarded-for', 'x-custom', 'referer', 'http-referer']) {
    assert.equal(sent.headers[h], undefined, `${h} is not forwarded`);
  }
  assert.deepEqual(JSON.parse(sent.body), {
    model: 'openai/gpt-4o',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
    ],
    stream: false,
    max_tokens: 512,
  });
});

test('A normal reply comes back as JSON, using the default model when none is chosen', async () => {
  serve(okChat);
  const app = await server();
  const res = await chat(app, hello());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    message: { role: 'assistant', content: 'Hi!' },
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    finishReason: 'stop',
  });
  assert.equal(res.headers['cache-control'], 'no-store');
  const sent = JSON.parse(seen.find(s => s.url.endsWith('/chat/completions'))!.body);
  assert.equal(sent.model, 'openrouter/free');
  assert.equal(sent.max_tokens, undefined);
});

test('A streamed reply is normalized into token, meta and done events', async () => {
  serve(okChat);
  const app = await server();
  const res = await chat(app, hello({ stream: true }));
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/event-stream/);
  assert.equal(res.headers['cache-control'], 'no-store, no-transform');
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin', 'helmet headers kept');
  assert.deepEqual(events(res.body), [
    { event: 'meta', data: { model: 'meta-llama/llama-3.3-70b-instruct:free' } },
    { event: 'token', data: { text: 'Hello' } },
    { event: 'token', data: { text: ' there' } },
    {
      event: 'done',
      data: { finishReason: 'stop', model: 'meta-llama/llama-3.3-70b-instruct:free' },
    },
  ]);
  assert.equal(JSON.parse(seen.find(s => s.url.endsWith('/chat/completions'))!.body).stream, true);
});

test('The stream parser copes with lines split across chunks and CRLF', () => {
  const r = new SseLineReader();
  const enc = new TextEncoder();
  assert.deepEqual(r.push(enc.encode('data: {"a"')), []);
  assert.deepEqual(r.push(enc.encode(':1}\r\n: comment\r\n\r\ndata: [DO')), ['{"a":1}']);
  assert.deepEqual(r.push(enc.encode('NE]\n')), ['[DONE]']);
  assert.deepEqual(r.flush(), []);
});

test('Upstream failures become clear errors that expose nothing from OpenRouter', async () => {
  const leak = `upstream internals ${KEY} at /srv/openrouter/handler.ts:42`;
  const cases: [number, object, number, string][] = [
    [401, { error: { code: 401, message: leak } }, 502, 'upstream_auth'],
    [402, { error: { code: 402, message: leak } }, 502, 'upstream_credits'],
    [403, { error: { code: 403, message: leak } }, 400, 'upstream_rejected'],
    [429, { error: { code: 429, message: leak } }, 429, 'upstream_rate_limited'],
    [400, { error: { code: 400, message: 'x/y is not a valid model ID' } }, 400, 'invalid_model'],
    [500, { error: { code: 500, message: leak } }, 502, 'upstream_unavailable'],
    [503, { error: { code: 503, message: leak } }, 502, 'upstream_unavailable'],
  ];
  const warn = test.mock.method(console, 'warn', () => {});
  try {
    for (const [status, body, expected, code] of cases) {
      serve((_req, _body, res) => json(res, status, body));
      const app = await server();
      for (const stream of [false, true]) {
        const res = await chat(app, hello({ stream }));
        assert.equal(res.statusCode, expected, `${status} stream=${stream}`);
        assert.equal(res.json().error.code, code, `${status} stream=${stream}`);
        assert.doesNotMatch(res.body, /sk-or|internals|handler\.ts/);
      }
    }
    // A 200 that isn't the reply it should be.
    serve((_req, _body, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end('<html>'),
    );
    const app = await server();
    assert.equal((await chat(app, hello())).json().error.code, 'malformed_response');
    serve((_req, _body, res) => json(res, 200, { choices: [] }));
    assert.equal((await chat(await server(), hello())).json().error.code, 'malformed_response');
    // OpenRouter is unreachable.
    serve((req, _body, res) => {
      if (req.url!.endsWith('/models')) return json(res, 200, MODELS);
      req.socket.destroy();
    });
    const down = await chat(await server(), hello());
    assert.equal(down.statusCode, 502);
    assert.equal(down.json().error.code, 'upstream_unavailable');
    for (const call of warn.mock.calls) {
      assert.doesNotMatch(
        call.arguments.join(' '),
        /sk-or|Hello|internals/,
        'logs hold codes only',
      );
    }
  } finally {
    warn.mock.restore();
  }
});

test('Errors part way through a stream arrive as an error event after what was already sent', async () => {
  serve((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('Partial'));
    res.end(
      `data: ${JSON.stringify({ error: { code: 502, message: `boom ${KEY}` }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] })}\n\n`,
    );
  });
  const warn = test.mock.method(console, 'warn', () => {});
  try {
    const res = await chat(await server(), hello({ stream: true }));
    const evs = events(res.body);
    assert.deepEqual(evs.slice(0, 2), [
      { event: 'meta', data: { model: 'meta-llama/llama-3.3-70b-instruct:free' } },
      { event: 'token', data: { text: 'Partial' } },
    ]);
    assert.equal(evs[2].event, 'error');
    assert.equal(evs[2].data.code, 'upstream_unavailable');
    assert.doesNotMatch(res.body, /sk-or|boom/);

    // The connection drops with no [DONE] and no finish reason.
    serve((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk('Half'));
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const cut = events((await chat(await server(), hello({ stream: true }))).body);
    assert.deepEqual(cut.at(-2), { event: 'token', data: { text: 'Half' } });
    assert.deepEqual(cut.at(-1)!.data.code, 'stream_interrupted');
  } finally {
    warn.mock.restore();
  }
});

test('A model that never answers times out', async () => {
  serve(() => {}); // Accepts the request and says nothing.
  const app = await server(undefined, { tweak: c => (c.timeouts.headersMs = 200) });
  const started = Date.now();
  const res = await chat(app, hello());
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error.code, 'upstream_timeout');
  assert.ok(Date.now() - started < 5000);
  assert.equal((await chat(app, hello({ stream: true }))).json().error.code, 'upstream_timeout');

  // Starts streaming, then goes quiet.
  serve((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('Thinking'));
  });
  const idle = await server(undefined, { tweak: c => (c.timeouts.idleMs = 200) });
  const evs = events((await chat(idle, hello({ stream: true }))).body);
  assert.deepEqual(evs.at(-1), {
    event: 'error',
    data: { code: 'upstream_timeout', message: 'The model took too long to answer.' },
  });
  await Promise.race([
    Promise.all(seen.map(s => s.closed)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream left open')), 2000)),
  ]);
});

test('Closing the reply (Stop, or leaving the page) cancels the OpenRouter request', async () => {
  serve((_req, _body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk('First'));
    // Then keeps generating slowly, as a long reply would.
    const timer = setInterval(() => res.write(chunk(' more')), 50);
    res.on('close', () => clearInterval(timer));
  });
  const app = await server();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  try {
    const firstToken = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/ai/chat',
          headers: { ...alice, 'content-type': 'application/json' },
        },
        res => {
          res.once('data', d => {
            req.destroy(); // The browser goes away.
            resolve(String(d));
          });
        },
      );
      req.on('error', () => {});
      req.end(JSON.stringify(hello({ stream: true })));
      setTimeout(() => reject(new Error('no reply')), 3000);
    });
    assert.match(firstToken, /event: (meta|token)/);
    const upstreamReq = seen.find(s => s.url.endsWith('/chat/completions'))!;
    await Promise.race([
      upstreamReq.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('not cancelled')), 2000)),
    ]);

    // The slot it held is free again, so the same person can go on chatting.
    serve(okChat);
    const again = await chat(app, hello(), alice);
    assert.notEqual(again.json()?.error?.code, 'too_many_streams');
  } finally {
    await app.close();
  }
});

test('The OpenRouter key never appears in a response', async () => {
  serve(okChat);
  const app = await server();
  const bodies = await Promise.all([
    app.inject({ url: '/api/ai/status', headers: alice }),
    app.inject({ url: '/api/ai/models', headers: alice }),
    chat(app, hello()),
    chat(app, hello({ stream: true })),
    chat(app, { bogus: true }),
  ]);
  for (const res of bodies) {
    assert.ok(!res.body.includes(KEY));
    assert.ok(!JSON.stringify(res.headers).includes(KEY));
  }
});
