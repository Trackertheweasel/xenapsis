document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-short]').forEach(el => {
    el.addEventListener('click', e => {
      const url = (el as HTMLElement).getAttribute('data-short');
      if (url) {
        e.preventDefault();
        // The address bar's submit sets the transport and reports failures.
        const input = window.parent.document.getElementById('urlbar') as HTMLInputElement | null;
        if (!input) return;
        input.value = url;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
    });
  });
});
