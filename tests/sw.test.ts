import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const origin = 'https://persec.test';

// Runs public/sw.js with the proxy engines stubbed out, exposing its functions.
async function loadServiceWorker() {
	const ctx: any = {
		URL,
		console,
		location: { origin },
		addEventListener: () => {},
		importScripts: () => {},
		$scramjetLoadWorker: () => ({
			ScramjetServiceWorker: class {
				config = { prefix: '/v1/data/' };
				cookieStore = { load() {} };
			},
		}),
		UVServiceWorker: class {},
	};
	ctx.self = ctx;
	vm.createContext(ctx);
	for (const file of ['public/tmp/config.js', 'public/sw.js']) {
		vm.runInContext(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), ctx);
	}
	return ctx;
}

const sw = await loadServiceWorker();
const scramjet = (url: string) => `${origin}/v1/data/${encodeURIComponent(url)}`;
const uv = (url: string) => `${origin}${sw.__uv$config.prefix}${sw.__uv$config.encodeUrl(url)}`;
const blocked = (proxied: string, request: Record<string, string> = { destination: 'script' }) => {
	const target = sw.targetUrl(proxied);
	return !!target && sw.isAdRequest(target, request);
};

test('Ad blocker decodes proxied URLs from both engines', () => {
	assert.equal(sw.targetUrl(scramjet('https://ad.doubleclick.net/x.js?a=1')).hostname, 'ad.doubleclick.net');
	assert.equal(sw.targetUrl(uv('https://ad.doubleclick.net/x.js')).hostname, 'ad.doubleclick.net');
});

test("Ad blocker never touches Persec's own requests", () => {
	assert.equal(sw.targetUrl(`${origin}/api/query?q=headphones`), null);
	assert.equal(sw.targetUrl(`${origin}/cdn-cgi/challenge-platform/x.js`), null);
});

test('Ad blocker blocks ad and tracker requests', () => {
	assert.ok(blocked(scramjet('https://securepubads.g.doubleclick.net/tag/js/gpt.js')));
	assert.ok(blocked(uv('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')));
	assert.ok(blocked(scramjet('https://www.googletagmanager.com/gtag/js?id=G-1')));
	assert.ok(blocked(scramjet('https://example.com/static/ads/banner.js')));
	assert.ok(blocked(scramjet('https://example.com/beacon'), { destination: 'ping' }));
});

test('Ad blocker leaves normal sites and pages alone', () => {
	assert.ok(!blocked(scramjet('https://www.reddit.com/app.js')));
	assert.ok(!blocked(scramjet('https://www.facebook.com/'), { destination: 'document', mode: 'navigate' }));
	assert.ok(!blocked(scramjet('https://ad.doubleclick.net/click'), { destination: 'document', mode: 'navigate' }));
	assert.ok(!blocked(scramjet('https://example.com/uploads/app.js')));
	assert.ok(!blocked(scramjet('https://example.com/img.png?utm_source=x'), { destination: 'image' }));
	assert.ok(!blocked(scramjet('https://example.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1')));
});
