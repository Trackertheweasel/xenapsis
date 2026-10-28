/// <reference path="../.astro/types.d.ts" />

declare const LAST_UPDATED: string;
declare const VERSION: string;
declare const WISP_PATH: string;
declare const URL_KEY: string;
// This build's paths (serverlib/env.ts deployPaths), injected by astro.config.ts.
declare const PERSEC_PATHS: import('../serverlib/env').DeployPaths;
declare const BareMux: any;

interface Bookmark {
  name: string;
  logo: string;
  redir: string;
}

interface tmpConfig {
  prefix: string;
  encodeUrl: (str: string) => string;
  decodeUrl: (encodedUrl: string) => string;
}

declare const tmpConfig: tmpConfig;
declare const LC_NAME: string;
declare const BM_NAME: string;

interface ScramjetFiles {
  wasm: string;
  all: string;
  sync: string;
}

interface ScramjetOptions {
  prefix: string;
  files: ScramjetFiles;
}

// What Persec uses of a ScramjetFrame: contextInit fires as Scramjet starts each page in the frame
// (subframes too), before the page's own scripts, with the page's window and Scramjet's client.
interface ScramjetFrame {
  addEventListener(
    type: 'contextInit',
    listener: (event: { window: Window; client: { url: URL | string } }) => void,
  ): void;
}

declare class ScramjetController {
  constructor(options: ScramjetOptions);
  init(): any;
  createFrame(frame: HTMLIFrameElement): ScramjetFrame;
  decodeUrl(url: string): string;
  encodeUrl(url: string): string;
}

// Defined by Scramjet's page script (src/components/ProxyRuntime.astro); read only by src/utils/pro.ts.
declare function $scramjetLoadController(): { ScramjetController: typeof ScramjetController };

interface Window {
  sj: any;
  eruda: any;
}

// What the server hands each page it renders (serverlib/app.ts, and astro.config.ts in dev).
declare namespace App {
  interface Locals {
    ads?: import('../serverlib/ads').AdSlot;
  }
}

declare module '@mercuryworkshop/epoxy-transport';
declare module '@mercuryworkshop/wisp-js/server';
declare module '@mercuryworkshop/bare-mux/node';
declare module '@mercuryworkshop/libcurl-transport';
