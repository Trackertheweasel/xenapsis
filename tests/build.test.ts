import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function sourceFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
		else if (/\.(astro|ts)$/.test(entry.name)) out.push(path);
	}
	return out;
}

const pascal = (name: string) =>
	name.replace(/(\w)(\w*)(_|-|\s*)/g, (_, first: string, rest: string) => first.toUpperCase() + rest.toLowerCase());

test('Every Lucide icon used in the UI is bundled', async () => {
	const bundled = new Set([...(await read('src/utils/icons.ts')).matchAll(/^  (\w+),$/gm)].map(m => m[1]));
	const used = new Set<string>();
	for (const file of await sourceFiles('src')) {
		const src = await read(file);
		for (const m of src.matchAll(/data-lucide=\\?"([a-z0-9-]+)/g)) used.add(m[1]);
		for (const m of src.matchAll(/icon: '([a-z0-9-]+)'/g)) used.add(m[1]);
	}
	assert.ok(used.size > 10);
	const missing = [...used].filter(name => !bundled.has(pascal(name)));
	assert.deepEqual(missing, [], 'add these icons to src/utils/icons.ts');
});

test('The code obfuscator is gone', async () => {
	assert.doesNotMatch(await read('astro.config.ts'), /obfuscator/i);
	assert.doesNotMatch(await read('package.json'), /obfuscator/i);
});
