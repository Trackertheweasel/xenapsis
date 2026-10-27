import { decodeUrl, encodeUrl } from '@/utils/codec';

export const prerender = true;

// Ultraviolet's config, loaded by the page and by the service worker (public/sw.js). Generated
// so it shares Scramjet's URL codec and build-time key (src/utils/codec.ts).
export const uvConfigSource = () => `const encode = ${encodeUrl};
const decode = ${decodeUrl};

tmpConfig = {
  prefix: ${JSON.stringify(UV_PREFIX)},
  encodeUrl: encode,
  decodeUrl: decode,
  handler: '/tmp/handler.js',
  client: '/tmp/client.js',
  bundle: '/tmp/bundle.js',
  config: '/tmp/config.js',
  sw: '/tmp/sw.js',
};

self.__uv$config = tmpConfig;
`;

export const GET = () =>
  new Response(uvConfigSource(), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
