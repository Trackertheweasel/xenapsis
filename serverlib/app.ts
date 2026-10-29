import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyMiddie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { constants as zlibConstants } from 'node:zlib';
import type { AccessConfig } from './access';
import { adSlot, handleAd } from './ads';
import { loadAiConfig } from './ai/index';
import type { AiConfig, ChatProvider } from './ai/index';
import { loadBrowserConfig } from './browser/index';
import type { BrowserConfig, BrowserRuntime } from './browser/index';
import type { DeployPaths } from './env';
import { registerAccessGate } from './routes/access';
import { registerAdminRoutes } from './routes/admin';
import { registerAiRoutes } from './routes/ai';
import { registerBrowserRoutes } from './routes/browser';
import { registerLoginRoutes } from './routes/logins';
import { handleQuery } from './routes/query';
import { staticFileOptions } from './static';
import { routeWisp } from './wisp';

type NodeHandler = (req: any, res: any, next: (err?: unknown) => void, locals?: App.Locals) => void;

export interface AppOptions {
  access: AccessConfig | null;
  wispPath: string;
  // Where saved-login backups are stored (only used in invite-only mode).
  loginsDir: string;
  // The built site (dist/). Left out, only the server's own routes run, which is what tests use.
  // paths is the build's own (dist/server/paths.json), for cache headers.
  site?: { clientRoot: string; handler: NodeHandler; paths: DeployPaths };
  // PerSec AI (serverlib/ai/). Left out, it is off, as it is without an OpenRouter key. provider
  // replaces the real OpenRouter client, for tests.
  ai?: { config: AiConfig; provider?: ChatProvider };
  // Browser mode (serverlib/browser/). Left out, it is off, as it is without CAMOUFOX_ENABLED.
  // runtime replaces the real Camoufox connection, for tests.
  browser?: { config: BrowserConfig; runtime?: BrowserRuntime };
}

// Composition only: this wires the server's parts together. Put logic in the module it belongs to
// (routes/, access.ts, ads.ts, wisp.ts, static.ts) so it can be tested on its own.
export async function buildApp({ access, wispPath, loginsDir, site, ai, browser }: AppOptions) {
  const app = Fastify({
    logger: false,
    serverFactory: handler => {
      const server = createServer();
      // Astro's SSR and Fastify add many listeners per socket; lift the cap so Node doesn't log a
      // false memory-leak warning.
      server.setMaxListeners(0);
      server.on('connection', socket => socket.setMaxListeners(0));
      server.on('request', (req, res) => handler(req, res));
      // Only the tunnel upgrades; it needs an invite too (see routeWisp).
      server.on('upgrade', (req, socket, head) => {
        if (!routeWisp(access, wispPath, req, socket, head)) socket.destroy();
      });
      return server;
    },
  });

  await app.register(fastifyHelmet, {
    crossOriginEmbedderPolicy: { policy: 'credentialless' }, // Like Space: require-corp blocks some cross-origin assets.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    contentSecurityPolicy: false,
    xPoweredBy: false,
  });

  await app.register(fastifyCompress, {
    encodings: ['br', 'gzip', 'deflate'],
    // Default brotli quality (11) is far too slow to run per request on multi-MB files.
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
  });

  // For health checks (Dockerfile, Render). Open even in invite-only mode, and says nothing about
  // the server beyond being up: a plain "ok" on /healthz is what countless other sites answer too.
  app.get('/healthz', (_req, reply) => {
    reply.header('Cache-Control', 'no-store').type('text/plain').send('ok');
  });

  // Before middie, so the gate's hook runs ahead of the search API and Astro's pages.
  if (access) {
    registerAccessGate(app, access);
    registerLoginRoutes(app, access, loginsDir);
    if (access.adminPassword) registerAdminRoutes(app, access, access.adminPassword);
  }

  // After the gate, which covers these routes too. Registered in every mode so /api/ai/status can
  // say why PerSec AI is off.
  await registerAiRoutes(app, {
    access,
    config: ai?.config ?? loadAiConfig({}),
    provider: ai?.provider,
  });

  // Separate from PerSec AI and from the proxy: its own routes, behind the same gate. Registered
  // in every mode so /api/browser/status can say why it's off.
  await registerBrowserRoutes(app, {
    access,
    config: browser?.config ?? loadBrowserConfig({}),
    runtime: browser?.runtime,
  });

  await app.register(fastifyMiddie);
  if (site) await app.register(fastifyStatic, staticFileOptions(site.clientRoot, site.paths));

  app.use('/api/query', handleQuery);
  app.use(handleAd);

  // What every page Astro renders gets as Astro.locals. The ad slot lives here, in the server, so
  // the page showing an ad and the /a/ad/* routes serving it share one module's state.
  const locals: App.Locals = { ads: adSlot };

  if (site) {
    // Astro's middleware would try (and fail) to render prerendered pages itself, so send
    // those straight to fastify-static, which serves dist/client/<page>.html.
    const prerendered = new Set(
      fs
        .readdirSync(site.clientRoot)
        .filter(f => f.endsWith('.html'))
        .map(f => (f === 'index.html' ? '/' : `/${f.slice(0, -'.html'.length)}`)),
    );
    app.use((req: any, res: any, next: any) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (prerendered.has(pathname)) return next();
      return site.handler(req, res, next, locals);
    });
  }

  app.setNotFoundHandler((_, reply) => {
    reply.code(404).type('text/plain').send('404 Not Found');
  });

  return app;
}
