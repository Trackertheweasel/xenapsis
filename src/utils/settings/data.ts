import ConfigAPI from '../config';
import { exportSettings, mergeBookmarks, parseSettings } from '../portable';
import { clearSiteData } from '../sitedata';
import { busy, confirm, notify } from './ui';

// The Settings page's data tools: clear Persec's data, clear site data, export and import
// settings, and the connection check.

export async function reset(btn: HTMLButtonElement | null) {
  const ok = await confirm(
    'Clear all Persec data?',
    [
      'Every Persec setting goes back to its default, and your bookmarks and start page shortcuts are deleted from this browser.',
      'Site cookies and saved logins are not touched; use Clear site data for those.',
      'This can’t be undone. Export your settings first if you might want them back.',
    ],
    'Clear all data',
  );
  if (!ok) return;
  await busy(btn, async () => {
    try {
      await ConfigAPI.reset();
      notify('All Persec data cleared. Reloading…');
      setTimeout(() => parent.location.reload(), 800);
    } catch (err) {
      notify(`Couldn’t clear Persec’s data: ${(err as Error).message}`, true);
    }
  });
}

export function initConnectionCheck() {
  const btn = document.querySelector<HTMLButtonElement>('[data-check-connection]');
  const out = document.querySelector<HTMLElement>('[data-check-result]');
  btn?.addEventListener('click', () =>
    busy(btn, async () => {
      if (!out) return;
      out.textContent = 'Checking… this can take up to 30 seconds.';
      try {
        // Loaded on demand so Settings doesn't carry the proxy's connection code until it's used.
        const { renderResults, runDiagnostics } = await import('../diagnostics');
        renderResults(out, await runDiagnostics());
      } catch (err) {
        out.textContent = `The checks couldn’t run (${(err as Error).message}). Reload the page and try again.`;
      }
    }),
  );
}

export function initPortableSettings() {
  document.querySelector('[data-export-settings]')?.addEventListener('click', async () => {
    const file = exportSettings(await ConfigAPI.getAll());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
    );
    a.download = 'persec-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    notify('Settings exported to persec-settings.json. It isn’t encrypted: keep it private.');
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
      notify((err as Error).message, true);
      return;
    }
    try {
      if (settings.bm) {
        settings.bm = mergeBookmarks((await ConfigAPI.get('bm')) || [], settings.bm);
      }
      for (const [key, value] of Object.entries(settings)) await ConfigAPI.set(key, value);
    } catch (err) {
      notify(`Only part of the file could be saved: ${(err as Error).message}`, true);
      return;
    }
    notify('Settings imported. Reloading…');
    setTimeout(() => parent.location.reload(), 800);
  });
}

export function initClearSiteData() {
  const btn = document.querySelector<HTMLButtonElement>('[data-clear-site-data]');
  btn?.addEventListener('click', async () => {
    if (btn.disabled) return;
    const ok = await confirm(
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
    await busy(btn, async () => {
      try {
        await clearSiteData();
        notify('Site data cleared. Reloading…');
        setTimeout(() => parent.location.reload(), 800);
      } catch (err) {
        notify(
          `Some site data couldn’t be cleared (${(err as Error).message}). Try again, or clear this site’s data in your browser’s settings.`,
          true,
        );
      }
    });
  });
}
