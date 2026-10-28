import type { APIRoute } from 'astro';
import { PIXEL, recordImpression } from '@/utils/ads';

export const prerender = false;

// A 1x1 pixel the ad card loads when it is shown. Loading it makes the server fire the network's
// impression callback, so views are counted without the visitor ever contacting the network.
export const GET: APIRoute = async ({ params }) => {
  if (params.id) await recordImpression(params.id);
  return new Response(PIXEL, {
    headers: {
      'content-type': 'image/gif',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
