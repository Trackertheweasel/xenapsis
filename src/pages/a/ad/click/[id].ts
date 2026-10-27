import type { APIRoute } from 'astro';
import { recordClick } from '@/utils/ads';

export const prerender = false;

// Records the click on the server (firing the network's click callback if any) and then sends the
// visitor straight to the advertiser. The network never sees the visitor.
export const GET: APIRoute = async ({ params, redirect }) => {
  const target = params.id ? await recordClick(params.id) : null;
  // Only ever redirect to a real web address, never to javascript:/data: and the like.
  if (!target || !/^https?:\/\//i.test(target)) return redirect('/new', 302);
  return redirect(target, 302);
};
