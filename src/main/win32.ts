// Windows-specific FFI wrapper around SetWindowDisplayAffinity.
//
// Why this exists: Electron's BrowserWindow.setContentProtection(true) on
// Windows internally calls SetWindowDisplayAffinity with WDA_MONITOR (0x01).
// That flag blocks the legacy BitBlt and Desktop Duplication paths but is
// IGNORED by tools that use the modern Windows.Graphics.Capture API — OBS,
// Discord, Teams, Win11's Snipping Tool, Loom, etc. all capture the window
// content normally.
//
// The fix is WDA_EXCLUDEFROMCAPTURE (0x11), added in Windows 10 2004
// (build 19041). With that flag set, the OS compositor doesn't include the
// window in ANY capture surface — the window is invisible to every capturer
// on the machine.
//
// We load user32.dll lazily via koffi (pure FFI, no node-gyp / native build)
// and call SetWindowDisplayAffinity ourselves with the stronger flag, falling
// back to WDA_MONITOR if the OS is too old to accept it.

import type { BrowserWindow } from 'electron';
import { log } from './log.js';

export const WDA_NONE = 0x00;
export const WDA_MONITOR = 0x01;
export const WDA_EXCLUDEFROMCAPTURE = 0x11;

// Windows BOOL is `typedef int BOOL` — 4 bytes, NOT C99 bool. koffi's
// 'bool' is 1 byte, which would only read the low byte of EAX and could
// mis-report success/failure. We use int32 and compare against zero.
//
// HWND is passed as a uintptr_t (pointer-sized integer VALUE) — NOT as a
// Buffer typed as 'void *'. The earlier bug was passing the Buffer object
// itself, which koffi interprets as "pointer to this buffer's storage" and
// hands Windows a Node heap address instead of the actual window handle.
type SetWindowDisplayAffinityFn = (hwnd: bigint, affinity: number) => number;
type GetLastErrorFn = () => number;

interface User32 {
  SetWindowDisplayAffinity: SetWindowDisplayAffinityFn;
  GetLastError: GetLastErrorFn;
}

let user32: User32 | null = null;
let loadAttempted = false;
let loadError: string | null = null;

function loadUser32(): User32 | null {
  if (loadAttempted) return user32;
  loadAttempted = true;

  if (process.platform !== 'win32') return null;

  try {
    // koffi is CommonJS — `require` it dynamically so the module load only
    // happens on Windows and Mac/Linux builds don't need it bundled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi');

    const user32lib = koffi.load('user32.dll');
    // GetLastError is in kernel32, NOT user32. Earlier I tried to bind it
    // from user32 — koffi aborts the whole load when one symbol lookup
    // fails, so that one mistake masked the real working binding.
    const kernel32 = koffi.load('kernel32.dll');

    // BOOL SetWindowDisplayAffinity(HWND hWnd, DWORD dwAffinity);
    //
    // HWND is uintptr_t — pass the pointer VALUE, not a buffer-as-pointer.
    // On x64 this is 8 bytes (BigInt); on x86 it'd fit in a Number, but
    // BigInt covers both with one code path.
    const SetWindowDisplayAffinity = user32lib.func(
      '__stdcall',
      'SetWindowDisplayAffinity',
      'int32',                    // BOOL — 4-byte int, NOT C99 bool
      ['uintptr_t', 'uint32']     // HWND value + DWORD affinity
    ) as unknown as SetWindowDisplayAffinityFn;

    // DWORD GetLastError(void);  — for diagnostics on failure.
    const GetLastError = kernel32.func(
      '__stdcall',
      'GetLastError',
      'uint32',
      []
    ) as unknown as GetLastErrorFn;

    user32 = { SetWindowDisplayAffinity, GetLastError };
    log('win32', 'user32+kernel32 bound (SetWindowDisplayAffinity, GetLastError)');
  } catch (err) {
    loadError = (err as Error).message;
    log('win32', `FFI load FAILED: ${loadError}`);
    log('win32', '  → run `npm install` to ensure koffi is present.');
    user32 = null;
  }
  return user32;
}

