import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = (name: string) =>
	readFile(new URL(`../src/pages/${name}.astro`, import.meta.url), 'utf8');

test('Lunar SocialBar is declared on the outer page before its main UI iframe', async () => {
	const html = await page('index');
	const script = '<script is:inline async data-cfasync="false" src="https://bauval.org/14/4aa111ba60066e322a3fa56e92984f39"';
	const adPosition = html.indexOf(script);
	const iframePosition = html.indexOf('<iframe\n          id="frame"');
	assert.notEqual(adPosition, -1);
	assert.notEqual(iframePosition, -1);
	assert.ok(adPosition < iframePosition);
	assert.match(html, /onerror="this\.onerror=null;this\.src='https:\/\/pl29334616\.profitablecpmratenetwork\.com\/4a\/a1\/11\/4aa111ba60066e322a3fa56e92984f39\.js';"/);
});

test('Lunar inner iframe pages no longer load the ad helper', async () => {
	for (const name of ['st', 'math', 'new', 'sci']) {
		assert.doesNotMatch(await page(name), /@scripts\/ext/);
	}
	await assert.rejects(
		readFile(new URL('../src/utils/ext.ts', import.meta.url), 'utf8'),
		{ code: 'ENOENT' },
	);
});

test('Lunar allows cross-origin no-CORS resources with credentialless COEP', async () => {
	const server = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
	assert.match(server, /crossOriginEmbedderPolicy:\s*\{\s*policy:\s*'credentialless'\s*\}/);
});
