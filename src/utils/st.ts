import ConfigAPI from './config';
import {
  backUpNow,
  deleteBackup,
  getConsent,
  getStatus,
  hasKey,
  keepKeyFromCode,
  restore,
  setConsent,
} from './loginsync';
import { exportSettings, mergeBookmarks, parseSettings } from './portable';
import { clearSiteData } from './sitedata';

export const SettingsAPI = {
  async enable(key: string) {
    await ConfigAPI.set(key, 'on');
  },
  async disable(key: string) {
    await ConfigAPI.set(key, 'off');
  },
  async toggle(key: string) {
    const value = await ConfigAPI.get(key);
    const newValue = value === 'on' ? 'off' : 'on';
    await ConfigAPI.set(key, newValue);
    return newValue;
  },
  async isEnabled(key: string) {
    const value = await ConfigAPI.get(key);
    return value === 'on' || value === true || value === 1;
  },
  async loadAll() {
    const keys = [
      'cloak',
      'cloakTitle',
      'cloakFavicon',
      'tabSwitchCloak',
      'autoCloak',
      'beforeUnload',
      'backend',
      'adBlock',
      'engine',
      'wispUrl',
      'panicLoc',
      'panicKey',
    ];
    const settings: Record<string, any> = {};
    for (const key of keys) {
      settings[key] = await ConfigAPI.get(key);
    }
    return settings;
  },
};

export interface SettingsConfig {
  cloak?: string;
  cloakTitle?: string;
  cloakFavicon?: string;
  tabSwitchCloak?: string;
  autoCloak?: string;
  beforeUnload?: string;
  backend?: string;
  adBlock?: string;
  engine?: string;
  wispUrl?: string;
  panicLoc?: string;
  panicKey?: string;
}

