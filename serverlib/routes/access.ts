import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ACCESS_COOKIE,
  accessCookie,
  checkCode,
  createToken,
  displayName,
  enterPage,
  readCookie,
  recordFailure,
  renewToken,
  tokenSubject,
  tooManyAttempts,
  verifyToken,
} from '../access';
import type { AccessConfig } from '../access';

export const isSecure = (req: FastifyRequest) =>
  req.headers['x-forwarded-proto'] === 'https' || !!(req.raw.socket as any).encrypted;

export function clientIp(access: AccessConfig, req: FastifyRequest): string {
  const header = access.clientIpHeader && req.headers[access.clientIpHeader];
  return (typeof header === 'string' && header) || req.ip;
}

// Called on the root instance, not through app.register: a hook added inside a plugin only covers
// that plugin's routes, which would leave static files, the search API and pages ungated.
export function registerAccessGate(app: FastifyInstance, access: AccessConfig) {
  const OPEN_PATHS = new Set(['/enter', '/favicon.ico', '/healthz', '/robots.txt']);

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, body, done) => done(null, new URLSearchParams(body as string)),
  );

  app.addHook('onRequest', async (req, reply) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (OPEN_PATHS.has(pathname)) return;
    const isPage = req.method === 'GET' && !!req.headers.accept?.includes('text/html');
    const token = readCookie(req.headers.cookie, ACCESS_COOKIE);
    if (verifyToken(access, token)) {
      // Only on pages, which are never cached, so a shared cache can't hand the cookie to others.
      // Set on the raw response because Astro writes some pages without going through reply.
      const renewed = isPage && renewToken(access, token);
      if (renewed) reply.raw.setHeader('Set-Cookie', accessCookie(renewed, isSecure(req)));
      return;
    }
    if (isPage) return reply.redirect('/enter');
    return reply.code(401).type('text/plain').send('Invite required');
  });

  // Behind the gate above, so only a signed-in person reaches it, and only their own name.
  app.get('/api/me', (req, reply) => {
    const subject = tokenSubject(access, readCookie(req.headers.cookie, ACCESS_COOKIE))!;
    reply.header('Cache-Control', 'no-store');
    return { name: displayName(subject) };
  });

  app.get('/enter', (_req, reply) => {
    reply.header('Cache-Control', 'no-store').type('text/html').send(enterPage());
  });

  app.post('/enter', (req, reply) => {
    const ip = clientIp(access, req);
    reply.header('Cache-Control', 'no-store').type('text/html');
    if (tooManyAttempts(ip)) {
      return reply.code(429).send(enterPage('Too many attempts. Try again in 15 minutes.'));
    }
    const code = (req.body as URLSearchParams | undefined)?.get('code') ?? '';
    const name = checkCode(access, code);
    if (!name) {
      recordFailure(ip);
      return reply.code(401).send(enterPage('That code is not valid.'));
    }
    reply.header('Set-Cookie', accessCookie(createToken(access, name), isSecure(req)));
    return reply.redirect('/');
  });
}
