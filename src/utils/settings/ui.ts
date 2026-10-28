// What every part of the Settings page (src/pages/st.astro) uses to talk to the person: the saved
// toast, the confirmation dialog, busy buttons and the switches' state.

let notifyTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text = 'Settings saved', error = false) {
  const notif = document.querySelector<HTMLElement>('[data-notification]');
  const box = notif?.querySelector('[data-notification-box]');
  const span = notif?.querySelector('[data-notification-text]');
  if (!notif || !box || !span) return;
  span.textContent = text;
  box.classList.toggle('border-[#10b981]/40', !error);
  box.classList.toggle('border-red-500/50', error);
  notif.classList.remove('opacity-0');
  clearTimeout(notifyTimer);
  // Errors stay up longer, as they usually say what to do next.
  notifyTimer = setTimeout(() => notif.classList.add('opacity-0'), error ? 6000 : 2500);
}

// An in-page confirmation (the <dialog data-confirm> in st.astro), so every destructive action
// asks the same way and can list everything it will do.
export function confirm(title: string, lines: string[], ok: string): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>('[data-confirm]');
  if (!dialog?.showModal) {
    return Promise.resolve(window.confirm(`${title}\n\n${lines.join('\n')}`));
  }
  dialog.querySelector('#confirm-title')!.textContent = title;
  dialog.querySelector('[data-confirm-text]')!.replaceChildren(
    ...lines.map(line => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }),
  );
  dialog.querySelector('[data-confirm-ok]')!.textContent = ok;
  dialog.returnValue = '';
  dialog.showModal();
  // Cancel has focus first, so a stray Enter doesn't delete anything.
  dialog.querySelector<HTMLButtonElement>('button[value="cancel"]')?.focus();
  return new Promise(resolve =>
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }),
  );
}

// Runs an action once at a time: the button stays disabled until it finishes or fails.
export async function busy(btn: HTMLButtonElement | null, run: () => Promise<void>) {
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    await run();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Switch semantics for the .toggle buttons, which the code here turns on and off by class.
export function syncSwitches() {
  document.querySelectorAll('.toggle').forEach(t => {
    t.setAttribute('aria-checked', String(t.classList.contains('active')));
  });
}
