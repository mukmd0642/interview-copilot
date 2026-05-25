import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';
import { applyHardestContentProtection, clearContentProtection } from './win32.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const primary = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1280, primary.width - 80);
  const height = Math.min(872, primary.height - 80);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#101012',
    show: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: 'Interview Copilot',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      sandbox: false, // preload needs Node access for the IPC bridge
      contextIsolation: true,
      // <webview> tag is required to embed browser tabs for cross-platform
      // audio capture. Disabled by default for security in Electron 30+; we
      // explicitly opt in.
      webviewTag: true,
      // We don't want random renderer crashes to take down the app.
      backgroundThrottling: false,
    },
  });

  // Cross-platform screen-capture exclusion. Different story on each OS:
  //
  //   macOS: BrowserWindow.setContentProtection(true) sets
  //          NSWindowSharingType = NSWindowSharingNone, which already
  //          excludes the window from EVERY capture path on macOS. Done.
  //
  //   Windows: setContentProtection(true) only calls SetWindowDisplayAffinity
  //            with WDA_MONITOR (0x01) — the LEGACY flag. Modern
  //            Windows.Graphics.Capture clients (OBS, Discord, Teams, Win11
  //            Snipping Tool) ignore it. We override with
  //            WDA_EXCLUDEFROMCAPTURE (0x11), the Win10 2004+ flag, which
  //            makes the window invisible to ALL captures.
  //            See src/main/win32.ts.
  //
  // Two reasons we apply the win32 flag from event handlers below rather than
  // here at construction time:
  //   1. show:false means the HWND may not be realized yet — calling
  //      SetWindowDisplayAffinity on a zero handle silently no-ops.
  //   2. Some Windows builds reset display affinity when the window is
  //      minimized/restored. Reapplying on 'show' makes it sticky.
  mainWindow.setContentProtection(true);
  log('window', 'setContentProtection(true) applied (macOS-ready)');

  const reapplyWin32Protection = (reason: string): void => {
    const result = applyHardestContentProtection(mainWindow!);
    log('window', `win32 content protection [${reason}] = ${result}`);
  };

  // Primary application: as soon as the renderer is loaded enough to show,
  // the HWND definitely exists and the window is about to become visible.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    reapplyWin32Protection('ready-to-show');
  });

  // Defensive reapplications. Cheap (single Win32 call) and covers every
  // path that has historically broken display affinity:
  mainWindow.on('show', () => reapplyWin32Protection('show'));
  mainWindow.on('restore', () => reapplyWin32Protection('restore'));
  mainWindow.on('focus', () => reapplyWin32Protection('focus'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // electron-vite injects ELECTRON_RENDERER_URL during dev so we hot-reload
  // the React app; in production we load the built bundle from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return mainWindow;
}

export function setPrivacy(enabled: boolean): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // Order matters: enable both layers when turning on, disable both when off.
  // On Mac only setContentProtection moves the needle; on Windows only the
  // FFI call does. Calling both keeps the code branch-free.
  if (enabled) {
    mainWindow.setContentProtection(true);
    applyHardestContentProtection(mainWindow);
  } else {
    mainWindow.setContentProtection(false);
    clearContentProtection(mainWindow);
  }
  log('window', `privacy=${enabled}`);
  return enabled;
}

export function setTopMost(enabled: boolean): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setAlwaysOnTop(enabled, 'floating');
  return enabled;
}

export function setOpacity(value: number): number {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  const clamped = Math.max(0.2, Math.min(1, value));
  mainWindow.setOpacity(clamped);
  return clamped;
}

export function ensureSingleInstance(): void {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
