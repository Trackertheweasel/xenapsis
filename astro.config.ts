import node from '@astrojs/node';
import { baremuxPath } from '@mercuryworkshop/bare-mux/node';
import { libcurlPath } from '@mercuryworkshop/libcurl-transport';
import { scramjetPath } from '@mercuryworkshop/scramjet/path';
import playformCompress from '@playform/compress';
import tailwindcss from '@tailwindcss/vite';
import { uvPath } from '@titaniumnetwork-dev/ultraviolet';
import { defineConfig } from 'astro/config';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePath } from 'vite';
import type { Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { RUNTIME_FIXES } from './build/vendor';
import { version } from './package.json';
import { loadAccess } from './serverlib/access';
import { adSlot, handleAd } from './serverlib/ads';
import { deployPaths, urlKey, wispPath } from './serverlib/env';
import type { RuntimeFile } from './serverlib/env';
import { handleQuery } from './serverlib/routes/query';
import { routeWisp } from './serverlib/wisp';

// Build-time values baked into the client; see serverlib/env.ts for what each one does.
const WISP_PATH = wispPath();
const URL_KEY = urlKey();
const PATHS = deployPaths();

// Where each runtime file comes from in its package.
const RUNTIME_SOURCES: Record<Exclude<RuntimeFile, 'uvConfig'>, string> = {
  scramjetAll: `${scramjetPath}/scramjet.all.js`,
  scramjetSync: `${scramjetPath}/scramjet.sync.js`,
  scramjetWasm: `${scramjetPath}/scramjet.wasm.wasm`,
  uvBundle: `${uvPath}/uv.bundle.js`,
  uvHandler: `${uvPath}/uv.handler.js`,
  uvClient: `${uvPath}/uv.client.js`,
  uvSw: `${uvPath}/uv.sw.js`,
  bareMux: `${baremuxPath}/index.js`,
  bareMuxWorker: `${baremuxPath}/worker.js`,
  libcurl: `${libcurlPath}/index.mjs`,
};

// Dev server only (`pnpm dev`); production serves both from serverlib/app.ts. They share the same
// Wisp settings and search handler so dev behaves like production.
function WispServer(): Plugin {
  return {
    name: 'vite-wisp-server',
    configureServer(server: any) {
      // Same invite rule as production, so a dev server shared over a tunnel is no open proxy.
      const access = loadAccess();
      if (access) {
        console.warn(
          'Invite-only mode: the dev server has no sign-in page, so the Wisp tunnel stays closed. ' +
            'Unset PERSEC_INVITE_CODES and PERSEC_INVITE_ONLY to browse through the proxy in dev.',
        );
      }
      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: any, head: any) => {
        routeWisp(access, WISP_PATH, req, socket, head);
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

// The ad routes, and the ad slot handed to pages as Astro.locals.ads, as serverlib/app.ts does in
// production. Astro's dev server reads a request's locals from this symbol.
function adsBackend(): Plugin {
  return {
    name: 'persec-ads',
    configureServer({ middlewares }) {
      middlewares.use((req, res, next) => {
        Reflect.set(req, Symbol.for('astro.locals'), { ads: adSlot } satisfies App.Locals);
        handleAd(req, res, next);
      });
    },
  };
}

// The server needs this build's paths for its cache headers (serverlib/static.ts). Written next to
// the server bundle, never into dist/client, so it is not served.
function savePaths() {
  return {
    name: 'persec-deploy-paths',
    hooks: {
      'astro:build:done': ({ dir }: { dir: URL }) => {
        const file = path.join(fileURLToPath(dir), '..', 'server', 'paths.json');
        fs.writeFileSync(file, JSON.stringify(PATHS));
      },
    },
  };
}

export default defineConfig({
  integrations: [
    savePaths(),
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
      PERSEC_PATHS: JSON.stringify(PATHS),
    },
    plugins: [
      tailwindcss(),
      WispServer(),
      searchBackend(),
      adsBackend(),
      viteStaticCopy({
        targets: Object.entries(RUNTIME_SOURCES).map(([role, src]) => ({
          src: normalizePath(src),
          dest: PATHS.runtime.slice(1, -1),
          // v4 keeps the source's folders unless told to strip them; the runtime is one flat folder.
          rename: { stripBase: true, name: path.basename(PATHS.files[role as RuntimeFile]) },
          overwrite: false,
          // Bugs in the runtime's own code, fixed as it's copied (build/vendor.ts).
          ...(RUNTIME_FIXES[role] && { transform: RUNTIME_FIXES[role] }),
        })),
      }) as any, // DO NOT REMOVE "AS ANY"
    ],
    server: {
      host: true,
      allowedHosts: ['.localhost', '.trycloudflare.com'],
    },
  },
});
