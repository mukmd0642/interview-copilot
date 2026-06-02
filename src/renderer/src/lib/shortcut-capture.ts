// Turn a browser KeyboardEvent into an Electron accelerator string
// (https://www.electronjs.org/docs/latest/api/accelerator).
//
// The capture happens in the renderer's controlled input — once the user
// presses a real key (not just a modifier) we return a string like
// "CommandOrControl+Shift+P". The caller then sends it to the main
// process, which feeds it to globalShortcut.register.
//
// We deliberately key off e.code (the physical key) for the main key,
// NOT e.key (the produced character). On AZERTY, Shift+1 produces "1"
// in e.key but "Digit1" in e.code — Electron accelerators are layout-
// relative ("1" = top-row 1 wherever your layout puts it), and the
// physical code translates more reliably than the produced character.

const CODE_TO_ACCEL: Record<string, string> = {
  // Letters and digits — strip the prefix.
  // (KeyA → A, Digit1 → 1; handled by regex below for compactness.)

  Backslash: '\\',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',

  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Return',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CapsLock: 'Capslock',

  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

function codeToAccel(code: string): string | null {
  if (CODE_TO_ACCEL[code]) return CODE_TO_ACCEL[code]!;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const fkey = /^(F\d{1,2})$/.exec(code);
  if (fkey) return fkey[1]!;
  // Numpad and other rare keys: return null so the caller treats this
  // press as "not capturable" rather than registering a bogus accelerator
  // that globalShortcut would then reject.
  return null;
}

export interface CaptureResult {
  /** Electron accelerator string, ready to send to main. */
  accelerator: string;
  /** Human-readable label for display ("Ctrl+\\"). */
  label: string;
}

/**
 * Returns the accelerator if `e` is a complete chord (at least one
 * modifier or function key + a main key), or null if it's a pure-modifier
 * keypress that should be ignored while the user is still building the
 * chord.
 */
export function captureShortcut(e: KeyboardEvent): CaptureResult | null {
  // Ignore standalone modifier presses — wait until a "real" key joins them.
  const modOnly =
    e.code === 'ShiftLeft' || e.code === 'ShiftRight' ||
    e.code === 'ControlLeft' || e.code === 'ControlRight' ||
    e.code === 'AltLeft' || e.code === 'AltRight' ||
    e.code === 'MetaLeft' || e.code === 'MetaRight';
  if (modOnly) return null;

  const main = codeToAccel(e.code);
  if (!main) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  // Require at least one modifier UNLESS it's a function key. Without
  // this, pressing "A" alone would register a global hotkey that blocks
  // typing the letter A in any other app.
  const isFKey = /^F\d{1,2}$/.test(main);
  if (parts.length === 0 && !isFKey) return null;

  parts.push(main);
  const accelerator = parts.join('+');
  return { accelerator, label: prettyLabel(accelerator) };
}

/** "CommandOrControl+Shift+\\" → "Ctrl+Shift+\\" (or "Cmd+..." on Mac). */
export function prettyLabel(accelerator: string): string {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return accelerator
    .replace(/CommandOrControl/g, isMac ? 'Cmd' : 'Ctrl')
    .replace(/CmdOrCtrl/g, isMac ? 'Cmd' : 'Ctrl')
    .replace(/Control/g, 'Ctrl')
    .replace(/Command/g, 'Cmd');
}
