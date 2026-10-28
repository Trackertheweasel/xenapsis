// PerSec AI: a chat assistant that runs through this server. The browser only ever talks to
// Persec's own /api/ai/* routes (serverlib/routes/ai.ts); this server talks to the model provider.
//
//   browser  ->  /api/ai/chat  ->  provider (OpenRouter)  ->  the chosen model
//
// The provider's API key stays in the server's environment. It is never sent to the browser, never
// logged and never written anywhere. Clients choose a model by its ID and nothing else: they can't
// name an upstream URL, header or provider, so this can't be turned into a general HTTP proxy.
//
// OpenRouter (serverlib/ai/openrouter.ts) is the only provider. ChatProvider is the seam a second
// one would plug into.

export const DEFAULT_MODEL = 'openrouter/free';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// What the routes hand a provider, already validated (serverlib/ai/validate.ts).
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
}

export interface ChatResult {
  content: string;
  // The model that actually answered. With openrouter/free, OpenRouter picks one.
  model: string;
  finishReason: string | null;
}

// What a streamed reply is made of, already normalized from the provider's own format.
export type StreamEvent =
  | { type: 'meta'; model: string }
  | { type: 'token'; text: string }
  | { type: 'done'; finishReason: string | null; model: string | null };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number | null;
  free: boolean;
}

export interface ChatProvider {
  readonly id: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  // Yields as the provider sends; throws AiError if the reply fails or is cut off part way.
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

// Every failure the browser can see. Messages are written here, never copied from the provider,
// so nothing upstream (its internals, or anything echoing a credential) reaches a client.
export type AiErrorCode =
  | 'not_configured'
  | 'unavailable_open_mode'
  | 'invalid_request'
  | 'invalid_model'
  | 'payload_too_large'
  | 'rate_limited'
  | 'too_many_streams'
  | 'upstream_auth'
  | 'upstream_credits'
  | 'upstream_rate_limited'
  | 'upstream_rejected'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'malformed_response'
  | 'stream_interrupted'
  | 'cancelled'
  | 'internal';

const ERRORS: Record<AiErrorCode, [status: number, message: string]> = {
  not_configured: [503, 'PerSec AI is not set up on this server.'],
  unavailable_open_mode: [
    503,
    'PerSec AI is off because this server has no invite codes. The owner can turn on invite-only mode to use it.',
  ],
  invalid_request: [400, 'That request is not valid.'],
  invalid_model: [400, 'That model is not available.'],
  payload_too_large: [413, 'That conversation is too long. Start a new one.'],
  rate_limited: [429, 'Too many messages. Wait a moment and try again.'],
  too_many_streams: [429, 'Wait for your other replies to finish first.'],
  upstream_auth: [502, 'The AI service did not accept this server’s credentials.'],
  upstream_credits: [
    502,
    'This server has run out of AI credits for that model. Try a free model.',
  ],
  upstream_rate_limited: [429, 'The AI service is busy. Try again shortly or pick another model.'],
  upstream_rejected: [400, 'The model refused that request.'],
  upstream_timeout: [504, 'The model took too long to answer.'],
  upstream_unavailable: [
    502,
    'The AI service could not be reached. Try again or pick another model.',
  ],
  malformed_response: [502, 'The AI service sent a reply that could not be read.'],
  stream_interrupted: [502, 'The reply was cut off.'],
  cancelled: [499, 'Stopped.'],
  internal: [500, 'Something went wrong. Try again.'],
};

export class AiError extends Error {
  readonly status: number;
  constructor(
    readonly code: AiErrorCode,
    message?: string,
  ) {
    const [status, fallback] = ERRORS[code];
    super(message ?? fallback);
    this.status = status;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const isAiError = (err: unknown): err is AiError => err instanceof AiError;

// How long to wait on the provider. headersMs covers connecting and the model starting to answer;
// idleMs is the longest gap allowed between streamed pieces; totalMs caps a whole reply.
export interface Timeouts {
  headersMs: number;
  idleMs: number;
  totalMs: number;
}

export interface AiLimits {
  maxBodyBytes: number;
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
  maxSystemChars: number;
}

export interface RateLimit {
  windowMs: number;
  maxRequests: number;
  // Replies one person may have streaming at once.
  maxConcurrent: number;
}

export interface AiConfig {
  apiKey: string | null;
  defaultModel: string;
  // Unset: any model OpenRouter lists. 'free': only free ones. Otherwise the listed IDs only.
  allowedModels: 'all' | 'free' | Set<string>;
  maxOutputTokens: number | null;
  // Explicit opt-in to run PerSec AI on a server with no invite codes, where anyone could spend
  // the owner's OpenRouter allowance.
  allowOpen: boolean;
  limits: AiLimits;
  rateLimit: RateLimit;
  timeouts: Timeouts;
}

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v?.trim() ?? '');
const positive = (v: string | undefined, fallback: number, min = 1) => {
  const n = Number(v?.trim());
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};

// Read once at start-up, like loadAccess. A missing key leaves PerSec AI off and the rest of
// Persec running normally.
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const allowed = env.OPENROUTER_ALLOWED_MODELS?.trim();
  return {
    apiKey: env.OPENROUTER_API_KEY?.trim() || null,
    defaultModel: env.OPENROUTER_DEFAULT_MODEL?.trim() || DEFAULT_MODEL,
    allowedModels: !allowed
      ? 'all'
      : allowed.toLowerCase() === 'free'
        ? 'free'
        : new Set(
            allowed
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
          ),
    maxOutputTokens: env.OPENROUTER_MAX_TOKENS?.trim()
      ? positive(env.OPENROUTER_MAX_TOKENS, 0) || null
      : null,
    allowOpen: truthy(env.PERSEC_AI_ALLOW_OPEN),
    limits: {
      maxBodyBytes: 256 * 1024,
      maxMessages: 100,
      maxMessageChars: 32_000,
      maxTotalChars: 120_000,
      maxSystemChars: 8_000,
    },
    rateLimit: {
      windowMs: positive(env.AI_RATE_LIMIT_WINDOW_MS, 60_000, 1000),
      maxRequests: positive(env.AI_RATE_LIMIT_MAX_REQUESTS, 20),
      maxConcurrent: 2,
    },
    timeouts: {
      headersMs: positive(env.AI_UPSTREAM_TIMEOUT_MS, 60_000, 1000),
      idleMs: 60_000,
      totalMs: 10 * 60_000,
    },
  };
}
