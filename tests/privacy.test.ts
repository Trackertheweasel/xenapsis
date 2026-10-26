import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const pagesDir = new URL('../src/pages/', import.meta.url);
const page = (name: string) => readFile(new URL(`${name}.astro`, pagesDir), 'utf8');

test('Persec pages load no third-party ad, analytics or font scripts', async () => {
	const names = (await readdir(pagesDir)).filter(f => f.endsWith('.astro'));
	for (const name of names) {
		const html = await readFile(new URL(name, pagesDir), 'utf8');
		assert.doesNotMatch(html, /googletagmanager|gtag\(|bauval\.org|profitablecpmratenetwork|fonts\.googleapis/, name);
	}
	const css = await readFile(new URL('../src/main.css', import.meta.url), 'utf8');
	assert.doesNotMatch(css, /fonts\.googleapis/);
});

test('Persec ads are self-served from a local sponsor list', async () => {
	const component = await readFile(new URL('../src/components/Sponsor.astro', import.meta.url), 'utf8');
	assert.doesNotMatch(component, /<script/);
	assert.match(component, /rel="sponsored noopener noreferrer"/);
	assert.match(await page('new'), /<Sponsor \/>/);
	const sponsors = JSON.parse(await readFile(new URL('../public/a/json/sponsors.json', import.meta.url), 'utf8'));
	for (const s of sponsors) {
		assert.ok(!s.image || s.image.startsWith('/'), `${s.name} image must be served locally`);
	}
});

test('Persec inner iframe pages no longer load the ad helper', async () => {
	for (const name of ['st', 'math', 'new', 'sci']) {
		assert.doesNotMatch(await page(name), /@scripts\/ext/);
	}
	await assert.rejects(
		readFile(new URL('../src/utils/ext.ts', import.meta.url), 'utf8'),
		{ code: 'ENOENT' },
	);
});

test('Persec allows cross-origin no-CORS resources with credentialless COEP', async () => {
	const server = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
	assert.match(server, /crossOriginEmbedderPolicy:\s*\{\s*policy:\s*'credentialless'\s*\}/);
});
