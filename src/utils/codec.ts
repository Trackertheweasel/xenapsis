// How both engines write the real URL into a proxied one (/v1/data/<here>). encodeURIComponent
// leaves "https%3A%2F%2Fsite.com" readable, which marks the server as a proxy at a glance, so
// the URL is XORed with a key and written as base64url. The key ships in the client, so this
// hides URLs from casual inspection only; it is no secret.
//
// URL_KEY is replaced with a string literal at build time (astro.config.ts) and these functions
// must not use anything else from this module: Scramjet stringifies its codec and re-creates it
// in the service worker, and the Ultraviolet config ([uvconfig].js.ts) embeds the same source for Ultraviolet.

// Scramjet also runs the codec on a page's #fragment on its own, and passes the fragment on after
// the encoded URL when it decodes. Only whole addresses ("scheme://...") are scrambled; anything else,
// a fragment above all, is left as it is, and decoding leaves anything that isn't one alone.
export const encodeUrl = (url: string): string => {
  if (!url || !/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
  const key = new TextEncoder().encode(URL_KEY);
  const bytes = new TextEncoder().encode(url);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ^ key[i % key.length]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const decodeUrl = (url: string): string => {
  if (!url) return url;
  // Anything after "#" is a fragment, which is never scrambled: the page's own (location.hash), or
  // one Scramjet has already decoded and appended. It can hold "?" too, so it is split off first.
  const at = url.indexOf('#');
  const hash = at < 0 ? '' : url.slice(at);
  // A GET form on a proxied page appends its own "?query" to the encoded URL.
  const [input, ...search] = (at < 0 ? url : url.slice(0, at)).split('?');
  try {
    const key = new TextEncoder().encode(URL_KEY);
    const bin = atob(input.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ key[i % key.length];
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // A fragment on its own (or anything else that was never encoded) can still be valid base64;
    // what it decodes to is no address.
    if (!/^[a-z][a-z\d+.-]*:\/\/[^\x00-\x1f\x7f]*$/i.test(decoded)) return url;
    return decoded + (search.length ? '?' + search.join('?') : '') + hash;
  } catch {
    return url;
  }
};
