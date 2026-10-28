import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import {
  USER_AGENT_PRESETS,
  applyGuards,
  customUserAgent,
  customUserAgentValue,
  fixSearchNavigation,
  leakGuard,
  profileFromUserAgent,
  readGuards,
  sessionNoise,
  spoofNavigator,
  storedUserAgent,
  userAgentHeaders,
} from '../src/utils/guards.ts';

const preset = (id: string) => USER_AGENT_PRESETS.find(p => p.id === id)!;

test("A saved user agent is a preset, a custom one, or the browser's own", () => {
  assert.equal(storedUserAgent('safari-iphone'), preset('safari-iphone').userAgent);
  assert.equal(storedUserAgent(customUserAgentValue('MyAgent/1.0')), 'MyAgent/1.0');
  for (const none of ['', 'nope', null, 3, 'custom:', 'custom:a\nb'])
    assert.equal(storedUserAgent(none), null);
  assert.equal(customUserAgent('x'.repeat(513)), null);
  assert.equal(new Set(USER_AGENT_PRESETS.map(p => p.id)).size, USER_AGENT_PRESETS.length);
});

test('The rest of what a site reads matches the user agent', () => {
  const iphone = profileFromUserAgent(preset('safari-iphone').userAgent);
  assert.equal(iphone.platform, 'iPhone');
  assert.equal(iphone.mobile, true);
  assert.equal(iphone.chromium, undefined);
  const win = profileFromUserAgent(preset('chrome-windows').userAgent);
  assert.equal(win.platform, 'Win32');
  assert.equal(win.vendor, 'Google Inc.');
  assert.equal(win.chromium?.platform, 'Windows');

  assert.equal(userAgentHeaders(null), null);
  const headers = userAgentHeaders(win)!;
  assert.equal(headers['user-agent'], win.userAgent);
  assert.equal(headers['sec-ch-ua-platform'], '"Windows"');
  assert.equal(headers['sec-ch-ua-mobile'], '?0');
  // Safari and Firefox don't send client hints.
  assert.deepEqual(Object.keys(userAgentHeaders(iphone)!), ['user-agent']);
});

test('Guards default to the leak guard and site fixes on, the rest off', () => {
  assert.deepEqual(readGuards({}), {
    profile: null,
    noise: null,
    leakGuard: true,
    siteFixes: true,
  });
  const all = readGuards({
    userAgent: 'xbox',
    fingerprintNoise: 'on',
    leakGuard: 'off',
    siteFixes: 'off',
  });
  assert.equal(all.profile?.platform, 'Win32');
  assert.ok(all.noise);
  assert.equal(all.leakGuard, false);
  assert.equal(all.siteFixes, false);
});

test('Fingerprint noise stays the same for a whole session', () => {
  const store = new Map<string, string>();
  const session = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  };
  const first = sessionNoise(session, () => 0.5);
  assert.deepEqual(
    sessionNoise(session, () => 0.1),
    first,
  );
});

test('A spoofed navigator reports the chosen browser', () => {
  const win = new Window();
  spoofNavigator(win as any, profileFromUserAgent(preset('chrome-android').userAgent));
  assert.match(win.navigator.userAgent, /Android/);
  assert.equal(win.navigator.platform, 'Linux armv81');
  assert.equal(win.navigator.maxTouchPoints, 5);
  assert.equal((win.navigator as any).userAgentData.mobile, true);
  win.happyDOM.close();
});

test('Links and pop-ups that would open a new window open a Persec tab instead', () => {
  const win = new Window({ url: 'https://site.test/page' });
  const opened: string[] = [];
  leakGuard(win as any, url => opened.push(url));
  win.document.body.innerHTML =
    '<a id="blank" href="/next" target="_blank">x</a><a id="same" href="/here">y</a><a id="file" href="/f.zip" target="_blank" download>z</a>';
  const click = (id: string, init = {}) => {
    const e = new win.MouseEvent('click', { bubbles: true, cancelable: true, ...init });
    win.document.getElementById(id)!.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(click('blank'), true);
  assert.equal(click('same'), false);
  assert.equal(click('same', { ctrlKey: true }), true);
  assert.equal(click('file'), false);
  assert.equal(win.open('https://popup.test/'), null);
  // happy-dom also runs its own default action for some clicks, so compare as a set.
  assert.deepEqual(
    new Set(opened.filter(u => !u.endsWith('.zip'))),
    new Set(['https://site.test/next', 'https://site.test/here', 'https://popup.test/']),
  );
  win.happyDOM.close();
});

test('A broken search navigation is repaired from the search box, or dropped', () => {
  const base = 'https://duckduckgo.com/?q=cats';
  assert.equal(
    fixSearchNavigation('https://duckduckgo.com/?q=dogs', base, () => ''),
    'https://duckduckgo.com/?q=dogs',
  );
  assert.equal(
    fixSearchNavigation('/undefined', base, () => 'dogs'),
    '/?q=dogs',
  );
  assert.equal(
    fixSearchNavigation('https://duckduckgo.com/?q=null&ia=web', base, () => 'dogs'),
    'https://duckduckgo.com/?q=dogs&ia=web',
  );
  assert.equal(
    fixSearchNavigation('undefined', base, () => ''),
    null,
  );
  assert.equal(
    fixSearchNavigation('mailto:a@b.c', base, () => ''),
    'mailto:a@b.c',
  );
});

test('Guards that throw never stop the page from loading', () => {
  const guards = readGuards({ userAgent: 'safari-mac', fingerprintNoise: 'on' });
  assert.doesNotThrow(() => applyGuards({} as any, { url: 'https://x.test/' }, guards, () => {}));
});
