// The bookmarks page (/bm, persec://bookmarks): saved bookmarks and the new-tab shortcuts.
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
import ConfigAPI from './config';

type Key = 'bm' | 'shortcuts';
const status = document.querySelector<HTMLElement>('[data-status]')!;
const btnClass =
  'min-h-11 rounded-lg border border-white/10 bg-white/5 px-3 text-sm hover:bg-white/10 disabled:opacity-50';

const say = (text: string, error = false) => {
  status.textContent = text;
  status.classList.toggle('text-red-300', error);
};

const read = async (key: Key): Promise<Bookmark[]> => (await ConfigAPI.getIndecator(key)) || [];

// Reads the latest list before changing it, so two open tabs editing don't undo each other.
async function change(key: Key, edit: (list: Bookmark[]) => Bookmark[], done: string) {
  try {
    await ConfigAPI.set(key, edit(await read(key)));
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

function row(key: Key, b: Bookmark, onNewTab: boolean): HTMLLIElement {
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
  open.append(name, url);
  open.setAttribute('aria-label', `Open ${b.name}`);
  open.addEventListener('click', () => openInPersec(b.redir));

  const actions = document.createElement('div');
  actions.className = 'flex flex-wrap gap-2';
  if (key === 'bm') {
    const pin = button(
      onNewTab ? 'On new tab' : 'Add to new tab',
      onNewTab ? `Remove ${b.name} from the new tab` : `Add ${b.name} to the new tab`,
      () =>
        change(
          'shortcuts',
          list => (onNewTab ? remove(list, b.redir) : add(list, b)),
          onNewTab ? `Removed ${b.name} from the new tab.` : `Added ${b.name} to the new tab.`,
        ),
    );
    pin.setAttribute('aria-pressed', String(onNewTab));
    actions.append(pin);
  }
  actions.append(
    button('Rename', `Rename ${b.name}`, () => startRename(li, key, b)),
    button('Remove', `Remove ${b.name}`, () =>
      change(key, list => remove(list, b.redir), `Removed ${b.name}.`),
    ),
  );

  li.append(img, open, actions);
  return li;
}

function startRename(li: HTMLLIElement, key: Key, b: Bookmark) {
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
    change(key, list => rename(list, b.redir, input.value), 'Renamed.');
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') render();
  });
  li.replaceChildren(form);
  input.focus();
  input.select();
}

async function render() {
  const [bm, shortcuts] = await Promise.all([read('bm'), read('shortcuts')]);
  for (const [key, list] of [
    ['bm', bm],
    ['shortcuts', shortcuts],
  ] as const) {
    document
      .querySelector(`[data-list="${key}"]`)!
      .replaceChildren(...list.map(b => row(key, b, has(shortcuts, b.redir))));
    document.querySelector<HTMLElement>(`[data-empty="${key}"]`)!.hidden = list.length > 0;
  }
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
  if (has(await read('bm'), redir)) {
    say('That page is already bookmarked.');
    return;
  }
  await change('bm', list => add(list, { name: String(data.get('name') || ''), redir }), 'Added.');
  form.reset();
});

render();
