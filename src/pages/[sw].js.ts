import source from '../sw.js?raw';

export const prerender = true;

export const getStaticPaths = () => [{ params: { sw: PERSEC_PATHS.sw.slice(1, -'.js'.length) } }];

// The service worker (src/sw.js), served at this build's own path and told where the runtime is.
export const GET = () =>
  new Response(`const PERSEC_PATHS = ${JSON.stringify(PERSEC_PATHS)};\n${source}`, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  });
