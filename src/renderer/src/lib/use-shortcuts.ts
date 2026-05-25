import { useEffect } from 'react';
import { useApp } from '../state/store.js';
import { webviewRegistry } from './webview-registry.js';

// Renderer-level keyboard accelerators for browser-style shortcuts that
// match what users expect from any tabbed browser.
//
// Caveat about webview focus
// ──────────────────────────
// When the user has clicked INTO an embedded <webview>, keyboard events
// happen inside that webview's renderer process and our window-level
// addEventListener('keydown') never sees them. The user can still hit
// Esc / Tab / a click outside the webview to give our main page focus
// back, then shortcuts work. Routing them through main-process
// before-input-event would catch the in-webview case too, at the cost of
// an IPC round-trip and more setup; we keep this renderer-only for v1.

type ShortcutMatch = (e: KeyboardEvent) => boolean;

const cmdOrCtrl = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey;

const matchers: Array<{ name: string; match: ShortcutMatch; run: () => void }> = [];

function register(name: string, match: ShortcutMatch, run: () => void): void {
  matchers.push({ name, match, run });
}

// Rebuilt on every hook invocation; we read from the live store each time
// so the actions reflect the current state.
function install(): void {
  matchers.length = 0;

  const s = useApp.getState();

  // ── Browser-tab shortcuts ───────────────────────────────────────────────
  register(
    'Ctrl/Cmd+T',
    (e) => cmdOrCtrl(e) && !e.shiftKey && (e.key === 't' || e.key === 'T'),
    () => useApp.getState().newTab()
  );

  register(
    'Ctrl/Cmd+W',
    (e) => cmdOrCtrl(e) && !e.shiftKey && (e.key === 'w' || e.key === 'W'),
    () => {
      // Only close a tab when the browser is the visible view AND we have
      // more than one tab. Otherwise this would silently close the last
      // remaining tab in the background, which the user can't observe.
      const state = useApp.getState();
      if (!state.browserVisible) return;
      if (state.tabs.length <= 1) return;
      state.closeTab();
    }
  );

  register(
    'Ctrl/Cmd+H',
    (e) => cmdOrCtrl(e) && !e.shiftKey && (e.key === 'h' || e.key === 'H'),
    () => useApp.getState().toggleHistory()
  );

  register(
    'Ctrl/Cmd+Tab',
    (e) => cmdOrCtrl(e) && e.key === 'Tab',
    () => {
      // Cycle through tabs in the browser view.
      const state = useApp.getState();
      if (!state.browserVisible || state.tabs.length < 2) return;
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const next = state.tabs[(idx + 1) % state.tabs.length];
      if (next) state.selectTab(next.id);
    }
  );

  // Back / Forward in active webview
  register(
    'Alt+Left',
    (e) => e.altKey && !cmdOrCtrl(e) && e.key === 'ArrowLeft',
    () => webviewRegistry.getActive()?.goBack()
  );
  register(
    'Alt+Right',
    (e) => e.altKey && !cmdOrCtrl(e) && e.key === 'ArrowRight',
    () => webviewRegistry.getActive()?.goForward()
  );

  // ── App-level shortcuts (mirror the WinForms ProcessCmdKey list) ────────
  register(
    'Ctrl/Cmd+Shift+B',
    (e) => cmdOrCtrl(e) && e.shiftKey && (e.key === 'b' || e.key === 'B'),
    () => useApp.getState().toggleBrowser()
  );

  // Close the history dialog with Escape (better than fishing for the
  // backdrop with the mouse).
  register(
    'Escape',
    (e) => e.key === 'Escape',
    () => {
      const state = useApp.getState();
      if (state.historyOpen) state.setHistoryOpen(false);
    }
  );
}

/** Install global keyboard accelerators. Call once from the App component. */
export function useShortcuts(): void {
  useEffect(() => {
    install();
    const onKeyDown = (e: KeyboardEvent): void => {
      for (const m of matchers) {
        if (!m.match(e)) continue;
        e.preventDefault();
        e.stopPropagation();
        m.run();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
