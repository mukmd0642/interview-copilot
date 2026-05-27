import { app, type Input } from 'electron';
import { log } from './log.js';
import { getMainWindow } from './window.js';
import { IPC, type AppAction } from '../shared/ipc.js';

// Intercepts browser-style keyboard shortcuts that fire while focus is
// inside an embedded <webview>. Without this, Ctrl+T / Ctrl+W / Ctrl+H
// etc. land inside the webview's own renderer process — the page handles
// them (or, more commonly, ignores them) and our window-level keydown
// listener never sees the event.
//
// Approach
// ────────
// Electron fires `web-contents-created` for every WebContents the app
// creates, including each <webview> tag in the renderer. We filter to
// type === 'webview', attach `before-input-event`, and on a keydown we
// match against our shortcut table. If it matches, we
//   • event.preventDefault() — stops the webview from acting on the key
//   • send the action name to the main window's renderer via IPC, which
//     dispatches the same store action the regular keydown handler would.
//
// Why prevent default specifically: Ctrl+W in many web apps is "close
// tab" or worse; without preventDefault the page can intercept it before
// we react. Ctrl+H opens browser-internal help in some apps. We claim
// these keys for our app since the user's mental model is "I'm in a
// tabbed browser shell that I own."

function matchInput(input: Input): AppAction | null {
  if (input.type !== 'keyDown') return null;
  // input.control is true for Ctrl on Win/Linux; input.meta for Cmd on Mac.
  // Treat both as the same "command" modifier — same convention as
  // CommandOrControl elsewhere in the app.
  const cmd = input.control || input.meta;
  const key = input.key.toLowerCase();

  if (cmd && !input.shift && !input.alt) {
    if (key === 't') return 'new-tab';
    if (key === 'w') return 'close-tab';
    if (key === 'h') return 'toggle-history';
    if (key === 'tab') return 'cycle-tab';
  }
  if (cmd && input.shift && !input.alt) {
    if (key === 'b') return 'toggle-browser';
  }
  if (input.alt && !cmd && !input.shift) {
    if (key === 'arrowleft') return 'go-back';
    if (key === 'arrowright') return 'go-forward';
  }
  return null;
}

let installed = false;

export function installWebviewShortcutHook(): void {
  if (installed) return;
  installed = true;

  app.on('web-contents-created', (_event, contents) => {
    // Filter to <webview> tag webContents only. The other webContents we
    // see here are our main BrowserWindow's renderer (handled by the
    // window-level listener in use-shortcuts.ts) and any DevTools
    // contents (which we don't want to hijack).
    if (contents.getType() !== 'webview') return;

    const id = contents.id;
    log('webview-keys', `attaching before-input-event to webview webContents #${id}`);

    contents.on('before-input-event', (event, input) => {
      const action = matchInput(input);
      if (!action) return;
      event.preventDefault();
      log('webview-keys', `intercepted ${input.key}${input.shift ? '+shift' : ''}${input.alt ? '+alt' : ''} → ${action}`);
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.Events.WebviewShortcut, action);
    });
  });
}
