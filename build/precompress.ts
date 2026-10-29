// Writes a .br and a .gz copy next to each text file in dist/client, once, at build time, so the
// server sends those (serverlib/static.ts, preCompressed) instead of compressing every response
// itself. On a one-core server that was about 150 ms of CPU for each visitor's first load of the
// 1.9 MB transport file alone, and build time allows the slowest, smallest setting.
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const TEXT = /\.(html|js|mjs|css|wasm|json|svg|txt|xml|webmanifest)$/i;
// Below this, the compressed copy saves less than a packet.
const MIN_BYTES = 1024;

// Returns how many files got compressed copies.
export function precompress(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !TEXT.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    const data = fs.readFileSync(file);
    if (data.length < MIN_BYTES) continue;
    const copies: [string, Buffer][] = [
      [
        '.br',
        brotliCompressSync(data, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        }),
      ],
      ['.gz', gzipSync(data, { level: 9 })],
    ];
    let wrote = false;
    for (const [ext, packed] of copies) {
      // A copy that barely shrinks isn't worth the client's time to unpack.
      if (packed.length > data.length * 0.9) continue;
      fs.writeFileSync(file + ext, packed);
      wrote = true;
    }
    if (wrote) count++;
  }
  return count;
}
