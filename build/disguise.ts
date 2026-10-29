// Build-time steps that make a Persec build harder for a filter to recognise by its contents, run
// on dist/ after Astro and the compressor are done (see scripts/disguise.ts). Two of them:
//
// 1. The scrub. The proxy runtime is the public Scramjet, Ultraviolet, bare-mux and libcurl code,
//    full of their names ("scramjet", "__uv$config", "bare-mux"), which a filter can match the way
//    it matches a path. Each name is replaced everywhere in the client with a token of the same
//    length (so the .wasm file's offsets stay valid), drawn from a per-build seed. Ported from
//    Nebula's build/scrub.ts (github.com/NebulaServices/Nebula, AGPL-3.0).
// 2. Text masking (opt-in). Words like "proxy" and "unblocked" in the pages' text get a soft hyphen,
//    which renders as nothing but stops a keyword scan from matching them. The idea is InvisiProxy's
//    "source randomization" (github.com/QuiteAFancyEmerald/Holy-Unblocker, AGPL-3.0).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Longest first, so "scramjet" is replaced whole before "scram" could match part of it. "wisp" is
// left alone: the tunnel's protocol is spoken by the server too, which isn't scrubbed.
export const SCRUB_WORDS = [
  'ultraviolet',
  'scramjet',
  'bare-mux',
  'baremux',
  'libcurl',
  'epoxy',
  'scram',
  'bare',
  '__uv',
] as const;

