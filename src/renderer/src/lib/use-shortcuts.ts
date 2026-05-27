import { useEffect } from 'react';
import { useApp } from '../state/store.js';
import { webviewRegistry } from './webview-registry.js';
import type { AppAction } from '../../../shared/ipc';

// Renderer-level keyboard accelerators for browser-style shortcuts.
//
// Why two sources fire the same actions
// ─────────────────────────────────────
// When the user's focus is on our React app's top-level page, plain
// `keydown` listeners fire — the matcher table below handles those.
//
// When focus is INSIDE an embedded <webview>, keystrokes happen in that
// webview's separate renderer process and our window listener never sees
// them. The main process intercepts via `before-input-event` and pushes
// the matched action over IPC (`onWebviewShortcut`). We dispatch through
// the same `dispatchAction` so both paths produce identical behaviour.
//
// Routing critical keys through the main-process hook costs one IPC hop
// per keypress, which is fine for keyboard accelerators (handful per
// minute, not per frame).

// ── Action dispatcher ──────────────────────────────────────────────────
// Single source of truth for "what does each action DO." Both the
// renderer keydown matcher and the webview-shortcut IPC handler call
// this. Keep behaviour identical across both entry points.

function dispatchAction(action: AppAction): void {
  const state = useApp.getState();
  switch (action) {
    case 'new-tab':
      state.newTab();
      return;
    case 'close-tab':
      // Only act when the browser is the visible view AND we have more
      // than one tab. Otherwise we'd silently close the last remaining
      // tab in the background, which the user can't observe.
      if (!state.browserVisible) return;
      if (state.tabs.length <= 1) return;
      state.closeTab();
      return;
    case 'toggle-history':
      state.toggleHistory();
      return;
    case 'cycle-tab': {
      if (!state.browserVisible || state.tabs.length < 2) return;
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const next = state.tabs[(idx + 1) % state.tabs.length];
      if (next) state.selectTab(next.id);
      return;
    }
    case 'toggle-browser':
      state.toggleBrowser();
      return;
    case 'go-back':
      webviewRegistry.getActive()?.goBack();
      return;
    case 'go-forward':
      webviewRegistry.getActive()?.goForward();
      return;
  }
}

// ── Renderer keydown matcher table ─────────────────────────────────────

const cmdOrCtrl = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey;

interface Matcher {
  match: (e: KeyboardEvent) => boolean;
  action: AppAction | (() => void); // either an AppAction or a one-off callback
}

function buildMatchers(): Matcher[] {
  return [
    // Browser-tab shortcuts — these mirror what main intercepts from the
    // webview, so behaviour is identical regardless of focus location.
    { match: (e) => cmdOrCtrl(e) && !e.shiftKey && !e.altKey && (e.key === 't' || e.key === 'T'), action: 'new-tab' },
    { match: (e) => cmdOrCtrl(e) && !e.shiftKey && !e.altKey && (e.key === 'w' || e.key === 'W'), action: 'close-tab' },
    { match: (e) => cmdOrCtrl(e) && !e.shiftKey && !e.altKey && (e.key === 'h' || e.key === 'H'), action: 'toggle-history' },
    { match: (e) => cmdOrCtrl(e) && !e.shiftKey && e.key === 'Tab', action: 'cycle-tab' },

    // App-level
    { match: (e) => cmdOrCtrl(e) && e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B'), action: 'toggle-browser' },

    // Webview navigation
    { match: (e) => e.altKey && !cmdOrCtrl(e) && !e.shiftKey && e.key === 'ArrowLeft', action: 'go-back' },
    { match: (e) => e.altKey && !cmdOrCtrl(e) && !e.shiftKey && e.key === 'ArrowRight', action: 'go-forward' },

    // One-off (Escape doesn't map to an AppAction because closing dialogs
    // never fires from inside a webview anyway).
    {
      match: (e) => e.key === 'Escape',
      action: () => {
        const s = useApp.getState();
        if (s.historyOpen) s.setHistoryOpen(false);
      },
    },
  ];
}

/** Install global keyboard accelerators. Call once from the App component. */
export function useShortcuts(): void {
  useEffect(() => {
    const matchers = buildMatchers();

    const onKeyDown = (e: KeyboardEvent): void => {
      for (const m of matchers) {
        if (!m.match(e)) continue;
        e.preventDefault();
        e.stopPropagation();
        if (typeof m.action === 'string') dispatchAction(m.action);
        else m.action();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);

    // Webview-focused keys land here via main-process interception.
    const offWebviewShortcut = window.api.onWebviewShortcut((action) => {
      dispatchAction(action);
    });

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      offWebviewShortcut();
    };
  }, []);
}
