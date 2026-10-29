// Runs last in `pnpm build`, after scripts/disguise.ts has finished changing dist/client. See
// build/precompress.ts.
import { fileURLToPath } from 'node:url';
import { precompress } from '../build/precompress';

const count = precompress(fileURLToPath(new URL('../dist/client', import.meta.url)));
console.log(`Precompressed ${count} files`);
