// The PerSec AI page (/ai, persec://ai). Talks only to this server's /api/ai/* routes, which pass
// messages on to OpenRouter. The conversation is kept in this browser (IndexedDB), never uploaded
// for safekeeping, and not part of the saved-logins backup, which only copies localStorage.
import localForage from 'localforage';
import {
  DEFAULT_SYSTEM,
  LIMITS,
  OFF_REASONS,
  contextLabel,
  historyFor,
  modelLabel,
  readEvents,
  splitCode,
  type ModelInfo,
  type StoredMessage,
} from './ai';
import { renderIcons } from './icons';

interface Prefs {
  model: string;
  freeOnly: boolean;
  keep: boolean;
  system: string;
}

const store = localForage.createInstance({ name: 'PersecAI', storeName: 'chat' });
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const ui = {
  off: $('[data-off]'),
  offText: $('[data-off-text]'),
  chat: $('[data-chat]'),
  log: $('[data-log]'),
  empty: $('[data-empty]'),
  model: $<HTMLSelectElement>('[data-model]'),
  modelInfo: $('[data-model-info]'),
  freeOnly: $<HTMLInputElement>('[data-free-only]'),
  keep: $<HTMLInputElement>('[data-keep]'),
  system: $<HTMLTextAreaElement>('[data-system]'),
  form: $<HTMLFormElement>('[data-composer]'),
  input: $<HTMLTextAreaElement>('[data-input]'),
  send: $<HTMLButtonElement>('[data-send]'),
  stop: $<HTMLButtonElement>('[data-stop]'),
  newChat: $<HTMLButtonElement>('[data-new]'),
  clear: $<HTMLButtonElement>('[data-clear]'),
  status: $('[data-status]'),
};

let prefs: Prefs = { model: 'openrouter/free', freeOnly: true, keep: true, system: '' };
let defaultModel = 'openrouter/free';
let models: ModelInfo[] = [];
let messages: StoredMessage[] = [];
let busy: AbortController | null = null;

const say = (text: string) => (ui.status.textContent = text);

async function savePrefs() {
  try {
    await store.setItem('prefs', prefs);
  } catch {}
}

let saveTimer: number | undefined;
// While a reply streams in, saving after every word would be wasteful; once a second is enough.
function saveChat(soon = false) {
  clearTimeout(saveTimer);
  const run = () => {
    const work = prefs.keep ? store.setItem('messages', messages) : store.removeItem('messages');
    work.catch(() => {});
  };
  if (soon) saveTimer = window.setTimeout(run, 1000);
  else run();
}

// ---- Rendering. Every message is written with textContent, never as HTML.

function bubble(m: StoredMessage, i: number): HTMLElement {
  const mine = m.role === 'user';
  const row = document.createElement('div');
  row.className = `flex ${mine ? 'justify-end' : 'justify-start'}`;
  const box = document.createElement('div');
  box.className = mine
    ? 'max-w-[85%] rounded-2xl rounded-br-md bg-[#6366f1] px-4 py-2.5 text-white sm:max-w-[75%]'
    : 'bg-background-overlay/80 text-text-header max-w-[92%] rounded-2xl rounded-bl-md border border-white/6 px-4 py-2.5 sm:max-w-[80%]';
  const pending = !mine && busy && i === messages.length - 1;

  if (mine || m.content) {
    for (const part of mine ? [{ code: false, text: m.content }] : splitCode(m.content)) {
      if (part.code) {
        const pre = document.createElement('pre');
        pre.className =
          'my-2 overflow-x-auto rounded-lg border border-white/8 bg-black/40 p-3 font-mono text-[13px] leading-relaxed';
        const code = document.createElement('code');
        code.textContent = part.text;
        pre.append(code);
        box.append(pre);
      } else {
        // The blank lines around a code block are already its margin.
        const text = mine ? part.text : part.text.replace(/^\n+|\n+$/g, '');
        if (!text) continue;
        const p = document.createElement('div');
        p.className = 'leading-relaxed break-words whitespace-pre-wrap';
        p.textContent = text;
        box.append(p);
      }
    }
  } else if (pending) {
    const dots = document.createElement('div');
    dots.className = 'text-text-secondary flex items-center gap-2 text-sm';
    dots.innerHTML =
      '<span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span>';
    dots.setAttribute('aria-label', 'Thinking');
    box.append(dots);
  }

  if (!mine) {
    const meta = document.createElement('div');
    meta.className =
      'text-text-secondary mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs';
    if (m.model) {
      const by = document.createElement('span');
      by.textContent = m.model;
      meta.append(by);
    }
    if (m.stopped) {
      const s = document.createElement('span');
      s.textContent = 'Stopped';
      meta.append(s);
    }
    if (m.error) {
      const e = document.createElement('span');
      e.className = 'text-red-300';
      e.setAttribute('role', 'alert');
      e.textContent = m.error;
      meta.append(e);
    }
    const last = i === messages.length - 1;
    if (last && !busy && (m.error || m.stopped || m.content)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'rounded-md px-1.5 py-0.5 text-[#a5a3ff] hover:bg-white/5 hover:text-white';
      retry.textContent = m.error ? 'Try again' : 'Regenerate';
      retry.addEventListener('click', () => retryLast());
      meta.append(retry);
    }
    if (meta.childElementCount) box.append(meta);
  }
  row.append(box);
  return row;
}