// What must keep its name, because something outside this build depends on it:
// - Web addresses (credits and error pages link to the projects' GitHub pages).
// - Scramjet's database, "$scramjet", which holds people's cookies for sites they are signed in to.
//   A new name on every build would sign everyone out of every site after each update. Matched as
//   a whole name, so it's also kept where minified code uses it as a key ({$scramjet: ...}).
const PROTECTED = [/https?:\/\/[^\s"'`<>()\\]+/g, /\$scramjet(?![\w$])/g];

// Same-length, letter-first stand-ins for each word, unique, and found nowhere in the build already,
// so a replaced name can't run into an existing one. "__uv" keeps its underscores ("__ab").
export function scrubTokens(seed: string, corpus: string): Record<string, string> {
  const lower = corpus.toLowerCase();
  const tokens: Record<string, string> = {};
  const used = new Set<string>();
  for (const word of SCRUB_WORDS) {
    const prefix = word.match(/^_*/)![0];
    for (let attempt = 0; ; attempt++) {
      if (attempt === 1000) throw new Error(`scrub: no free token for "${word}"`);
      const digest = createHash('sha256').update(`${seed}/${word}/${attempt}`).digest();
      const body = [...digest.subarray(0, word.length - prefix.length)]
        .map(
          (b, i) =>
            (i === 0 ? 'abcdefghijklmnopqrstuvwxyz' : 'abcdefghijklmnopqrstuvwxyz0123456789')[
              b % (i === 0 ? 26 : 36)
            ],
        )
        .join('');
      const token = prefix + body;
      if (used.has(token) || lower.includes(token) || SCRUB_WORDS.some(w => token.includes(w)))
        continue;
      tokens[word] = token;
      used.add(token);
      break;
    }
  }
  return tokens;
}

// "bare" is also part of ordinary words ("barely"), so it only counts at the start of a name and
// when what follows is not a lowercase letter, except in "barews" (BareClient, bare-mux, e.bare).
const WORD_RE = new RegExp(
  SCRUB_WORDS.map(w => (w === 'bare' ? '(?<![A-Za-z])bare' : w.replace(/\$/g, '\\$'))).join('|'),
  'gi',
);

// The token takes the case of each letter it replaces, so "Scramjet" and "SCRAMJET" stay distinct
// names and anything comparing names case-insensitively still matches.
const withCase = (token: string, original: string) =>
  [...token]
    .map((c, i) => (original[i] !== original[i].toLowerCase() ? c.toUpperCase() : c))
    .join('');

export function scrubText(text: string, tokens: Record<string, string>): string {
  const keep: [number, number][] = [];
  for (const re of PROTECTED)
    for (const m of text.matchAll(re)) keep.push([m.index, m.index + m[0].length]);
  return text.replace(WORD_RE, (match, offset: number) =>
    keep.some(([a, b]) => offset >= a && offset < b) ||
    (match.toLowerCase() === 'bare' && /[a-vx-z]/.test(text[offset + 4] ?? ''))
      ? match
      : withCase(tokens[match.toLowerCase()], match),
  );
}

// Words a school or workplace filter's keyword scan is likely to flag on a page.
export const MASK_WORDS = [
  'unblocked',
  'unblocker',
  'unblock',
  'proxies',
  'proxied',
  'proxy',
  'bypass',
  'cloak',
  'games',
  'game',
  'vpn',
];
const MASK_RE = new RegExp(`(?<![A-Za-z])(?:${MASK_WORDS.join('|')})`, 'gi');
// Scripts, styles and tags (with their attributes) are left alone; only the text between them,
// which includes the <title>, is masked.
const NOT_TEXT =
  /(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->|<[^>]*>)/gi;

export function maskHtml(html: string): string {
  return html
    .split(NOT_TEXT)
    .map((part, i) =>
      i % 2 ? part : part.replace(MASK_RE, w => `${w[0]}­${w.slice(1, -1)}­${w.slice(-1)}`),
    )
    .join('');
}

const TEXT = /\.(?:html?|m?js|css|json|svg|txt|webmanifest|map)$/i;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

export interface DisguiseOptions {
  // dist/client and dist/server.
  client: string;
  server: string;
  scrub: boolean;
  seed: string;
  mask: boolean;
}

export function disguiseBuild({ client, server, scrub, seed, mask }: DisguiseOptions): void {
  const files = walk(client);
  const texts = files.filter(f => TEXT.test(f));

  if (scrub) {
    const wasm = files.filter(f => f.endsWith('.wasm'));
    const corpus = [...texts, ...wasm].map(f => fs.readFileSync(f, 'latin1')).join('\n');
    const tokens = scrubTokens(seed, corpus);

    // Astro's own files are cached by browsers for a year under content-hashed names. Their
    // contents now change with the seed, so they get new names too, or a browser holding the old
    // copy would mix it with this build's runtime. References to them are updated everywhere,
    // including the server bundle (the page it renders on request links to them).
    const astroDir = path.join(client, '_astro');
    const renames = new Map<string, string>();
    for (const f of files.filter(f => f.startsWith(astroDir + path.sep))) {
      const name = path.basename(f);
      const ext = path.extname(name);
      const tag = createHash('sha256').update(`${seed}/${name}`).digest('hex').slice(0, 8);
      renames.set(
        name,
        scrubText(`${name.slice(0, -ext.length || undefined)}.${tag}${ext}`, tokens),
      );
    }
    const names = [...renames.keys()].sort((a, b) => b.length - a.length);
    const NAME_RE = names.length
      ? new RegExp(
          `(?<![\\w.-])(?:${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
          'g',
        )
      : null;
    const rename = (text: string) => (NAME_RE ? text.replace(NAME_RE, n => renames.get(n)!) : text);

    for (const f of texts) {
      const text = fs.readFileSync(f, 'utf8');
      const out = scrubText(rename(text), tokens);
      if (out !== text) fs.writeFileSync(f, out);
    }
    // Binary, so read as one byte per character; the tokens are ASCII and the same length.
    for (const f of wasm) {
      const bytes = fs.readFileSync(f, 'latin1');
      const out = scrubText(bytes, tokens);
      if (out !== bytes) fs.writeFileSync(f, out, 'latin1');
    }
    for (const f of walk(server).filter(f => TEXT.test(f))) {
      const text = fs.readFileSync(f, 'utf8');
      const out = rename(text);
      if (out !== text) fs.writeFileSync(f, out);
    }
    for (const [from, to] of renames)
      fs.renameSync(path.join(astroDir, from), path.join(astroDir, to));
  }

  if (mask) {
    for (const f of files.filter(f => /\.html?$/i.test(f))) {
      const html = fs.readFileSync(f, 'utf8');
      const out = maskHtml(html);
      if (out !== html) fs.writeFileSync(f, out);
    }
  }
}
