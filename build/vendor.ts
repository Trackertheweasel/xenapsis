// Fixes to bugs in the proxy runtime's own code, applied as its files are copied into the build
// (astro.config.ts). Each one names the exact text it replaces and fails the build when that text
// isn't there exactly once, so an upgrade that changes it (or fixes it) is noticed instead of
// quietly running without the fix.

interface VendorFix {
  why: string;
  find: string;
  replace: string;
}

// Scramjet 1.1.0, scramjet.all.js.
const SCRAMJET_FIXES: VendorFix[] = [
  {
    // When a site's server sets cookies, the service worker tells the page so its document.cookie
    // sees them. It looped with `in` instead of `of`, so the page was sent each cookie's position
    // ("0", "1"…) instead of the cookie: it got a junk "=0" cookie, and a cookie set by a fetch or
    // XHR (sign-in, consent, Cloudflare's check) stayed invisible to the page until a reload.
    why: 'server-set cookies never reached the page',
    find: 'let x=v["set-cookie"]||[];for(let t in x)if(h){',
    replace: 'let x=v["set-cookie"]||[];for(let t of Array.isArray(x)?x:[x])if(h){',
  },
  {
    // The cookie jar ran every cookie's value through decodeURIComponent, so a value a site sent as
    // `ab%2Bc%2F%3D%3D` came back to it as `ab+c/==`, a different value. Sign-in and anti-forgery
    // tokens stopped matching. Browsers store a cookie's value exactly as it was sent.
    why: 'cookie values were changed by decoding them',
    find: 'let e=i()(r),n={domain:e.domain,sameSite:e.sameSite,...e[0]};',
    replace: 'let e=i()(r,{decodeValues:!1}),n={domain:e.domain,sameSite:e.sameSite,...e[0]};',
  },
  {
    // The jar ignored Max-Age. A cookie a site deleted with Max-Age=0 (how sign-in pages clear a
    // stale step or session) was kept and sent back, and one meant to last a set time never ran
    // out. Max-Age wins over Expires, as in browsers, and a cookie that's already expired is
    // deleted instead of stored.
    why: 'Max-Age was ignored, so deleted cookies came back',
    find: 'n.expires&&(n.expires=n.expires.toString());let a=`${n.domain}@${n.path}@${n.name}`;this.cookies[a]=n',
    replace:
      '"number"==typeof n.maxAge&&!isNaN(n.maxAge)&&(n.expires=new Date(Date.now()+1e3*n.maxAge)),delete n.maxAge;' +
      'n.expires&&(n.expires=n.expires.toString());let a=`${n.domain}@${n.path}@${n.name}`;' +
      'n.expires&&!(new Date(n.expires)>new Date)?delete this.cookies[a]:this.cookies[a]=n',
  },
];

// Ultraviolet 3.2.10, uv.bundle.js.
const UV_FIXES: VendorFix[] = [
  {
    // A cookie's Max-Age was only honoured when it wasn't 0, so Max-Age=0, which deletes a cookie,
    // kept it instead whenever the site didn't also send an Expires date in the past.
    why: 'Max-Age=0 never deleted a cookie',
    find: 'r.set&&(r.maxAge?n=',
    replace: 'r.set&&("number"==typeof r.maxAge&&!isNaN(r.maxAge)?n=',
  },
];

function applyFixes(file: string, code: string, fixes: VendorFix[]): string {
  for (const fix of fixes) {
    const parts = code.split(fix.find);
    if (parts.length !== 2) {
      throw new Error(
        `${file}: expected the code for "${fix.why}" once, found it ${parts.length - 1} times. ` +
          'Check whether the new version still has the bug, then update or drop the fix in build/vendor.ts.',
      );
    }
    code = parts.join(fix.replace);
  }
  return code;
}

export const fixScramjet = (code: string) => applyFixes('scramjet.all.js', code, SCRAMJET_FIXES);
export const fixUltraviolet = (code: string) => applyFixes('uv.bundle.js', code, UV_FIXES);