export class SettingsManager {
  static initProxyBackend() {
    const proxyButtons = document.querySelectorAll('[data-proxy]');
    function updateProxyUI(val: string) {
      proxyButtons.forEach(btn => {
        const type = btn.getAttribute('data-proxy');
        const isActive =
          (type === 'ultraviolet' && val === 'u') || (type === 'scramjet' && val === 'sc');
        if (isActive) {
          btn.classList.add('border-[#6366f1]', 'bg-[#6366f1]/10');
        } else {
          btn.classList.remove('border-[#6366f1]', 'bg-[#6366f1]/10');
        }
      });
    }
    proxyButtons.forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.getAttribute('data-proxy');
        const val = type === 'ultraviolet' ? 'u' : 'sc';
        await ConfigAPI.set('backend', val);
        updateProxyUI(val);
        SettingsManager.notify();
      });
    });
    ConfigAPI.get('backend').then(val => {
      updateProxyUI(val === 'u' ? 'u' : 'sc');
    });
  }
  private static panicKeyHandler: (e: KeyboardEvent) => void = () => {};
  static async load() {
    return {
      cloak: (await ConfigAPI.get('cloak')) as string,
      cloakTitle: (await ConfigAPI.get('cloakTitle')) as string,
      cloakFavicon: (await ConfigAPI.get('cloakFavicon')) as string,
      tabSwitchCloak: (await ConfigAPI.get('tabSwitchCloak')) as string,
      autoCloak: (await ConfigAPI.get('autoCloak')) as string,
      beforeUnload: (await ConfigAPI.get('beforeUnload')) as string,
      backend: (await ConfigAPI.get('backend')) as string,
      adBlock: (await ConfigAPI.get('adBlock')) as string,
      engine: (await ConfigAPI.get('engine')) as string,
      wispUrl: (await ConfigAPI.get('wispUrl')) as string,
      panicLoc: (await ConfigAPI.get('panicLoc')) as string,
      panicKey: (await ConfigAPI.get('panicKey')) as string,
    };
  }

  private static notifyTimer: ReturnType<typeof setTimeout> | undefined;
  static notify(text = 'Settings saved', error = false) {
    const notif = document.querySelector<HTMLElement>('[data-notification]');
    const box = notif?.querySelector('[data-notification-box]');
    const span = notif?.querySelector('[data-notification-text]');
    if (!notif || !box || !span) return;
    span.textContent = text;
    box.classList.toggle('border-[#10b981]/40', !error);
    box.classList.toggle('border-red-500/50', error);
    notif.classList.remove('opacity-0');
    clearTimeout(this.notifyTimer);
    // Errors stay up longer, as they usually say what to do next.
    this.notifyTimer = setTimeout(() => notif.classList.add('opacity-0'), error ? 6000 : 2500);
  }

  // An in-page confirmation (the <dialog data-confirm> in st.astro), so every destructive action
  // asks the same way and can list everything it will do.
  static confirm(title: string, lines: string[], ok: string): Promise<boolean> {
    const dialog = document.querySelector<HTMLDialogElement>('[data-confirm]');
    if (!dialog?.showModal) {
      return Promise.resolve(window.confirm(`${title}\n\n${lines.join('\n')}`));
    }
    dialog.querySelector('#confirm-title')!.textContent = title;
    dialog.querySelector('[data-confirm-text]')!.replaceChildren(
      ...lines.map(line => {
        const p = document.createElement('p');
        p.textContent = line;
        return p;
      }),
    );
    dialog.querySelector('[data-confirm-ok]')!.textContent = ok;
    dialog.returnValue = '';
    dialog.showModal();
    // Cancel has focus first, so a stray Enter doesn't delete anything.
    dialog.querySelector<HTMLButtonElement>('button[value="cancel"]')?.focus();
    return new Promise(resolve =>
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }),
    );
  }

  // Runs an action once at a time: the button stays disabled until it finishes or fails.
  static async busy(btn: HTMLButtonElement | null, run: () => Promise<void>) {
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      await run();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  static async reset(btn: HTMLButtonElement | null) {
    const ok = await this.confirm(
      'Clear all Persec data?',
      [
        'Every Persec setting goes back to its default, and your bookmarks and start page shortcuts are deleted from this browser.',
        'Site cookies and saved logins are not touched; use Clear site data for those.',
        'This can’t be undone. Export your settings first if you might want them back.',
      ],
      'Clear all data',
    );
    if (!ok) return;
    await this.busy(btn, async () => {
      try {
        await ConfigAPI.reset();
        this.notify('All Persec data cleared. Reloading…');
        setTimeout(() => parent.location.reload(), 800);
      } catch (err) {
        this.notify(`Couldn’t clear Persec’s data: ${(err as Error).message}`, true);
      }
    });
  }

  // Switch semantics for the .toggle buttons, which the code here turns on and off by class.
  static syncSwitches() {
    document.querySelectorAll('.toggle').forEach(t => {
      t.setAttribute('aria-checked', String(t.classList.contains('active')));
    });
  }

  static initConnectionCheck() {
    const btn = document.querySelector<HTMLButtonElement>('[data-check-connection]');
    const out = document.querySelector<HTMLElement>('[data-check-result]');
    btn?.addEventListener('click', () =>
      this.busy(btn, async () => {
        if (!out) return;
        out.textContent = 'Checking… this can take up to 30 seconds.';
        try {
          // Loaded on demand so Settings doesn't carry the proxy's connection code until it's used.
          const { renderResults, runDiagnostics } = await import('./diagnostics');
          renderResults(out, await runDiagnostics());
        } catch (err) {
          out.textContent = `The checks couldn’t run (${(err as Error).message}). Reload the page and try again.`;
        }
      }),
    );
  }

  static initPortableSettings() {
    document.querySelector('[data-export-settings]')?.addEventListener('click', async () => {
      const file = exportSettings(await ConfigAPI.getAll());
      const a = document.createElement('a');
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
      );
      a.download = 'persec-settings.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      this.notify(
        'Settings exported to persec-settings.json. It isn’t encrypted: keep it private.',
      );
    });
    const input = document.querySelector<HTMLInputElement>('[data-import-settings]');
    input?.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      let settings: Record<string, any>;
      try {
        settings = parseSettings(await file.text());
      } catch (err) {
        this.notify((err as Error).message, true);
        return;
      }
      try {
        if (settings.bm) {
          settings.bm = mergeBookmarks((await ConfigAPI.get('bm')) || [], settings.bm);
        }
        for (const [key, value] of Object.entries(settings)) await ConfigAPI.set(key, value);
      } catch (err) {
        this.notify(`Only part of the file could be saved: ${(err as Error).message}`, true);
        return;
      }
      this.notify('Settings imported. Reloading…');
      setTimeout(() => parent.location.reload(), 800);
    });
  }

  static initClearSiteData() {
    const btn = document.querySelector<HTMLButtonElement>('[data-clear-site-data]');
    btn?.addEventListener('click', async () => {
      if (btn.disabled) return;
      const ok = await this.confirm(
        'Clear cookies and site data?',
        [
          'Everything sites have saved in Persec in this browser is deleted: cookies, storage and caches.',
          'You’ll be logged out of every site you use in Persec.',
          'Your saved-logins backup on this server is deleted too, if you have one.',
          'Your Persec settings and bookmarks are kept. Persec reloads when it’s done.',
        ],
        'Clear site data',
      );
      if (!ok) return;
      await this.busy(btn, async () => {
        try {
          await clearSiteData();
          this.notify('Site data cleared. Reloading…');
          setTimeout(() => parent.location.reload(), 800);
        } catch (err) {
          this.notify(
            `Some site data couldn’t be cleared (${(err as Error).message}). Try again, or clear this site’s data in your browser’s settings.`,
            true,
          );
        }
      });
    });
  }

  // Only shown on an invite-only Persec, where there's somewhere to keep the backup.
  static async initSavedLogins() {
    const card = document.querySelector<HTMLElement>('[data-logins]');
    const status = await getStatus();
    if (!card || !status) return;
    const toggle = card.querySelector<HTMLButtonElement>('[data-logins-toggle]')!;
    const label = card.querySelector<HTMLElement>('[data-logins-status]')!;
    const codeForm = card.querySelector<HTMLFormElement>('[data-logins-code]')!;
    const codeInput = codeForm.querySelector('input')!;
    const restoreBtn = card.querySelector<HTMLButtonElement>('[data-logins-restore]')!;
    card.hidden = false;

    const show = async (message?: string) => {
      const [on, current] = await Promise.all([getConsent().then(c => c === 'saved'), getStatus()]);
      toggle.setAttribute('aria-checked', String(on));
      restoreBtn.hidden = !current?.saved;
      label.textContent =
        message ??
        (on && current?.updated
          ? `On. Last backed up ${new Date(current.updated).toLocaleString()}.`
          : on
            ? 'On.'
            : current?.saved
              ? 'Off in this browser. You have a backup from another device.'
              : 'Off.');
    };

    const turnOn = async () => {
      // Backing up from here replaces the other device's backup, so only on purpose.
      if ((await getStatus())?.saved) {
        const ok = await this.confirm(
          'Replace the backup from another device?',
          [
            'This browser’s logins replace it, and the ones only in that backup are lost.',
            'To keep them, choose Restore instead.',
          ],
          'Replace backup',
        );
        if (!ok) {
          codeForm.hidden = true;
          return show();
        }
      }
      await setConsent('saved');
      await backUpNow();
      codeForm.hidden = true;
      await show();
    };

    toggle.addEventListener('click', async () => {
      if (toggle.getAttribute('aria-checked') === 'true') {
        const ok = await this.confirm(
          'Turn off saved logins?',
          [
            'Your encrypted backup on this server is deleted right away.',
            'You stay logged in to sites in this browser until you clear site data.',
          ],
          'Turn off and delete backup',
        );
        if (!ok) return;
        return this.busy(toggle, async () => {
          try {
            await setConsent('essential');
            await deleteBackup();
            await show('Off. Your backup was deleted.');
          } catch (err) {
            await show(`Couldn’t delete the backup: ${(err as Error).message}. Try again.`);
          }
        });
      }
      if (await hasKey()) return this.busy(toggle, turnOn);
      codeForm.hidden = false;
      codeInput.focus();
    });

    codeForm.addEventListener('submit', async e => {
      e.preventDefault();
      label.textContent = 'Checking your code…';
      const error = await keepKeyFromCode(codeInput.value);
      codeInput.value = '';
      if (error) return show(error);
      await turnOn();
    });

    restoreBtn.addEventListener('click', async () => {
      if (!(await hasKey())) {
        codeForm.hidden = false;
        codeInput.focus();
        return show('Enter your invite code first.');
      }
      const ok = await this.confirm(
        'Restore saved logins here?',
        [
          'Your sites’ logins from the backup are copied into this browser, so anyone using it can use those accounts.',
          'Only do this on a device you trust.',
        ],
        'Restore logins',
      );
      if (!ok) return;
      let result: Awaited<ReturnType<typeof restore>>;
      restoreBtn.disabled = true;
      label.textContent = 'Restoring…';
      try {
        result = await restore();
      } catch (err) {
        return show(`Couldn’t restore: ${(err as Error).message}. Try again.`);
      } finally {
        restoreBtn.disabled = false;
      }
      if (result === 'locked') {
        return show(
          'Your backup was saved with a different invite code, so it can’t be unlocked here.',
        );
      }
      await setConsent('saved');
      await show(result === 'restored' ? 'Restored. Sites you open now will use them.' : undefined);
    });

    await show();
  }

  // Marks a category current in both the side list and the phone bar.
  static setActive(id: string) {
    document.querySelectorAll('[data-nav]').forEach(n => {
      const on = n.getAttribute('data-nav') === id;
      n.classList.toggle('bg-[#6366f1]/10', on);
      n.classList.toggle('text-[#6366f1]', on);
      n.classList.toggle('text-text-secondary', !on);
      if (on) n.setAttribute('aria-current', 'true');
      else n.removeAttribute('aria-current');
    });
  }

  static scrollTo(section: Element) {
    // Below the sticky search bar, which covers the top of the page on phones.
    const bar = document.querySelector('[data-filter-input]')?.closest('.sticky');
    const offset = (bar && getComputedStyle(bar).position === 'sticky' ? bar.clientHeight : 0) + 20;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({
      top: section.getBoundingClientRect().top + window.scrollY - offset,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  static initNav() {
    document.querySelectorAll('[data-nav]').forEach(item => {
      item.addEventListener('click', (e: Event) => {
        e.preventDefault();
        const target = item.getAttribute('data-nav')!;
        // A category is a way out of a search, so show everything again first.
        SettingsManager.filter('');
        const section = document.querySelector(`[data-section="${target}"]`);
        if (!section) return;
        SettingsManager.setActive(target);
        SettingsManager.scrollTo(section);
        try {
          history.replaceState(null, '', `#${target}`);
        } catch {}
      });
    });

    const initialHash = (window.location.hash || '').replace('#', '');
    const section = initialHash && document.querySelector(`[data-section="${initialHash}"]`);
    if (section) {
      SettingsManager.setActive(initialHash);
      SettingsManager.scrollTo(section);
    } else {
      SettingsManager.setActive('privacy');
    }
  }

  // The setting cards in a section: the children of its list, or the one card (About).
  private static cards(section: Element): HTMLElement[] {
    const body = section.children[1] as HTMLElement | undefined;
    if (!body) return [];
    return body.classList.contains('space-y-3')
      ? (Array.from(body.children) as HTMLElement[])
      : [body];
  }

  // Shows the cards whose name or description contains every word of the query.
  static filter(query: string) {
    const input = document.querySelector<HTMLInputElement>('[data-filter-input]');
    const clear = document.querySelector<HTMLElement>('[data-filter-clear]');
    const empty = document.querySelector<HTMLElement>('[data-filter-empty]');
    if (input && input.value !== query) input.value = query;
    if (clear) clear.hidden = !query;
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    let first: string | null = null;

    document.querySelectorAll<HTMLElement>('[data-section]').forEach(section => {
      let found = false;
      for (const card of SettingsManager.cards(section)) {
        const text = (card.textContent || '').toLowerCase().replace(/\s+/g, ' ');
        const match = words.every(w => text.includes(w));
        // Inline style only, so a card hidden for another reason (hidden attribute) stays hidden.
        card.style.display = match ? '' : 'none';
        if (match && !card.hidden) found = true;
      }
      section.style.display = found ? '' : 'none';
      if (found) {
        shown++;
        first ??= section.getAttribute('data-section');
      }
    });

    if (empty) {
      empty.textContent =
        words.length && !shown
          ? `No settings match “${query.trim()}”. Try another word, or clear the search.`
          : '';
    }
    if (first) SettingsManager.setActive(first);
  }

  static initSearch() {
    const search = document.querySelector<HTMLInputElement>('[data-filter-input]');
    if (!search) return;
    search.addEventListener('input', () => SettingsManager.filter(search.value));
    search.addEventListener('keydown', e => {
      if (e.key === 'Escape' && search.value) {
        e.preventDefault();
        SettingsManager.filter('');
      }
    });
    document.querySelector('[data-filter-clear]')?.addEventListener('click', () => {
      SettingsManager.filter('');
      search.focus();
    });
  }

  static initScrollSpy() {
    let ticking = false;

    const update = () => {
      ticking = false;
      // Sections hidden by a search have no position; leave the highlight to the search.
      const visible = Array.from(document.querySelectorAll<HTMLElement>('[data-section]')).filter(
        s => s.style.display !== 'none',
      );
      if (!visible.length) return;
      let current = visible[0];
      for (const section of visible) {
        if (section.getBoundingClientRect().top <= 160) current = section;
      }
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 2) {
        current = visible[visible.length - 1];
      }
      SettingsManager.setActive(current.getAttribute('data-section') || 'privacy');
    };

    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    });
  }

  static setCloak(on: boolean, title?: string, icon?: string) {
    const win = window.top || window;
    const doc = win.document;

    if (on) {
      doc.title = title || 'Google';

      let link = doc.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (!link) {
        link = doc.createElement('link');
        link.rel = 'icon';
        doc.head.appendChild(link);
      }
      link.href = icon || 'https://www.google.com/favicon.ico';
    } else {
      doc.title = 'Persec';

      let link = doc.querySelector("link[rel~='icon']") as HTMLLinkElement;
      if (link) link.href = '/favicon.ico';
    }
  }

  static initToggles() {
    document.querySelectorAll('.toggle').forEach(toggle => {
      toggle.addEventListener('click', async () => {
        toggle.classList.toggle('active');
        const key = toggle.getAttribute('data-toggle');
        const on = toggle.classList.contains('active');

        if (key) {
          if (on) {
            await SettingsAPI.enable(key);
          } else {
            await SettingsAPI.disable(key);
          }

          if (key === 'adBlock') {
            if (
              navigator.serviceWorker &&
              (navigator.serviceWorker.controller || navigator.serviceWorker.ready)
            ) {
              const msg = { type: 'ADBLOCK', data: { enabled: on } };
              if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage(msg);
              } else if (navigator.serviceWorker.ready) {
                navigator.serviceWorker.ready.then(reg => {
                  reg.active?.postMessage(msg);
                });
              }
            }
          }

          switch (key) {
            case 'cloak': {
              const titleIn = document.querySelector(
                '[data-input="cloakTitle"]',
              ) as HTMLInputElement;
              const iconIn = document.querySelector(
                '[data-input="cloakFavicon"]',
              ) as HTMLInputElement;
              if (titleIn) titleIn.disabled = !on;
              if (iconIn) iconIn.disabled = !on;
              this.setCloak(on, titleIn?.value, iconIn?.value);
              if (on) {
                const tabSwitchToggle = document.querySelector('[data-toggle="tabSwitchCloak"]');
                if (tabSwitchToggle?.classList.contains('active')) {
                  tabSwitchToggle.classList.remove('active');
                  await SettingsAPI.disable('tabSwitchCloak');
                  this.initAutoCloak(false);
                }
              }
              break;
            }
            case 'tabSwitchCloak': {
              if (on) {
                const cloakToggle = document.querySelector('[data-toggle="cloak"]');
                if (cloakToggle?.classList.contains('active')) {
                  cloakToggle.classList.remove('active');
                  await SettingsAPI.disable('cloak');
                  const titleIn = document.querySelector(
                    '[data-input="cloakTitle"]',
                  ) as HTMLInputElement;
                  const iconIn = document.querySelector(
                    '[data-input="cloakFavicon"]',
                  ) as HTMLInputElement;
                  if (titleIn) titleIn.disabled = true;
                  if (iconIn) iconIn.disabled = true;
                  this.setCloak(false);
                }
              }
              this.initAutoCloak(on);
              break;
            }
            case 'beforeUnload': {
              this.initExitPrompt(on);
              break;
            }
            case 'autoCloak': {
              this.initAutoCloak(on);
              break;
            }
            default:
              break;
          }
          this.syncSwitches();
          this.notify();
        }
      });
    });
  }

  static initInputs() {
    document.querySelectorAll('[data-input]').forEach(input => {
      input.addEventListener('blur', async e => {
        const el = e.target as HTMLInputElement;
        const key = el.getAttribute('data-input');

        if (key && el.value) {
          await ConfigAPI.set(key, el.value);
          this.notify();

          if (key === 'wispUrl') {
            el.placeholder = el.value;
          }

          if (key === 'cloakTitle' || key === 'cloakFavicon') {
            const toggle = document.querySelector('[data-toggle="cloak"]');
            const on = toggle?.classList.contains('active');
            if (on) {
              const titleIn = document.querySelector(
                '[data-input="cloakTitle"]',
              ) as HTMLInputElement;
              const iconIn = document.querySelector(
                '[data-input="cloakFavicon"]',
              ) as HTMLInputElement;
              this.setCloak(true, titleIn?.value, iconIn?.value);
            }
          }
        }
      });

      input.addEventListener('keydown', async e => {
        if ((e as KeyboardEvent).key === 'Enter') {
          const el = e.target as HTMLInputElement;
          const key = el.getAttribute('data-input');

          if (key && el.value) {
            await ConfigAPI.set(key, el.value);
            this.notify();
            el.blur();

            if (key === 'wispUrl') {
              el.placeholder = el.value;
            }

            if (key === 'cloakTitle' || key === 'cloakFavicon') {
              const toggle = document.querySelector('[data-toggle="cloak"]');
              const on = toggle?.classList.contains('active');
              if (on) {
                const titleIn = document.querySelector(
                  '[data-input="cloakTitle"]',
                ) as HTMLInputElement;
                const iconIn = document.querySelector(
                  '[data-input="cloakFavicon"]',
                ) as HTMLInputElement;
                this.setCloak(true, titleIn?.value, iconIn?.value);
              }
            }
          }
        }
      });
    });
  }

  static initDropdowns() {
    const dropdowns = document.querySelectorAll('[data-dropdown]');

    dropdowns.forEach(dd => {
      const btn = dd.querySelector('.dropdown-selected');
      const opts = dd.querySelectorAll('.dropdown-option');

      btn?.addEventListener('click', e => {
        e.stopPropagation();
        dd.classList.toggle('open');
        dropdowns.forEach(d => {
          if (d !== dd) d.classList.remove('open');
        });
      });

      opts.forEach(opt => {
        opt.addEventListener('click', async () => {
          const val = opt.getAttribute('data-value');
          const txt = opt.textContent?.trim();
          const key = dd.getAttribute('data-dropdown');

          const display = dd.querySelector('[data-dropdown-value]');
          if (display) display.textContent = txt || '';

          opts.forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');

          if (key && val) {
            await ConfigAPI.set(key, val);
            this.notify();
          }

          dd.classList.remove('open');
        });
      });
    });

    document.addEventListener('click', () => {
      dropdowns.forEach(d => d.classList.remove('open'));
    });
  }

  static initEngines() {
    document.querySelectorAll('[data-engine]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-engine');
        if (url) {
          await ConfigAPI.set('engine', url);
          const input = document.querySelector('[data-input="engine"]') as HTMLInputElement;
          if (input) input.value = url;

          document.querySelectorAll('[data-engine]').forEach(b => {
            b.classList.remove('bg-[#6366f1]/15', 'border-[#6366f1]/50');
            const check = b.querySelector('.engine-check');
            if (check) check.classList.add('hidden');
            const icon = b.querySelector('.engine-icon');
            const txt = b.querySelector('.engine-text');
            if (icon) icon.classList.remove('text-[#6366f1]');
            if (txt) txt.classList.remove('text-[#6366f1]', 'font-semibold');
          });

          btn.classList.add('bg-[#6366f1]/15', 'border-[#6366f1]/50');
          const check = btn.querySelector('.engine-check');
          if (check) check.classList.remove('hidden');
          const icon = btn.querySelector('.engine-icon');
          const txt = btn.querySelector('.engine-text');
          if (icon) icon.classList.add('text-[#6366f1]');
          if (txt) txt.classList.add('text-[#6366f1]', 'font-semibold');

          this.notify();
        }
      });
    });
  }

  static initPresets() {
    document.querySelectorAll('[data-cloak-preset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.getAttribute('data-preset-title');
        const icon = btn.getAttribute('data-preset-favicon');

        if (title && icon) {
          const titleIn = document.querySelector('[data-input="cloakTitle"]') as HTMLInputElement;
          const iconIn = document.querySelector('[data-input="cloakFavicon"]') as HTMLInputElement;

          if (titleIn) titleIn.value = title;
          if (iconIn) iconIn.value = icon;

          await ConfigAPI.set('cloakTitle', title);
          await ConfigAPI.set('cloakFavicon', icon);

          const toggle = document.querySelector('[data-toggle="cloak"]');
          if (toggle?.classList.contains('active')) {
            this.setCloak(true, title, icon);
          }

          this.notify();
        }
      });
    });
  }

  static initAutoCloak(on: boolean) {
    const doc = (window.top || window).document;
    doc.removeEventListener('visibilitychange', this.handleAutoCloak);

    if (on) {
      doc.addEventListener('visibilitychange', this.handleAutoCloak);
    }
  }

  static handleAutoCloak = async () => {
    const manual = (await ConfigAPI.get('cloak')) as string;
    if (manual === 'on') return;

    const title = (await ConfigAPI.get('cloakTitle')) as string;
    const icon = (await ConfigAPI.get('cloakFavicon')) as string;
    const doc = (window.top || window).document;

    if (doc.hidden) {
      SettingsManager.setCloak(true, title, icon);
    } else {
      SettingsManager.setCloak(false);
    }
  };

  static initPanicKey() {
    const input = document.querySelector('[data-input="panicKey"]') as HTMLInputElement;
    if (!input) return;

    let recording = false;

    input.addEventListener('focus', () => {
      recording = true;
      input.value = 'Press keys...';
      input.classList.add('border-[#6366f1]/50', 'ring-2', 'ring-[#6366f1]/20');
    });

    input.addEventListener('keydown', async e => {
      if (!recording) return;

      e.preventDefault();
      e.stopPropagation();

      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        if (e.metaKey) mods.push('Meta');
        input.value = mods.join('+') + '+';
        return;
      }

      const parts = [];
      if (e.ctrlKey) parts.push('ctrl');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      if (e.metaKey) parts.push('meta');
      parts.push(e.key.toLowerCase());

      const combo = parts.join('+');

      const display = [];
      if (e.ctrlKey) display.push('Ctrl');
      if (e.altKey) display.push('Alt');
      if (e.shiftKey) display.push('Shift');
      if (e.metaKey) display.push('Meta');
      display.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);

      input.value = display.join('+');
      await ConfigAPI.set('panicKey', combo);

      const win = window.top || window;
      win.dispatchEvent(new CustomEvent('panicKeyChanged', { detail: combo }));

      this.notify();
      this.setPanicKey(combo);

      parent.location.reload();
    });

    input.addEventListener('blur', () => {
      recording = false;
      input.classList.remove('border-[#6366f1]/50', 'ring-2', 'ring-[#6366f1]/20');
      if (input.value === 'Press keys...') {
        ConfigAPI.get('panicKey').then(saved => {
          const key = saved as string;
          if (key) {
            const parts = key.split('+');
            const display = parts.map(p => {
              if (p === 'ctrl') return 'Ctrl';
              if (p === 'alt') return 'Alt';
              if (p === 'shift') return 'Shift';
              if (p === 'meta') return 'Meta';
              return p.length === 1 ? p.toUpperCase() : p;
            });
            input.value = display.join('+');
          } else {
            input.value = '';
          }
        });
      }
    });
  }

  static setPanicKey(combo: string) {
    const doc = (window.top || window).document;
    doc.removeEventListener('keydown', this.panicKeyHandler);

    this.panicKeyHandler = async (e: KeyboardEvent) => {
      const parts = [];
      if (e.ctrlKey) parts.push('ctrl');
      if (e.altKey) parts.push('alt');
      if (e.shiftKey) parts.push('shift');
      if (e.metaKey) parts.push('meta');

      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        parts.push(e.key.toLowerCase());
      }

      const pressed = parts.join('+');

      if (pressed === combo) {
        e.preventDefault();
        const url = (await ConfigAPI.get('panicLoc')) as string;
        if (url) {
          (window.top || window).location.href = url;
        }
      }
    };

    doc.addEventListener('keydown', this.panicKeyHandler);
  }

  static handleExit = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    (e as any).returnValue = '';
    return '';
  };

  static initExitPrompt(on: boolean) {
    const win = window.top || window;
    win.removeEventListener('beforeunload', this.handleExit);

    if (on) {
      win.addEventListener('beforeunload', this.handleExit);
    }
  }

  static async apply(cfg: SettingsConfig) {
    const cloakToggle = document.querySelector('[data-toggle="cloak"]') as HTMLElement;
    const titleIn = document.querySelector('[data-input="cloakTitle"]') as HTMLInputElement;
    const iconIn = document.querySelector('[data-input="cloakFavicon"]') as HTMLInputElement;

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
        this.setCloak(true, title, favicon);
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
      const parts = cfg.panicKey.split('+');
      const display = parts.map((p: string) => {
        if (p === 'ctrl') return 'Ctrl';
        if (p === 'alt') return 'Alt';
        if (p === 'shift') return 'Shift';
        if (p === 'meta') return 'Meta';
        return p.length === 1 ? p.toUpperCase() : p;
      });
      panicKeyIn.value = display.join('+');
      this.setPanicKey(cfg.panicKey);
    }

    if (cfg.engine) {
      document.querySelectorAll('[data-engine]').forEach(btn => {
        const url = btn.getAttribute('data-engine');
        if (url === cfg.engine) {
          btn.classList.add('bg-[#6366f1]/15', 'border-[#6366f1]/50');
          const check = btn.querySelector('.engine-check');
          if (check) check.classList.remove('hidden');
          const icon = btn.querySelector('.engine-icon');
          const txt = btn.querySelector('.engine-text');
          if (icon) icon.classList.add('text-[#6366f1]');
          if (txt) txt.classList.add('text-[#6366f1]', 'font-semibold');
        }
      });
    }

    if (cfg.cloak === 'on') {
      this.setCloak(true, cfg.cloakTitle, cfg.cloakFavicon);
    } else {
      this.setCloak(false);
    }

    this.initAutoCloak(cfg.autoCloak === 'on');
    this.initExitPrompt(cfg.beforeUnload === 'on');
    this.syncSwitches();
  }

  static async init() {
    const cfg = await this.load();
    await this.apply(cfg);

    if (cfg.adBlock === 'on') {
      if (
        navigator.serviceWorker &&
        (navigator.serviceWorker.controller || navigator.serviceWorker.ready)
      ) {
        const msg = { type: 'ADBLOCK', data: { enabled: true } };
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage(msg);
        } else if (navigator.serviceWorker.ready) {
          navigator.serviceWorker.ready.then(reg => {
            reg.active?.postMessage(msg);
          });
        }
      }
    }

    this.initNav();
    this.initScrollSpy();
    this.initSearch();
    this.initToggles();
    this.initInputs();
    this.initDropdowns();
    this.initEngines();
    this.initPresets();
    this.initProxyBackend();
    this.initPanicKey();
    this.initClearSiteData();
    this.initConnectionCheck();
    this.initPortableSettings();
    this.initSavedLogins();

    const resetBtn = document.querySelector<HTMLButtonElement>('[data-reset="reset"]');
    resetBtn?.addEventListener('click', () => this.reset(resetBtn));
  }
}
