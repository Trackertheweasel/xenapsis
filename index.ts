import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyMiddie from '@fastify/middie';
import fastifyStatic from '@fastify/static';
import type { FastifyStaticOptions, SetHeadersResponse } from '@fastify/static';
import { logging, server as wisp } from '@mercuryworkshop/wisp-js/server';
import chalk from 'chalk';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { constants as zlibConstants } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCESS_COOKIE,
  accessCookie,
  checkCode,
  createToken,
  enterPage,
  loadAccess,
  readCookie,
  recordFailure,
  renewToken,
  tokenSubject,
  tooManyAttempts,
  verifyToken,
} from 'serverlib/access';
import { updateChecker } from 'serverlib/check';
import { wispPath } from 'serverlib/env';
import { BackupStore, MAX_BACKUP_BYTES } from 'serverlib/logins';
import { findProvider } from 'serverlib/provider';
import { version } from './package.json' with { type: 'json' };

EventEmitter.defaultMaxListeners = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 6060;

// The client bakes the same value in at build time (serverlib/env.ts is shared with astro.config.ts).
const WISP_PATH = wispPath();

logging.set_level(logging.ERROR);
Object.assign(wisp.options, {
  dns_method: 'resolve',
  // Cloudflare DNS with malware blocking only (1.1.1.3 would also block adult content).
  dns_servers: ['1.1.1.2', '1.0.0.2'],
  dns_result_order: 'ipv4first',
  // Browsing only needs TCP to web ports. Blocking UDP and low ports (SMTP, SSH, ...)
  // stops the server being used for spam or attacks; 2525 is a common alternate SMTP port.
  allow_udp_streams: false,
  port_whitelist: [80, 443, [1024, 2524], [2526, 65535]],
  wisp_version: 2,
  // The MOTD is returned to anyone who completes the WebSocket handshake. The usual
  // "wisp server" string is a fixed value that lets automated fingerprinting identify the
  // endpoint as a Wisp proxy at a glance, so default to an empty, non-identifying value.
  // A deployment can set PERSEC_WISP_MOTD if it wants a custom string.
  wisp_motd: process.env.PERSEC_WISP_MOTD ?? '',
});

async function ensureBuild() {
  if (!fs.existsSync('dist')) {
    console.log(chalk.hex('#f39c12')('🚀 Building Persec...'));
    try {
      execSync('npm run build', { stdio: 'inherit' });
      console.log(chalk.hex('#2ecc71')('✅ Build completed successfully!'));
    } catch (error) {
      console.error(chalk.red('Build failed:'), error);
      process.exit(1);
    }
  } else {
    console.log(chalk.hex('#3498db')('Persec is already built, skipping...'));
  }
}

const access = loadAccess();
const hasAccess = (cookieHeader: string | undefined) =>
  !access || verifyToken(access, readCookie(cookieHeader, ACCESS_COOKIE));
const isSecure = (req: FastifyRequest) =>
  req.headers['x-forwarded-proto'] === 'https' || !!(req.raw.socket as any).encrypted;

const app = Fastify({
  logger: false,
  serverFactory: handler => {
    const server = createServer();
    
    server.setMaxListeners(0);
    // it will log about a memory leak due to how many sockets it adds due to astros SSR & fastify shit

  server.on('connection', (socket) => {
    socket.setMaxListeners(0);
  });
    const requestHandler = (req: any, res: any) => handler(req, res);
    const upgradeHandler = (req: any, socket: any, head: any) => {
      if (req.url?.endsWith(WISP_PATH) && hasAccess(req.headers.cookie)) {
        wisp.routeRequest(req, socket, head);
      } else {
        socket.destroy();
      }
    };
    
    server.on('request', requestHandler);
    server.on('upgrade', upgradeHandler);
    
    return server;
  },
});

await ensureBuild();

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

