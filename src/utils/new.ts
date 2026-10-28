import ConfigAPI from './config';
import {
  PREF_DEFAULTS,
  cleanDisplayName,
  clockParts,
  greeting,
  nextQuote,
  readPrefs,
  type Prefs,
} from './personalize';

document.addEventListener('DOMContentLoaded', () => {
  const hoursEl = document.getElementById('hours');
  const minutesEl = document.getElementById('minutes');
  const secondsEl = document.getElementById('seconds');
  const ampmEl = document.getElementById('ampm');
  const serverEl = document.getElementById('sl');
  const refreshBtn = document.getElementById('refresh');

  let clockInterval: ReturnType<typeof setInterval> | null = null;
  let spinTimeout: ReturnType<typeof setTimeout> | null = null;

  let prefs: Prefs = { ...PREF_DEFAULTS };
  let inviteName = '';

  function updateClock() {
    const t = clockParts(new Date(), prefs.timeFormat);
    if (hoursEl && hoursEl.textContent !== t.hours) hoursEl.textContent = t.hours;
    if (minutesEl && minutesEl.textContent !== t.minutes) minutesEl.textContent = t.minutes;
    if (secondsEl && secondsEl.textContent !== t.seconds) secondsEl.textContent = t.seconds;
    if (ampmEl && ampmEl.textContent !== t.ampm) ampmEl.textContent = t.ampm;
  }

  async function pingServer(url: string) {
    const start = performance.now();
    try {
      await fetch(url, { method: 'HEAD', cache: 'no-cache' });
      return { ok: true, latency: Math.round(performance.now() - start) };
    } catch {
      return { ok: false, latency: 0 };
    }
  }

  // A HEAD request to this server: how fast it answers, nothing about the tunnel or sites.
  let pinging = false;
  async function updatePing() {
    if (!serverEl || pinging) return;
    pinging = true;
    serverEl.textContent = 'Measuring server response…';
    const result = await pingServer(window.location.origin);
    pinging = false;
    if (result.ok) {
      const color =
        result.latency >= 300
          ? 'text-red-500'
          : result.latency >= 100
            ? 'text-yellow-400'
            : 'text-green-400';
      const ms = document.createElement('span');
      ms.className = `${color} ml-1`;
      ms.textContent = `${result.latency}ms`;
      serverEl.replaceChildren('Server response:', ms);
    } else {
      serverEl.textContent = 'Server not responding';
    }
  }

  function handleRefreshClick() {
    if (!refreshBtn || pinging) return;
    refreshBtn.classList.add('animate-spin');
    updatePing().finally(() => {
      if (spinTimeout) clearTimeout(spinTimeout);
      spinTimeout = setTimeout(() => refreshBtn.classList.remove('animate-spin'), 800);
    });
  }

  function cleanup() {
    if (clockInterval) clearInterval(clockInterval);
    if (spinTimeout) clearTimeout(spinTimeout);
    refreshBtn?.removeEventListener('click', handleRefreshClick);
  }

  clockInterval = setInterval(updateClock, 1000);
  updateClock();

  refreshBtn?.addEventListener('click', handleRefreshClick);

  updatePing();

  // The saved look and name. Shown with the defaults if storage can't be read.
  const greetingEl = document.getElementById('greeting');
  const quoteBox = document.getElementById('quote-box');
  const quoteEl = document.getElementById('quote');
  function apply() {
    document.documentElement.dataset.theme = prefs.theme;
    const clock = document.getElementById('clock');
    if (clock) clock.hidden = prefs.showClock === 'off';
    document.querySelectorAll<HTMLElement>('[data-seconds]').forEach(el => {
      el.hidden = prefs.showSeconds === 'off';
    });
    if (ampmEl) ampmEl.hidden = prefs.timeFormat === '24';
    if (quoteBox) quoteBox.hidden = prefs.showQuote === 'off' || !quoteEl?.textContent?.trim();
    if (greetingEl)
      greetingEl.textContent = greeting(new Date().getHours(), prefs.displayName, inviteName);
    updateClock();
  }
  const keys = Object.keys(PREF_DEFAULTS) as (keyof Prefs)[];
  Promise.all(keys.map(k => ConfigAPI.get(k)))
    .then(values => (prefs = readPrefs(Object.fromEntries(keys.map((k, i) => [k, values[i]])))))
    .catch(() => {})
    .finally(() => {
      apply();
      document.getElementById('hero')?.classList.remove('opacity-0');
    });

  // The invite's name, when there's no name of the person's own. Open (no-invite) installs have no
  // /api/me. The name chosen in Customize stays in this browser and is never sent.
  fetch('/api/me', { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(me => {
      if (typeof me?.name !== 'string') return;
      inviteName = me.name;
      apply();
      if (nameInput) nameInput.placeholder = inviteName;
    })
    .catch(() => {});

  // Quotes come from Persec's own list, fetched only when someone asks for another.
  let quotes: Promise<unknown> | null = null;
  const quoteBtn = document.getElementById('quote-next') as HTMLButtonElement | null;
  quoteBtn?.addEventListener('click', async () => {
    quotes ??= fetch('/a/json/quotes.json').then(r => (r.ok ? r.json() : []));
    try {
      const q = nextQuote(await quotes, quoteEl?.textContent?.trim() ?? '');
      if (q && quoteEl) quoteEl.textContent = q;
    } catch {
      quotes = null;
    }
  });

  // Customize: every change is applied and saved at once.
  const dialog = document.getElementById('customize') as HTMLDialogElement | null;
  const statusEl = document.getElementById('customize-status');
  const nameForm = document.getElementById('name-form') as HTMLFormElement | null;
  const nameInput = document.getElementById('display-name') as HTMLInputElement | null;
  const nameError = document.getElementById('name-error');
  let opener: HTMLElement | null = null;

  function save<K extends keyof Prefs>(key: K, value: Prefs[K], done = 'Saved.') {
    prefs = { ...prefs, [key]: value };
    apply();
    ConfigAPI.set(key, value)
      .then(() => statusEl && (statusEl.textContent = done))
      .catch(() => {
        if (statusEl)
          statusEl.textContent = 'Couldn’t save: this change lasts until you close the tab.';
      });
  }

  function fillCustomize() {
    if (!dialog) return;
    if (nameInput) nameInput.value = prefs.displayName;
    if (nameError) nameError.textContent = '';
    for (const input of dialog.querySelectorAll<HTMLInputElement>('input[type=radio]')) {
      input.checked = prefs[input.name as keyof Prefs] === input.value;
    }
    for (const input of dialog.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      input.checked = prefs[input.name as keyof Prefs] === 'on';
    }
    if (statusEl) statusEl.textContent = '';
  }

  document.querySelectorAll<HTMLElement>('[data-customize-open]').forEach(btn =>
    btn.addEventListener('click', () => {
      if (!dialog) return;
      opener = btn;
      fillCustomize();
      dialog.showModal();
      nameInput?.focus();
    }),
  );
  dialog
    ?.querySelectorAll('[data-close]')
    .forEach(b => b.addEventListener('click', () => dialog.close()));
  dialog?.addEventListener('close', () => opener?.focus());
  // A click on the dimmed backdrop (the dialog itself, outside its content) closes it.
  dialog?.addEventListener('click', e => e.target === dialog && dialog.close());

  dialog?.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    // readPrefs turns anything unexpected into the default before it's saved.
    if (input.name === 'theme') save('theme', readPrefs({ theme: input.value }).theme);
    else if (input.name === 'timeFormat')
      save('timeFormat', readPrefs({ timeFormat: input.value }).timeFormat);
    else if (input.type === 'checkbox') {
      const key = input.name as 'showClock' | 'showSeconds' | 'showQuote';
      if (key in PREF_DEFAULTS) save(key, input.checked ? 'on' : 'off');
    }
  });

  nameForm?.addEventListener('submit', e => {
    e.preventDefault();
    if (!nameInput) return;
    try {
      const name = cleanDisplayName(nameInput.value);
      nameInput.value = name;
      nameInput.removeAttribute('aria-invalid');
      if (nameError) nameError.textContent = '';
      save('displayName', name, name ? `Hi, ${name}. Saved.` : 'Name cleared.');
    } catch (err) {
      nameInput.setAttribute('aria-invalid', 'true');
      if (nameError) nameError.textContent = (err as Error).message;
    }
  });
  document.getElementById('name-clear')?.addEventListener('click', () => {
    if (nameInput) nameInput.value = '';
    if (nameError) nameError.textContent = '';
    save('displayName', '', 'Name cleared.');
    nameInput?.focus();
  });

  // The guide's "seen" mark is kept with Persec's settings in this browser, never sent anywhere.
  const guide = document.getElementById('guide');
  const showGuide = (focus: boolean) => {
    if (!guide) return;
    guide.hidden = false;
    if (focus) document.getElementById('guide-title')?.focus();
  };
  if (location.hash === '#guide') showGuide(true);
  else
    ConfigAPI.get('guideDone')
      .then(done => !done && showGuide(false))
      .catch(() => showGuide(false));
  document.querySelector('[data-guide-open]')?.addEventListener('click', e => {
    e.preventDefault();
    showGuide(true);
  });
  document.querySelector('[data-guide-done]')?.addEventListener('click', () => {
    if (guide) guide.hidden = true;
    ConfigAPI.set('guideDone', true).catch(() => {});
  });

  window.addEventListener('unload', cleanup);
});
