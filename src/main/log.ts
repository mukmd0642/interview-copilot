import { app } from 'electron';
import { promises as fs, mkdirSync } from 'fs';
import path from 'path';

// Single shared log sink. Mirrors the WinForms AppLog so a reader who knows
// the Windows logs can correlate the same event categories here.
//
// Output: <userData>/app.log
//   Windows: %APPDATA%/Interview Copilot/app.log
//   Mac:     ~/Library/Application Support/Interview Copilot/app.log
//   Linux:   ~/.config/Interview Copilot/app.log

const LOG_PATH = path.join(app.getPath('userData'), 'app.log');

let queue: Promise<void> = Promise.resolve();

try {
  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
} catch {
  /* ignore — logging must never throw at module load */
}

function fmtTime(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function log(category: string, msg: string): void {
  const line = `[${fmtTime()}] [${category.padEnd(15)}] ${msg}\n`;
  // Serialize writes so concurrent callers don't interleave bytes.
  queue = queue.then(() => fs.appendFile(LOG_PATH, line).catch(() => {}));
  // Also mirror to stderr in dev so the developer sees output without tail -f.
  if (!app.isPackaged) {
    process.stderr.write(line);
  }
}

/** Quotes a string for log output, collapses newlines, truncates if long. */
export function q(s: string | null | undefined, max = 120): string {
  if (s == null) return '<null>';
  if (s.length === 0) return '""';
  const clean = s.replace(/\r/g, '').replace(/\n/g, '\\n');
  return clean.length <= max ? `"${clean}"` : `"${clean.slice(0, max)}…" (len=${s.length})`;
}

export function sessionBoundary(label: string): void {
  // ASCII separator instead of U+2500 box-drawing — the file is UTF-8 either
  // way, but Windows cmd defaults to CP-850 and mangles multibyte chars when
  // we mirror to stderr in dev. Plain dashes render correctly everywhere.
  log('session', '-'.repeat(60));
  log('session', `=== ${label} @ ${new Date().toISOString()} ===`);
}

export const LOG_PATH_FOR_DISPLAY = LOG_PATH;
