import chalk from 'chalk';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAccess } from 'serverlib/access';
import { buildApp } from 'serverlib/app';
import { printBanner } from 'serverlib/banner';
import { wispPath } from 'serverlib/env';

EventEmitter.defaultMaxListeners = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 6060;
const entry = path.join(__dirname, 'dist', 'server', 'entry.mjs');
const pathsFile = path.join(__dirname, 'dist', 'server', 'paths.json');

// Start only what `pnpm build` produced. Building here instead made every first start slow, needed
// the build tooling at runtime, and could never notice that dist/ was older than the code.
if (!fs.existsSync(entry) || !fs.existsSync(pathsFile)) {
  console.error(chalk.red('Persec is not built. Run `pnpm build`, then `pnpm start`.'));
  process.exit(1);
}
const { handler } = await import(pathToFileURL(entry).href);

const access = loadAccess();
const app = await buildApp({
  access,
  // The client bakes the same value in at build time (serverlib/env.ts is shared with astro.config.ts).
  wispPath: wispPath(),
  loginsDir: process.env.PERSEC_DATA_DIR
    ? path.join(process.env.PERSEC_DATA_DIR, 'logins')
    : path.join(__dirname, 'data', 'logins'),
  site: {
    clientRoot: path.join(__dirname, 'dist', 'client'),
    handler,
    paths: JSON.parse(fs.readFileSync(pathsFile, 'utf8')),
  },
});

app.listen({ host: '0.0.0.0', port }, err => {
  if (err) {
    console.error(chalk.red('Failed to start server:'), err);
    process.exit(1);
  }
  printBanner(port, access);
});