function render() {
  const nearBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 120;
  ui.log.replaceChildren(...messages.map(bubble));
  ui.empty.hidden = messages.length > 0;
  ui.log.hidden = messages.length === 0;
  ui.send.hidden = !!busy;
  ui.stop.hidden = !busy;
  ui.clear.disabled = !messages.length || !!busy;
  ui.newChat.disabled = !messages.length || !!busy;
  ui.model.disabled = !!busy;
  if (nearBottom || busy) ui.log.scrollTop = ui.log.scrollHeight;
}

// Streaming re-renders only the reply being written, not the whole conversation.
function renderLast() {
  const last = ui.log.lastElementChild;
  const fresh = bubble(messages.at(-1)!, messages.length - 1);
  if (last) last.replaceWith(fresh);
  else ui.log.append(fresh);
  ui.log.scrollTop = ui.log.scrollHeight;
}

// ---- Models.

function selected(): ModelInfo | undefined {
  return models.find(m => m.id === prefs.model);
}

function renderModels() {
  const shown = models.filter(m => !prefs.freeOnly || m.free || m.id === prefs.model);
  const group = (label: string, list: ModelInfo[]) => {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent =
        m.id === 'openrouter/free'
          ? 'OpenRouter Free (picks an available free model)'
          : modelLabel(m);
      g.append(o);
    }
    return g;
  };
  const free = shown.filter(m => m.free);
  const paid = shown.filter(m => !m.free);
  ui.model.replaceChildren(
    ...(free.length ? [group('Free', free)] : []),
    ...(paid.length ? [group('Paid (uses this server’s credits)', paid)] : []),
  );
  ui.model.value = prefs.model;
  const m = selected();
  ui.modelInfo.textContent = m
    ? [
        m.provider,
        m.contextLength && `${contextLabel(m.contextLength)} context`,
        m.free ? 'Free' : 'Paid',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
}

async function loadModels() {
  try {
    const res = await fetch('/api/ai/models', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message);
    models = body.models;
    defaultModel = body.default;
  } catch (err) {
    // The picker still offers the default, so chatting works while the list can't be fetched.
    models = [
      {
        id: defaultModel,
        name: 'OpenRouter Free',
        provider: 'OpenRouter',
        contextLength: null,
        free: true,
      },
    ];
    say(err instanceof Error && err.message ? err.message : 'Couldn’t load the model list.');
  }
  // A model saved earlier that's gone now (free models come and go) falls back to the default.
  if (!models.some(m => m.id === prefs.model)) prefs.model = defaultModel;
  renderModels();
}

// ---- Sending.

async function ask() {
  const assistant: StoredMessage = { role: 'assistant', content: '' };
  messages.push(assistant);
  busy = new AbortController();
  render();
  say('');

  const system = prefs.system.trim() || DEFAULT_SYSTEM;
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: prefs.model,
        system,
        messages: historyFor(messages.slice(0, -1), system.length),
        stream: true,
      }),
      signal: busy.signal,
      cache: 'no-store',
    });
    if (!res.ok || !res.body) {
      let message = res.status === 401 ? 'Your sign-in has expired. Reload to sign in again.' : '';
      try {
        message ||= (await res.json())?.error?.message;
      } catch {}
      throw new Error(message || `The request failed (${res.status}).`);
    }
    let finished = false;
    await readEvents(res.body, (event, data) => {
      if (event === 'meta' && typeof data.model === 'string') assistant.model = data.model;
      else if (event === 'token' && typeof data.text === 'string') assistant.content += data.text;
      else if (event === 'done') {
        finished = true;
        if (typeof data.model === 'string') assistant.model = data.model;
        if (data.finishReason === 'length') assistant.error = 'The reply hit the length limit.';
      } else if (event === 'error') {
        finished = true;
        assistant.error = typeof data.message === 'string' ? data.message : 'The reply failed.';
      }
      renderLast();
      saveChat(true);
    });
    if (!finished) assistant.error = 'The connection closed before the reply finished.';
  } catch (err) {
    if (busy?.signal.aborted) assistant.stopped = true;
    else assistant.error = err instanceof Error ? err.message : 'The request failed.';
  } finally {
    busy = null;
    if (!assistant.content && !assistant.error && !assistant.stopped) {
      assistant.error = 'The model sent an empty reply. Try again or pick another model.';
    }
    render();
    saveChat();
    ui.input.focus();
  }
}

