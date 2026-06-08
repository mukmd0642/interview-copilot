import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';
import { applyHardestContentProtection, clearContentProtection } from './win32.js';
import * as settings from './settings.js';
import type { LayoutMode, WindowBounds } from '../shared/ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

// Authoritative desired state for the two window flags that can be toggled
// from multiple entry points (toolbar button, global hotkey, IPC, OS event
// reapplication). Reading from `win.isAlwaysOnTop()` or trying to infer
// privacy from setContentProtection is unreliable on Windows — those
// queries can drift after multiple toggles, which is exactly what produced
// the "pin hotkey stops working" report. Treat these as the single source
// of truth and have every setter update them.
let topMostState = false;
let privacyState = true;

// Current layout mode — drives which windowBounds slot we persist resizes
// into. Loaded from settings at window creation.
let layoutModeState: LayoutMode = 'compact';

// Debounce handle for persisting window geometry. Resize/move fire rapidly
// while the user drags; we only write settings.json once they settle.
let saveBoundsTimer: NodeJS.Timeout | null = null;

// ── Window geometry helpers ─────────────────────────────────────────────────

/** Sensible default size+position for a layout mode on the primary display. */
function defaultBounds(mode: LayoutMode): WindowBounds {
  const wa = screen.getPrimaryDisplay().workArea;
  if (mode === 'compact') {
    const width = 520;
    const height = Math.min(680, wa.height - 48);
    // Top-right corner with a small margin — the conventional overlay spot,
    // out of the way of the editor / meeting window the user is focused on.
    return { width, height, x: wa.x + wa.width - width - 24, y: wa.y + 24 };
  }
  // full
  const width = Math.min(1040, wa.width - 80);
  const height = Math.min(720, wa.height - 80);
  return {
    width,
    height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
  };
}

/**
 * Returns the saved bounds for a mode if they still land on a connected
 * display (so a position remembered from a now-disconnected monitor doesn't
 * strand the window off-screen); otherwise the default for that mode.
 */
function resolveBounds(mode: LayoutMode, saved?: WindowBounds): WindowBounds {
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
    return defaultBounds(mode);
  }
  // The window is on-screen if its rect overlaps any display's workArea by a
  // reasonable margin (require the title-bar-ish top strip to be visible).
  const visible = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const overlapX = Math.max(0, Math.min(saved.x + saved.width, wa.x + wa.width) - Math.max(saved.x, wa.x));
    const overlapY = Math.max(0, Math.min(saved.y + saved.height, wa.y + wa.height) - Math.max(saved.y, wa.y));
    return overlapX >= 80 && overlapY >= 40;
  });
  return visible ? saved : defaultBounds(mode);
}

/** Debounced persist of the current window geometry into its mode's slot. */
function scheduleSaveBounds(): void {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    const win = mainWindow;
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    const current = settings.cached();
    void settings.save({
      windowBounds: { ...current.windowBounds, [layoutModeState]: b },
    });
  }, 500);
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getTopMost(): boolean {
  return topMostState;
}

export function getPrivacy(): boolean {
  return privacyState;
}

