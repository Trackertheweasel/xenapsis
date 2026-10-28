import { AiError } from './index';
import type {
  AiErrorCode,
  ChatProvider,
  ChatRequest,
  ChatResult,
  ModelInfo,
  StreamEvent,
  Timeouts,
} from './index';
import { isModelId } from './validate';

// OpenRouter's OpenAI-compatible API (https://openrouter.ai/docs). One key reaches models from many
// companies, including a pool of free ones behind the "openrouter/free" ID, so Persec never needs
// to know which free model happens to be up today.
//
// The address is fixed here. Nothing a browser sends, and no environment variable, can change it.
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Upstream error bodies are read only to tell an unknown model from other problems, never passed on.
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_MODELS_BYTES = 8 * 1024 * 1024;

export interface OpenRouterOptions {
  apiKey: string;
  timeouts: Timeouts;
  maxOutputTokens?: number | null;
  // For tests: a stand-in fetch, or a local mock server's address. Never set from requests or env.
  fetch?: typeof fetch;
  baseUrl?: string;
}

// One request's abort switch. It trips when the caller cancels (the browser went away or pressed
// Stop) or a timer runs out, and remembers which, so each is reported as itself.
class Deadline {
  readonly controller = new AbortController();
  reason: 'timeout' | 'cancelled' | null = null;
  private total: NodeJS.Timeout;
  private step: NodeJS.Timeout | undefined;
  private readonly onParent = () => this.trip('cancelled');

  constructor(
    private readonly parent: AbortSignal | undefined,
    totalMs: number,
  ) {
    this.total = setTimeout(() => this.trip('timeout'), totalMs);
    if (parent?.aborted) this.trip('cancelled');
    else parent?.addEventListener('abort', this.onParent, { once: true });
  }

  get signal() {
    return this.controller.signal;
  }

  // (Re)starts the shorter timer: waiting for headers, then for each streamed piece.
  arm(ms: number) {
    clearTimeout(this.step);
    this.step = setTimeout(() => this.trip('timeout'), ms);
  }

  trip(reason: 'timeout' | 'cancelled') {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
  }

  // What went wrong, given an error thrown while this deadline was running.
  error(err: unknown): AiError {
    if (err instanceof AiError) return err;
    if (this.reason === 'timeout') return new AiError('upstream_timeout');
    if (this.reason === 'cancelled') return new AiError('cancelled');
    return new AiError('upstream_unavailable');
  }

