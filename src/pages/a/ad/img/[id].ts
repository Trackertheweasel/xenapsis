import type { APIRoute } from 'astro';
import { creativeFor } from '@/utils/ads';

export const prerender = false;

// Serves a cached ad creative from Persec's own origin, so the visitor's browser never requests it
// from the ad network.
export const GET: APIRoute = ({ params }) => {
  const creative = params.id ? creativeFor(params.id) : undefined;
  if (!creative) return new Response('Not found', { status: 404 });
  // A plain, own-buffer Uint8Array so it is accepted as a response body.
  return new Response(new Uint8Array(creative.buf), {
    headers: {
      'content-type': creative.type,
      // Private and short-lived: the slot rotates and creatives are per-session.
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
};
