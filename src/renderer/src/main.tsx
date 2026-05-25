import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// Apply the persisted theme BEFORE React mounts — otherwise the body
// paints in dark for a frame before settings load and the user sees a
// flash. localStorage is the only sync, pre-render source available;
// settings.json is the durable canonical record that we sync into
// localStorage whenever the user toggles. See InterviewView for the
// canonical-load handshake.
(function applyInitialTheme(): void {
  try {
    const saved = localStorage.getItem('theme');
    const theme = saved === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();

// CSP violations from any code path land here. Without this, blocks happen
// invisibly — the only sign is a misleading "The user aborted a request"
// from whichever API tried to load the blocked resource. Logging them to
// the main process makes future CSP issues self-diagnosing.
document.addEventListener('securitypolicyviolation', (e) => {
  const msg =
    `${e.violatedDirective} blocked ` +
    `${e.blockedURI || '<inline>'} ` +
    `(effective: ${e.effectiveDirective}, source: ${e.sourceFile || '?'}:${e.lineNumber || '?'})`;
  window.api.log('csp', msg);
});

// Surface unhandled errors and rejections too — without this they only
// appear in DevTools, which is closed by default for users.
window.addEventListener('error', (e) => {
  window.api.log('uncaught', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason instanceof Error ? `${e.reason.name}: ${e.reason.message}` : String(e.reason);
  window.api.log('unhandled-rejection', reason);
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root in index.html');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
