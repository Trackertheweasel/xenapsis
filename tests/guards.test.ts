import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import {
  USER_AGENT_PRESETS,
  applyGuards,
  customUserAgent,
  customUserAgentValue,
  VERIFICATION_HOSTS,
  fixSearchNavigation,
  isVerificationFrame,
  guardLinks,
  leakGuard,
  opensPopup,
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

test('Sign-in pop-ups and same-tab opens get the engine’s own window, plain new tabs a Persec tab', () => {
  const win = new Window({ url: 'https://site.test/page' });
  const engine: unknown[][] = [];
  const popup = { closed: false };
  let blocked = false;
  (win as any).open = (...args: unknown[]) => (engine.push(args), blocked ? null : popup);
  const tabs: string[] = [];
  leakGuard(win as any, url => tabs.push(url));

  // "Continue with Google": the site needs the window back to watch it and hear from it.
  const signIn = 'https://accounts.example/o/oauth2/auth';
  assert.equal(win.open(signIn, 'oauth', 'width=500,height=600'), popup);
  assert.equal(win.open('/next', '_self'), popup);
  assert.equal(win.open('/top', ' _TOP '), popup);
  assert.deepEqual(
    engine.map(a => a[0]),
    [signIn, '/next', '/top'],
  );
  assert.deepEqual(tabs, []);

  // A blocked pop-up still opens, in a Persec tab; a blocked same-tab open just doesn't happen.
  blocked = true;
  assert.equal(win.open(signIn, '', 'popup'), null);
  assert.equal(win.open('/again', '_self'), null);
  assert.deepEqual(tabs, [signIn]);

  // New tabs, and pop-ups that ask not to be linked to the page, stay Persec tabs.
  blocked = false;
  engine.length = 0;
  assert.equal(win.open('/a'), null);
  assert.equal(win.open('/b', '_blank'), null);
  assert.equal(win.open('/c', '_blank', 'noopener,width=400'), null);
  assert.deepEqual(engine, []);
  assert.deepEqual(tabs.slice(1), [
    'https://site.test/a',
    'https://site.test/b',
    'https://site.test/c',
  ]);
  win.happyDOM.close();
});

test('What counts as a pop-up', () => {
  assert.equal(opensPopup(undefined, 'width=400'), true);
  assert.equal(opensPopup('', 'popup=yes'), true);
  assert.equal(opensPopup('_parent', ''), true);
  assert.equal(opensPopup('name', undefined), false);
  assert.equal(opensPopup('_blank', 'noreferrer,height=300'), false);
  assert.equal(opensPopup(undefined, 'resizable'), false);
});

test('Cloudflare, hCaptcha and reCAPTCHA check frames are recognised, and nothing else', () => {
  for (const url of [
    'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv0/0/x',
    'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html',
    'https://www.google.com/recaptcha/api2/anchor?k=1',
    'https://www.recaptcha.net/recaptcha/api2/bframe',
  ])
    assert.equal(isVerificationFrame(url), true, url);
  for (const url of [
    'https://claude.ai/',
    'https://chatgpt.com/',
    'https://www.google.com/search?q=recaptcha',
    'https://challenges.cloudflare.com.evil.test/',
    'https://notcloudflare.com/',
    'not a url',
  ])
    assert.equal(isVerificationFrame(url), false, url);
});

test('Check frames get only the chosen user agent, never the other guards', () => {
  const guards = readGuards({ userAgent: 'chrome-windows', fingerprintNoise: 'on' });
  const frame = new Window({ url: 'https://persec.test/frame' });
  const cores = frame.navigator.hardwareConcurrency;
  const open = frame.open;
  applyGuards(
    frame as any,
    { url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x' },
    guards,
    () => {},
  );
  // The user agent is in every request's headers too, so the frame must agree with them.
  assert.match(frame.navigator.userAgent, /Windows NT 10\.0/);
  assert.equal(frame.navigator.hardwareConcurrency, cores);
  assert.equal(frame.open, open);
  assert.equal((frame as any)[Symbol.for('persec leak guard')], undefined);
  frame.happyDOM.close();

  const page = new Window({ url: 'https://persec.test/page' });
  applyGuards(page as any, { url: 'https://claude.ai/' }, guards, () => {});
  assert.equal((page as any)[Symbol.for('persec leak guard')], true);
  page.happyDOM.close();
});

test('The service worker leaves the same check frames alone', async () => {
  const { readFile } = await import('node:fs/promises');
  const sw = await readFile(new URL('../src/sw.js', import.meta.url), 'utf8');
  const list = /const VERIFICATION_HOSTS = (\[[^\]]*\]);/.exec(sw)?.[1];
  assert.deepEqual(JSON.parse(list!.replaceAll("'", '"')), VERIFICATION_HOSTS);
});

test("Ultraviolet pages send new-tab links to Persec but keep the engine's pop-ups", () => {
  const win = new Window({ url: 'https://site.test/page' });
  const engineOpen = () => ({}) as any;
  win.open = engineOpen;
  const opened: string[] = [];
  guardLinks(win as any, url => opened.push(url));
  guardLinks(win as any, url => opened.push(url));
  win.document.body.innerHTML = '<a id="a" href="/next">x</a>';
  const link = win.document.getElementById('a')!;
  const fire = (type: string, init = {}) => {
    const e = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    link.dispatchEvent(e);
    return e.defaultPrevented;
  };
  assert.equal(fire('auxclick', { button: 1 }), true, 'middle-click');
  assert.equal(fire('auxclick', { button: 2 }), false, 'right-click');
  assert.equal(fire('click', { metaKey: true }), true, 'Cmd-click');
  assert.equal(win.open, engineOpen, 'window.open left to the engine');
  // Guarding twice (Scramjet's leak guard, then the load handler) still opens one tab per click.
  assert.deepEqual(opened, ['https://site.test/next', 'https://site.test/next']);
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
