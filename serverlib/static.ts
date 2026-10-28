import type { FastifyStaticOptions } from '@fastify/static';
import type { FastifyReply } from 'fastify';
import path from 'node:path';
import type { DeployPaths } from './env';

export function cacheControlFor(clientRoot: string, filePath: string, paths: DeployPaths): string {
  const rel = path.relative(clientRoot, filePath).split(path.sep).join('/');
  if (/\.(html?|astro)$/i.test(rel)) return 'no-cache, no-store, must-revalidate';
  // Astro puts content-hashed files in _astro/, so they never change.
  if (rel.startsWith('_astro/')) return 'public, max-age=31536000, immutable';
  // The service worker and the proxy runtime it imports must update together, so always revalidate.
  const url = '/' + rel;
  if (url === paths.sw || url.startsWith(paths.runtime)) return 'no-cache';
  return 'public, max-age=3600';
}

export function staticFileOptions(clientRoot: string, paths: DeployPaths): FastifyStaticOptions {
  return {
    decorateReply: true,
    // Let setHeaders decide Cache-Control instead of the plugin's default "max-age=0".
    cacheControl: false,
    setHeaders(reply: FastifyReply, filePath: string) {
      reply.headers({
        'Cache-Control': cacheControlFor(clientRoot, filePath, paths),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
    },
    root: clientRoot,
    // Serves prerendered pages (dist/client/st.html) at their clean URLs (/st).
    extensions: ['html'],
  };
}
