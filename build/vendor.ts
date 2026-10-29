// Fixes to bugs in the proxy runtime's own code, applied as its files are copied into the build
// (astro.config.ts). Each one names the exact text it replaces and fails the build when that text
// isn't there exactly once, so an upgrade that changes it (or fixes it) is noticed instead of
// quietly running without the fix.

interface VendorFix {
  why: string;
  find: string;
  replace: string;
}

// The Cookie header for a WebSocket a Scramjet page opens: the jar's cookies for the socket's
// address, read as an http(s) one. Spread into the socket's headers; {} when there are none.
const WS_COOKIE = (url: string) =>
  `(()=>{try{let u=new URL(${url},e.url);u.protocol=u.protocol.replace("ws","http");` +
  'let c=e.cookieStore.getCookies(u,!1);return c?{Cookie:c}:{}}catch{return{}}})()';

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
    // The cookie parser percent-decodes values by default, so a site that set "t=ab%2Bc%3D" got
    // "t=ab+c=" back. Servers decode cookies themselves and read that "+" as a space, so tokens
    // kept this way (Canvas's CSRF cookie, most Rails and PHP sites) stopped matching.
    why: 'cookie values came back decoded',
    find: 'let e=i()(r),n={domain:e.domain',
    replace: 'let e=i()(r,{decodeValues:!1}),n={domain:e.domain',
  },
  {
    // Max-Age was never read: "Max-Age=0", how most sites delete a cookie (sign-out, a failed
    // sign-in step), left it in place, and cookies meant to last minutes lasted forever, until the
    // Cookie header grew past what servers accept. Max-Age wins over Expires, as in browsers.
    why: 'Max-Age was ignored',
    find: 'n.expires&&(n.expires=n.expires.toString());let a=`${n.domain}@${n.path}@${n.name}`;this.cookies[a]=n',
    replace:
      'n.expires&&(n.expires=n.expires.toString());let a=`${n.domain}@${n.path}@${n.name}`;' +
      'if("number"==typeof n.maxAge&&isFinite(n.maxAge)){if(n.maxAge<=0){delete this.cookies[a];continue}' +
      'n.expires=new Date(Date.now()+1e3*n.maxAge).toString()}this.cookies[a]=n',
  },
  {
    // Scramjet adds ?type= and ?dest= to the scripts and workers it loads, and took those names out
    // of every request, so a GET form with a field called "type" (a catalog's search filter) lost
    // it. Scramjet never adds them to a page being opened, so a navigation keeps every field. The
    // fields also replace the action's own query, and repeated names all stay, as in browsers.
    why: 'form fields named type or dest were dropped',
    find: 'let u="",d={};for(let[e,t]of[...o.searchParams.entries()]){switch(e){',
    replace:
      'let u="",d=[],$f="navigate"===e.mode;for(let[e,t]of[...o.searchParams.entries()]){switch($f?"":e){',
  },
  {
    why: 'form fields named type or dest were dropped',
    find: 'd[e]=t}o.searchParams.delete(e)}let h=new URL((0,s.v2)(o));for(let[e,t]of Object.entries(d))h.searchParams.set(e,t);',
    replace:
      'd.push([e,t])}o.searchParams.delete(e)}let h=new URL((0,s.v2)(o));$f&&d.length&&(h.search="");' +
      'for(let[e,t]of d)$f?h.searchParams.append(e,t):h.searchParams.set(e,t);',
  },
  // A browser sends the site's cookies when it opens a WebSocket, and sites that sign the
  // connection with their login cookie refuse one without them. Scramjet sent none. The page's
  // copy of the cookie jar has every cookie, HttpOnly ones too, so the header is built from it.
  ...[
    'let a=e.bare.createWebSocket(n.args[0],n.args[1]',
    'let l=e.bare.createWebSocket(r.args[0],r.args[1]',
  ].map(call => ({
    why: 'WebSockets opened without cookies',
    find: `${call},null,{"User-Agent":t.navigator.userAgent,Origin:e.url.origin})`,
    replace: `${call},null,{"User-Agent":t.navigator.userAgent,Origin:e.url.origin,...${WS_COOKIE(call.includes('n.args') ? 'n.args[0]' : 'r.args[0]')}})`,
  })),
];

