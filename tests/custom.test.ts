import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CUSTOM_TILES,
  addCustom,
  customKey,
  readCustom,
  removeCustom,
} from '../src/utils/custom.ts';

test('Games and apps keep their own tiles', () => {
  assert.equal(customKey('games'), 'customGames');
  assert.equal(customKey('app'), 'customApps');
});

test('A tile is added with a web address and a name, falling back to the host', () => {
  const list = addCustom([], { name: '  ', url: 'play.example.com/game' });
  assert.deepEqual(list, [{ name: 'play.example.com', url: 'https://play.example.com/game' }]);
  const named = addCustom(list, { name: 'Chess', url: 'https://chess.example/' });
  assert.equal(named[1].name, 'Chess');
});

test('Bad, repeated or too many addresses are refused with a message', () => {
  assert.throws(() => addCustom([], { name: 'x', url: 'javascript:alert(1)' }), /web address/);
  assert.throws(() => addCustom([], { name: 'x', url: 'hello' }), /web address/);
  const one = addCustom([], { name: 'x', url: 'https://a.example/' });
  assert.throws(() => addCustom(one, { name: 'y', url: 'https://a.example' }), /already/);
  const full = Array.from({ length: MAX_CUSTOM_TILES }, (_, i) => ({
    name: `${i}`,
    url: `https://${i}.example/`,
  }));
  assert.throws(() => addCustom(full, { name: 'z', url: 'https://z.example/' }), /up to/);
});

test('Saved tiles that are malformed are dropped, and removing one keeps the rest', () => {
  const saved = [
    { name: 'Good', url: 'https://good.example/' },
    { name: 'Bad', url: 'javascript:alert(1)' },
    { url: 1 },
    null,
  ];
  assert.deepEqual(readCustom(saved), [{ name: 'Good', url: 'https://good.example/' }]);
  assert.deepEqual(readCustom('nope'), []);
  assert.deepEqual(removeCustom(readCustom(saved), 'https://good.example/'), []);
});
