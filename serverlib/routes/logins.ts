import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ACCESS_COOKIE, readCookie, tokenSubject } from '../access';
import type { AccessConfig } from '../access';
import { BackupStore, MAX_BACKUP_BYTES } from '../logins';

// Saved logins (see serverlib/logins.ts). Each person can only reach their own backup.
export function registerLoginRoutes(app: FastifyInstance, access: AccessConfig, dir: string) {
  const backups = new BackupStore(dir);
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