// Ultraviolet 3.2.10, uv.bundle.js.
const UV_BUNDLE_FIXES: VendorFix[] = [
  {
    // "if (cookie.maxAge)" treats Max-Age=0, the usual way to delete a cookie, as no Max-Age at all,
    // so deleted cookies were sent on as empty values for ever.
    why: 'Max-Age=0 never deleted a cookie',
    find: 'r.set&&(r.maxAge?n=r.set.getTime()+r.maxAge*1e3<t',
    replace: 'r.set&&(Number.isFinite(r.maxAge)?n=r.set.getTime()+r.maxAge*1e3<=t',
  },
];

// Runs inside Ultraviolet's handler: `uv` is its Ultraviolet instance and `bare` the transport
// client its WebSockets open through. Returns a stand-in for `bare` whose sockets carry the site's
// cookies. A socket made before the jar has loaded is a stand-in until it has: it takes listeners
// and close() as a real one would and refuses send(), as a socket still connecting does. Plain
// JavaScript in a string, so nothing the TypeScript compiler adds ends up in Ultraviolet's file.
const UV_COOKIE_SOCKETS = `(function (uv, bare) {
  var jar = null;
  function load() {
    try {
      return uv.cookie.db()
        .then(function (db) { return uv.cookie.getCookies(db); })
        .then(function (cookies) { jar = cookies || []; }, function () { jar = jar || []; });
    } catch (e) {
      jar = jar || [];
      return Promise.resolve();
    }
  }
  var loaded = load();
  function withCookies(url, headers) {
    try {
      var http = new URL(url, uv.meta.url.href);
      http.protocol = http.protocol.replace('ws', 'http');
      var cookie = uv.cookie.serialize(jar || [], { url: http }, false);
      if (cookie) return Object.assign({}, headers, { Cookie: cookie });
    } catch (e) {}
    return headers;
  }
  return {
    createWebSocket: function (url, protocols, ws, headers) {
      if (jar) {
        var socket = bare.createWebSocket(url, protocols, ws, withCookies(url, headers));
        loaded = load();
        return socket;
      }
      var early = new EventTarget(), real = null, closed = null;
      Object.defineProperty(early, 'readyState', { get: function () { return real ? real.readyState : closed ? 3 : 0; } });
      Object.defineProperty(early, 'protocols', { get: function () { return real ? real.protocols : []; } });
      early.send = function () {
        if (!real) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
        return real.send.apply(real, arguments);
      };
      early.close = function () {
        if (real) return real.close.apply(real, arguments);
        closed = arguments;
      };
      Promise.race([loaded, new Promise(function (r) { setTimeout(r, 1000); })]).then(function () {
        if (closed) return early.dispatchEvent(new CloseEvent('close', { code: 1000 }));
        real = bare.createWebSocket(url, protocols, ws, withCookies(url, headers));
        real.addEventListener('open', function () { early.dispatchEvent(new Event('open')); });
        real.addEventListener('error', function () { early.dispatchEvent(new Event('error')); });
        real.addEventListener('close', function (ev) {
          early.dispatchEvent(new CloseEvent('close', { code: ev.code, reason: ev.reason, wasClean: ev.wasClean }));
        });
        real.addEventListener('message', function (ev) {
          early.dispatchEvent(new MessageEvent('message', { data: ev.data, origin: ev.origin, lastEventId: ev.lastEventId }));
        });
      });
      return early;
    },
  };
})`;

// Ultraviolet 3.2.10, uv.handler.js.
const UV_HANDLER_FIXES: VendorFix[] = [
  {
    // The same missing WebSocket cookies as Scramjet's. A page only holds the cookies its scripts
    // may read, so the full jar is read from Ultraviolet's database, again for every socket. Until
    // it has been read (a socket opened as the page starts) the socket waits for it, up to a second.
    why: 'WebSockets opened without cookies',
    find: 'a.websocket.overrideWebSocket(c)',
    replace: `a.websocket.overrideWebSocket(${UV_COOKIE_SOCKETS}(e,c))`,
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
export const fixUvBundle = (code: string) => applyFixes('uv.bundle.js', code, UV_BUNDLE_FIXES);
export const fixUvHandler = (code: string) => applyFixes('uv.handler.js', code, UV_HANDLER_FIXES);

// The fixes for each runtime file that has some, by its role in astro.config.ts.
export const RUNTIME_FIXES: Record<string, (code: string) => string> = {
  scramjetAll: fixScramjet,
  uvBundle: fixUvBundle,
  uvHandler: fixUvHandler,
};
