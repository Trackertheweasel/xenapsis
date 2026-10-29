import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installDom, key } from './dom.ts';

// The tab strip (src/utils/tb.ts) on a page laid out like src/layouts/tab.astro.
const dom = installDom(`
  <div id="tcontainer"></div>
  <button id="add">+</button>
  <input id="urlbar" />
  <div id="loading-bar"></div>
  <div id="fcontainer"></div>
`);
const { TabManager, initTabs } = await import('../src/utils/tb.ts');

const tabButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const frames = () => [...document.querySelectorAll<HTMLIFrameElement>('#fcontainer iframe')];
const selected = () => tabButtons().map(b => b.getAttribute('aria-selected'));
const visible = () => frames().map(f => !f.classList.contains('hidden'));

after(() => {
  window.dispatchEvent(new Event('unload'));
  return dom.close();
});

test('Importing the tab strip does nothing until it is started', () => {
  assert.equal(tabButtons().length, 0);
  assert.equal((globalThis as any).TabManager, undefined);
});

test('Starting it opens one selected tab on the start page, registered with Scramjet', async () => {
  initTabs();
  await dom.tick();
  assert.equal(tabButtons().length, 1);
  assert.deepEqual(selected(), ['true']);
  assert.equal(frames()[0].getAttribute('src'), 'new');
  assert.deepEqual(visible(), [true]);
  assert.equal(dom.frames.length, 1, 'the frame is a Scramjet frame');
  assert.equal(TabManager.activeTabId, Number(frames()[0].id.slice('frame-'.length)));
  assert.equal((globalThis as any).TabManager, TabManager, 'pages in tabs can reach it');
});

test('A new tab is selected and shown; only one frame is visible', async () => {
  document.querySelector<HTMLButtonElement>('#add')!.click();
  await dom.tick();
  assert.equal(tabButtons().length, 2);
  assert.deepEqual(selected(), ['false', 'true']);
  assert.deepEqual(visible(), [false, true]);
});

test('Arrow keys move between tabs, and Delete closes the focused one', async () => {
  tabButtons()[1].dispatchEvent(key('keydown', { key: 'ArrowLeft' }));
  assert.deepEqual(selected(), ['true', 'false']);
  assert.deepEqual(visible(), [true, false]);

  tabButtons()[0].dispatchEvent(key('keydown', { key: 'End' }));
  assert.deepEqual(selected(), ['false', 'true']);

  tabButtons()[1].dispatchEvent(key('keydown', { key: 'Delete' }));
  await dom.tick();
  assert.equal(tabButtons().length, 1);
  assert.equal(frames().length, 1, 'its frame goes too');
  assert.deepEqual(selected(), ['true']);
});

test('Closing the last tab leaves a fresh one, and a blank tab is not offered to reopen', async () => {
  document.querySelector<HTMLButtonElement>('.tab-close')!.click();
  await dom.tick();
  assert.equal(tabButtons().length, 1);
  assert.deepEqual(selected(), ['true']);
  assert.equal(await TabManager.reopenClosed(), false);
});

test('Each tab is labelled for screen readers, and its close button names it', () => {
  const tab = tabButtons()[0];
  assert.equal(tab.getAttribute('aria-label'), 'New Tab');
  assert.equal(tab.getAttribute('aria-controls'), frames()[0].id);
  assert.equal(document.querySelector('.tab-close')!.getAttribute('aria-label'), 'Close New Tab');
});

test("A tab's frame lets sites start downloads, which a sandboxed frame otherwise drops", () => {
  const sandbox = frames()[0].getAttribute('sandbox')!.split(' ');
  assert.ok(sandbox.includes('allow-downloads'));
  assert.ok(sandbox.includes('allow-scripts') && sandbox.includes('allow-same-origin'));
});
