import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blocklistMatcher,
  isBlocked,
  parseBlocklist,
  setBlocklist,
  startBlocklist,
} from '../serverlib/blocklist.ts';

const LIST = `! AdGuard DNS filter
[Adblock Plus 2.0]
||doubleclick.net^
||ads.example.com^
||tracker.test^|
@@||safe.doubleclick.net^
||example.org^$important
||*.wild.test^
/banner/*
0.0.0.0 hosts-style.test
127.0.0.1 localhost
`;

test('Whole-host rules are read; rules a tunnel cannot act on are skipped', () => {
  const list = parseBlocklist(LIST);
  assert.deepEqual([...list.blocked].sort(), [
    'ads.example.com',
    'doubleclick.net',
    'hosts-style.test',
    'tracker.test',
  ]);
  assert.deepEqual([...list.allowed], ['safe.doubleclick.net']);
});

test('A host is blocked with its subdomains, unless an exception covers it', () => {
  const list = parseBlocklist(LIST);
  assert.ok(isBlocked(list, 'doubleclick.net'));
  assert.ok(isBlocked(list, 'securepubads.g.DoubleClick.net.'));
  assert.ok(!isBlocked(list, 'safe.doubleclick.net'));
  assert.ok(!isBlocked(list, 'a.safe.doubleclick.net'));
  assert.ok(!isBlocked(list, 'example.com'));
  assert.ok(!isBlocked(list, 'notdoubleclick.net'));
  assert.ok(!isBlocked(null, 'doubleclick.net'));
});

test('The tunnel uses the loaded list, and blocks nothing without one', async () => {
  setBlocklist(null);
  assert.equal(blocklistMatcher.test('doubleclick.net'), false);

  const logs: string[] = [];
  const failing = (async () => new Response('', { status: 503 })) as typeof fetch;
  startBlocklist({}, failing, m => logs.push(m))();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(blocklistMatcher.test('doubleclick.net'), false);
  assert.match(logs[0], /couldn't load/);

  const ok = (async () => new Response(LIST)) as typeof fetch;
  startBlocklist({}, ok)();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(blocklistMatcher.test('ads.example.com'), true);

  startBlocklist({ PERSEC_WISP_ADBLOCK: 'off' }, ok)();
  assert.equal(blocklistMatcher.test('ads.example.com'), false);
});

test('A list that is too large is refused instead of filling memory', async () => {
  setBlocklist(null);
  const logs: string[] = [];
  const huge = (async () => new Response('||a.test^\n'.repeat(1_200_000))) as typeof fetch;
  startBlocklist({}, huge, m => logs.push(m))();
  await new Promise(r => setTimeout(r, 200));
  assert.match(logs[0] ?? '', /over 10 MB/);
  assert.equal(blocklistMatcher.test('a.test'), false);
});
