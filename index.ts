import chalk from 'chalk';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from './package.json' with { type: 'json' };
import { loadAccess } from 'serverlib/access';
import { loadAiConfig } from 'serverlib/ai/index';
import { buildApp } from 'serverlib/app';
import { printBanner } from 'serverlib/banner';
import { startBlocklist } from 'serverlib/blocklist';
import { loadBrowserConfig } from 'serverlib/browser/index';
import { wispPath } from 'serverlib/env';

EventEmitter.defaultMaxListeners = 0;

// Runs from source (tsx index.ts) or as the bundle `pnpm build` writes to dist/start.mjs, which is
// what the Docker image runs. Either way, paths below are relative to the repository root.
const here = path.dirname(fileURLToPath(import.meta.url));
const __dirname = path.basename(here) === 'dist' ? path.dirname(here) : here;
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
const dataDir = process.env.PERSEC_DATA_DIR || path.join(__dirname, 'data');
// Ad and tracker hosts the tunnel refuses (PERSEC_WISP_ADBLOCK=off turns it off).
startBlocklist();
const app = await buildApp({
  access,
  // The client bakes the same value in at build time (serverlib/env.ts is shared with astro.config.ts).
  wispPath: wispPath(),
  loginsDir: path.join(dataDir, 'logins'),
  invitesFile: path.join(dataDir, 'invites.json'),
  version: pkg.version,
  // OPENROUTER_API_KEY and friends. Without a key, PerSec AI reports itself off and nothing else changes.
  ai: { config: loadAiConfig() },
  // CAMOUFOX_ENABLED and friends. Off unless the owner runs a browser service (docs/browser-runtime.md).
  browser: { config: loadBrowserConfig() },
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

// `docker stop` and hosts like Render send SIGTERM. Stop taking connections and let requests in
// flight finish, but don't wait long: proxy tunnels stay open for as long as a tab does.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    setTimeout(() => process.exit(0), 5000).unref();
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
