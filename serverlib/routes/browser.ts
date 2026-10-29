import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ACCESS_COOKIE, readCookie, tokenSubject } from '../access';
import type { AccessConfig } from '../access';
import { createCamoufoxRuntime } from '../browser/camoufox';
import { BrowserError, SessionManager, isBrowserError } from '../browser/index';
import type { BrowserConfig, BrowserErrorCode, BrowserRuntime } from '../browser/index';
import { siteById } from '../browser/sites';
import { checkNavigationUrl } from '../browser/url';
import { sameOrigin } from '../wisp';

// Browser mode's routes (see serverlib/browser/index.ts):
//
//   GET    /api/browser/status                     whether it's on, and nothing else
//   GET    /api/browser/sessions/current           the caller's open session, if any
//   POST   /api/browser/sessions                   { site: 'chatgpt' | 'claude' } starts one there
//   GET    /api/browser/sessions/:id               where the page is now
//   POST   /api/browser/sessions/:id/navigate      { url } on that same site
//   GET    /api/browser/sessions/:id/screenshot    a JPEG of the page, for its owner only
//   DELETE /api/browser/sessions/:id               ends it
//
// Every session belongs to the invite that started it, so browser mode needs invite-only mode.
// Nothing a client sends picks the browser, its binary, profile, proxy or endpoint: those come
// from the server's environment. Cookies, storage and passwords stay inside the browser; these
// routes return a page's address, title and picture, never its cookies or its fields.

export interface BrowserRouteOptions {
  access: AccessConfig | null;
  config: BrowserConfig;
  // For tests: a runtime to use instead of connecting to Camoufox.
  runtime?: BrowserRuntime;
}

export async function registerBrowserRoutes(app: FastifyInstance, options: BrowserRouteOptions) {
  const { access, config } = options;
  const disabled: BrowserErrorCode | null = !config.enabled
    ? 'disabled'
    : !access
      ? 'unavailable_open_mode'
      : !config.wsEndpoint && !options.runtime
        ? 'not_configured'
        : null;

  const manager = disabled
    ? null
    : new SessionManager(options.runtime ?? createCamoufoxRuntime(config.wsEndpoint!), config);
  if (manager) app.addHook('onClose', () => manager.shutdown());

  const ownerOf = (req: FastifyRequest): string => {
    if (!access || !manager) throw new BrowserError(disabled ?? 'disabled');
    const subject = tokenSubject(access, readCookie(req.headers.cookie, ACCESS_COOKIE));
    if (subject === null) throw Object.assign(new Error('Invite required'), { statusCode: 401 });
    return subject;
  };

  const ready = () => {
    if (!manager) throw new BrowserError(disabled ?? 'disabled');
    return manager;
  };

  await app.register(
    async scope => {
      scope.setErrorHandler((err, _req, reply) => {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 401) return reply.code(401).type('text/plain').send('Invite required');
        const e = isBrowserError(err)
          ? err
          : new BrowserError(
              status && status >= 400 && status < 500 ? 'invalid_request' : 'internal',
            );
        reply.code(e.status).send(e.toJSON());
      });

      scope.addHook('onRequest', async req => {
        // SameSite=Lax still sends the sign-in cookie from sibling subdomains (another *.sslip.io
        // name), so anything that changes state must come from this site's own pages.
        if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req.raw)) {
          throw new BrowserError('invalid_request');
        }
      });

      scope.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });

      scope.get('/status', async () => ({
        enabled: !disabled,
        runtime: 'camoufox',
        ...(disabled ? { reason: disabled } : {}),
      }));

      scope.get('/sessions/current', async req => {
        const owner = ownerOf(req);
        return { session: ready().current(owner) };
      });

      scope.post('/sessions', { bodyLimit: 4 * 1024 }, async (req, reply) => {
        const owner = ownerOf(req);
        const site = siteById((req.body as { site?: unknown } | null)?.site);
        if (!site) throw new BrowserError('site_not_allowed');
        const m = ready();
        const session = await m.create(owner);
        try {
          const state = await m.navigate(owner, session.id, site.start);
          return reply.code(201).send({ session, state });
        } catch (err) {
          // The session is still there to retry or end; say why the first page didn't load.
          const e = isBrowserError(err) ? err : new BrowserError('navigation_failed');
          return reply.code(201).send({ session, state: null, error: e.toJSON().error });
        }
      });

      scope.get('/sessions/:id', async req => {
        const owner = ownerOf(req);
        const { id } = req.params as { id: string };
        const m = ready();
        return { session: m.info(owner, id), state: await m.state(owner, id) };
      });

      scope.post('/sessions/:id/navigate', { bodyLimit: 4 * 1024 }, async req => {
        const owner = ownerOf(req);
        const { id } = req.params as { id: string };
        const url = checkNavigationUrl((req.body as { url?: unknown } | null)?.url);
        return { state: await ready().navigate(owner, id, url.href) };
      });

      scope.get('/sessions/:id/screenshot', async (req, reply) => {
        const owner = ownerOf(req);
        const { id } = req.params as { id: string };
        const image = await ready().screenshot(owner, id);
        return reply.type('image/jpeg').header('X-Content-Type-Options', 'nosniff').send(image);
      });

      scope.delete('/sessions/:id', async (req, reply) => {
        const owner = ownerOf(req);
        const { id } = req.params as { id: string };
        await ready().end(owner, id);
        return reply.code(204).send();
      });
    },
    { prefix: '/api/browser' },
  );

  return manager;
}
