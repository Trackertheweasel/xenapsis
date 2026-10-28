import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { ACCESS_COOKIE, readCookie, tokenSubject } from '../access';
import type { AccessConfig } from '../access';
import { ModelCatalog } from '../ai/catalog';
import { AiError, isAiError } from '../ai/index';
import type { AiConfig, AiErrorCode, ChatProvider, StreamEvent } from '../ai/index';
import { AiLimiter } from '../ai/limiter';
import { createOpenRouter } from '../ai/openrouter';
import { parseChatBody } from '../ai/validate';

// PerSec AI's routes (see serverlib/ai/index.ts):
//
//   GET  /api/ai/status   whether it's on, and nothing else about the server
//   GET  /api/ai/models   the models people can pick
//   POST /api/ai/chat     one reply, as JSON or (with "stream": true) as server-sent events
//
// They sit behind the invite gate (routes/access.ts) like everything else. On a server with no
// invite codes, PerSec AI stays off unless the owner sets PERSEC_AI_ALLOW_OPEN, because anyone who
// found the server could otherwise spend the owner's OpenRouter allowance.

export interface AiRouteOptions {
  access: AccessConfig | null;
  config: AiConfig;
  // For tests: a provider to use instead of the real OpenRouter one.
  provider?: ChatProvider;
}

const HEARTBEAT_MS = 15_000;
// Errors worth the owner's attention in the server log. Only the code: never the conversation,
// the reply, a header or the key.
const LOGGED = new Set<AiErrorCode>([
  'upstream_auth',
  'upstream_credits',
  'upstream_unavailable',
  'malformed_response',
  'internal',
]);

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const toSse = (e: StreamEvent) =>
  e.type === 'token'
    ? sse('token', { text: e.text })
    : e.type === 'meta'
      ? sse('meta', { model: e.model })
      : sse('done', { finishReason: e.finishReason, model: e.model });

// Waits for the socket to take more when it's full, so a slow reader can't make us buffer a reply.
async function write(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  await Promise.race([once(res, 'drain'), once(res, 'close')]);
  return !res.destroyed;
}

function log(err: AiError) {
  if (LOGGED.has(err.code)) console.warn(`PerSec AI: ${err.code}`);
}

// Fastify's own errors (body too big, not JSON...) in PerSec AI's error shape.
function normalize(err: unknown): AiError {
  if (isAiError(err)) return err;
  const status = (err as { statusCode?: number })?.statusCode;
  if (status === 413) return new AiError('payload_too_large');
  if (status === 415) return new AiError('invalid_request', 'Send the request as JSON.');
  if (status && status >= 400 && status < 500) return new AiError('invalid_request');
  return new AiError('internal');
}

export async function registerAiRoutes(app: FastifyInstance, options: AiRouteOptions) {
  const { access, config } = options;
  const disabled: AiErrorCode | null = !config.apiKey
    ? 'not_configured'
    : !access && !config.allowOpen
      ? 'unavailable_open_mode'
      : null;

  const provider =
    options.provider ??
    (config.apiKey
      ? createOpenRouter({
          apiKey: config.apiKey,
          timeouts: config.timeouts,
          maxOutputTokens: config.maxOutputTokens,
        })
      : null);
  const catalog = provider && new ModelCatalog(provider, config);
  const limiter = new AiLimiter(config.rateLimit);

  // Who a request counts against: the invite it signed in with, or, on an open server that allows
  // PerSec AI, its address.
  const keyOf = (req: FastifyRequest): string => {
    if (!access) return `ip:${req.ip}`;
    const subject = tokenSubject(access, readCookie(req.headers.cookie, ACCESS_COOKIE));
    if (subject === null) throw Object.assign(new Error('Invite required'), { statusCode: 401 });
    return `invite:${subject}`;
  };

  const ready = () => {
    if (disabled || !provider || !catalog) throw new AiError(disabled ?? 'not_configured');
    return { provider, catalog };
  };

  await app.register(
    async scope => {
      scope.setErrorHandler((err, _req, reply) => {
        if ((err as { statusCode?: number }).statusCode === 401) {
          return reply.code(401).type('text/plain').send('Invite required');
        }
        const e = normalize(err);
        log(e);
        reply.code(e.status).header('Cache-Control', 'no-store').send(e.toJSON());
      });

      scope.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });

      scope.get('/status', async () => ({
        enabled: !disabled,
        provider: 'openrouter',
        ...(disabled ? { reason: disabled } : {}),
      }));

      scope.get('/models', async () => {
        const { catalog } = ready();
        return { default: config.defaultModel, models: await catalog.list() };
      });

      scope.post(
        '/chat',
        { bodyLimit: config.limits.maxBodyBytes },
        async (req: FastifyRequest, reply: FastifyReply) => {
          const { provider, catalog } = ready();
          const key = keyOf(req);
          const chat = parseChatBody(req.body, config.limits, config.defaultModel);

          const wait = limiter.take(key);
          if (wait) {
            reply.header('Retry-After', String(wait));
            throw new AiError('rate_limited');
          }
          await catalog.check(chat.model);
          const release = limiter.openStream(key);
          if (!release) throw new AiError('too_many_streams');

          // The browser leaving (closing the tab, pressing Stop) cancels the request to OpenRouter.
          const cancel = new AbortController();
          const onClose = () => {
            if (!reply.raw.writableFinished) cancel.abort();
          };
          reply.raw.on('close', onClose);
          const cleanup = () => {
            reply.raw.off('close', onClose);
            release();
          };

          const request = { model: chat.model, messages: chat.messages, system: chat.system };

          if (!chat.stream) {
            try {
              const result = await provider.chat(request, cancel.signal);
              return {
                message: { role: 'assistant', content: result.content },
                model: result.model,
                finishReason: result.finishReason,
              };
            } finally {
              cleanup();
            }
          }

          // Streamed. Wait for the first piece before answering, so a failure that happens before
          // anything is generated (unknown model, no credits) still gets its real HTTP status.
          const events = provider.stream(request, cancel.signal)[Symbol.asyncIterator]();
          let first: IteratorResult<StreamEvent>;
          try {
            first = await events.next();
          } catch (err) {
            cleanup();
            throw err;
          }

          reply.hijack();
          const res = reply.raw;
          res.writeHead(200, {
            ...(reply.getHeaders() as Record<string, string>),
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            // Tells nginx-style proxies not to hold the reply back until it's complete.
            'X-Accel-Buffering': 'no',
          });
          const heartbeat = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
          }, HEARTBEAT_MS);
          try {
            let next = first;
            while (!next.done) {
              if (!(await write(res, toSse(next.value)))) break;
              next = await events.next();
            }
          } catch (err) {
            const e = normalize(err);
            if (e.code !== 'cancelled') {
              log(e);
              await write(res, sse('error', e.toJSON().error));
            }
          } finally {
            clearInterval(heartbeat);
            // Stops the provider's request if we stopped reading early (the browser went away).
            await events.return?.().catch(() => {});
            cleanup();
            if (!res.writableEnded) res.end();
          }
        },
      );
    },
    { prefix: '/api/ai' },
  );
}
