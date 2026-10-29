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
