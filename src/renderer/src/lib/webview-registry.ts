// Tiny module-level pointer to the currently-active <webview> element.
// Lets non-React code (the keyboard shortcut hook) reach into the live DOM
// element to call goBack/goForward/reload without prop drilling refs
// through three components.
//
// Updated by BrowserView whenever the active tab changes; null when no
// browser view is mounted or no tab is selected.

/** Subset of HTMLElement + Electron's <webview> API that we actually use. */
export interface WebviewElement extends HTMLElement {
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  getTitle?: () => string;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
}

let active: WebviewElement | null = null;

export const webviewRegistry = {
  setActive(el: WebviewElement | null): void {
    active = el;
  },
  getActive(): WebviewElement | null {
    return active;
  },
};