  dispose() {
    clearTimeout(this.total);
    clearTimeout(this.step);
    this.parent?.removeEventListener('abort', this.onParent);
  }
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new AiError('malformed_response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

// OpenRouter's status codes (https://openrouter.ai/docs/api-reference/errors), as Persec's own.
export function errorForStatus(status: number, message = ''): AiError {
  const byStatus: Record<number, AiErrorCode> = {
    400: /model/i.test(message) ? 'invalid_model' : 'invalid_request',
    401: 'upstream_auth',
    402: 'upstream_credits',
    403: 'upstream_rejected',
    404: 'invalid_model',
    408: 'upstream_timeout',
    413: 'payload_too_large',
    429: 'upstream_rate_limited',
  };
  return new AiError(byStatus[status] ?? 'upstream_unavailable');
}

const upstreamMessage = (body: unknown): string => {
  const e = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof e?.message === 'string' ? e.message : '';
};

async function failure(res: Response): Promise<AiError> {
  let message = '';
  try {
    message = upstreamMessage(JSON.parse(await readCapped(res, MAX_ERROR_BYTES)));
  } catch {}
  return errorForStatus(res.status, message);
}

// An error OpenRouter reports inside a 200 reply or a stream ({ error: { code, message } }).
function inlineError(body: unknown): AiError | null {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (!e || typeof e !== 'object') return null;
  const code = Number(e.code);
  return errorForStatus(Number.isInteger(code) ? code : 502, upstreamMessage(body));
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

// One entry of OpenRouter's GET /models, in the shape the model picker shows.
export function toModelInfo(raw: any): ModelInfo | null {
  if (!raw || typeof raw !== 'object' || !isModelId(raw.id)) return null;
  const out = raw.architecture?.output_modalities;
  if (Array.isArray(out) && !out.includes('text')) return null;
  const fullName = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.id;
  // Names read "Company: Model"; the ID's first part is the fallback.
  const sep = fullName.indexOf(': ');
  const provider = sep > 0 ? fullName.slice(0, sep) : raw.id.replace(/^~/, '').split('/')[0];
  const prompt = asNumber(raw.pricing?.prompt);
  const completion = asNumber(raw.pricing?.completion);
  return {
    id: raw.id,
    name: (sep > 0 ? fullName.slice(sep + 2) : fullName).slice(0, 120),
    provider: provider.slice(0, 60),
    contextLength: asNumber(raw.context_length),
    free: raw.id.endsWith(':free') || (prompt === 0 && completion === 0),
  };
}

// Pulls whole "data:" lines out of OpenRouter's event stream. Comment lines (": OPENROUTER
// PROCESSING", sent while a model warms up) and blank lines are skipped.
export class SseLineReader {
  private buffer = '';
  private decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    // A line that never ends would grow without bound.
    if (this.buffer.length > 1024 * 1024) throw new AiError('malformed_response');
    return lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
  }

  flush(): string[] {
    const rest = this.buffer + this.decoder.decode();
    this.buffer = '';
    return rest.startsWith('data:') ? [rest.slice(5).trimStart()] : [];
  }
}

export function createOpenRouter(options: OpenRouterOptions): ChatProvider {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? OPENROUTER_BASE_URL;
  const { timeouts } = options;

  // Only these headers go upstream. Nothing from the browser's request is forwarded.
  const headers = () => ({
    Authorization: `Bearer ${options.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });

  const body = (req: ChatRequest, stream: boolean) =>
    JSON.stringify({
      model: req.model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        ...req.messages.map(m => ({ role: m.role, content: m.content })),
      ],
      stream,
      ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
    });

  async function post(req: ChatRequest, stream: boolean, deadline: Deadline): Promise<Response> {
    deadline.arm(timeouts.headersMs);
    const res = await doFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...headers(), ...(stream ? { Accept: 'text/event-stream' } : {}) },
      body: body(req, stream),
      signal: deadline.signal,
      redirect: 'error',
    });
    if (!res.ok) throw await failure(res);
    return res;
  }

  return {
    id: 'openrouter',

    async listModels(signal) {
      const deadline = new Deadline(signal, timeouts.headersMs);
      try {
        const res = await doFetch(`${base}/models`, {
          headers: headers(),
          signal: deadline.signal,
          redirect: 'error',
        });
        if (!res.ok) throw await failure(res);
        const data = JSON.parse(await readCapped(res, MAX_MODELS_BYTES))?.data;
        if (!Array.isArray(data)) throw new AiError('malformed_response');
        return data.map(toModelInfo).filter((m): m is ModelInfo => !!m);
      } catch (err) {
        throw err instanceof SyntaxError ? new AiError('malformed_response') : deadline.error(err);
      } finally {
        deadline.dispose();
      }
    },

    async chat(req, signal): Promise<ChatResult> {
      const deadline = new Deadline(signal, timeouts.totalMs);
      try {
        const res = await post(req, false, deadline);
        deadline.arm(timeouts.totalMs);
        let json: any;
        try {
          json = JSON.parse(await readCapped(res, MAX_MODELS_BYTES));
        } catch (err) {
          if (err instanceof SyntaxError) throw new AiError('malformed_response');
          throw err;
        }
        const inline = inlineError(json);
        if (inline) throw inline;
        const choice = json?.choices?.[0];
        const content = choice?.message?.content;
        if (!choice || (content != null && typeof content !== 'string')) {
          throw new AiError('malformed_response');
        }
        return {
          content: content ?? '',
          model: typeof json.model === 'string' ? json.model : req.model,
          finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        };
      } catch (err) {
        throw deadline.error(err);
      } finally {
        deadline.dispose();
      }
    },

    async *stream(req, signal): AsyncGenerator<StreamEvent> {
      const deadline = new Deadline(signal, timeouts.totalMs);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const res = await post(req, true, deadline);
        if (!res.body) throw new AiError('malformed_response');
        reader = res.body.getReader();
        const lines = new SseLineReader();
        let model: string | null = null;
        let finishReason: string | null = null;
        let finished = false;
        let unreadable = 0;

        // Yields what one data line holds; returns true at the end of the reply.
        const handle = function* (data: string): Generator<StreamEvent, boolean> {
          if (data === '[DONE]') return true;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            // One bad line is skipped; a stream of them means something is badly wrong.
            if (++unreadable > 20) throw new AiError('malformed_response');
            return false;
          }
          const inline = inlineError(chunk);
          if (inline) throw inline;
          if (!model && typeof chunk?.model === 'string') {
            model = chunk.model;
            yield { type: 'meta', model: chunk.model };
          }
          const choice = chunk?.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text) yield { type: 'token', text };
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason;
            if (finishReason === 'error') throw new AiError('stream_interrupted');
          }
          return false;
        };

        read: for (;;) {
          deadline.arm(timeouts.idleMs);
          const { done, value } = await reader.read();
          const batch = done ? lines.flush() : lines.push(value);
          for (const data of batch) {
            if (yield* handle(data)) {
              finished = true;
              break read;
            }
          }
          if (done) break;
        }
        // Ended without [DONE] or a finish reason: the connection dropped part way.
        if (!finished && !finishReason) throw new AiError('stream_interrupted');
        yield { type: 'done', finishReason, model };
      } catch (err) {
        // A connection that breaks once the reply has started is a cut-off reply.
        const e = deadline.error(err);
        throw !(err instanceof AiError) && e.code === 'upstream_unavailable' && reader
          ? new AiError('stream_interrupted')
          : e;
      } finally {
        // Also runs when the consumer stops early (the browser left): stop OpenRouter generating.
        deadline.trip('cancelled');
        reader?.cancel().catch(() => {});
        deadline.dispose();
      }
    },
  };
}
