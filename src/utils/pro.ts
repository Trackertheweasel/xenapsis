import { decodeUrl, encodeUrl } from './codec';

// The one place the page reaches the proxy runtime. Its scripts (src/components/ProxyRuntime.astro)
// define the globals read here, $scramjetLoadController and Ultraviolet's tmpConfig, before any
// module runs; everything else asks this module instead of touching them.

// 'sc' is Scramjet, 'u' is Ultraviolet: the values of the saved `backend` setting.
export type Backend = 'sc' | 'u';

class VWrapper {
  getConfig() {
    return tmpConfig;
  }
}

class ScramjetWrapper {
  instance: ScramjetController | undefined;

  getConfig() {
    return {
      prefix: PERSEC_PATHS.scPrefix,
      files: {
        wasm: PERSEC_PATHS.files.scramjetWasm,
        all: PERSEC_PATHS.files.scramjetAll,
        sync: PERSEC_PATHS.files.scramjetSync,
      },
      flags: {
        captureErrors: false,
        cleanErrors: true,
        rewriterLogs: false,
        serviceworkers: false,
        strictRewrites: false,
        syncxhr: false,
      },
      codec: { encode: encodeUrl, decode: decodeUrl },
    };
  }

  // Created on first use, not on import, so this module loads where the runtime isn't (tests).
  controller() {
    if (!this.instance) {
      const { ScramjetController } = $scramjetLoadController();
      this.instance = new ScramjetController(this.getConfig());
    }
    return this.instance;
  }

  // Scramjet only works in iframes it has registered as frames. In a plain iframe its
  // page script crashes while walking up to Persec's own (unproxied) pages, which also
  // leaves the cookie dump it injects (window.COOKIE) readable by the site.
  tagFrame(frame: HTMLIFrameElement) {
    return this.controller().createFrame(frame);
  }

  async init() {
    await this.controller().init();
    return this.instance;
  }
}

const scramjetWrapper = new ScramjetWrapper();
const vWrapper = new VWrapper();
export { scramjetWrapper, vWrapper };

// The proxied address of a site, for the engine given. Anything but Ultraviolet means Scramjet, the
// default.
export function encodeProxyUrl(url: string, backend: unknown): string {
  if (backend === 'u') {
    const uv = vWrapper.getConfig();
    return uv.prefix + uv.encodeUrl(url);
  }
  const sc = scramjetWrapper.getConfig();
  return sc.prefix + sc.codec.encode(url);
}

// The site's real address from a proxied one, decoded by whichever engine's prefix it carries (not
// the current setting, which may have changed since the page was opened). '' when it isn't one.
// Takes the whole href: a GET form on an Ultraviolet page adds its query after the encoded path,
// which the codec puts back (as src/sw.js does).
export function decodeProxyUrl(href: string): string {
  const { pathname: path, search } = new URL(href, location.origin);
  const scPrefix = scramjetWrapper.getConfig().prefix;
  const uvPrefix = vWrapper.getConfig().prefix;
  if (path.startsWith(scPrefix)) {
    // The codec already decodes; decoding twice corrupts URLs containing escapes like %2B.
    try {
      return decodeUrl(path.slice(scPrefix.length)) || '';
    } catch {
      return '';
    }
  }
  if (path.startsWith(uvPrefix)) {
    return vWrapper.getConfig().decodeUrl(path.slice(uvPrefix.length) + search);
  }
  return '';
}
