// The start page's shortcut tiles: the first saved bookmarks, added, edited and reordered here.
import { openInPersec, remove, safeLogo, toWebUrl, DEFAULT_LOGO, type Bookmark } from './bookmarks';
import ConfigAPI, { loadBookmarks } from './config';
import { renderIcons } from './icons';
import { MAX_SHORTCUTS, STARTERS, initial, move, saveShortcut, seedShortcuts } from './personalize';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const list = $('shortcuts');
const empty = $('shortcuts-empty');
const more = $<HTMLAnchorElement>('shortcuts-more');
const status = $('shortcuts-status');
const addBtn = $<HTMLButtonElement>('shortcut-add');
const dialog = $<HTMLDialogElement>('shortcut-dialog');
const form = $<HTMLFormElement>('shortcut-form');
const title = $('shortcut-title');
const nameInput = $<HTMLInputElement>('shortcut-name');
const urlInput = $<HTMLInputElement>('shortcut-url');
const error = $('shortcut-error');

let items: Bookmark[] = [];
// The address of the shortcut being edited; undefined while adding one.
let editing: string | undefined;
let opener: HTMLElement | null = null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string, isError = false) {
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('text-red-300', isError);
  clearTimeout(statusTimer);
  if (!isError) statusTimer = setTimeout(() => (status.textContent = ''), 4000);
}

// The site's first letter, for tiles without an icon of their own.
function letter(b: Bookmark) {
  const span = document.createElement('span');
  span.className = 'text-accent text-xl font-bold sm:text-2xl';
  span.textContent = initial(b);
  return span;
}

function tile(b: Bookmark): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'group relative';

  // A button, not a link: a real link would open the site outside the proxy on a middle-click.
  const open = document.createElement('button');
  open.type = 'button';
  open.className =
    'bg-background-overlay/70 border-border-default/40 hover:border-accent/50 hover:bg-background-overlay/90 flex h-full w-full cursor-pointer flex-col items-center gap-2 rounded-2xl border px-2 py-3 shadow-lg backdrop-blur-md transition duration-200 hover:-translate-y-0.5 sm:gap-3 sm:py-4';
  const frame = document.createElement('span');
  frame.className =
    'bg-accent/10 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl border border-white/10 sm:h-14 sm:w-14';
  const logo = safeLogo(b.logo);
  if (logo === DEFAULT_LOGO) frame.append(letter(b));
  else {
    const img = document.createElement('img');
    img.className = 'h-7 w-7 object-contain sm:h-8 sm:w-8';
    img.alt = '';
    img.src = logo;
    img.onerror = () => img.replaceWith(letter(b));
    frame.append(img);
  }
  const name = document.createElement('span');
  name.className = 'w-full truncate px-1 text-center text-sm font-medium text-white/90';
  name.textContent = b.name;
  open.append(frame, name);
  open.title = b.name;
  open.addEventListener('click', () => openInPersec(b.redir));

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className =
    'bg-background-overlay/95 absolute top-1 right-1 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-white/70 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-white focus-visible:opacity-100 [@media(hover:none)]:opacity-100';
  edit.setAttribute('aria-label', `Edit ${b.name}`);
  const icon = document.createElement('i');
  icon.dataset.lucide = 'pencil';
  icon.className = 'h-4 w-4';
  edit.append(icon);
  edit.addEventListener('click', () => openEditor(edit, b.redir));

  li.append(open, edit);
  return li;
}

async function render() {
  if (!list) return;
  try {
    items = await loadBookmarks();
  } catch {
    items = [];
    say('Your shortcuts couldn’t be loaded. Reload the page to try again.', true);
  }
  const shown = items.slice(0, MAX_SHORTCUTS);
  list.replaceChildren(...shown.map(tile));
  list.hidden = shown.length === 0;
  if (empty) empty.hidden = shown.length > 0;
  if (more) {
    const hidden = items.length - shown.length;
    more.textContent = hidden > 0 ? `All bookmarks (${hidden} more)` : 'All bookmarks';
  }
  renderIcons();
}

