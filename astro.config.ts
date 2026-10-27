import node from '@astrojs/node';
import { baremuxPath } from '@mercuryworkshop/bare-mux/node';
import { libcurlPath } from '@mercuryworkshop/libcurl-transport';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import playformCompress from '@playform/compress';
import tailwindcss from '@tailwindcss/vite';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';
import { defineConfig } from 'astro/config';
import type { IncomingMessage } from 'http';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { version } from './package.json';
import { proxyPrefixes, urlKey, wispPath } from './serverlib/env';
import { handleQuery } from './serverlib/routes/query';
import { wisp } from './serverlib/wisp';

// Build-time values baked into the client; see serverlib/env.ts for what each one does.
const WISP_PATH = wispPath();
const URL_KEY = urlKey();
const [SC_PREFIX, UV_PREFIX] = proxyPrefixes();

// Dev server only (`pnpm dev`); production serves both from serverlib/app.ts. They share the same
// Wisp settings and search handler so dev behaves like production.
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
      middlewares.use('/api/query', handleQuery);
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
      URL_KEY: JSON.stringify(URL_KEY),
      SC_PREFIX: JSON.stringify(SC_PREFIX),
      UV_PREFIX: JSON.stringify(UV_PREFIX),
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