function send(text: string) {
  text = text.trim();
  if (!text || busy) return;
  if (text.length > LIMITS.maxMessageChars) {
    say(`Messages can be up to ${LIMITS.maxMessageChars.toLocaleString()} characters.`);
    return;
  }
  messages.push({ role: 'user', content: text });
  ui.input.value = '';
  autosize();
  ask();
}

function retryLast() {
  if (busy) return;
  if (messages.at(-1)?.role === 'assistant') messages.pop();
  if (messages.at(-1)?.role !== 'user') return render();
  ask();
}

function reset() {
  busy?.abort();
  messages = [];
  render();
  saveChat();
  ui.input.focus();
}

function autosize() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 200)}px`;
}

// ---- Wiring.

ui.form.addEventListener('submit', e => {
  e.preventDefault();
  send(ui.input.value);
});
ui.input.addEventListener('keydown', e => {
  // Enter sends, Shift+Enter starts a new line. Not while an IME is composing a character.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(ui.input.value);
  }
});
ui.input.addEventListener('input', autosize);
ui.stop.addEventListener('click', () => busy?.abort());
ui.newChat.addEventListener('click', reset);
ui.clear.addEventListener('click', () => {
  if (!confirmClear()) return;
  reset();
  say('Conversation cleared from this browser.');
});
ui.model.addEventListener('change', () => {
  prefs.model = ui.model.value;
  renderModels();
  savePrefs();
});
ui.freeOnly.addEventListener('change', () => {
  prefs.freeOnly = ui.freeOnly.checked;
  if (prefs.freeOnly && !selected()?.free) prefs.model = defaultModel;
  renderModels();
  savePrefs();
});
ui.keep.addEventListener('change', () => {
  prefs.keep = ui.keep.checked;
  savePrefs();
  saveChat();
  say(
    prefs.keep
      ? 'This conversation will be kept in this browser.'
      : 'Conversations won’t be kept after you leave.',
  );
});
ui.system.addEventListener('change', () => {
  prefs.system = ui.system.value.slice(0, LIMITS.maxSystemChars);
  savePrefs();
});

// A second press within 3 seconds confirms, instead of a blocking confirm() dialog.
let armed = 0;
function confirmClear(): boolean {
  if (Date.now() - armed < 3000) return true;
  armed = Date.now();
  say('Press Clear again to delete this conversation.');
  return false;
}

async function start() {
  try {
    const saved = await store.getItem<Partial<Prefs>>('prefs');
    if (saved) prefs = { ...prefs, ...saved };
    if (prefs.keep) {
      const kept = await store.getItem<StoredMessage[]>('messages');
      if (Array.isArray(kept)) messages = kept.filter(m => m && typeof m.content === 'string');
    }
  } catch {}
  ui.freeOnly.checked = prefs.freeOnly;
  ui.keep.checked = prefs.keep;
  ui.system.value = prefs.system;
  ui.system.placeholder = DEFAULT_SYSTEM;
  ui.input.maxLength = LIMITS.maxMessageChars;
  ui.system.maxLength = LIMITS.maxSystemChars;

  let status: { enabled?: boolean; reason?: string } = {};
  try {
    const res = await fetch('/api/ai/status', { cache: 'no-store' });
    status = res.ok ? await res.json() : { reason: res.status === 401 ? 'signed_out' : 'error' };
  } catch {
    status = { reason: 'error' };
  }
  if (!status.enabled) {
    ui.offText.textContent =
      OFF_REASONS[status.reason ?? ''] ??
      (status.reason === 'signed_out'
        ? 'Sign in with your invite code to use PerSec AI.'
        : 'PerSec AI can’t be reached right now. Try reloading the page.');
    ui.off.hidden = false;
    ui.chat.hidden = true;
    return;
  }
  ui.off.hidden = true;
  ui.chat.hidden = false;
  render();
  await loadModels();
  renderIcons();
  ui.input.focus();
}

start();
