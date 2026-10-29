import { openInAboutBlank } from './aboutblank';
import ConfigAPI from './config';
import { notify } from './status';
import { TabManager } from './tb';

interface MenuElements {
  menuButton: HTMLButtonElement;
  menuContainer: HTMLDivElement;
  newTab: HTMLButtonElement;
  fullscreen: HTMLButtonElement;
  darkmode: HTMLButtonElement;
  reload: HTMLButtonElement;
  inspectElement: HTMLButtonElement;
  cloak: HTMLButtonElement;
  panic: HTMLButtonElement;
  settings: HTMLButtonElement;
  reopen: HTMLButtonElement;
  bookmarks: HTMLButtonElement;
  help: HTMLButtonElement;
}

// A key combination as the keybinds are saved: "ctrl+alt+shift+meta+key", the order the panic key
// is recorded in (src/utils/settings/panic.ts).
export function keybindFor(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  parts.push(key);
  return parts.join('+');
}

// Typing in a text field: a shortcut without Ctrl, Alt or Meta (the panic key is ` by default)
// would fire on an ordinary character.
export function isTyping(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ''));
}

interface KeybindConfig {
  element: HTMLButtonElement;
  combo: string;
}

export class MenuHandler {
  private elements: MenuElements;
  private keyMap = new Map<string, HTMLButtonElement>();
  private isMenuOpen = false;

  constructor(elements: MenuElements) {
    this.elements = elements;
  }

  async initialize(): Promise<void> {
    await this.setupKeybinds();
    this.attachEventListeners();
  }

  private async setupKeybinds(): Promise<void> {
    const panicKeybind = await this.getPanicKeybind();
    const keybindConfigs: KeybindConfig[] = [
      { element: this.elements.newTab, combo: 'Ctrl+Alt+N' },
      { element: this.elements.reopen, combo: 'Ctrl+Alt+T' },
      { element: this.elements.bookmarks, combo: 'Ctrl+Alt+B' },
      { element: this.elements.fullscreen, combo: 'Ctrl+Alt+Z' },
      { element: this.elements.reload, combo: 'Ctrl+Alt+R' },
      { element: this.elements.inspectElement, combo: 'Ctrl+Alt+I' },
      { element: this.elements.darkmode, combo: 'Ctrl+Alt+X' },
      { element: this.elements.cloak, combo: 'Ctrl+Alt+C' },
      { element: this.elements.panic, combo: panicKeybind },
      { element: this.elements.settings, combo: 'Ctrl+,' },
    ];
    for (const { element, combo } of keybindConfigs) {
      if (!combo) continue;
      this.addKeybindLabel(element, combo);
      this.keyMap.set(this.normalizeKeybind(combo), element);
    }
  }

  private async getPanicKeybind(): Promise<string> {
    try {
      return String((await ConfigAPI.get('panicKey')) ?? '');
    } catch {
      return '';
    }
  }

  private addKeybindLabel(element: HTMLButtonElement, combo: string): void {
    // Phones and tablets have no keyboard shortcuts, and the labels crowd a narrow menu.
    if (!matchMedia('(any-hover: hover)').matches) return;
    const label = element.querySelector('span');
    if (label) {
      label.textContent = `${label.textContent} (${combo})`;
    }
  }

  private normalizeKeybind(combo: string): string {
    return combo.toLowerCase().replace(/\s+/g, '');
  }

