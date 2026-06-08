import { globalShortcut } from 'electron';
import { log } from './log.js';
import { getMainWindow, getTopMost, setTopMost, setPrivacy, toggleHidden } from './window.js';
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
// Default accelerators (Ctrl+\ / Ctrl+Shift+\) live in shared/ipc.ts as
// DEFAULT_PIN_SHORTCUT / DEFAULT_PRIVACY_SHORTCUT. Some keyboard layouts
// don't have backslash, so the user can override both in Setup.

export interface RegisterResult {
  pinOk: boolean;
  privacyOk: boolean;
  hideOk: boolean;
  codingOk: boolean;
}

// Coding mode's capture/solve key is global so it fires while focus is in the
// editor/CoderPad. In coding mode it re-captures mid-session; otherwise it
// jumps into coding mode and solves what's on screen. Renderer routes it
// (InterviewView). Accelerator is user-customisable via Setup.

export function registerGlobalShortcuts(
  pinAccel: string,
  privacyAccel: string,
  hideAccel: string,
  codingAccel: string
): RegisterResult {
  // Free anything previously registered before binding new accelerators.
  // globalShortcut.register on an already-registered key silently no-ops
  // and returns false, so re-registration without an unregister would
  // appear as a "failed" result on every settings save.
  globalShortcut.unregisterAll();

  // ── Toggle Pin (and summon when pinning) ────────────────────────────────
  //
  // Toggle the always-on-top flag. When pinning ON (from OFF), also raise
  // and focus the window — without this, the user could "pin" an
  // invisible-behind-everything window and still not be able to find it.
  // Unpinning leaves the window where it is so the user can keep working.
  const pinOk = safeRegister(pinAccel, () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      log('shortcut', 'pin: no window');
      return;
    }
    // Read from our tracked state, NOT win.isAlwaysOnTop() — the latter
    // can drift on Windows after several toggles, which is what made the
    // hotkey appear to get stuck.
    const next = !getTopMost();
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
  if (pinOk) log('shortcut', `registered ${pinAccel} → pin toggle + summon`);
  else log('shortcut', `failed to register ${pinAccel}`);

  // ── Toggle Privacy (panic key) ─────────────────────────────────────────
  //
  // Belt-and-suspenders: if the user ever loses confidence that the window
  // is hidden from capture, a single key flips it back ON regardless of
  // current state. The renderer's toolbar updates via the broadcast.
  const privacyOk = safeRegister(privacyAccel, () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    // setContentProtection has no getter we can rely on cross-platform,
    // so we track in window.ts and just toggle the flag here. For a
    // "panic" hotkey, the safest default is to always re-enable.
    setPrivacy(true);
    log('shortcut', 'privacy panic → re-enabled');
    safeSend(IPC.Events.Privacy, true);
  });
  if (privacyOk) log('shortcut', `registered ${privacyAccel} → privacy panic`);
  else log('shortcut', `failed to register ${privacyAccel}`);

  // ── Toggle Hide (whole window) ─────────────────────────────────────────
  //
  // Yank the window off screen entirely (no taskbar, no Alt+Tab, just
  // gone). Press again to restore on top of whatever's currently in
  // front. Useful when the candidate needs to share their screen
  // momentarily without the OS-level "screen recording" indicator
  // showing a hidden-but-running window in some niche capturers.
  const hideOk = safeRegister(hideAccel, () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      log('shortcut', 'hide: no window');
      return;
    }
    toggleHidden();
  });
  if (hideOk) log('shortcut', `registered ${hideAccel} → hide/show toggle`);
  else log('shortcut', `failed to register ${hideAccel}`);

  // ── Coding capture / solve (global) ─────────────────────────────────────
  // Fire-and-forget to the renderer, which decides start-vs-recapture based
  // on session state. Hardcoded accel (not user-customisable yet).
  const codingOk = safeRegister(codingAccel, () => {
    safeSend(IPC.Events.CodingCaptureHotkey, undefined);
    log('shortcut', 'coding capture hotkey → renderer');
  });
  if (codingOk) log('shortcut', `registered ${codingAccel} → coding capture/solve`);
  else log('shortcut', `failed to register ${codingAccel}`);

  return { pinOk, privacyOk, hideOk, codingOk };
}

export function unregisterGlobalShortcuts(): void {
  globalShortcut.unregisterAll();
}

// globalShortcut.register throws (rather than returning false) when the
// accelerator string itself is malformed — e.g. "CommandOrControl++" or a
// user-recorded chord we couldn't parse. Wrap so a bad accelerator string
// degrades to a logged failure instead of taking down the IPC handler.
function safeRegister(accel: string, fn: () => void): boolean {
  try {
    return globalShortcut.register(accel, fn);
  } catch (err) {
    log('shortcut', `register("${accel}") threw: ${(err as Error).message}`);
    return false;
  }
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
