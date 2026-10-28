// Short messages from the browser's own controls, read out by screen readers (src/layouts/tab.astro).
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string) {
  const el = document.getElementById('persec-status');
  if (!el) return;
  // Shown and hidden with opacity: a live region removed from the page isn't announced.
  el.textContent = text;
  el.classList.remove('opacity-0');
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    el.classList.add('opacity-0');
    el.textContent = '';
  }, 4000);
}
