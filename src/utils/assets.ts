import ConfigAPI from './config';
import { addCustom, customKey, readCustom, removeCustom, type CustomTile } from './custom';
import { checkAndShow } from './diagnostics';
import { encodeProxyUrl, scramjetWrapper } from './pro';
import { renderIcons } from './icons';
import { ensureTransport } from './transport';

type CardItem = {
  el: HTMLDivElement;
  n: string;
  d: string;
  sn: string;
};

document.addEventListener('DOMContentLoaded', async () => {
  scramjetWrapper.init();
  const input = document.querySelector<HTMLInputElement>('[data-input]');
  const box = document.querySelector<HTMLDivElement>('[data-container]');
  const empty = document.querySelector<HTMLDivElement>('[data-empty]');
  const count = document.querySelector<HTMLSpanElement>('[data-visible]');

  if (!input || !box) return;

  const key = customKey(box.dataset.type || '');
  let custom: CustomTile[] = [];
  try {
    custom = readCustom(await ConfigAPI.get(key));
  } catch {}
  const addButton = box.querySelector<HTMLButtonElement>('[data-add-custom]');
  let lastCustom: Element | null = addButton;
  for (const tile of custom) {
    const el = customCard(tile);
    lastCustom?.after(el);
    lastCustom = el;
  }
  if (custom.length) renderIcons();

  const toItem = (el: HTMLDivElement): CardItem => ({
    el,
    n: el.querySelector('h2')?.textContent?.toLowerCase() || '',
    d: el.querySelector('p')?.textContent?.toLowerCase() || '',
    sn: el.dataset.name?.toLowerCase() || '',
  });
  const items: CardItem[] = Array.from(box.querySelectorAll<HTMLDivElement>('.card')).map(toItem);

  // Pictures load as their card nears the screen: with about 400 games, loading them all at once
  // costs every visitor (and the server's monthly transfer) several megabytes.
  const showPicture = (el: HTMLDivElement) => {
    const bg = el.dataset.bg;
    if (!bg) return;
    const img = new Image();
    img.onload = () => {
      el.classList.remove('card-loading');
      el.querySelector('.card-tile')?.remove();
      const div = el.querySelector<HTMLElement>('.card-bg');
      if (div) div.style.backgroundImage = `url('${bg}')`;
    };
    img.onerror = () => el.classList.remove('card-loading');
    img.src = bg;
  };
  const near =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          entries => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              near?.unobserve(e.target);
              showPicture(e.target as HTMLDivElement);
            }
          },
          { rootMargin: '600px' },
        )
      : null;
  for (const { el } of items) {
    if (near) near.observe(el);
    else showPicture(el);
  }

  function update(): void {
    const vis = items.filter(({ el }) => el.style.display !== 'none').length;
    if (count) count.textContent = String(vis);
    const total = document.querySelector<HTMLSpanElement>('[data-total]');
    if (total) total.textContent = String(items.length);
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

  function bind(el: HTMLDivElement) {
    el.querySelector('[data-remove]')?.addEventListener('click', async e => {
      e.stopPropagation();
      custom = removeCustom(custom, el.dataset.href || '');
      await ConfigAPI.set(key, custom);
      items.splice(
        items.findIndex(i => i.el === el),
        1,
      );
      el.remove();
      update();
    });
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
      // Games from GitHub mirrors need Scramjet, whose service worker gives their files the right type (src/sw.js).
      const backend = await ConfigAPI.get('backend');
      window.location.href = encodeProxyUrl(url, isMirrored(url) ? 'sc' : backend);
    });
    el.addEventListener('keydown', e => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el.click();
      }
    });
  }
  for (const { el } of items) bind(el);

  const dialog = document.querySelector<HTMLDialogElement>('[data-custom-dialog]');
  const form = dialog?.querySelector<HTMLFormElement>('[data-custom-form]');
  const error = dialog?.querySelector<HTMLElement>('[data-custom-error]');
  addButton?.addEventListener('click', () => {
    form?.reset();
    if (error) error.textContent = '';
    dialog?.showModal();
  });
  dialog?.querySelector('[data-custom-cancel]')?.addEventListener('click', () => dialog.close());
  form?.addEventListener('submit', async e => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      custom = addCustom(custom, {
        name: String(data.get('name') ?? ''),
        url: String(data.get('url') ?? ''),
      });
    } catch (err) {
      if (error) error.textContent = (err as Error).message;
      return;
    }
    await ConfigAPI.set(key, custom);
    const el = customCard(custom[custom.length - 1]);
    lastCustom?.after(el);
    lastCustom = el;
    items.push(toItem(el));
    bind(el);
    renderIcons();
    dialog?.close();
    update();
  });

  update();
});

const isMirrored = (url: string) => url.startsWith('https://raw.githubusercontent.com/');

// A card for one of the person's own tiles, built like the listed ones (asset.astro) with a letter
// in place of a picture. Text goes in as text, never as HTML.
function customCard(tile: CustomTile): HTMLDivElement {
  const el = document.createElement('div');
  el.className =
    'card group bg-background-overlay relative flex h-44 cursor-pointer flex-col justify-end overflow-hidden rounded-lg transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-[#6366f1] focus-visible:outline-none';
  el.dataset.href = tile.url;
  el.dataset.name = tile.name;
  el.setAttribute('role', 'link');
  el.tabIndex = 0;
  el.setAttribute('aria-label', `Open ${tile.name}`);
  const hue = [...tile.name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const bg = document.createElement('div');
  bg.className = 'absolute inset-0 flex items-start justify-center pt-6';
  bg.style.background = `linear-gradient(135deg, hsl(${hue} 45% 30%), hsl(${(hue + 40) % 360} 40% 18%))`;
  const letter = document.createElement('span');
  letter.className = 'text-5xl leading-none font-black text-white/80';
  letter.textContent = tile.name.charAt(0).toUpperCase();
  bg.append(letter);
  const shade = document.createElement('div');
  shade.className = 'absolute inset-0 bg-linear-to-t from-black/80 via-black/40 to-transparent';
  const text = document.createElement('div');
  text.className = 'relative z-10 p-4';
  const h2 = document.createElement('h2');
  h2.className = 'mb-1 font-semibold text-white drop-shadow-lg';
  h2.textContent = tile.name;
  const p = document.createElement('p');
  p.className = 'line-clamp-2 text-xs text-gray-300 drop-shadow-md';
  p.textContent = `Added by you · ${new URL(tile.url).hostname}`;
  text.append(h2, p);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.dataset.remove = '';
  remove.setAttribute('aria-label', `Remove ${tile.name}`);
  remove.className =
    'absolute top-2 right-2 z-20 flex h-8 w-8 items-center justify-center rounded-md bg-black/50 text-white/80 hover:bg-black/70 hover:text-white';
  const icon = document.createElement('i');
  icon.dataset.lucide = 'trash-2';
  icon.className = 'h-4 w-4';
  remove.append(icon);
  el.append(bg, shade, text, remove);
  return el;
}
