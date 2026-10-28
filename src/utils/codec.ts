// How both engines write the real URL into a proxied one (/v1/data/<here>). encodeURIComponent
// leaves "https%3A%2F%2Fsite.com" readable, which marks the server as a proxy at a glance, so
// the URL is XORed with a key and written as base64url. The key ships in the client, so this
// hides URLs from casual inspection only; it is no secret.
//
// URL_KEY is replaced with a string literal at build time (astro.config.ts) and these functions
// must not use anything else from this module: Scramjet stringifies its codec and re-creates it
// in the service worker, and the Ultraviolet config ([uvconfig].js.ts) embeds the same source for Ultraviolet.

export const encodeUrl = (url: string): string => {
  if (!url) return url;
  const key = new TextEncoder().encode(URL_KEY);
  const bytes = new TextEncoder().encode(url);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ^ key[i % key.length]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const decodeUrl = (url: string): string => {
  if (!url) return url;
  // A GET form on a proxied page appends its own "?query" to the encoded URL.
  const [input, ...search] = url.split('?');
  try {
    const key = new TextEncoder().encode(URL_KEY);
    const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key[i % key.length];
    return new TextDecoder().decode(bytes) + (search.length ? '?' + search.join('?') : '');
  } catch {
    return url;
  }
};
