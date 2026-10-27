import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const exists = (path: string) =>
	access(new URL(`../public${path}`, import.meta.url)).then(
		() => true,
		() => false,
	);

interface Item {
	name: string;
	desc: string;
	url: string;
	icon: string;
	logo?: string;
}
const lists: { aps: Item[]; gms: Item[] } = JSON.parse(await read('public/a/json/lists.json'));

test('Every app and game has a name, an https address and only pictures that exist', async () => {
	for (const item of [...lists.aps, ...lists.gms]) {
		assert.ok(item.name.trim(), JSON.stringify(item));
		assert.equal(new URL(item.url).protocol, 'https:', item.name);
		for (const picture of [item.icon, item.logo]) {
			if (picture) assert.ok(await exists(picture), `${item.name}: ${picture} is missing`);
		}
	}
});

test('Apps are listed once and none point at shut-down services', () => {
	const names = lists.aps.map(a => a.name);
	assert.equal(new Set(names).size, names.length, 'duplicate app names');
	const urls = lists.aps.map(a => a.url);
	assert.equal(new Set(urls).size, urls.length, 'two apps open the same address');
	const gone = ['bard.google.com', 'mint.com', 'glitch.com'];
	for (const { name, url } of lists.aps) {
		const host = new URL(url).hostname;
		assert.ok(!gone.some(g => host === g || host.endsWith('.' + g)), `${name} has shut down`);
	}
});

test('Apps open with the engine chosen in Settings', async () => {
	const src = await read('src/utils/assets.ts');
	// Settings stores Ultraviolet as 'u' (see src/utils/st.ts), and each engine encodes addresses its own way.
	assert.match(src, /=== 'u'\s*\?\s*uv\.prefix \+ uv\.encodeUrl\(url\)\s*:\s*sc\.prefix \+ sc\.codec\.encode\(url\)/);
});