/**
 * Read the HWND value out of the Buffer returned by getNativeWindowHandle().
 *
 * The Buffer holds the pointer-sized HWND as its first 8 bytes (x64) or
 * 4 bytes (x86, theoretical — Electron doesn't really ship x86 anymore).
 * We always return BigInt for type consistency.
 */
function readHwnd(buf: Buffer): bigint {
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  if (buf.length >= 4) return BigInt(buf.readUInt32LE(0));
  return 0n;
}

function hwndHex(value: bigint): string {
  return value === 0n ? '<zero>' : '0x' + value.toString(16);
}

/**
 * Apply the strongest available content-protection to a BrowserWindow's HWND.
 *
 * Returns:
 *   'excluded'    — WDA_EXCLUDEFROMCAPTURE applied (window invisible to all
 *                   captures, the result the user expects).
 *   'monitor'     — Older OS rejected EXCLUDEFROMCAPTURE; fell back to
 *                   WDA_MONITOR (window shows as black in captures).
 *   'failed'      — FFI couldn't load, the HWND was zero, or both calls
 *                   returned 0 (call GetLastError in the log to see why).
 *   'noop'        — Non-Windows platform; caller should rely on
 *                   BrowserWindow.setContentProtection instead.
 */
export function applyHardestContentProtection(
  window: BrowserWindow
): 'excluded' | 'monitor' | 'failed' | 'noop' {
  if (process.platform !== 'win32') return 'noop';

  const lib = loadUser32();
  if (!lib) return 'failed';

  const hwndBuf = window.getNativeWindowHandle();
  if (!hwndBuf || hwndBuf.length === 0) {
    log('win32', 'getNativeWindowHandle returned empty buffer');
    return 'failed';
  }

  const hwnd = readHwnd(hwndBuf);
  const hex = hwndHex(hwnd);

  // A zero HWND means the OS window hasn't been created yet — usually a
  // timing bug. Caller should defer to ready-to-show.
  if (hwnd === 0n) {
    log('win32', `HWND is zero — window not realized yet, deferring`);
    return 'failed';
  }

  if (lib.SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) !== 0) {
    log('win32', `WDA_EXCLUDEFROMCAPTURE applied on HWND ${hex}`);
    return 'excluded';
  }

  const errExcluded = lib.GetLastError();
  log(
    'win32',
    `WDA_EXCLUDEFROMCAPTURE rejected on HWND ${hex} (GetLastError=${errExcluded}); trying WDA_MONITOR`
  );

  if (lib.SetWindowDisplayAffinity(hwnd, WDA_MONITOR) !== 0) {
    log('win32', `WDA_MONITOR fallback applied on HWND ${hex}`);
    return 'monitor';
  }

  const errMonitor = lib.GetLastError();
  log('win32', `SetWindowDisplayAffinity failed for both flags (GetLastError=${errMonitor})`);
  return 'failed';
}

/** Disable content protection — useful for toggling Priv OFF. */
export function clearContentProtection(window: BrowserWindow): boolean {
  if (process.platform !== 'win32') return false;
  const lib = loadUser32();
  if (!lib) return false;
  const hwndBuf = window.getNativeWindowHandle();
  if (!hwndBuf || hwndBuf.length === 0) return false;
  const hwnd = readHwnd(hwndBuf);
  if (hwnd === 0n) return false;
  return lib.SetWindowDisplayAffinity(hwnd, WDA_NONE) !== 0;
}

/** True if koffi is actually loaded (use to gate diagnostic UI). */
export function isFfiAvailable(): boolean {
  return loadUser32() != null;
}

/** Last FFI load error, if any — for surfacing in logs / settings UI. */
export function ffiLoadError(): string | null {
  // Make sure we've at least attempted to load before reporting "no error."
  loadUser32();
  return loadError;
}
