// Runs after `astro build` (see package.json), once Astro's integrations, the compressor among
// them, have finished writing dist/. See build/disguise.ts.
import { fileURLToPath } from 'node:url';
import { disguiseBuild } from '../build/disguise';
import { disguiseSettings } from '../serverlib/env';

const settings = disguiseSettings();
disguiseBuild({
  client: fileURLToPath(new URL('../dist/client', import.meta.url)),
  server: fileURLToPath(new URL('../dist/server', import.meta.url)),
  ...settings,
});
console.log(
  `Disguise: scrub ${settings.scrub ? 'on' : 'off'}, text masking ${settings.mask ? 'on' : 'off'}`,
);
