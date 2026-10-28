import { renderIcons } from './icons';
import { looksLikeDomain } from './url';

renderIcons();
['astro:page-load', 'astro:after-swap'].forEach(evt => {
  document.addEventListener(evt, () => renderIcons());
});

const urlbar = document.getElementById('urlbar') as HTMLInputElement | null;
const quick: Record<string, string> = {
  'persec://settings': 'Settings',
  'persec://new': 'New Page',
  'persec://games': 'Games',
  'persec://apps': 'Apps',
  'persec://privacy': 'Privacy & Safety',
  'persec://bookmarks': 'Bookmarks',
  'persec://ai': 'PerSec AI',
};

let timer: number | null = null;
let open = false;
let prev = '';
// Bumped on Enter so a pending or in-flight update can't reopen the dropdown after navigating.
let generation = 0;

function isQuick(str: string): boolean {
  return str.startsWith('persec://');
}

function filterQuick(str: string): [string, string][] {
  const lc = str.toLowerCase();
  return Object.entries(quick).filter(([k]) => k.toLowerCase().includes(lc));
}

// Web addresses (typed, or the current page's address shown when the bar is focused)
// are never sent to the suggestion service.
function isAddress(str: string): boolean {
  return (
    isQuick(str) ||
    /^([a-z][a-z\d+.-]*:\/\/|(about|data|blob|javascript|mailto):)/i.test(str) ||
    looksLikeDomain(str)
  );
}

async function fetchSugg(q: string): Promise<string[]> {
  if (!q || isAddress(q)) return [];
  try {
    const r = await fetch(`/api/query?q=${encodeURIComponent(q)}`);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.suggestions) ? j.suggestions : [];
  } catch {
    return [];
  }
}

function isMath(str: string): boolean {
  const norm = str.trim().replace(/x/gi, '*');
  return /^[0-9+\-*/().%^√\s]+$/.test(norm) && !/^[0-9.]+$/.test(norm) && /[+\-*/%^√()]/.test(norm);
}

function calc(str: string): string | null {
  try {
    const expr = str
      .replace(/x/gi, '*')
      .replace(/√(\d+)/g, 'Math.sqrt($1)')
      .replace(/√/g, 'Math.sqrt')
      .replace(/\^/g, '**')
      .replace(/(\d+)%/g, '($1/100)');
    const ans = Function('"use strict";return(' + expr + ')')();
    return typeof ans === 'number' && isFinite(ans) ? String(ans) : null;
  } catch {
    return null;
  }
}

function create(): HTMLDivElement {
  close();
  const m = document.createElement('div');
  m.id = 'suggestions';
  m.setAttribute('role', 'listbox');
  m.setAttribute('aria-label', 'Suggestions');
  m.className =
    'absolute top-full z-50 mt-0 w-full rounded-b-xl border-x border-b border-[#3a3758] bg-[#1f1f30]/95 shadow-2xl backdrop-blur-xl transition-all duration-200 overflow-y-auto opacity-0 hidden';
  urlbar?.parentElement?.appendChild(m);
  return m;
}

function show(m: HTMLDivElement): void {
  if (!urlbar?.value.trim()) {
    close();
    return;
  }
  m.classList.remove('opacity-0', 'hidden');
  const b = urlbar.getBoundingClientRect();
  const max = window.innerHeight - b.bottom - 16;
  m.style.maxHeight = `${Math.max(max, 100)}px`;
  open = true;
  urlbar.setAttribute('aria-expanded', 'true');
}

function close(): void {
  const m = document.getElementById('suggestions');
  urlbar?.setAttribute('aria-expanded', 'false');
  urlbar?.removeAttribute('aria-activedescendant');
  if (m) {
    // Renamed so a new list can take the id while this one fades out.
    m.id = '';
    m.classList.add('opacity-0');
    setTimeout(() => m.remove(), 200);
  }
  open = false;
}

