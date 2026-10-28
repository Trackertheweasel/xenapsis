import {
  backUpNow,
  deleteBackup,
  getConsent,
  getStatus,
  hasKey,
  keepKeyFromCode,
  restore,
  setConsent,
} from '../loginsync';
import { busy, confirm } from './ui';

// Only shown on an invite-only Persec, where there's somewhere to keep the backup.
export async function initSavedLogins() {
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
      const ok = await confirm(
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
      const ok = await confirm(
        'Turn off saved logins?',
        [
          'Your encrypted backup on this server is deleted right away.',
          'You stay logged in to sites in this browser until you clear site data.',
        ],
        'Turn off and delete backup',
      );
      if (!ok) return;
      return busy(toggle, async () => {
        try {
          await setConsent('essential');
          await deleteBackup();
          await show('Off. Your backup was deleted.');
        } catch (err) {
          await show(`Couldn’t delete the backup: ${(err as Error).message}. Try again.`);
        }
      });
    }
    if (await hasKey()) return busy(toggle, turnOn);
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
    const ok = await confirm(
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
