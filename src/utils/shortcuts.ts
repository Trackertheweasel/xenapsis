import { openInPersec, remove, safeLogo, DEFAULT_LOGO, type Bookmark } from './bookmarks';
import ConfigAPI from './config';

const list = document.getElementById('shortcuts');
const empty = document.getElementById('shortcuts-empty');

function card(b: Bookmark): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'group relative';

  // A button, not a link: a real link would open the site outside the proxy on a middle-click.
  const open = document.createElement('button');
  open.type = 'button';
  open.className =
    'shortcut-card bg-background-overlay/80 border-border-default/20 relative flex w-full cursor-pointer flex-col items-center justify-center space-y-2 rounded-2xl border p-3 shadow-lg backdrop-blur-md transition-all duration-200 hover:scale-105 sm:max-w-40 sm:min-w-30 sm:space-y-3 sm:p-5';
  const frame = document.createElement('div');
  frame.className =
    'bg-background-overlay/90 border-border-default/20 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border sm:h-16 sm:w-16';
  const img = document.createElement('img');
  img.className = 'h-8 w-8 object-contain sm:h-10 sm:w-10';
  img.alt = '';
  img.src = safeLogo(b.logo);
  img.onerror = () => {
    img.onerror = null;
    img.src = DEFAULT_LOGO;
  };
  frame.append(img);
  const name = document.createElement('p');
  name.className =
    'text-text-header max-w-30 text-center text-sm font-semibold wrap-break-word sm:text-base';
  name.textContent = b.name;
  open.append(frame, name);
  open.addEventListener('click', () => openInPersec(b.redir));

  const del = document.createElement('button');
  del.type = 'button';
  del.className =
    'absolute -top-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#1f1d2e] text-white/70 opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-300 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';
  del.textContent = '×';
  del.setAttribute('aria-label', `Remove ${b.name} from shortcuts`);
  del.addEventListener('click', async () => {
    del.disabled = true;
    const current: Bookmark[] = (await ConfigAPI.getIndecator('shortcuts')) || [];
    await ConfigAPI.set('shortcuts', remove(current, b.redir));
    await render();
    // Keep keyboard focus on the grid instead of losing it with the removed card.
    list?.querySelector<HTMLElement>('button')?.focus();
  });

  li.append(open, del);
  return li;
}

async function render() {
  if (!list) return;
  let items: Bookmark[] = [];
  try {
    items = (await ConfigAPI.getIndecator('shortcuts')) || [];
  } catch {}
  list.replaceChildren(...items.map(card));
  if (empty) empty.hidden = items.length > 0;
}

render();