export async function createMainWindow(): Promise<BrowserWindow> {
  // Read the already-loaded settings synchronously. index.ts awaits
  // settings.load() BEFORE calling us, so the cache is populated. (We
  // deliberately do NOT await inside here — awaiting settings.load() within
  // this whenReady-invoked function was tearing the process down before the
  // window was ever created.)
  const s = settings.cached();
  layoutModeState = s.layoutMode;
  const bounds = resolveBounds(layoutModeState, s.windowBounds[layoutModeState]);

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    // Low enough that the compact overlay can shrink to a narrow rail; the
    // full view simply opens larger. (Was 960×600, which blocked compact.)
    minWidth: 360,
    minHeight: 420,
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
  // Dev/QA escape hatch: with IC_DISABLE_CONTENT_PROTECTION=1 we skip the
  // capture-exclusion so the window can be screenshotted for visual QA.
  // Env-gated, so it has zero effect on normal use. NEVER set in production.
  const disableProtect = process.env['IC_DISABLE_CONTENT_PROTECTION'] === '1';
  if (disableProtect) {
    privacyState = false;
    log('window', 'content protection DISABLED via IC_DISABLE_CONTENT_PROTECTION (dev/QA)');
  } else {
    mainWindow.setContentProtection(true);
    log('window', 'setContentProtection(true) applied (macOS-ready)');
  }

  // Gated on privacyState so that show/restore/focus events don't silently
  // re-enable capture exclusion after the user has explicitly turned Priv
  // OFF (e.g. to take a screenshot). Without this gate the user sees the
  // toolbar say "Priv OFF" but the next focus event flips display affinity
  // back to WDA_EXCLUDEFROMCAPTURE, hiding the window from capture again.
  const reapplyWin32Protection = (reason: string): void => {
    if (!privacyState) {
      log('window', `win32 content protection [${reason}] skipped — privacy OFF`);
      return;
    }
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

  // Persist geometry (debounced) whenever the user resizes or moves the
  // window, into the current mode's slot.
  mainWindow.on('resize', scheduleSaveBounds);
  mainWindow.on('move', scheduleSaveBounds);

  mainWindow.on('closed', () => {
    if (saveBoundsTimer) { clearTimeout(saveBoundsTimer); saveBoundsTimer = null; }
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
  // Update the authoritative flag FIRST so the reapply hooks (show /
  // restore / focus) see the new state on any event they fire during the
  // OS calls below.
  privacyState = enabled;
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
  // Track our own desired state. Using win.isAlwaysOnTop() as the source
  // of truth for the next toggle was unreliable on Windows — after a few
  // hotkey presses it would return stale results and the hotkey would
  // get stuck in one state. Authoritative state here means button +
  // hotkey + IPC all agree.
  topMostState = enabled;
  mainWindow.setAlwaysOnTop(enabled, 'floating');
  return enabled;
}

export function setOpacity(value: number): number {
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  const clamped = Math.max(0.2, Math.min(1, value));
  mainWindow.setOpacity(clamped);
  return clamped;
}

/**
 * Switch layout mode and resize the window to that mode's remembered bounds
 * (or its sensible default). Persists the new mode. The renderer is the one
 * that actually re-renders compact vs full; this just handles the window
 * geometry + persistence side.
 */
export function setLayout(mode: LayoutMode): LayoutMode {
  if (!mainWindow || mainWindow.isDestroyed()) return layoutModeState;
  if (mode !== 'compact' && mode !== 'full') return layoutModeState;
  layoutModeState = mode;

  const saved = settings.cached().windowBounds[mode];
  const target = resolveBounds(mode, saved);
  // Suppress the debounced save that setBounds would trigger via 'resize'/
  // 'move' — we already know the target and don't want to overwrite the
  // OTHER mode's slot or fight the restore. setBounds fires the events, so
  // we persist explicitly here and let the debounce coalesce harmlessly.
  mainWindow.setBounds(target);
  void settings.save({ layoutMode: mode });
  log('window', `layout → ${mode} (${target.width}x${target.height})`);
  return mode;
}

/**
 * Toggle whole-window visibility. The renderer can't be reached while
 * hidden (window.hide tears down the WebContents' compositing surface)
 * which is exactly why we tie this to a global hotkey — the user needs
 * a way to bring the app back without an OS-level entry point, since
 * skipTaskbar already hides it from the taskbar/Alt-Tab.
 *
 * On show we focus and moveTop to make sure the freshly-restored
 * window lands in front of whatever the user was looking at — without
 * the explicit raise, Win11 sometimes shows it behind the current
 * foreground window, which makes the hotkey feel broken.
 */
export function toggleHidden(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const willHide = mainWindow.isVisible();
  if (willHide) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.moveTop();
    mainWindow.focus();
  }
  log('window', `toggleHidden → hidden=${willHide}`);
  return willHide;
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
