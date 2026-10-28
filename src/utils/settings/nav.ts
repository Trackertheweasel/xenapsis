// Finding your way around the Settings page: the category list, the search box that filters cards,
// and the highlight that follows scrolling.

// Marks a category current in both the side list and the phone bar.
export function setActive(id: string) {
  document.querySelectorAll('[data-nav]').forEach(n => {
    const on = n.getAttribute('data-nav') === id;
    n.classList.toggle('bg-[#6366f1]/10', on);
    n.classList.toggle('text-[#6366f1]', on);
    n.classList.toggle('text-text-secondary', !on);
    if (on) n.setAttribute('aria-current', 'true');
    else n.removeAttribute('aria-current');
  });
}

function scrollTo(section: Element) {
  // Below the sticky search bar, which covers the top of the page on phones.
  const bar = document.querySelector('[data-filter-input]')?.closest('.sticky');
  const offset = (bar && getComputedStyle(bar).position === 'sticky' ? bar.clientHeight : 0) + 20;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({
    top: section.getBoundingClientRect().top + window.scrollY - offset,
    behavior: smooth ? 'smooth' : 'auto',
  });
}

export function initNav() {
  document.querySelectorAll('[data-nav]').forEach(item => {
    item.addEventListener('click', (e: Event) => {
      e.preventDefault();
      const target = item.getAttribute('data-nav')!;
      // A category is a way out of a search, so show everything again first.
      filter('');
      const section = document.querySelector(`[data-section="${target}"]`);
      if (!section) return;
      setActive(target);
      scrollTo(section);
      try {
        history.replaceState(null, '', `#${target}`);
      } catch {}
    });
  });

  const initialHash = (window.location.hash || '').replace('#', '');
  const section = initialHash && document.querySelector(`[data-section="${initialHash}"]`);
  if (section) {
    setActive(initialHash);
    scrollTo(section);
  } else {
    setActive('privacy');
  }
}

// The setting cards in a section: the children of its list, or the one card (About).
function cards(section: Element): HTMLElement[] {
  const body = section.children[1] as HTMLElement | undefined;
  if (!body) return [];
  return body.classList.contains('space-y-3')
    ? (Array.from(body.children) as HTMLElement[])
    : [body];
}

// Shows the cards whose name or description contains every word of the query.
export function filter(query: string) {
  const input = document.querySelector<HTMLInputElement>('[data-filter-input]');
  const clear = document.querySelector<HTMLElement>('[data-filter-clear]');
  const empty = document.querySelector<HTMLElement>('[data-filter-empty]');
  if (input && input.value !== query) input.value = query;
  if (clear) clear.hidden = !query;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  let first: string | null = null;

  document.querySelectorAll<HTMLElement>('[data-section]').forEach(section => {
    let found = false;
    for (const card of cards(section)) {
      const text = (card.textContent || '').toLowerCase().replace(/\s+/g, ' ');
      const match = words.every(w => text.includes(w));
      // Inline style only, so a card hidden for another reason (hidden attribute) stays hidden.
      card.style.display = match ? '' : 'none';
      if (match && !card.hidden) found = true;
    }
    section.style.display = found ? '' : 'none';
    if (found) {
      shown++;
      first ??= section.getAttribute('data-section');
    }
  });

  if (empty) {
    empty.textContent =
      words.length && !shown
        ? `No settings match “${query.trim()}”. Try another word, or clear the search.`
        : '';
  }
  if (first) setActive(first);
}

export function initSearch() {
  const search = document.querySelector<HTMLInputElement>('[data-filter-input]');
  if (!search) return;
  search.addEventListener('input', () => filter(search.value));
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      filter('');
    }
  });
  document.querySelector('[data-filter-clear]')?.addEventListener('click', () => {
    filter('');
    search.focus();
  });
}

export function initScrollSpy() {
  let ticking = false;

  const update = () => {
    ticking = false;
    // Sections hidden by a search have no position; leave the highlight to the search.
    const visible = Array.from(document.querySelectorAll<HTMLElement>('[data-section]')).filter(
      s => s.style.display !== 'none',
    );
    if (!visible.length) return;
    let current = visible[0];
    for (const section of visible) {
      if (section.getBoundingClientRect().top <= 160) current = section;
    }
    if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 2) {
      current = visible[visible.length - 1];
    }
    setActive(current.getAttribute('data-section') || 'privacy');
  };

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  });
}
