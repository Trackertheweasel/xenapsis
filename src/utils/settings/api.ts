import ConfigAPI, { loadPageSettings } from '../config';

// On/off settings by name, as the Settings page's switches store them.
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
  loadAll: loadPageSettings,
};
