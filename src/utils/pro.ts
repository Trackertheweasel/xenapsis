import { decodeUrl, encodeUrl } from './codec';

// @ts-ignore
const { ScramjetController } = $scramjetLoadController();

class VWrapper {
  getConfig() {
    return tmpConfig;
  }
}

class ScramjetWrapper {
  instance: any;

  getConfig() {
    return {
      prefix: '/v1/data/',
      files: {
        wasm: '/data/wasm.wasm',
        all: '/data/all.js',
        sync: '/data/sync.js',
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

  controller() {
    this.instance ??= new ScramjetController(this.getConfig());
    return this.instance;
  }

  // Scramjet only works in iframes it has registered as frames. In a plain iframe its
  // page script crashes while walking up to Persec's own (unproxied) pages, which also
  // leaves the cookie dump it injects (window.COOKIE) readable by the site.
  tagFrame(frame: HTMLIFrameElement) {
    this.controller().createFrame(frame);
  }

  async init() {
    await this.controller().init();
    return this.instance;
  }
}

const scramjetWrapper = new ScramjetWrapper();
const vWrapper = new VWrapper();
export { scramjetWrapper, vWrapper };
