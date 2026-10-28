import ConfigAPI from './config';

document.addEventListener('DOMContentLoaded', () => {
  const hoursEl = document.getElementById('hours');
  const minutesEl = document.getElementById('minutes');
  const secondsEl = document.getElementById('seconds');
  const ampmEl = document.getElementById('ampm');
  const serverEl = document.getElementById('sl');
  const refreshBtn = document.getElementById('refresh');

  let clockInterval: ReturnType<typeof setInterval> | null = null;
  let spinTimeout: ReturnType<typeof setTimeout> | null = null;

  function updateClock() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    const hs = hours.toString().padStart(2, '0');
    const ms = minutes.toString().padStart(2, '0');
    const ss = seconds.toString().padStart(2, '0');

    if (hoursEl && hoursEl.textContent !== hs) hoursEl.textContent = hs;
    if (minutesEl && minutesEl.textContent !== ms) minutesEl.textContent = ms;
    if (secondsEl && secondsEl.textContent !== ss) secondsEl.textContent = ss;
    if (ampmEl && ampmEl.textContent !== ampm) ampmEl.textContent = ampm;
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

  // Greets people by their invite's name. Open (no-invite) installs have no /api/me, so no greeting.
  const greetingEl = document.getElementById('greeting');
  fetch('/api/me', { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then(me => {
      if (!greetingEl || !me?.name) return;
      const hour = new Date().getHours();
      const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
      greetingEl.textContent = `Good ${part}, ${me.name}`;
      greetingEl.classList.remove('hidden');
    })
    .catch(() => {});

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
