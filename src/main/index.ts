import { app, BrowserWindow, session } from 'electron';
import { createMainWindow, ensureSingleInstance } from './window.js';
import { registerIpc } from './ipc.js';
import { sessionBoundary, log } from './log.js';

ensureSingleInstance();

app.whenReady().then(async () => {
  sessionBoundary('APP STARTED');
  registerIpc();

  // Grant the mic permission automatically when our own renderer asks —
  // OS-level prompts (NSMicrophoneUsageDescription on Mac, the Windows
  // privacy dialog) still gate actual capture, but at the Chromium layer
  // we shouldn't double-prompt the user inside our own app.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const ourApp =
      url.startsWith('file://') ||
      url.startsWith('http://localhost') ||
      url.startsWith('devtools://');
    if (ourApp && (permission === 'media' || permission === 'display-capture')) {
      callback(true);
      return;
    }
    // Embedded <webview> content gets the normal browser flow.
    callback(false);
  });

  try {
    await createMainWindow();
  } catch (err) {
    log('main', `createMainWindow failed: ${(err as Error).message}`);
    app.quit();
  }

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

process.on('uncaughtException', (err) => {
  log('main', `UNCAUGHT: ${err.stack ?? err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log('main', `UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
