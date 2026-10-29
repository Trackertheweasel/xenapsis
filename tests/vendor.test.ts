import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import { fixScramjet } from '../build/vendor.ts';

const scramjetAll = path.join(scramjetPath, 'scramjet.all.js');

test("Scramjet's worker sends the page each cookie a server sets, not its position", async () => {
  const original = await readFile(scramjetAll, 'utf8');
  const fixed = fixScramjet(original);
  assert.notEqual(fixed, original);
  assert.ok(!fixed.includes('for(let t in x)if(h)'));
  assert.equal(fixed.length - original.length, 'of Array.isArray(x)?x:[x]'.length - 'in x'.length);

  // The fixed loop, run on its own: one message per cookie, carrying the cookie.
  const loop = /for\(let t of Array\.isArray\(x\)\?x:\[x\]\)if\(h\)\{/.exec(fixed)![0];
  const sent = (x: unknown) => {
    const out: unknown[] = [];
    new Function('x', 'h', 'out', `${loop}out.push(t)}`)(x, true, out);
    return out;
  };
  assert.deepEqual(sent(['a=1; Path=/', 'b=2; HttpOnly']), ['a=1; Path=/', 'b=2; HttpOnly']);
  assert.deepEqual(sent('cf_clearance=x; Secure'), ['cf_clearance=x; Secure']);
  assert.deepEqual(sent([]), []);
});

test('A runtime fix that no longer matches fails the build instead of being skipped', () => {
  assert.throws(() => fixScramjet('nothing to fix here'), /found it 0 times/);
  const twice = 'let x=v["set-cookie"]||[];for(let t in x)if(h){'.repeat(2);
  assert.throws(() => fixScramjet(twice), /found it 2 times/);
});

test('The build applies the fix to the Scramjet file it serves', async () => {
  const config = await readFile(new URL('../astro.config.ts', import.meta.url), 'utf8');
  assert.match(config, /role === 'scramjetAll' && \{ transform: fixScramjet \}/);
});
