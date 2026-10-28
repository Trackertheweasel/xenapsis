import ConfigAPI from '../config';
import { notify } from './ui';

// Tab cloaking (a disguised title and icon), its automatic form when Persec's tab is hidden, and the
// leave-page prompt. They act on the top window, so they work from inside a tab's frame.

export function cloakInputs() {
  return {
    titleIn: document.querySelector<HTMLInputElement>('[data-input="cloakTitle"]'),
    iconIn: document.querySelector<HTMLInputElement>('[data-input="cloakFavicon"]'),
  };
}

export function setCloak(on: boolean, title?: string | null, icon?: string | null) {
  const win = window.top || window;
  const doc = win.document;

  if (on) {
    doc.title = title || 'Google';

    let link = doc.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (!link) {
      link = doc.createElement('link');
      link.rel = 'icon';
      doc.head.appendChild(link);
    }
    link.href = icon || 'https://www.google.com/favicon.ico';
  } else {
    doc.title = 'Persec';
    let link = doc.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (link) link.href = '/favicon.ico';
  }
}

const handleAutoCloak = async () => {
  const manual = await ConfigAPI.get('cloak');
  if (manual === 'on') return;

  const title = await ConfigAPI.get('cloakTitle');
  const icon = await ConfigAPI.get('cloakFavicon');
  const doc = (window.top || window).document;

  if (doc.hidden) {
    setCloak(true, title, icon);
  } else {
    setCloak(false);
  }
};

export function initAutoCloak(on: boolean) {
  const doc = (window.top || window).document;
  doc.removeEventListener('visibilitychange', handleAutoCloak);

  if (on) {
    doc.addEventListener('visibilitychange', handleAutoCloak);
  }
}

export function initPresets() {
  document.querySelectorAll('[data-cloak-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const title = btn.getAttribute('data-preset-title');
      const icon = btn.getAttribute('data-preset-favicon');

      if (title && icon) {
        const { titleIn, iconIn } = cloakInputs();

        if (titleIn) titleIn.value = title;
        if (iconIn) iconIn.value = icon;

        await ConfigAPI.set('cloakTitle', title);
        await ConfigAPI.set('cloakFavicon', icon);

        const toggle = document.querySelector('[data-toggle="cloak"]');
        if (toggle?.classList.contains('active')) {
          setCloak(true, title, icon);
        }

        notify();
      }
    });
  });
}

const handleExit = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  (e as any).returnValue = '';
  return '';
};

export function initExitPrompt(on: boolean) {
  const win = window.top || window;
  win.removeEventListener('beforeunload', handleExit);

  if (on) {
    win.addEventListener('beforeunload', handleExit);
  }
}