if (access) {
  const OPEN_PATHS = new Set(['/enter', '/favicon.ico', '/robots.txt']);

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

  app.get('/enter', (_req, reply) => {
    reply.header('Cache-Control', 'no-store').type('text/html').send(enterPage());
  });

  app.post('/enter', (req, reply) => {
    const ip = (req.headers['cf-connecting-ip'] as string) || req.ip;
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

  // Saved logins (see serverlib/logins.ts). Each person can only reach their own backup.
  const backups = new BackupStore(
    process.env.PERSEC_DATA_DIR
      ? path.join(process.env.PERSEC_DATA_DIR, 'logins')
      : path.join(__dirname, 'data', 'logins'),
  );
  const subjectOf = (req: FastifyRequest): string => {
    const subject = tokenSubject(access, readCookie(req.headers.cookie, ACCESS_COOKIE));
    if (subject === null) throw Object.assign(new Error('Invite required'), { statusCode: 401 });
    return subject;
  };
  backups.prune().catch(() => {});
  setInterval(() => backups.prune().catch(() => {}), 24 * 3600 * 1000).unref();

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_BACKUP_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/logins/status', async (req, reply) => {
    const backup = await backups.get(subjectOf(req));
    reply.header('Cache-Control', 'no-store');
    return { saved: !!backup, updated: backup?.updated ?? null };
  });

  app.get('/api/logins', async (req, reply) => {
    const backup = await backups.get(subjectOf(req));
    reply.header('Cache-Control', 'no-store');
    if (!backup) return reply.code(204).send();
    return reply.type('application/octet-stream').send(backup.data);
  });

  app.put('/api/logins', async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return reply.code(400).type('text/plain').send('Expected an encrypted backup');
    }
    await backups.put(subjectOf(req), req.body);
    return reply.code(204).send();
  });

  app.delete('/api/logins', async (req, reply) => {
    await backups.delete(subjectOf(req));
    return reply.code(204).send();
  });
}

await app.register(fastifyMiddie);

const clientRoot = path.join(__dirname, 'dist', 'client');

function cacheControlFor(filePath: string): string {
  const rel = path.relative(clientRoot, filePath).split(path.sep).join('/');
  if (/\.(html?|astro)$/i.test(rel)) return 'no-cache, no-store, must-revalidate';
  // Astro puts content-hashed files in _astro/, so they never change.
  if (rel.startsWith('_astro/')) return 'public, max-age=31536000, immutable';
  // The service worker and the proxy runtime it imports must update together, so always revalidate.
  if (rel === 'sw.js' || /^(data|tmp|lc|bm)\//.test(rel)) return 'no-cache';
  return 'public, max-age=3600';
}

const staticFileOptions: FastifyStaticOptions = {
  decorateReply: true,
  // Let setHeaders decide Cache-Control instead of the plugin's default "max-age=0".
  cacheControl: false,
  setHeaders(res: SetHeadersResponse, filePath: string) {
    res.setHeader('Cache-Control', cacheControlFor(filePath));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  },
  root: clientRoot,
  // Serves prerendered pages (dist/client/st.html) at their clean URLs (/st).
  extensions: ['html'],
};
await app.register(fastifyStatic, staticFileOptions);

app.use('/api/query', async (req: any, res: any) => {
  const urlObj = new URL(req.url ?? '', 'http://localhost');
  const search = urlObj.searchParams.get('q');
  if (!search) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Query parameter "q" is required.' }));
    return;
  }
  try {
    const response = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(search)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      // Without a timeout, a slow DuckDuckGo leaves requests hanging until the client gives up.
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      res.statusCode = response.status;
      res.end(JSON.stringify({ error: 'Failed to fetch suggestions.' }));
      return;
    }
    const data = await response.json();
    const suggestions = Array.isArray(data) ? data.map((d: any) => d.phrase).filter(Boolean) : [];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ suggestions }));
  } catch (err) {
    console.error('Backend suggestion error:', err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Internal server error.' }));
  }
});

// @ts-ignore
const { handler } = await import('./dist/server/entry.mjs');

// Astro's middleware would try (and fail) to render prerendered pages itself, so send
// those straight to fastify-static, which serves dist/client/<page>.html.
const prerendered = new Set(
  fs
    .readdirSync(clientRoot)
    .filter(f => f.endsWith('.html'))
    .map(f => (f === 'index.html' ? '/' : `/${f.slice(0, -'.html'.length)}`)),
);
app.use((req: any, res: any, next: any) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (prerendered.has(pathname)) return next();
  return handler(req, res, next);
});

