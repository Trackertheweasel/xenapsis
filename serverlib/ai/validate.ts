import { AiError } from './index';
import type { AiLimits, ChatMessage, ChatRequest } from './index';

// Checks what a browser sent to /api/ai/chat. Anything unexpected is refused rather than ignored,
// so a field like upstreamUrl, baseUrl or headers is an error, not something silently dropped.

const BODY_KEYS = new Set(['model', 'messages', 'system', 'stream']);
const MESSAGE_KEYS = new Set(['role', 'content']);
// Roles a browser may send. OpenRouter also takes "system" (sent here as its own field) and "tool"
// (needs tool calls, which PerSec AI doesn't use).
const ROLES = new Set(['user', 'assistant']);

// OpenRouter's IDs look like "openrouter/free", "meta-llama/llama-3.3-70b-instruct:free" or
// "~vendor/model". No scheme, host, spaces, query or path traversal can fit through this.
const MODEL_RE = /^~?[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,95}$/i;
export const isModelId = (v: unknown): v is string =>
  typeof v === 'string' && MODEL_RE.test(v) && !v.includes('..');

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const bad = (message: string) => new AiError('invalid_request', message);

export interface ParsedChat extends ChatRequest {
  stream: boolean;
}

export function parseChatBody(body: unknown, limits: AiLimits, defaultModel: string): ParsedChat {
  if (!isObject(body)) throw bad('Send a JSON object.');
  for (const key of Object.keys(body)) {
    if (!BODY_KEYS.has(key)) throw bad(`Unknown field "${key.slice(0, 40)}".`);
  }

  const model = body.model ?? defaultModel;
  if (!isModelId(model)) throw new AiError('invalid_model');

  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw bad('"stream" must be true or false.');
  }

  let system: string | undefined;
  if (body.system !== undefined && body.system !== null) {
    if (typeof body.system !== 'string') throw bad('"system" must be text.');
    if (body.system.length > limits.maxSystemChars) {
      throw new AiError('payload_too_large', 'The system instructions are too long.');
    }
    system = body.system.trim() || undefined;
  }

  const raw = body.messages;
  if (!Array.isArray(raw) || !raw.length) throw bad('Send at least one message.');
  if (raw.length > limits.maxMessages) throw new AiError('payload_too_large');

  let total = system?.length ?? 0;
  const messages: ChatMessage[] = raw.map((m, i) => {
    if (!isObject(m)) throw bad(`Message ${i + 1} is not valid.`);
    for (const key of Object.keys(m)) {
      if (!MESSAGE_KEYS.has(key)) throw bad(`Message ${i + 1} has an unknown field.`);
    }
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) {
      throw bad(`Message ${i + 1} has an unsupported role.`);
    }
    if (typeof m.content !== 'string' || !m.content.trim()) {
      throw bad(`Message ${i + 1} is empty.`);
    }
    if (m.content.length > limits.maxMessageChars) {
      throw new AiError('payload_too_large', `Message ${i + 1} is too long.`);
    }
    total += m.content.length;
    return { role: m.role as ChatMessage['role'], content: m.content };
  });
  if (total > limits.maxTotalChars) throw new AiError('payload_too_large');
  if (messages.at(-1)!.role !== 'user') throw bad('The last message must be from you.');

  return { model, messages, system, stream: body.stream ?? false };
}
