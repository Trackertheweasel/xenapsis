import node from '@astrojs/node';
import { baremuxPath } from '@mercuryworkshop/bare-mux/node';
import { libcurlPath } from '@mercuryworkshop/libcurl-transport';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import playformCompress from '@playform/compress';
import tailwindcss from '@tailwindcss/vite';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';
import { defineConfig } from 'astro/config';
import type { IncomingMessage, ServerResponse } from 'http';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { version } from './package.json';

wisp.options.wisp_version = 2;

// The path the proxy's WebSocket tunnel listens on. A fixed, well-known path (the usual "/w/")
// lets a network filter confirm the server is a proxy just by probing that one URL. A deployment
// can set PUBLIC_PERSEC_WISP_PATH to a hard-to-guess value so there is nothing constant to probe.
// This value is baked into the client at build time, so the server (index.ts) must read the same
// env var at runtime. Normalized here once; the client uses the injected WISP_PATH below.
function normalizeWispPath(raw: string | undefined): string {
  let p = (raw ?? '').trim();
  if (!p) return '/w/';
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.endsWith('/')) p = p + '/';
  return p;
}
const WISP_PATH = normalizeWispPath(process.env.PUBLIC_PERSEC_WISP_PATH);

function WispServer(): Plugin {
  return {
    name: 'vite-wisp-server',
    configureServer(server: any) {
      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: any, head: any) => {
        if (req.url?.endsWith(WISP_PATH)) {
          wisp.routeRequest(req, socket, head);
        }
      });
    },
  };
}

function searchBackend(): Plugin {
  return {
    name: 'search-suggestions-vite',
    configureServer({ middlewares }) {
      middlewares.use('/api/query', async (req: IncomingMessage, res: ServerResponse) => {
        const urlObj = new URL(req.url ?? '', 'http://localhost');
        const query = urlObj.searchParams.get('q');

        if (!query) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Query parameter "q" is required.' }));
          return;
        }

        try {
          const response = await fetch(
            `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}`,
            {
              headers: {
                'User-Agent': 'Mozilla/5.0',
                Accept: 'application/json',
              },
            },
          );

          if (!response.ok) {
            res.statusCode = response.status;
            res.end(JSON.stringify({ error: 'Failed to fetch suggestions.' }));
            return;
          }

          const data = (await response.json()) as Array<{ phrase: string }>;
          const suggestions = data.map(d => d.phrase).filter(Boolean);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ suggestions }));
        } catch (err) {
          console.error('Backend suggestion error:', err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'Internal server error.' }));
        }
      });
    },
  };
}

export default defineConfig({
  integrations: [
    playformCompress({
      CSS: true,
      HTML: {
        'html-minifier-terser': {
          caseSensitive: true,
          conservativeCollapse: false,
          customAttrAssign: [/\?=/],
          customAttrCollapse: /\s+/,
          customEventAttributes: [/^on[a-z]{3,}$/],
          html5: true,
          ignoreCustomComments: [/^!/, /^\s*ko/],
          ignoreCustomFragments: [/<%[\s\S]*?%>/, /<\?[\s\S]*?\?>/],
          maxLineLength: 0,
          preserveLineBreaks: false,
          preventAttributesEscaping: false,
          processScripts: ['text/html'],
          quoteCharacter: '"',
          removeAttributeQuotes: true,
          removeRedundantAttributes: true,
          removeStyleLinkTypeAttributes: true,
          sortAttributes: true,
          sortClassName: true,
          trimCustomFragments: true,
          useShortDoctype: true,
          collapseWhitespace: true,
          removeComments: true,
          removeEmptyAttributes: true,
          keepClosingSlash: false,
          minifyJS: true,
          minifyCSS: true,
          decodeEntities: true,
          collapseBooleanAttributes: true,
          removeOptionalTags: true,
          minifyURLs: true,
          removeScriptTypeAttributes: true,
          processConditionalComments: true,
        },
      },
      Image: true,
      JavaScript: true,
      JSON: true,
      SVG: true,
    }),
  ],
  output: 'server',
  // Prerendered pages are written as st.html etc. and served by fastify-static (see index.ts).
  build: { format: 'file' },
  adapter: node({ mode: 'middleware' }),
  prefetch: { prefetchAll: true, defaultStrategy: 'load' },
  vite: {
    build: {
      minify: 'esbuild',
      chunkSizeWarningLimit: 1000,
    },
    optimizeDeps: {
      include: [],
      exclude: [],
    },
    define: {
      VERSION: JSON.stringify(version),
      WISP_PATH: JSON.stringify(WISP_PATH),
    },
    plugins: [
      tailwindcss(),
      WispServer(),
      searchBackend(),
      viteStaticCopy({
        targets: [
          { src: normalizePath(`${libcurlPath}/**/*.mjs`), dest: 'lc', overwrite: false },
          { src: normalizePath(`${baremuxPath}/**/*.js`), dest: 'bm', overwrite: false },
          {
            src: [normalizePath(`${scramjetPath}/*.js`), normalizePath(`${scramjetPath}/*.wasm`)],
            dest: 'data',
            rename: (name: string) => {
              const ending = name.endsWith('.wasm') ? '.wasm' : '.js';
              return `${name.replace(/^scramjet\./, '')}${ending}`;
            },
            overwrite: false,
          },
          {
            src: [normalizePath(`${uvPath}/*.js`), '!' + normalizePath(`${uvPath}/sw.js`)],
            dest: 'tmp',
            rename: (name: string) => {
              return `${name.replace(/^uv\./, '')}.js`;
            },
            overwrite: false,
          },
        ],
      }) as any, // DO NOT REMOVE "AS ANY"
    ],
    server: {
      host: true,
      allowedHosts: ['.localhost', '.trycloudflare.com'],
    },
  },
});