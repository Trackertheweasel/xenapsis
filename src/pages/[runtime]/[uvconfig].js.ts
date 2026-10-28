import { decodeUrl, encodeUrl } from '@/utils/codec';

export const prerender = true;

export const getStaticPaths = () => {
  const [, runtime, file] = PERSEC_PATHS.files.uvConfig.split('/');
  return [{ params: { runtime, uvconfig: file.slice(0, -'.js'.length) } }];
};

// Ultraviolet's config, loaded by the page and by the service worker (src/sw.js). Generated
// so it shares Scramjet's URL codec and build-time key (src/utils/codec.ts), and this build's paths.
export const uvConfigSource = () => `const encode = ${encodeUrl};
const decode = ${decodeUrl};

tmpConfig = {
  prefix: ${JSON.stringify(PERSEC_PATHS.uvPrefix)},
  encodeUrl: encode,
  decodeUrl: decode,
  handler: ${JSON.stringify(PERSEC_PATHS.files.uvHandler)},
  client: ${JSON.stringify(PERSEC_PATHS.files.uvClient)},
  bundle: ${JSON.stringify(PERSEC_PATHS.files.uvBundle)},
  config: ${JSON.stringify(PERSEC_PATHS.files.uvConfig)},
  sw: ${JSON.stringify(PERSEC_PATHS.files.uvSw)},
};

self.__uv$config = tmpConfig;
`;

export const GET = () =>
  new Response(uvConfigSource(), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