  private attachEventListeners(): void {
    const { menuButton, menuContainer } = this.elements;

    menuButton.addEventListener('click', this.toggleMenu.bind(this));
    document.addEventListener('click', this.handleDocumentClick.bind(this));
    document.addEventListener('mousedown', this.handleDocumentClick.bind(this));
    window.addEventListener('blur', this.handleWindowBlur.bind(this));

    menuContainer.querySelectorAll<HTMLButtonElement>('.menu-item').forEach(item => {
      item.addEventListener('click', this.hideMenu.bind(this));
      item.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'Escape') this.hideMenu();
      });
    });

    this.setupMenuActions();
    window.addEventListener('keydown', this.handleKeydown.bind(this), true);
    document.addEventListener('keydown', this.handleKeydown.bind(this), true);
    // And from the page in each tab, so the panic key works while someone is on a site.
    TabManager.onFrameKeydown(this.handleKeydown.bind(this));
  }

  private setupMenuActions(): void {
    this.elements.newTab.addEventListener('click', () => TabManager.openTab());
    this.elements.reload.addEventListener('click', this.handleReload.bind(this));
    this.elements.settings.addEventListener('click', () => TabManager.openTab('./st'));
    this.elements.bookmarks.addEventListener('click', () => TabManager.openTab('/bm'));
    this.elements.help.addEventListener('click', () => TabManager.openTab('/new#guide'));
    this.elements.reopen.addEventListener('click', async () => {
      if (!(await TabManager.reopenClosed())) notify('No recently closed tabs to reopen.');
    });
    this.elements.cloak.addEventListener('click', this.handleCloak.bind(this));
    this.elements.fullscreen.addEventListener('click', this.handleFullscreen.bind(this));
    this.elements.inspectElement.addEventListener('click', this.handleInspectElement.bind(this));
    this.elements.darkmode.addEventListener('click', this.handleDarkMode.bind(this));
    this.elements.panic.addEventListener('click', this.handlePanic.bind(this));
  }

  private toggleMenu(e: MouseEvent): void {
    e.stopPropagation();
    e.preventDefault();

    const wasHidden = this.elements.menuContainer.classList.contains('hidden');

    if (wasHidden) {
      this.showMenu();
    } else {
      this.hideMenu();
    }
  }

  private showMenu(): void {
    this.elements.menuContainer.classList.remove('hidden');
    this.elements.menuButton.setAttribute('aria-expanded', 'true');
    this.isMenuOpen = true;
    this.visibleItems()[0]?.focus();
  }

  private hideMenu(): void {
    const hadFocus = this.elements.menuContainer.contains(document.activeElement);
    this.elements.menuContainer.classList.add('hidden');
    this.elements.menuButton.setAttribute('aria-expanded', 'false');
    this.isMenuOpen = false;
    // After the frame: Enter on an item hides the menu before the item's click runs.
    if (hadFocus) requestAnimationFrame(() => this.elements.menuButton.focus());
  }

  // Forward is only shown on phones, so skip it when it's hidden.
  private visibleItems(): HTMLButtonElement[] {
    return Array.from(
      this.elements.menuContainer.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).filter(b => b.offsetParent !== null);
  }

  // Up/Down, Home/End move through the menu, as role="menu" promises.
  private moveFocus(e: KeyboardEvent): boolean {
    const items = this.visibleItems();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? items[(i + 1) % items.length]
        : e.key === 'ArrowUp'
          ? items[(i - 1 + items.length) % items.length]
          : e.key === 'Home'
            ? items[0]
            : e.key === 'End'
              ? items[items.length - 1]
              : null;
    if (!next) return false;
    next.focus();
    return true;
  }

  private handleDocumentClick(e: MouseEvent): void {
    if (!this.isMenuOpen) return;

    const target = e.target as Node;
    const { menuButton, menuContainer } = this.elements;

    if (!menuButton.contains(target) && !menuContainer.contains(target)) {
      this.hideMenu();
    }
  }

  private handleWindowBlur(): void {
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLIFrameElement) {
        this.hideMenu();
      }
    });
  }

  private getActiveFrame(): HTMLIFrameElement | null {
    if (!TabManager?.activeTabId) return null;

    const frame = document.getElementById(`frame-${TabManager.activeTabId}`);
    return frame instanceof HTMLIFrameElement ? frame : null;
  }

  private handleReload(): void {
    const frame = this.getActiveFrame();
    if (frame?.contentWindow) {
      frame.contentWindow.location.reload();
    }
  }

  private handleDarkMode(): void {
    const frame = this.getActiveFrame();
    if (!frame?.contentWindow || !frame.contentDocument) return;

    const script = frame.contentDocument.createElement('script');
    script.textContent = `(() => {
      let style = document.getElementById('dark-mode');
      if (style) {
        style.parentNode.removeChild(style);
      } else {
        style = document.createElement('style');
        style.id = 'dark-mode';
        style.textContent = 'html { filter: invert(100%) hue-rotate(180deg); } iframe,img,object,video { filter: invert(90%) hue-rotate(180deg); }';
        document.head.appendChild(style);
      }
    })();`;
    frame.contentDocument.head.appendChild(script);
  }

  private handleCloak(): void {
    openInAboutBlank();
  }

  private handleFullscreen(): void {
    const doc = window.top?.document;
    if (!doc) return;

    const promise = doc.fullscreenElement
      ? doc.exitFullscreen()
      : doc.documentElement.requestFullscreen();

    promise?.catch?.(() => {});
  }

  private handleInspectElement(): void {
    const frame = this.getActiveFrame();
    if (!frame?.contentWindow || !frame.contentDocument) return;

    try {
      const win = frame.contentWindow as any;

      if (win.eruda) {
        win.eruda._isInit ? win.eruda.destroy() : win.eruda.init();
        return;
      }

      const script = frame.contentDocument.createElement('script');
      // Runs with full access to Persec's origin, so pinned to one version and checked against its hash
      // (the same file as the npm tarball). Bump both together.
      script.src = 'https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js';
      script.integrity = 'sha384-weDBY9jeIj4NqaiZF9f6PMAMMY4lIu+0CAI+TjBIE73RctCQOxDoEHltYnstRszI';
      script.crossOrigin = 'anonymous';
      script.onload = () => win.eruda?.init?.();
      frame.contentDocument.head.appendChild(script);
    } catch (error) {
      console.error('Failed to initialize inspector:', error);
    }
  }

  private async handlePanic(): Promise<void> {
    const panicLoc = await this.getConfigValue('panicLoc', 'https://google.com');
    const topWindow = window.top || window;
    topWindow.location.href = panicLoc;
  }

  private async getConfigValue(key: string, defaultValue: string): Promise<string> {
    try {
      return String((await ConfigAPI.get(key)) ?? defaultValue);
    } catch {
      return defaultValue;
    }
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.repeat) return;

    if (this.isMenuOpen && this.moveFocus(e)) {
      // Stopped, as this listens on both window and document.
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.key === 'Escape' && this.isMenuOpen) {
      e.preventDefault();
      e.stopPropagation();
      this.hideMenu();
      return;
    }

    if (e.key === 'Enter' && this.elements.menuContainer.contains(document.activeElement)) {
      this.hideMenu();
      return;
    }

    if (isTyping(e)) return;
    const target = this.keyMap.get(keybindFor(e));

    if (target) {
      e.preventDefault();
      e.stopPropagation();
      target.click();
    }
  }
}

// Finds the menu in the page that has it (src/layouts/tab.astro) and wires it up. Loading this module
// does nothing on its own.
export async function setupMenu(): Promise<MenuHandler | null> {
  const menuButton = document.querySelector<HTMLButtonElement>('#menubtn');
  const menuContainer = document.querySelector<HTMLDivElement>('#menu');
  const item = (id: string) => document.querySelector<HTMLButtonElement>(`#menu-${id}`);
  const ids = [
    'newTab',
    'fullscreen',
    'darkmode',
    'reload',
    'inspectElement',
    'cloak',
    'panic',
    'settings',
    'reopen',
    'bookmarks',
    'help',
  ] as const;
  const items = Object.fromEntries(ids.map(id => [id, item(id)]));

  if (!menuButton || !menuContainer || ids.some(id => !items[id])) {
    console.error('Required menu elements not found');
    return null;
  }

  const elements = { menuButton, menuContainer, ...items } as MenuElements;

  const menuHandler = new MenuHandler(elements);
  await menuHandler.initialize();
  return menuHandler;
}

export function initMenu() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setupMenu(), { once: true });
  } else {
    setupMenu();
  }
}