function select(val: string): void {
  if (!urlbar) return;
  urlbar.value = val;
  close();
  urlbar.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const options = () =>
  Array.from(document.querySelectorAll<HTMLElement>('#suggestions [role="option"]'));

function activeOption(): HTMLElement | null {
  const id = urlbar?.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

// Moves the highlight; past either end it returns to the typed text, as browsers do.
function move(by: 1 | -1): void {
  const all = options();
  const i = all.indexOf(activeOption()!);
  const next = i === -1 ? (by === 1 ? 0 : all.length - 1) : i + by;
  all.forEach((o, j) => {
    const on = j === next;
    o.setAttribute('aria-selected', String(on));
    o.classList.toggle('bg-[#2a293f]', on);
    if (on) o.scrollIntoView({ block: 'nearest' });
  });
  if (all[next]) urlbar?.setAttribute('aria-activedescendant', all[next].id);
  else urlbar?.removeAttribute('aria-activedescendant');
}

function esc(text: string): string {
  const t = document.createElement('div');
  t.textContent = text;
  // innerHTML leaves " as is, and these strings also go inside data-value="...".
  return t.innerHTML.replace(/"/g, '&quot;');
}

function render(sugg: string[], qm: [string, string][], math: string | null, sq: string): void {
  close();
  if (!urlbar?.value.trim()) return;

  const trim = sugg.slice(0, 7);
  const showq = isQuick(sq);

  if (!trim.length && !qm.length && !math) return;

  const dd = create();
  const html: string[] = [];

  if (math) {
    html.push(
      `<div class="flex items-center space-x-3 px-4 py-3 text-(--text-header) cursor-pointer hover:bg-[#2a293f] transition-colors" data-value="${esc(math)}"><i data-lucide="calculator" class="h-5 w-5 text-green-400"></i><span>${esc(math)}</span></div>`,
    );
  }

  if (trim.length) {
    html.push(
      `<div aria-hidden="true" class="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-(--text-secondary)">Suggestions for <span class="text-white">"${esc(sq)}"</span></div>`,
    );
    trim.forEach(s => {
      html.push(
        `<div class="flex items-center space-x-3 px-4 py-3 text-(--text-header) cursor-pointer hover:bg-[#2a293f] transition-colors" data-value="${esc(s)}"><i data-lucide="search" class="h-4 w-4 text-(--text-secondary)"></i><span>${esc(s)}</span></div>`,
      );
    });
  }

  if (showq && qm.length) {
    html.push(
      `<div aria-hidden="true" class="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-(--text-secondary) border-t border-[#3a3758]">Persec Links</div>`,
    );
    qm.forEach(([link, desc]) => {
      html.push(
        `<div class="flex items-center justify-between px-4 py-3 text-(--text-header) cursor-pointer hover:bg-[#2a293f] transition-colors" data-value="${esc(link)}"><div class="flex items-center space-x-3"><i data-lucide="globe" class="h-5 w-5 text-purple-400"></i><span>${esc(link)}</span></div><span class="text-xs text-(--text-secondary)">${esc(desc)}</span></div>`,
      );
    });
  }

  dd.innerHTML = html.join('');
  dd.querySelectorAll<HTMLElement>('[data-value]').forEach((el, i) => {
    el.id = `suggestion-${i}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const v = el.dataset.value;
      if (v) select(v);
    });
  });
  renderIcons();
  show(dd);
}

async function update(): Promise<void> {
  if (!urlbar) return;
  const cur = urlbar.value.trim();
  if (!cur) {
    close();
    return;
  }
  prev = cur;
  const gen = generation;
  const [sugg, math] = await Promise.all([
    fetchSugg(cur),
    isMath(cur) ? calc(cur) : Promise.resolve(null),
  ]);
  if (gen !== generation || urlbar.value.trim() !== prev) return;
  const qr = isQuick(cur) ? filterQuick(cur) : [];
  render(sugg, qr, math, cur);
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => {
    if (!urlbar?.value.trim()) {
      close();
      return;
    }
    update();
  }, 150);
}

function blur(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  setTimeout(() => {
    if (!document.activeElement?.closest('#suggestions')) {
      close();
    }
  }, 150);
}

if (urlbar) {
  urlbar.addEventListener('input', schedule);
  urlbar.addEventListener('focus', () => {
    if (urlbar.value.trim()) update();
  });
  urlbar.addEventListener('blur', blur);
  urlbar.addEventListener('keydown', e => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      // Runs before the address bar's own Enter handler (src/utils/navigation.ts), which then
      // opens the chosen suggestion.
      const chosen = activeOption();
      if (chosen?.dataset.value) urlbar.value = chosen.dataset.value;
      generation++;
      if (timer) clearTimeout(timer);
      timer = null;
      close();
    }
  });

  window.addEventListener('resize', () => {
    const dd = document.getElementById('suggestions') as HTMLDivElement | null;
    if (dd && open && urlbar?.value.trim()) {
      show(dd);
    } else if (dd) {
      close();
    }
  });

  document.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    if (!t.closest('#urlbar') && !t.closest('#suggestions')) {
      close();
    }
  });

  document.addEventListener(
    'mousedown',
    e => {
      const t = e.target as HTMLElement;
      if (t.closest('#suggestions')) {
        e.preventDefault();
      }
    },
    true,
  );
}
