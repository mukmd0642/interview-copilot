import { app, BrowserWindow, desktopCapturer, Menu, session } from 'electron';
import { createMainWindow, ensureSingleInstance } from './window.js';
import { registerIpc } from './ipc.js';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts.js';
import { installWebviewShortcutHook } from './webview-shortcuts.js';
import { sessionBoundary, log } from './log.js';

ensureSingleInstance();

app.whenReady().then(async () => {
  sessionBoundary('APP STARTED');

  // Default Electron menu binds Ctrl+W to "Close Window" and Ctrl+Shift+W to
  // "Close All Windows" — both quietly close our app when the user tries to
  // close a browser TAB inside the embedded webview view. We replace the
  // whole menu with a minimal one (or null on Win/Linux) so our renderer can
  // own Ctrl+W and the rest of the browser-style accelerators.
  //
  // On macOS we keep an Edit-only menu so Cmd+C / Cmd+V / Cmd+A still work
  // in form fields — that's the only Mac-specific surface that requires
  // a menu definition for clipboard behavior to function.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { label: app.name, submenu: [{ role: 'quit' }, { role: 'hide' }, { role: 'hideOthers' }] },
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
            { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
          ],
        },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  registerIpc();

  // Hook before-input-event on every <webview> webContents so browser-style
  // shortcuts (Ctrl+T / Ctrl+W / Ctrl+H / Alt+arrows / Ctrl+Shift+B) work
  // even when focus is inside the embedded page. The listener attaches
  // automatically as new webviews are created.
  installWebviewShortcutHook();

  // Grant the mic + display-capture permissions automatically when our own
  // renderer asks. OS-level prompts (NSMicrophoneUsageDescription on Mac,
  // the Windows privacy dialog) still gate actual capture, but at the
  // Chromium layer we shouldn't double-prompt inside our own app.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const ourApp =
      url.startsWith('file://') ||
      url.startsWith('http://localhost') ||
      url.startsWith('http://127.0.0.1') ||
      url.startsWith('devtools://');
    if (ourApp && (permission === 'media' || permission === 'display-capture')) {
      callback(true);
      return;
    }
    // Embedded <webview> content gets the normal browser flow.
    callback(false);
  });

  // setDisplayMediaRequestHandler is the modern way to grant
  // getDisplayMedia() requests in Electron 27+. Without this, calls to
  // navigator.mediaDevices.getDisplayMedia({ audio: true }) reject with an
  // AbortError — which is exactly what was breaking "Click CC" in the
  // earlier build that used the legacy chromeMediaSource: 'desktop'.
  //
  // The `audio: 'loopback'` option is the Windows-only knob that tells
  // Chromium to capture the system audio mix (everything playing through
  // the speakers, regardless of which app produced it). On macOS this
  // returns silence — for Mac users we use a virtual input device
  // (BlackHole / Loopback) via standard getUserMedia({deviceId}) instead.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          // We don't actually use the thumbnail — set to zero to skip the
          // expensive bitmap composition.
          thumbnailSize: { width: 0, height: 0 },
        });
        if (sources.length === 0) {
          log('displayMedia', 'no screen sources available — denying request');
          callback({});
          return;
        }
        log('displayMedia', `granted loopback audio + screen[0]=${sources[0]!.name}`);
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        log('displayMedia', `handler failed: ${(err as Error).message}`);
        callback({});
      }
    },
    // Don't pop up the native OS picker — we know we want the primary
    // screen and the system audio mix.
    { useSystemPicker: false }
  );

  try {
    await createMainWindow();
  } catch (err) {
    log('main', `createMainWindow failed: ${(err as Error).message}`);
    app.quit();
  }

  // Register global hotkeys AFTER the window exists so they have a target
  // window to act on. If we register earlier, the first hotkey press would
  // find a null window and silently no-op.
  registerGlobalShortcuts();

  app.on('activate', async () => {
    // macOS: re-create window when dock icon clicked and no windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS apps typically stay alive until ⌘Q; on Windows close = quit.
  if (process.platform !== 'darwin') app.quit();
});

// Free global shortcuts so they're available to other apps after we exit.
// Electron does this automatically on full process exit, but explicit
// cleanup here covers the macOS "quit without closing window" path.
app.on('will-quit', () => {
  unregisterGlobalShortcuts();
});

process.on('uncaughtException', (err) => {
  log('main', `UNCAUGHT: ${err.stack ?? err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log('main', `UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
