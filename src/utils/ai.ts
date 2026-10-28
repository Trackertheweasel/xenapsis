// PerSec AI in the browser: the pieces of the /ai page that don't touch the page itself, so they
// can be tested on their own. The page (aichat.ts) only ever talks to this server's /api/ai/*
// routes; the OpenRouter key never reaches the browser (see serverlib/ai/index.ts).

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  // The model that answered (with openrouter/free, OpenRouter picks one).
  model?: string;
  // Why a reply failed, shown under what arrived of it.
  error?: string;
  stopped?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength: number | null;
  free: boolean;
}

// The server's limits (serverlib/ai/index.ts loadAiConfig), so a long conversation is trimmed
// here instead of being refused there.
export const LIMITS = {
  maxMessages: 100,
  maxMessageChars: 32_000,
  maxTotalChars: 120_000,
  maxSystemChars: 8_000,
};

export const DEFAULT_SYSTEM =
  'You are PerSec AI, a helpful assistant built into the Persec web browser. Answer clearly and concisely.';

// The conversation as the server takes it: replies that failed with nothing to show are left out,
// and the oldest messages are dropped until it fits. Always ends with the newest message from you.
export function historyFor(
  messages: StoredMessage[],
  systemChars = 0,
  limits = LIMITS,
): { role: 'user' | 'assistant'; content: string }[] {
  const usable = messages
    .filter(m => m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, limits.maxMessageChars) }));
  while (usable.length && usable.at(-1)!.role !== 'user') usable.pop();
  let total = systemChars + usable.reduce((n, m) => n + m.content.length, 0);
  while (
    usable.length > 1 &&
    (usable.length > limits.maxMessages || total > limits.maxTotalChars)
  ) {
    total -= usable.shift()!.content.length;
  }
  // Starting on one of the model's replies reads oddly to some models.
  while (usable.length > 1 && usable[0].role !== 'user') usable.shift();
  return usable;
}

// Reads this server's event stream (serverlib/routes/ai.ts): "event: token|meta|done|error"
// followed by one JSON "data:" line. Heartbeat comments are skipped.
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = (block: string) => {
    let event = 'message';
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    if (!data) return;
    try {
      onEvent(event, JSON.parse(data));
    } catch {}
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : (blocks.pop() ?? '');
      blocks.forEach(emit);
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

// Splits a reply into prose and ``` code blocks, so code can be shown as code. Everything is
// rendered as text, never as HTML.
export function splitCode(text: string): { code: boolean; text: string; lang?: string }[] {
  const parts: { code: boolean; text: string; lang?: string }[] = [];
  const re = /```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[2].replace(/\n$/, ''), lang: m[1] || undefined });
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts.filter(p => p.code || p.text);
}

export function contextLabel(n: number | null): string {
  if (!n) return '';
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}

// How a model appears in the picker.
export function modelLabel(m: ModelInfo): string {
  const ctx = contextLabel(m.contextLength);
  return [m.name, m.provider && m.provider !== m.name ? m.provider : '', ctx && `${ctx} context`]
    .filter(Boolean)
    .join(' · ');
}

// What to show when /api/ai/status says PerSec AI is off.
export const OFF_REASONS: Record<string, string> = {
  not_configured:
    'PerSec AI isn’t set up on this server yet. The owner needs to add an OpenRouter key.',
  unavailable_open_mode:
    'PerSec AI is off because this server is open to everyone. The owner can turn on invite codes to use it.',
};
