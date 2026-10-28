import { Window } from 'happy-dom';
import { decodeUrl, encodeUrl } from '../src/utils/codec.ts';
import { deployPaths } from '../serverlib/env.ts';

// A browser page for the client modules, in Node: a happy-dom window whose globals stand in for the
// browser's, plus the build-time constants (astro.config.ts) and the proxy runtime's page globals
// (src/components/ProxyRuntime.astro) they read. Set it up before importing the module under test.
export function installDom(html = '') {
  const window = new Window({
    url: 'https://persec.test/welcome',
    settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true },
  });
  window.document.body.innerHTML = html;
  const g = globalThis as any;
  for (const name of [
    'window',
    'document',
    'location',
    'history',
    'HTMLElement',
    'HTMLIFrameElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLDivElement',
    'Node',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'CustomEvent',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
    'getComputedStyle',
    'top',
    'parent',
  ]) {
    Object.defineProperty(g, name, {
      configurable: true,
      writable: true,
      value: name === 'top' || name === 'parent' ? window : (window as any)[name],
    });
  }

  const paths = deployPaths('test-key');
  g.PERSEC_PATHS = paths;
  g.URL_KEY = 'test-key';
  g.tmpConfig = { prefix: paths.uvPrefix, encodeUrl, decodeUrl };
  // Scramjet's controller, which registers each tab's frame; here it only counts them.
  const frames: unknown[] = [];
  g.$scramjetLoadController = () => ({
    ScramjetController: class {
      createFrame(frame: unknown) {
        frames.push(frame);
      }
      async init() {}
    },
  });

  return {
    window,
    paths,
    frames,
    // A frame for requestAnimationFrame callbacks to run.
    tick: () => new Promise(resolve => setTimeout(resolve, 50)),
    close: () => window.happyDOM.close(),
  };
}

export function key(type: string, init: Record<string, unknown>) {
  return new (globalThis as any).KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
}