app.setNotFoundHandler((_, reply) => {
  const notFoundText = fs.existsSync('404') ? fs.readFileSync('404', 'utf8') : '404 Not Found';
  reply.code(404).type('text/plain').send(notFoundText);
});

app.listen({ host: '0.0.0.0', port }, err => {
  if (err) {
    console.error(chalk.red('Failed to start server:'), err);
    process.exit(1);
  }

  const updateStatus = updateChecker();
  type StatusKey = 'u' | 'n' | 'f';
  const statusMap: Record<
    StatusKey,
    { icon: string; text: string; color: string; extra?: string }
  > = {
    u: { icon: '✅', text: 'Up to date', color: '#2ecc71' },
    n: {
      icon: '❌',
      text: `Update available (${updateStatus.commitId})`,
      color: '#f1c40f',
      extra: chalk.hex('#95a5a6')('→ https://github.com/Trackertheweasel/xenapsis'),
    },
    f: { icon: '❌', text: 'Failed to check for updates', color: '#e74c3c' },
  };
  const statusKey = (
    ['u', 'n', 'f'].includes(updateStatus.status) ? updateStatus.status : 'f'
  ) as StatusKey;
  const status = statusMap[statusKey];
  const deploymentURL = findProvider(port);

  console.log();
  console.log(chalk.hex('#8e44ad').bold('╭────────────────────────────────────────────╮'));
  console.log(
    chalk.hex('#8e44ad').bold('│ ') +
      chalk.hex('#f39c12').bold('🔒 Persec Server Started') +
      '                  │',
  );
  console.log(chalk.hex('#8e44ad').bold('╰────────────────────────────────────────────╯'));
  console.log();
  console.log(chalk.hex('#00cec9')('Information:'));
  console.log(
    chalk.hex('#bdc3c7')('   ├─ ') +
      chalk.hex('#ecf0f1')('Version: ') +
      chalk.hex('#f39c12')(`v${version}`),
  );
  console.log(
    chalk.hex('#bdc3c7')('   └─ ') +
      chalk.hex('#ecf0f1')('Up to date: ') +
      chalk.hex(status.color)(`${status.icon} ${status.text}`),
  );
  if (status.extra) console.log('       ' + status.extra);
  console.log();
  console.log(
    chalk.hex('#bdc3c7')('   Access: ') +
      chalk.hex('#ecf0f1')(
        access
          ? `invite-only (${access.codes.size} code${access.codes.size === 1 ? '' : 's'}${access.minted ? ', minted invites on' : ''})`
          : 'open to everyone',
      ),
  );
  if (access && !access.minted) {
    console.log(chalk.hex('#f1c40f')('   Set PERSEC_SECRET so people stay signed in across restarts.'));
    if (!access.codes.size) {
      console.log(chalk.hex('#e74c3c')('   No invite codes and no PERSEC_SECRET: nobody can sign in.'));
    }
  }
  console.log();
  console.log(chalk.hex('#00b894')('Access Information:'));
  if (deploymentURL) {
    console.log(
      chalk.hex('#bdc3c7')('   ├─ ') +
        chalk.hex('#ecf0f1')('Deployment URL: ') +
        chalk.hex('#0984e3').underline(deploymentURL),
    );
    console.log(
      chalk.hex('#bdc3c7')('   └─ ') +
        chalk.hex('#ecf0f1')('Hosting Method: ') +
        chalk.hex('#95a5a6')('Cloud Hosting'),
    );
  } else {
    console.log(
      chalk.hex('#bdc3c7')('   ├─ ') +
        chalk.hex('#ecf0f1')('Local: ') +
        chalk.hex('#00cec9').underline(`http://localhost:${port}`),
    );
    console.log(
      chalk.hex('#bdc3c7')('   ├─ ') +
        chalk.hex('#ecf0f1')('Network: ') +
        chalk.hex('#00cec9').underline(`http://127.0.0.1:${port}`),
    );
    console.log(
      chalk.hex('#bdc3c7')('   └─ ') +
        chalk.hex('#ecf0f1')('Hosting Method: ') +
        chalk.hex('#95a5a6')('Self Hosting'),
    );
  }
  console.log();
  console.log(chalk.hex('#8e44ad').bold('──────────────────────────────────────────────'));
  console.log();
});
