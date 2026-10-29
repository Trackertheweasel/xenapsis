import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installDom } from './dom.ts';

// Parts of the Settings page (src/utils/settings/) on a page laid out like src/pages/st.astro.
const dom = installDom(`
  <nav><a data-nav="privacy">Privacy</a><a data-nav="browsing">Browsing</a></nav>
  <input data-filter-input /><button data-filter-clear hidden>Clear</button>
  <p data-filter-empty></p>
  <section data-section="privacy">
    <h2>Privacy</h2>
    <div class="space-y-3">
      <div id="cloak-card">Tab cloak: disguise the tab's title and icon</div>
      <div id="panic-card">Panic key: leave Persec at once</div>
    </div>
  </section>
  <section data-section="browsing">
    <h2>Browsing</h2>
    <div class="space-y-3">
      <div id="engine-card">Search engine used from the address bar</div>
      <div id="logins-card" hidden>Saved logins for tab sites</div>
    </div>
  </section>
`);
const { filter, setActive } = await import('../src/utils/settings/nav.ts');
const { formatPanicKey } = await import('../src/utils/settings/panic.ts');
const { PAGE_SETTINGS } = await import('../src/utils/config.ts');

const shown = (id: string) =>
  (document.getElementById(id) ?? document.querySelector(`[data-section="${id}"]`))!.style
    .display !== 'none';
const current = () =>
  [...document.querySelectorAll('[data-nav][aria-current]')].map(n => n.getAttribute('data-nav'));

after(() => dom.close());

test('Search shows only the cards with every word, and their sections', () => {
  filter('tab title');
  assert.ok(shown('cloak-card'));
  assert.ok(!shown('panic-card'));
  assert.ok(shown('privacy'));
  assert.ok(!shown('browsing'), 'a section with no match is hidden');
  assert.deepEqual(current(), ['privacy']);
  assert.equal(document.querySelector<HTMLElement>('[data-filter-clear]')!.hidden, false);
});

test('A card hidden for another reason does not keep its section on screen', () => {
  filter('tab sites');
  assert.ok(!shown('browsing'), 'only the hidden saved-logins card matches');
  assert.match(document.querySelector('[data-filter-empty]')!.textContent!, /No settings match/);
});

test('Clearing the search shows everything again', () => {
  filter('');
  for (const id of ['cloak-card', 'panic-card', 'engine-card', 'privacy', 'browsing']) {
    assert.ok(shown(id), id);
  }
  assert.equal(document.querySelector('[data-filter-empty]')!.textContent, '');
  assert.equal(document.querySelector<HTMLElement>('[data-filter-clear]')!.hidden, true);
});

test('One category is marked current at a time', () => {
  setActive('browsing');
  assert.deepEqual(current(), ['browsing']);
});

test('Panic keys are saved lower-case and shown as people type them', () => {
  assert.equal(formatPanicKey('ctrl+alt+x'), 'Ctrl+Alt+X');
  assert.equal(formatPanicKey('`'), '`');
  assert.equal(formatPanicKey('shift+arrowup'), 'Shift+arrowup');
});

test('The page settings are a fixed list of known keys', () => {
  assert.equal(new Set(PAGE_SETTINGS).size, PAGE_SETTINGS.length);
  assert.ok(PAGE_SETTINGS.includes('panicKey'));
});

test('Tab Switch Cloak is back on after a reload', async () => {
  const { SettingsManager } = await import('../src/utils/st.ts');
  const cfg = Object.fromEntries(PAGE_SETTINGS.map(k => [k, null])) as any;
  const watching = async (tabSwitchCloak: string | null) => {
    const added: string[] = [];
    const real = document.addEventListener.bind(document);
    document.addEventListener = ((type: string, ...rest: any[]) => {
      added.push(type);
      return (real as any)(type, ...rest);
    }) as any;
    try {
      await SettingsManager.apply({ ...cfg, tabSwitchCloak });
    } finally {
      document.addEventListener = real;
    }
    return added.includes('visibilitychange');
  };
  assert.ok(await watching('on'), 'it watches for the tab being hidden again');
  assert.ok(!(await watching('off')));
});
