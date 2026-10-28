import ConfigAPI from '../config';
import { postToServiceWorker } from '../serviceworker';
import { SettingsAPI } from './api';
import { cloakInputs, initAutoCloak, initExitPrompt, setCloak } from './cloak';
import { notify, syncSwitches } from './ui';

// The Settings page's generic controls, each saving to the setting its data-* attribute names:
// switches (data-toggle), text fields (data-input), dropdowns (data-dropdown), the search engine
// buttons (data-engine) and the proxy engine buttons (data-proxy).

export function initToggles() {
  document.querySelectorAll('.toggle').forEach(toggle => {
    toggle.addEventListener('click', async () => {
      toggle.classList.toggle('active');
      const key = toggle.getAttribute('data-toggle');
      const on = toggle.classList.contains('active');

      if (key) {
        if (on) {
          await SettingsAPI.enable(key);
        } else {
          await SettingsAPI.disable(key);
        }

        if (key === 'adBlock') {
          postToServiceWorker({ type: 'ADBLOCK', data: { enabled: on } });
        }

        switch (key) {
          case 'cloak': {
            const { titleIn, iconIn } = cloakInputs();
            if (titleIn) titleIn.disabled = !on;
            if (iconIn) iconIn.disabled = !on;
            setCloak(on, titleIn?.value, iconIn?.value);
            if (on) {
              const tabSwitchToggle = document.querySelector('[data-toggle="tabSwitchCloak"]');
              if (tabSwitchToggle?.classList.contains('active')) {
                tabSwitchToggle.classList.remove('active');
                await SettingsAPI.disable('tabSwitchCloak');
                initAutoCloak(false);
              }
            }
            break;
          }
          case 'tabSwitchCloak': {
            if (on) {
              const cloakToggle = document.querySelector('[data-toggle="cloak"]');
              if (cloakToggle?.classList.contains('active')) {
                cloakToggle.classList.remove('active');
                await SettingsAPI.disable('cloak');
                const { titleIn, iconIn } = cloakInputs();
                if (titleIn) titleIn.disabled = true;
                if (iconIn) iconIn.disabled = true;
                setCloak(false);
              }
            }
            initAutoCloak(on);
            break;
          }
          case 'beforeUnload': {
            initExitPrompt(on);
            break;
          }
          case 'autoCloak': {
            initAutoCloak(on);
            break;
          }
          default:
            break;
        }
        syncSwitches();
        notify();
      }
    });
  });
}

// Saves a text field (on leaving it, or on Enter) and applies what depends on it.
async function saveInput(el: HTMLInputElement) {
  const key = el.getAttribute('data-input');
  // An empty tunnel address means this server's own; every other field needs a value.
  if (!key || (!el.value && key !== 'wispUrl')) return false;

  await ConfigAPI.set(key, key === 'wispUrl' ? el.value.trim() : el.value);
  notify();

  if (key === 'wispUrl') {
    if (el.value.trim()) el.placeholder = el.value.trim();
    // Loaded here only: the rest of Settings doesn't need the proxy's connection code.
    const { applyTransport } = await import('../transport');
    applyTransport().catch(() =>
      notify('Saved. The new tunnel address applies when Persec reloads.'),
    );
  }

  if (key === 'cloakTitle' || key === 'cloakFavicon') {
    const toggle = document.querySelector('[data-toggle="cloak"]');
    if (toggle?.classList.contains('active')) {
      const { titleIn, iconIn } = cloakInputs();
      setCloak(true, titleIn?.value, iconIn?.value);
    }
  }
  return true;
}

export function initInputs() {
  document.querySelectorAll('[data-input]').forEach(input => {
    input.addEventListener('blur', e => saveInput(e.target as HTMLInputElement));

    input.addEventListener('keydown', async e => {
      if ((e as KeyboardEvent).key === 'Enter') {
        const el = e.target as HTMLInputElement;
        if (await saveInput(el)) el.blur();
      }
    });
  });
}

export function initDropdowns() {
  const dropdowns = document.querySelectorAll('[data-dropdown]');

  dropdowns.forEach(dd => {
    const btn = dd.querySelector('.dropdown-selected');
    const opts = dd.querySelectorAll('.dropdown-option');

    btn?.addEventListener('click', e => {
      e.stopPropagation();
      dd.classList.toggle('open');
      dropdowns.forEach(d => {
        if (d !== dd) d.classList.remove('open');
      });
    });

    opts.forEach(opt => {
      opt.addEventListener('click', async () => {
        const val = opt.getAttribute('data-value');
        const txt = opt.textContent?.trim();
        const key = dd.getAttribute('data-dropdown');

        const display = dd.querySelector('[data-dropdown-value]');
        if (display) display.textContent = txt || '';

        opts.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');

        if (key && val) {
          await ConfigAPI.set(key, val);
          notify();
        }

        dd.classList.remove('open');
      });
    });
  });

  document.addEventListener('click', () => {
    dropdowns.forEach(d => d.classList.remove('open'));
  });
}

// Highlights one search engine button, or none.
function styleEngine(btn: Element, on: boolean) {
  btn.classList.toggle('bg-[#6366f1]/15', on);
  btn.classList.toggle('border-[#6366f1]/50', on);
  btn.querySelector('.engine-check')?.classList.toggle('hidden', !on);
  btn.querySelector('.engine-icon')?.classList.toggle('text-[#6366f1]', on);
  const txt = btn.querySelector('.engine-text');
  txt?.classList.toggle('text-[#6366f1]', on);
  txt?.classList.toggle('font-semibold', on);
}

// Marks the button for this search engine's URL as the chosen one.
export function markEngine(url: string) {
  document.querySelectorAll('[data-engine]').forEach(btn => {
    if (btn.getAttribute('data-engine') === url) styleEngine(btn, true);
  });
}

export function initEngines() {
  document.querySelectorAll('[data-engine]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.getAttribute('data-engine');
      if (url) {
        await ConfigAPI.set('engine', url);
        const input = document.querySelector('[data-input="engine"]') as HTMLInputElement;
        if (input) input.value = url;

        document.querySelectorAll('[data-engine]').forEach(b => styleEngine(b, false));
        styleEngine(btn, true);

        notify();
      }
    });
  });
}

export function initProxyBackend() {
  const proxyButtons = document.querySelectorAll('[data-proxy]');
  function updateProxyUI(val: string) {
    proxyButtons.forEach(btn => {
      const type = btn.getAttribute('data-proxy');
      const isActive =
        (type === 'ultraviolet' && val === 'u') || (type === 'scramjet' && val === 'sc');
      if (isActive) {
        btn.classList.add('border-[#6366f1]', 'bg-[#6366f1]/10');
      } else {
        btn.classList.remove('border-[#6366f1]', 'bg-[#6366f1]/10');
      }
    });
  }
  proxyButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.getAttribute('data-proxy');
      const val = type === 'ultraviolet' ? 'u' : 'sc';
      await ConfigAPI.set('backend', val);
      updateProxyUI(val);
      notify();
    });
  });
  ConfigAPI.get('backend').then(val => {
    updateProxyUI(val === 'u' ? 'u' : 'sc');
  });
}
