import { globalShortcut } from 'electron';
import { log } from './log.js';
import { getMainWindow, setTopMost, setPrivacy } from './window.js';
import { IPC } from '../shared/ipc.js';

// Global hotkeys — these work even when the window doesn't have focus,
// which is the whole point: with skipTaskbar + WDA_EXCLUDEFROMCAPTURE the
// window is invisible to the taskbar, Alt+Tab and Win+Tab. If the user
// unpins and clicks away, the only way back IS a global hotkey.
//
// We keep the binding set small and unobtrusive — global shortcuts
// permanently block the key combination for every app on the system, so
// each one we register is a real cost.
//
// Defaults picked to be uncommon enough not to collide with normal app
// shortcuts. `\` is the convention used by Cluely and similar stealth
// tools, so users coming from those won't have to relearn.

const SHORTCUT_TOGGLE_PIN_AND_SUMMON = 'CommandOrControl+\\';
const SHORTCUT_TOGGLE_PRIVACY        = 'CommandOrControl+Shift+\\';

export function registerGlobalShortcuts(): void {
  // ── Toggle Pin (and summon when pinning) ────────────────────────────────
  //
  // Toggle the always-on-top flag. When pinning ON (from OFF), also raise
  // and focus the window — without this, the user could "pin" an
  // invisible-behind-everything window and still not be able to find it.
  // Unpinning leaves the window where it is so the user can keep working.
  const ok1 = globalShortcut.register(SHORTCUT_TOGGLE_PIN_AND_SUMMON, () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      log('shortcut', 'pin: no window');
      return;
    }
    const now = win.isAlwaysOnTop();
    const next = !now;
    setTopMost(next);
    log('shortcut', `pin toggled → ${next}`);

    if (next) {
      // Pinning ON → surface the window so the user can see what they
      // just summoned. Without showInactive, Win11 occasionally raises
      // without giving focus, leaving the user unable to type into it.
      if (!win.isVisible()) win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }

    // Sync toolbar state in the renderer.
    safeSend(IPC.Events.TopMost, next);
  });
  if (!ok1) log('shortcut', `failed to register ${SHORTCUT_TOGGLE_PIN_AND_SUMMON}`);
  else log('shortcut', `registered ${SHORTCUT_TOGGLE_PIN_AND_SUMMON} → pin toggle + summon`);

  // ── Toggle Privacy (panic key) ─────────────────────────────────────────
  //
  // Belt-and-suspenders: if the user ever loses confidence that the window
  // is hidden from capture, a single key flips it back ON regardless of
  // current state. The renderer's toolbar updates via the broadcast.
  const ok2 = globalShortcut.register(SHORTCUT_TOGGLE_PRIVACY, () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    // setContentProtection has no getter we can rely on cross-platform,
    // so we track in the renderer's store and just toggle the flag here.
    // For a "panic" hotkey, the safest default is to always re-enable.
    setPrivacy(true);
    log('shortcut', 'privacy panic → re-enabled');
    safeSend(IPC.Events.Privacy, true);
  });
  if (!ok2) log('shortcut', `failed to register ${SHORTCUT_TOGGLE_PRIVACY}`);
  else log('shortcut', `registered ${SHORTCUT_TOGGLE_PRIVACY} → privacy panic`);
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}

function safeSend<T>(channel: string, payload: T): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (err) {
    log('shortcut', `send(${channel}) failed: ${(err as Error).message}`);
  }
}
