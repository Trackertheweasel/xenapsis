import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyMiddie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { constants as zlibConstants } from 'node:zlib';
import type { AccessConfig } from './access';
import type { DeployPaths } from './env';
import { registerAccessGate } from './routes/access';
import { registerLoginRoutes } from './routes/logins';
import { handleQuery } from './routes/query';
import { staticFileOptions } from './static';
import { routeWisp } from './wisp';

type NodeHandler = (req: any, res: any, next: (err?: unknown) => void) => void;

export interface AppOptions {
  access: AccessConfig | null;
  wispPath: string;
  // Where saved-login backups are stored (only used in invite-only mode).
  loginsDir: string;
  // The built site (dist/). Left out, only the server's own routes run, which is what tests use.
  // paths is the build's own (dist/server/paths.json), for cache headers.
  site?: { clientRoot: string; handler: NodeHandler; paths: DeployPaths };
}

// Composition only: this wires the server's parts together. Put logic in the module it belongs to
// (routes/, access.ts, wisp.ts, static.ts) so it can be tested on its own.
export async function buildApp({ access, wispPath, loginsDir, site }: AppOptions) {
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

  // Before middie, so the gate's hook runs ahead of the search API and Astro's pages.
  if (access) {
    registerAccessGate(app, access);
    registerLoginRoutes(app, access, loginsDir);
  }

  await app.register(fastifyMiddie);
  if (site) await app.register(fastifyStatic, staticFileOptions(site.clientRoot, site.paths));

  app.use('/api/query', handleQuery);

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
      return site.handler(req, res, next);
    });
  }

  app.setNotFoundHandler((_, reply) => {
    const notFoundText = fs.existsSync('404') ? fs.readFileSync('404', 'utf8') : '404 Not Found';
    reply.code(404).type('text/plain').send(notFoundText);
  });

  return app;
}
