import { loadPageSettings, type PageSettings } from './config';
import { postToServiceWorker } from './serviceworker';
import {
  cloakInputs,
  initAutoCloak,
  initExitPrompt,
  initPresets,
  setCloak,
} from './settings/cloak';
import {
  initDropdowns,
  initEngines,
  initInputs,
  initProxyBackend,
  initToggles,
  markEngine,
} from './settings/controls';
import {
  initClearSiteData,
  initConnectionCheck,
  initPortableSettings,
  reset,
} from './settings/data';
import { initSavedLogins } from './settings/logins';
import { initNav, initScrollSpy, initSearch } from './settings/nav';
import { formatPanicKey, initPanicKey, setPanicKey } from './settings/panic';
import { syncSwitches } from './settings/ui';

export { SettingsAPI } from './settings/api';
export type SettingsConfig = PageSettings;

// The settings that act on every page (cloaking, the panic key, the leave-page prompt) and the
// Settings page itself. init() runs on Persec's top page (src/utils/index.ts), where it applies the
// saved settings, and on the Settings page (src/pages/st.astro), where it also wires up each section,
// from src/utils/settings/.
export class SettingsManager {
  static load(): Promise<SettingsConfig> {
    return loadPageSettings();
  }

  // Puts the saved settings into the page's controls, where it has them, and applies them.
  static async apply(cfg: SettingsConfig) {
    const cloakToggle = document.querySelector('[data-toggle="cloak"]') as HTMLElement;
    const { titleIn, iconIn } = cloakInputs();

    if (cfg.cloak === 'on') {
      cloakToggle?.classList.add('active');
      if (titleIn) titleIn.disabled = false;
      if (iconIn) iconIn.disabled = false;
    } else {
      if (titleIn) titleIn.disabled = true;
      if (iconIn) iconIn.disabled = true;
    }

    const tabSwitchToggle = document.querySelector('[data-toggle="tabSwitchCloak"]') as HTMLElement;
    if (cfg.tabSwitchCloak === 'on') tabSwitchToggle?.classList.add('active');

    const autoCloakToggle = document.querySelector('[data-toggle="autoCloak"]') as HTMLElement;
    if (cfg.autoCloak === 'on') {
      autoCloakToggle?.classList.add('active');
      if (document.referrer === '') {
        const title = cfg.cloakTitle || 'Google';
        const favicon = cfg.cloakFavicon || 'https://www.google.com/favicon.ico';
        setCloak(true, title, favicon);
      }
    }

    const adBlockToggle = document.querySelector('[data-toggle="adBlock"]') as HTMLElement;
    if (adBlockToggle) {
      if (cfg.adBlock === 'on') {
        adBlockToggle.classList.add('active');
      } else {
        adBlockToggle.classList.remove('active');
      }
    }

    const webrtcToggle = document.querySelector('[data-toggle="blockWebRTC"]') as HTMLElement;
    webrtcToggle?.classList.toggle('active', cfg.blockWebRTC !== 'off');

    const exitToggle = document.querySelector('[data-toggle="beforeUnload"]') as HTMLElement;
    if (cfg.beforeUnload === 'on') exitToggle?.classList.add('active');

    const backendDD = document.querySelector('[data-dropdown="backend"]');
    if (cfg.backend) {
      const opt = backendDD?.querySelector(`[data-value="${cfg.backend}"]`);
      const display = backendDD?.querySelector('[data-dropdown-value]');
      if (display && opt) {
        display.textContent = opt.textContent?.trim() || '';
        opt.classList.add('selected');
      }
    }

    if (titleIn && cfg.cloakTitle) titleIn.value = cfg.cloakTitle;
    if (iconIn && cfg.cloakFavicon) iconIn.value = cfg.cloakFavicon;

    const engineIn = document.querySelector('[data-input="engine"]') as HTMLInputElement;
    if (engineIn && cfg.engine) engineIn.value = cfg.engine;

    const wispIn = document.querySelector('[data-input="wispUrl"]') as HTMLInputElement;

    if (wispIn && cfg.wispUrl) {
      wispIn.value = cfg.wispUrl;
      wispIn.placeholder = cfg.wispUrl;
    }

    const panicUrlIn = document.querySelector('[data-input="panicLoc"]') as HTMLInputElement;
    if (panicUrlIn && cfg.panicLoc) panicUrlIn.value = cfg.panicLoc;

    const panicKeyIn = document.querySelector('[data-input="panicKey"]') as HTMLInputElement;
    if (panicKeyIn && cfg.panicKey) {
      panicKeyIn.value = formatPanicKey(cfg.panicKey);
      setPanicKey(cfg.panicKey);
    }

    if (cfg.engine) markEngine(cfg.engine);

    if (cfg.cloak === 'on') {
      setCloak(true, cfg.cloakTitle, cfg.cloakFavicon);
    } else {
      setCloak(false);
    }

    // Tab Switch Cloak is applied only by toggling it, so without this it was off after a reload
    // while its switch still showed on.
    initAutoCloak(cfg.tabSwitchCloak === 'on' || cfg.autoCloak === 'on');
    initExitPrompt(cfg.beforeUnload === 'on');
    syncSwitches();
  }

  static async init() {
    const cfg = await this.load();
    await this.apply(cfg);

    if (cfg.adBlock === 'on') postToServiceWorker({ type: 'ADBLOCK', data: { enabled: true } });
    if (cfg.blockWebRTC !== 'off') postToServiceWorker({ type: 'WEBRTC', data: { enabled: true } });

    initNav();
    initScrollSpy();
    initSearch();
    initToggles();
    initInputs();
    initDropdowns();
    initEngines();
    initPresets();
    initProxyBackend();
    initPanicKey();
    initClearSiteData();
    initConnectionCheck();
    initPortableSettings();
    initSavedLogins();

    const resetBtn = document.querySelector<HTMLButtonElement>('[data-reset="reset"]');
    resetBtn?.addEventListener('click', () => reset(resetBtn));
  }
}
