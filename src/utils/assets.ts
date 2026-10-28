import ConfigAPI from './config';
import { checkAndShow } from './diagnostics';
import { scramjetWrapper, vWrapper } from './pro';
import { ensureTransport } from './transport';

type CardItem = {
  el: HTMLDivElement;
  n: string;
  d: string;
  sn: string;
};

document.addEventListener('DOMContentLoaded', async () => {
  scramjetWrapper.init();
  const sc = scramjetWrapper.getConfig();
  const input = document.querySelector<HTMLInputElement>('[data-input]');
  const box = document.querySelector<HTMLDivElement>('[data-container]');
  const empty = document.querySelector<HTMLDivElement>('[data-empty]');
  const count = document.querySelector<HTMLSpanElement>('[data-visible]');

  if (!input || !box) return;

  const items: CardItem[] = Array.from(box.querySelectorAll<HTMLDivElement>('.card')).map(el => ({
    el,
    n: el.querySelector('h2')?.textContent?.toLowerCase() || '',
    d: el.querySelector('p')?.textContent?.toLowerCase() || '',
    sn: el.dataset.name?.toLowerCase() || '',
  }));

  for (const { el } of items) {
    const bg = el.dataset.bg;
    if (!bg) continue;
    const img = new Image();
    img.onload = () => {
      el.classList.remove('card-loading');
      el.querySelector('.card-tile')?.remove();
      const div = el.querySelector<HTMLElement>('.card-bg');
      if (div) div.style.backgroundImage = `url('${bg}')`;
    };
    img.onerror = () => el.classList.remove('card-loading');
    img.src = bg;
  }

  function update(): void {
    const vis = items.filter(({ el }) => el.style.display !== 'none').length;
    if (count) count.textContent = String(vis);
    const show = vis === 0 && input && input.value.trim() !== '';
    empty?.classList.toggle('hidden', !show);
    empty?.classList.toggle('flex', !!show);
  }

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    for (const { el, n, d } of items) {
      el.style.display = n.includes(q) || d.includes(q) ? '' : 'none';
    }
    update();
  });

  document.querySelector<HTMLButtonElement>('[data-random]')?.addEventListener('click', () => {
    const vis = items.filter(({ el }) => el.style.display !== 'none');
    if (vis.length) vis[Math.floor(Math.random() * vis.length)].el.click();
  });

  let rev = false;
  document.querySelector<HTMLButtonElement>('[data-sort]')?.addEventListener('click', function () {
    rev = !rev;
    items.sort((a, b) => (rev ? b.sn.localeCompare(a.sn) : a.sn.localeCompare(b.sn)));
    this.querySelector('span')!.textContent = rev ? 'Z-A' : 'A-Z';
    for (const { el } of items) box.appendChild(el);
  });

  document.querySelector<HTMLButtonElement>('[data-clear]')?.addEventListener('click', () => {
    input.value = '';
    for (const { el } of items) el.style.display = '';
    update();
  });

  const views = ['grid', 'list', 'compact'] as const;
  const btns = views.map(v => document.querySelector<HTMLButtonElement>(`[data-view="${v}"]`));

  function setActive(btn: HTMLButtonElement) {
    for (const b of btns) {
      b?.classList.remove('bg-background', 'text-text-header');
      b?.classList.add('text-text-secondary');
    }
    btn.classList.add('bg-background', 'text-text-header');
    btn.classList.remove('text-text-secondary');
  }

  btns[0]?.addEventListener('click', function () {
    for (const { el } of items) {
      el.classList.remove('h-32', 'h-36');
      el.classList.add('h-44');
      const p = el.querySelector<HTMLElement>('p');
      if (p) p.style.display = '';
    }
    box.className = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4';
    setActive(this);
  });

  btns[1]?.addEventListener('click', function () {
    for (const { el } of items) {
      el.classList.remove('h-32', 'h-44');
      el.classList.add('h-36');
      const p = el.querySelector<HTMLElement>('p');
      if (p) p.style.display = '';
    }
    box.className = 'flex flex-col gap-4';
    setActive(this);
  });

  btns[2]?.addEventListener('click', function () {
    for (const { el } of items) {
      el.classList.remove('h-36', 'h-44');
      el.classList.add('h-32');
      const p = el.querySelector<HTMLElement>('p');
      if (p) p.style.display = 'none';
    }
    box.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3';
    setActive(this);
  });

  for (const { el } of items) {
    el.addEventListener('click', async () => {
      const url = el.dataset.href;
      if (!url) return;

      try {
        await ensureTransport();
      } catch {
        checkAndShow({ runtime: () => scramjetWrapper.init() });
        return;
      }

      // Opens with whichever engine is chosen in Settings ('u' is Ultraviolet), each with its own encoding.
      const uv = vWrapper.getConfig();
      window.location.href =
        (await ConfigAPI.get('backend')) === 'u'
          ? uv.prefix + uv.encodeUrl(url)
          : sc.prefix + sc.codec.encode(url);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  }

  update();
});
