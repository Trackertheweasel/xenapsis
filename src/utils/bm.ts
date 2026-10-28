// The bookmarks page (/bm, persec://bookmarks). The first ones are also the start page's tiles.
import {
  add,
  has,
  openInPersec,
  remove,
  rename,
  safeLogo,
  toWebUrl,
  DEFAULT_LOGO,
  type Bookmark,
} from './bookmarks';
import ConfigAPI, { loadBookmarks } from './config';
import { MAX_SHORTCUTS } from './personalize';

const status = document.querySelector<HTMLElement>('[data-status]')!;
const btnClass =
  'min-h-11 rounded-lg border border-white/10 bg-white/5 px-3 text-sm hover:bg-white/10 disabled:opacity-50';

const say = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle('text-red-300', error);
};

// Reads the latest list before changing it, so two open tabs editing don't undo each other.
async function change(edit: (list: Bookmark[]) => Bookmark[], done: string) {
  try {
    await ConfigAPI.set('bm', edit(await loadBookmarks()));
    say(done);
  } catch (err) {
    say(err instanceof Error ? err.message : 'That change couldn’t be saved.', true);
  }
  await render();
}

function button(text: string, label: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = btnClass;
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function row(b: Bookmark, onStartPage: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className =
    'bg-background-overlay/60 flex flex-wrap items-center gap-3 rounded-xl border border-white/6 p-3';

  const img = document.createElement('img');
  img.className = 'h-6 w-6 shrink-0 object-contain';
  img.alt = '';
  img.src = safeLogo(b.logo);
  img.onerror = () => {
    img.onerror = null;
    img.src = DEFAULT_LOGO;
  };

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'min-h-11 min-w-0 flex-1 text-left hover:underline';
  const name = document.createElement('span');
  name.className = 'block truncate font-medium';
  name.textContent = b.name;
  const url = document.createElement('span');
  url.className = 'text-text-secondary block truncate text-xs';
  url.textContent = b.redir;
  if (onStartPage) {
    const tag = document.createElement('span');
    tag.className = 'text-text-secondary mt-0.5 block text-xs';
    tag.textContent = 'On the start page';
    open.append(name, url, tag);
  } else open.append(name, url);
  open.setAttribute('aria-label', `Open ${b.name}`);
  open.addEventListener('click', () => openInPersec(b.redir));

  const actions = document.createElement('div');
  actions.className = 'flex flex-wrap gap-2';
  actions.append(
    button('Rename', `Rename ${b.name}`, () => startRename(li, b)),
    button('Remove', `Remove ${b.name}`, () =>
      change(list => remove(list, b.redir), `Removed ${b.name}.`),
    ),
  );

  li.append(img, open, actions);
  return li;
}

function startRename(li: HTMLLIElement, b: Bookmark) {
  const form = document.createElement('form');
  form.className = 'flex w-full flex-wrap gap-2';
  const input = document.createElement('input');
  input.value = b.name;
  input.maxLength = 300;
  input.setAttribute('aria-label', `New name for ${b.name}`);
  input.className =
    'bg-background/80 min-w-0 flex-1 rounded-lg border border-white/6 px-3 py-2 text-sm';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = btnClass;
  save.textContent = 'Save';
  const cancel = button('Cancel', 'Cancel renaming', () => render());
  form.append(input, save, cancel);
  form.addEventListener('submit', e => {
    e.preventDefault();
    // An empty name falls back to the site's address (cleanName).
    change(list => rename(list, b.redir, input.value), 'Renamed.');
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') render();
  });
  li.replaceChildren(form);
  input.focus();
  input.select();
}

async function render() {
  let bm: Bookmark[] = [];
  try {
    bm = await loadBookmarks();
  } catch {
    say('Your bookmarks couldn’t be loaded. Reload the page to try again.', true);
  }
  document
    .querySelector('[data-list="bm"]')!
    .replaceChildren(...bm.map((b, i) => row(b, i < MAX_SHORTCUTS)));
  document.querySelector<HTMLElement>('[data-empty="bm"]')!.hidden = bm.length > 0;
}

const form = document.querySelector<HTMLFormElement>('[data-add]')!;
form.addEventListener('submit', async e => {
  e.preventDefault();
  const data = new FormData(form);
  const redir = toWebUrl(String(data.get('url') || ''));
  if (!redir) {
    say('That isn’t a web address. Enter something like example.com or https://example.com.', true);
    return;
  }
  if (has(await loadBookmarks(), redir)) {
    say('That page is already bookmarked.');
    return;
  }
  await change(list => add(list, { name: String(data.get('name') || ''), redir }), 'Added.');
  form.reset();
});

render();
