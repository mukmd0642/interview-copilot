#!/usr/bin/env node
/**
 * Production build script for InterviewCopilot.
 *
 * Usage (from project root):
 *   npm run build           — build for the current platform (default sensible)
 *   npm run build:win       — build Windows NSIS installer (.exe)
 *   npm run build:mac       — build Mac DMG (arm64 + x64 separately)
 *   npm run build:all       — build for both platforms in one shot
 *   npm run clean           — wipe dist/ and out/ without building
 *
 * Cross-compilation notes
 * ───────────────────────
 *   • You can build a Mac DMG on Windows, but it cannot be code-signed or
 *     notarized — recipients will see Gatekeeper warnings and need to
 *     right-click → Open to bypass. For production releases, build on a
 *     Mac that has a Developer ID Application certificate installed.
 *   • Building a Windows EXE on Mac/Linux works the same way: produces an
 *     unsigned binary that triggers SmartScreen on first run.
 *
 * Steps the script runs
 * ─────────────────────
 *   1. Clean dist/ and out/ — guarantees no stale files leak into the
 *      installer.
 *   2. tsc --noEmit for both the node and web projects — catches type
 *      errors before we spend 60 seconds packaging.
 *   3. electron-vite build — transpiles main + preload + renderer to out/.
 *   4. electron-builder — produces the platform installer in dist/.
 *   5. Prints artifact sizes and paths.
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ── Args ────────────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const flagWin   = args.has('--win');
const flagMac   = args.has('--mac');
const flagAll   = args.has('--all');
const flagClean = args.has('--clean-only');
const skipTypecheck = args.has('--skip-typecheck');

// Decide target list. If nothing specified, default to current platform —
// least surprising for an interactive `npm run build` invocation.
let targets;
if (flagAll || (flagWin && flagMac)) targets = ['--mac', '--win'];
else if (flagWin)                    targets = ['--win'];
else if (flagMac)                    targets = ['--mac'];
else                                  targets = [process.platform === 'darwin' ? '--mac' : '--win'];

// ── ANSI colours (only if stdout is a TTY) ──────────────────────────────
const tty = process.stdout.isTTY;
const c = {
  green:  (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red:    (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  cyan:   (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
  bold:   (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  dim:    (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
};

// ── Helpers ─────────────────────────────────────────────────────────────
function step(label, fn) {
  process.stdout.write(`\n${c.cyan('→')} ${label}\n`);
  const t0 = Date.now();
  try {
    fn();
    process.stdout.write(`  ${c.green('✓')} ${c.dim(`${((Date.now() - t0) / 1000).toFixed(1)}s`)}\n`);
  } catch (err) {
    process.stdout.write(`  ${c.red('✗')} failed\n`);
    throw err;
  }
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, shell: true });
}

function rmDir(dir) {
  const p = join(ROOT, dir);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

function humanSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── Pre-flight warnings ─────────────────────────────────────────────────
if (process.platform !== 'darwin' && targets.includes('--mac')) {
  console.warn(c.yellow('⚠  Building Mac targets on a non-Mac platform.'));
  console.warn(c.yellow('   The .dmg will be UNSIGNED and UN-NOTARIZED — Mac users will need'));
  console.warn(c.yellow('   to right-click → Open and bypass Gatekeeper. For production'));
  console.warn(c.yellow('   releases, run this on a Mac with a Developer ID certificate.\n'));
}
if (process.platform !== 'win32' && targets.includes('--win')) {
  console.warn(c.yellow('⚠  Building Windows targets on a non-Windows platform.'));
  console.warn(c.yellow('   The .exe will be UNSIGNED; SmartScreen will flag it on first run.\n'));
}

// ── Steps ───────────────────────────────────────────────────────────────
console.log(c.bold(`\nInterviewCopilot · production build`));
console.log(c.dim(`  host=${process.platform} ${process.arch}   targets=${targets.join(' ')}`));

step('Clean dist/ and out/', () => {
  rmDir('dist');
  rmDir('out');
});

// Clean-only mode bails out here.
if (flagClean) {
  console.log(c.green('\n✓ Clean done.\n'));
  process.exit(0);
}

if (!skipTypecheck) {
  step('Typecheck (main+preload)', () => run('npx --no-install tsc --noEmit -p tsconfig.node.json'));
  step('Typecheck (renderer)',     () => run('npx --no-install tsc --noEmit -p tsconfig.web.json'));
} else {
  console.log(c.dim('  (typecheck skipped via --skip-typecheck)'));
}

step('Build (electron-vite)', () => run('npx --no-install electron-vite build'));

step(`Package (electron-builder ${targets.join(' ')})`, () => {
  run(`npx --no-install electron-builder ${targets.join(' ')}`);
});

// ── Artifact summary ────────────────────────────────────────────────────
const distDir = join(ROOT, 'dist');
console.log(c.green(`\n${c.bold('✓ Build complete.')}`));

if (existsSync(distDir)) {
  // List top-level installer files; ignore intermediate build directories
  // (electron-builder also leaves win-unpacked/, mac/, etc. — those are
  // useful for debugging but not artifacts a user installs).
  const entries = readdirSync(distDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, full: join(distDir, e.name) }))
    .map((e) => ({ ...e, size: statSync(e.full).size }))
    .filter((e) => !e.name.endsWith('.yml') && !e.name.endsWith('.yaml') && !e.name.endsWith('.blockmap'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) {
    console.log(c.yellow('  (no installer files found in dist/ — electron-builder may have failed silently)'));
  } else {
    console.log(c.cyan('\nInstallers:'));
    const nameW = Math.min(60, Math.max(...entries.map((e) => e.name.length)));
    for (const { name, size, full } of entries) {
      console.log(`  ${name.padEnd(nameW)}  ${c.dim(humanSize(size).padStart(8))}`);
      console.log(`    ${c.dim(full)}`);
    }
  }
} else {
  console.log(c.yellow('  (no dist/ folder; build may have failed)'));
}

console.log();
console.log(c.dim('Next:'));
console.log(c.dim('  • Test the installer on a clean machine — confirm WDA_EXCLUDEFROMCAPTURE applies'));
console.log(c.dim('    in the packaged build (koffi loads from app.asar.unpacked).'));
console.log(c.dim('  • For signed releases, see docs/BUILD.md.\n'));
