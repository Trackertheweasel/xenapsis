import ConfigAPI from '../config';
import {
  GUARDS_CHANNEL,
  customUserAgent,
  customUserAgentValue,
  profileFromUserAgent,
  storedUserAgent,
  userAgentHeaders,
} from '../guards';
import { postToServiceWorker } from '../serviceworker';
import { notify, syncSwitches } from './ui';

// The Settings page's Privacy guards card (src/pages/st.astro): the user agent sites see, and the
// switches for fingerprint noise, the new-tab leak guard and site fixes (src/utils/guards.ts).
const SWITCHES = ['fingerprintNoise', 'leakGuard', 'siteFixes'] as const;

function announce() {
  try {
    const channel = new BroadcastChannel(GUARDS_CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {}
}

async function saveUserAgent(value: string) {
  const agent = storedUserAgent(value);
  const headers = userAgentHeaders(agent ? profileFromUserAgent(agent) : null);
  await ConfigAPI.set('userAgent', agent ? value : '');
  await ConfigAPI.set('userAgentHeaders', headers);
  postToServiceWorker({ type: 'USER_AGENT', data: { headers } });
  announce();
  notify(agent ? 'Settings saved. Reload open sites to use it.' : 'Settings saved');
}

export async function initGuards() {
  const select = document.querySelector<HTMLSelectElement>('[data-user-agent]');
  const custom = document.querySelector<HTMLInputElement>('[data-user-agent-custom]');
  if (!select || !custom) return;

  const saved = String((await ConfigAPI.get('userAgent')) ?? '');
  const isCustom = saved.startsWith('custom:') && !!storedUserAgent(saved);
  select.value = isCustom ? 'custom' : storedUserAgent(saved) ? saved : '';
  custom.value = isCustom ? (storedUserAgent(saved) ?? '') : '';
  custom.hidden = select.value !== 'custom';

  select.addEventListener('change', () => {
    custom.hidden = select.value !== 'custom';
    if (select.value === 'custom') return custom.focus();
    saveUserAgent(select.value);
  });
  const saveCustom = () => {
    const agent = customUserAgent(custom.value);
    if (!agent) return notify('Enter a user agent on one line, up to 512 characters.', true);
    saveUserAgent(customUserAgentValue(agent));
  };
  custom.addEventListener('change', saveCustom);

  for (const key of SWITCHES) {
    const toggle = document.querySelector<HTMLElement>(`[data-toggle="${key}"]`);
    if (!toggle) continue;
    toggle.classList.toggle('active', (await ConfigAPI.getIndecator(key)) === 'on');
    // After the generic switch handler (settings/controls.ts) has flipped and saved it.
    toggle.addEventListener('click', async () => {
      await ConfigAPI.set(key, toggle.classList.contains('active') ? 'on' : 'off');
      announce();
    });
  }
  syncSwitches();
}
