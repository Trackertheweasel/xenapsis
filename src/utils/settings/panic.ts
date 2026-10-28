import ConfigAPI from '../config';
import { notify } from './ui';

// The panic key: a key combination that sends the top window to the panic address. Saved as
// "ctrl+alt+x"; shown as "Ctrl+Alt+X".

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta'];

export function formatPanicKey(combo: string): string {
  return combo
    .split('+')
    .map(p => {
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'alt') return 'Alt';
      if (p === 'shift') return 'Shift';
      if (p === 'meta') return 'Meta';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join('+');
}

function heldModifiers(e: KeyboardEvent): string[] {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  return parts;
}

let panicKeyHandler: (e: KeyboardEvent) => void = () => {};

export function setPanicKey(combo: string) {
  const doc = (window.top || window).document;
  doc.removeEventListener('keydown', panicKeyHandler);

  panicKeyHandler = async (e: KeyboardEvent) => {
    const parts = heldModifiers(e);
    if (!MODIFIERS.includes(e.key)) {
      parts.push(e.key.toLowerCase());
    }

    const pressed = parts.join('+');

    if (pressed === combo) {
      e.preventDefault();
      const url = await ConfigAPI.get('panicLoc');
      if (url) {
        (window.top || window).location.href = url;
      }
    }
  };

  doc.addEventListener('keydown', panicKeyHandler);
}

// The field that records a new panic key from the next combination pressed in it.
export function initPanicKey() {
  const input = document.querySelector('[data-input="panicKey"]') as HTMLInputElement;
  if (!input) return;

  let recording = false;

  input.addEventListener('focus', () => {
    recording = true;
    input.value = 'Press keys...';
    input.classList.add('border-[#6366f1]/50', 'ring-2', 'ring-[#6366f1]/20');
  });

  input.addEventListener('keydown', async e => {
    if (!recording) return;

    e.preventDefault();
    e.stopPropagation();

    if (MODIFIERS.includes(e.key)) {
      input.value = formatPanicKey(heldModifiers(e).join('+')) + '+';
      return;
    }

    const combo = [...heldModifiers(e), e.key.toLowerCase()].join('+');

    input.value = [
      ...heldModifiers(e).map(formatPanicKey),
      e.key.length === 1 ? e.key.toUpperCase() : e.key,
    ].join('+');
    await ConfigAPI.set('panicKey', combo);

    const win = window.top || window;
    win.dispatchEvent(new CustomEvent('panicKeyChanged', { detail: combo }));

    notify();
    setPanicKey(combo);

    parent.location.reload();
  });

  input.addEventListener('blur', () => {
    recording = false;
    input.classList.remove('border-[#6366f1]/50', 'ring-2', 'ring-[#6366f1]/20');
    if (input.value === 'Press keys...') {
      ConfigAPI.get('panicKey').then(saved => {
        input.value = saved ? formatPanicKey(saved) : '';
      });
    }
  });
}
