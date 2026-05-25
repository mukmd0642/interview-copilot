import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';

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

  // The cross-platform killer feature: tells the OS compositor not to include
  // this window's pixels in screen captures, screen recordings, or screen-
  // share streams.
  //   Windows: maps to SetWindowDisplayAffinity(WDA_MONITOR).
  //   macOS:   sets NSWindowSharingType = NSWindowSharingNone.
  // Both succeed silently when unsupported (very old OS builds); the user
  // would visually see the window appear in their share, so we don't try to
  // fall back — the privacy guarantee is the API working.
  mainWindow.setContentProtection(true);
  log('window', 'setContentProtection(true) applied');

  // Don't reveal the window until the renderer has painted, otherwise the
  // user sees a white flash before the dark UI loads.
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

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
  mainWindow.setContentProtection(enabled);
  log('window', `setContentProtection(${enabled})`);
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
