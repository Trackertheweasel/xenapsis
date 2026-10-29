import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import { fixScramjet, fixUltraviolet } from '../build/vendor.ts';

const scramjetAll = path.join(scramjetPath, 'scramjet.all.js');
const uvBundle = new URL(
  '../node_modules/@titaniumnetwork-dev/ultraviolet/dist/uv.bundle.js',
  import.meta.url,
);

// Scramjet's cookie jar, from the fixed file the build serves: its module and the cookie parser it
// uses, run on their own.
async function scramjetJar() {
  const code = fixScramjet(await readFile(scramjetAll, 'utf8'));
  const source = (id: string, next: string) =>
    code.slice(
      code.indexOf(`${id}:function(`) + id.length + 1,
      code.indexOf(`},${next}:function(`) + 1,
    );
  const parser = { exports: {} as any };
  new Function(`return ${source('4322', '7302')}`)()(parser);
  const jar: any = {};
  const require: any = () => parser.exports;
  require.n = (m: unknown) => () => m;
  require.d = (target: object, getters: Record<string, () => unknown>) => {
    for (const key in getters) Object.defineProperty(target, key, { get: getters[key] });
  };
  new Function(`return ${source('3831', '1427')}`)()({}, jar, require);
  return new jar.k();
}

test("Scramjet's worker sends the page each cookie a server sets, not its position", async () => {
  const original = await readFile(scramjetAll, 'utf8');
  const fixed = fixScramjet(original);
  assert.notEqual(fixed, original);
  assert.ok(!fixed.includes('for(let t in x)if(h)'));

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

test("Scramjet's cookie jar keeps cookie values as sent and honours Max-Age", async () => {
  const jar = await scramjetJar();
  const site = new URL('https://accounts.google.com/signin');
  jar.setCookies(
    ['a=ab%2Bc%2F%3D%3D; Path=/', 'b=1; Max-Age=3600', 'c=1', 'd=1; Max-Age=0', 'e=1; Max-Age=-1'],
    site,
  );
  assert.equal(jar.getCookies(site, false), 'a=ab%2Bc%2F%3D%3D; b=1; c=1');
  // Max-Age wins over Expires.
  jar.setCookies(['f=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60'], site);
  assert.match(jar.getCookies(site, false), /f=1/);

  // Deleting a cookie, either way sites do it, takes it out of the jar the worker saves.
  jar.setCookies(
    ['b=; Max-Age=0', 'c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'f=; Max-Age=0'],
    site,
  );
  assert.equal(jar.getCookies(site, false), 'a=ab%2Bc%2F%3D%3D');
  assert.deepEqual(Object.keys(JSON.parse(jar.dump())), ['.accounts.google.com@/@a']);
});

test("Ultraviolet's cookie jar deletes a cookie with Max-Age=0", async () => {
  const fixed = fixUltraviolet(await readFile(uvBundle, 'utf8'));
  // The expiry check in the fixed bundle, run on its own over one stored cookie.
  const check = /n=!1;return (r\.set&&\("number"==typeof r\.maxAge.*?),n\?\(e\.delete/.exec(
    fixed,
  )![1];
  const expired = (cookie: object) =>
    new Function('r', 't', `let n=!1;${check};return n`)(cookie, new Date());
  const set = new Date(Date.now() - 1000);
  assert.equal(expired({ set, maxAge: 0 }), true);
  assert.equal(expired({ set, maxAge: 3600 }), false);
  assert.equal(expired({ set, expires: new Date(0) }), true);
  assert.equal(expired({ set }), false);
});

test('A runtime fix that no longer matches fails the build instead of being skipped', () => {
  assert.throws(() => fixScramjet('nothing to fix here'), /found it 0 times/);
  const twice = 'let x=v["set-cookie"]||[];for(let t in x)if(h){'.repeat(2);
  assert.throws(() => fixScramjet(twice), /found it 2 times/);
});

test('The build applies the fix to the Scramjet file it serves', async () => {
  const config = await readFile(new URL('../astro.config.ts', import.meta.url), 'utf8');
  assert.match(config, /role === 'scramjetAll' && \{ transform: fixScramjet \}/);
  assert.match(config, /role === 'uvBundle' && \{ transform: fixUltraviolet \}/);
});
