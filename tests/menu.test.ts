import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installDom, key } from './dom.ts';

// The browser menu (src/utils/menu.ts) on a page laid out like src/layouts/tab.astro.
const ids = [
  'newTab',
  'fullscreen',
  'darkmode',
  'reload',
  'inspectElement',
  'cloak',
  'panic',
  'settings',
  'reopen',
  'bookmarks',
  'help',
];
const dom = installDom(`
  <button id="menubtn" aria-expanded="false">Menu</button>
  <div id="menu" class="hidden" role="menu">
    ${ids.map(id => `<button id="menu-${id}" class="menu-item" role="menuitem"><span>${id}</span></button>`).join('')}
  </div>
  <button id="outside">Elsewhere</button>
`);
const { isTyping, keybindFor, setupMenu } = await import('../src/utils/menu.ts');
const { TabManager } = await import('../src/utils/tb.ts');

// What the menu hands the tab strip, which calls it with keys pressed inside a tab's page.
let frameKeydown: ((e: KeyboardEvent) => void) | undefined;
TabManager.onFrameKeydown = cb => void (frameKeydown = cb);

const menu = () => document.querySelector('#menu')!;
const button = () => document.querySelector<HTMLButtonElement>('#menubtn')!;
const isOpen = () => !menu().classList.contains('hidden');

const opened: (string | undefined)[] = [];
TabManager.openTab = (src?: string) => void opened.push(src);

after(() => dom.close());

test('Setting up the menu needs every item, and finds them', async () => {
  assert.ok(await setupMenu());
});

test('The menu button opens and closes the menu, and says so', () => {
  button().click();
  assert.ok(isOpen());
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  button().click();
  assert.ok(!isOpen());
  assert.equal(button().getAttribute('aria-expanded'), 'false');
});

test('Escape and a click elsewhere close it', () => {
  button().click();
  document.dispatchEvent(key('keydown', { key: 'Escape' }));
  assert.ok(!isOpen());

  button().click();
  document.querySelector<HTMLButtonElement>('#outside')!.click();
  assert.ok(!isOpen());
});

test('Menu items open their pages in a new tab and close the menu', () => {
  button().click();
  document.querySelector<HTMLButtonElement>('#menu-settings')!.click();
  document.querySelector<HTMLButtonElement>('#menu-bookmarks')!.click();
  assert.deepEqual(opened.splice(0), ['./st', '/bm']);
  assert.ok(!isOpen());
});

test('Keyboard shortcuts run their item', () => {
  document.dispatchEvent(key('keydown', { key: 'n', ctrlKey: true, altKey: true }));
  assert.deepEqual(opened.splice(0), [undefined], 'Ctrl+Alt+N opens a new tab');
  document.dispatchEvent(key('keydown', { key: 'n', ctrlKey: true, altKey: true, repeat: true }));
  assert.deepEqual(opened, [], 'a held key does not open a tab per repeat');
});

test('Shortcuts also work from the page inside a tab', () => {
  assert.ok(frameKeydown, 'the menu listens to tab pages');
  const e = key('keydown', { key: 'n', ctrlKey: true, altKey: true });
  frameKeydown!(e);
  assert.deepEqual(opened.splice(0), [undefined]);
  assert.ok(e.defaultPrevented, 'the page in the tab does not also act on it');
});

test('Key combinations read the way the panic key is saved, Meta included', () => {
  assert.equal(
    keybindFor(key('keydown', { key: 'X', ctrlKey: true, shiftKey: true })),
    'ctrl+shift+x',
  );
  assert.equal(keybindFor(key('keydown', { key: 'p', metaKey: true, altKey: true })), 'alt+meta+p');
  assert.equal(keybindFor(key('keydown', { key: ' ' })), 'space');
});

test('A plain key typed into a text field is not a shortcut', () => {
  const input = document.createElement('input');
  document.body.append(input);
  const typed = key('keydown', { key: '`' });
  input.dispatchEvent(typed);
  assert.ok(isTyping(typed), 'a backtick typed in the address bar');
  const withCtrl = key('keydown', { key: 'n', ctrlKey: true, altKey: true });
  input.dispatchEvent(withCtrl);
  assert.ok(!isTyping(withCtrl), 'Ctrl+Alt shortcuts still work in a field');
  const onPage = key('keydown', { key: '`' });
  document.body.dispatchEvent(onPage);
  assert.ok(!isTyping(onPage), 'outside a field the panic key still fires');
  input.remove();
});