// Reads the latest list before changing it, so two open tabs editing don't undo each other.
// Throws with a message that can be shown if the change isn't valid or can't be saved.
async function change(edit: (list: Bookmark[]) => Bookmark[]) {
  const next = edit(await loadBookmarks());
  await ConfigAPI.set('bm', next);
  await render();
}

// The edit button on the tile for `redir`, to return focus to after the tiles are re-drawn.
const editButtonFor = (redir: string) =>
  list?.children[items.findIndex(b => b.redir === redir)]?.lastElementChild as HTMLElement | null;

function syncMoveButtons() {
  const i = items.findIndex(b => b.redir === editing);
  const last = Math.min(items.length, MAX_SHORTCUTS) - 1;
  form?.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(btn => {
    btn.disabled = btn.dataset.move === '-1' ? i <= 0 : i < 0 || i >= last;
  });
}

function showError(text: string) {
  if (error) error.textContent = text;
  urlInput?.setAttribute('aria-invalid', String(!!text));
}

function openEditor(from: HTMLElement, redir?: string) {
  if (!dialog || !form || !nameInput || !urlInput) return;
  const b = items.find(x => x.redir === redir);
  editing = b?.redir;
  opener = from;
  if (title) title.textContent = b ? 'Edit shortcut' : 'Add shortcut';
  nameInput.value = b?.name ?? '';
  urlInput.value = b?.redir ?? '';
  showError('');
  form.querySelector<HTMLElement>('[data-edit-only]')!.hidden = !b;
  syncMoveButtons();
  dialog.showModal();
  (b ? nameInput : urlInput).focus();
}

let saving = false;
form?.addEventListener('submit', async e => {
  e.preventDefault();
  if (!nameInput || !urlInput || saving) return;
  // What was typed when Save was pressed, not whatever the fields hold once storage answers.
  const was = editing;
  const input = { name: nameInput.value, url: urlInput.value };
  saving = true;
  try {
    let pushedOut: Bookmark | undefined;
    await change(list => {
      const next = saveShortcut(list, input, was);
      if (was === undefined && list.length >= MAX_SHORTCUTS) pushedOut = list[MAX_SHORTCUTS - 1];
      return next;
    });
    if (was !== undefined) opener = editButtonFor(toWebUrl(input.url) ?? '');
    dialog?.close();
    const name = input.name.trim() || 'Shortcut';
    say(
      was !== undefined
        ? 'Shortcut saved.'
        : pushedOut
          ? `Added ${name}. ${pushedOut.name} is now under All bookmarks.`
          : `Added ${name}.`,
    );
  } catch (err) {
    showError(err instanceof Error ? err.message : 'That shortcut couldn’t be saved.');
    urlInput.focus();
  } finally {
    saving = false;
  }
});

form?.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(btn =>
  btn.addEventListener('click', async () => {
    const i = items.findIndex(b => b.redir === editing);
    try {
      await change(list => move(list, i, Number(btn.dataset.move)));
      if (editing) opener = editButtonFor(editing);
      syncMoveButtons();
      // A disabled button drops focus; keep it on the other one.
      if (btn.disabled)
        form.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)')?.focus();
    } catch {
      showError('That change couldn’t be saved.');
    }
  }),
);

form?.querySelector('[data-remove]')?.addEventListener('click', async () => {
  const target = editing;
  if (target === undefined) return;
  const name = items.find(b => b.redir === target)?.name ?? 'Shortcut';
  try {
    await change(list => remove(list, target));
    opener = null;
    dialog?.close();
    say(`Removed ${name}.`);
  } catch {
    showError('That shortcut couldn’t be removed.');
  }
});

form?.querySelector('[data-cancel]')?.addEventListener('click', () => dialog?.close());

// Back to where the person was; a re-drawn tile's button is gone, so fall back to Add shortcut.
dialog?.addEventListener('close', () => (opener?.isConnected ? opener : addBtn)?.focus());

addBtn?.addEventListener('click', () => openEditor(addBtn));

// Only when someone asks: the starters are never put back on their own.
$('shortcuts-starters')?.addEventListener('click', async () => {
  try {
    await change(list => seedShortcuts(list, STARTERS));
    say('Added suggested sites.');
    list?.querySelector('button')?.focus();
  } catch {
    say('The suggested sites couldn’t be added.', true);
  }
});

render();
