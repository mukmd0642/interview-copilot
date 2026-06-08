import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import {
  LANGUAGES,
  CODING_LANGUAGES,
  DEFAULT_PIN_SHORTCUT,
  DEFAULT_PRIVACY_SHORTCUT,
  DEFAULT_HIDE_SHORTCUT,
  DEFAULT_CODING_CAPTURE_SHORTCUT,
  type Settings,
} from '../shared/ipc.js';
import { log } from './log.js';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

// Default audio source depends on platform:
//   Windows: desktopCapturer works out of the box, so default to it.
//   macOS:   no equivalent without a virtual device; start in 'off' mode
//            so a fresh install doesn't crash on getUserMedia rejections,
//            then the user picks BlackHole / Loopback via Setup.
//   Linux:   desktopCapturer works on most distros.
const DEFAULT_SYSTEM_AUDIO: Settings['systemAudio'] =
  process.platform === 'darwin' ? { kind: 'off' } : { kind: 'desktop' };

const DEFAULTS: Settings = {
  jobDescription: '',
  resume: '',
  language: 'en',
  systemAudio: DEFAULT_SYSTEM_AUDIO,
  // Dark by default — matches the stealth aesthetic and most users' OS
  // preference. The renderer applies whichever value is in localStorage
  // before React renders to avoid a flash; settings.json is the durable
  // record across machines and reinstalls.
  theme: 'dark',
  // Informal default — natural spoken prose. Matches the WinForms build
  // and is the right choice for the majority of behavioural / experience
  // questions where the candidate reads the answer aloud.
  answerStyle: 'informal',
  // Tight enough to read aloud live by default; 'detailed' restores the long
  // essay-length answers for prep / second-monitor use.
  answerLength: 'standard',
  pinShortcut: DEFAULT_PIN_SHORTCUT,
  privacyShortcut: DEFAULT_PRIVACY_SHORTCUT,
  hideShortcut: DEFAULT_HIDE_SHORTCUT,
  codingCaptureShortcut: DEFAULT_CODING_CAPTURE_SHORTCUT,
  // Compact overlay by default; per-mode geometry remembered in windowBounds.
  layoutMode: 'compact',
  windowBounds: {},
  // Coding-mode defaults: Python is the most common interview language;
  // fast (minimal reasoning) keeps the common case snappy; solve (not review)
  // is the default task.
  codingLanguage: 'python',
  codingEffort: 'fast',
  codingTaskType: 'solve',
};

let cache: Settings | null = null;

export async function load(): Promise<Settings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    cache = { ...DEFAULTS, ...parsed };
    // Defensive: clamp language to a known value. An old settings file
    // from before pt-BR existed will still have 'en' or 'es' and pass
    // through unchanged; anything else (corruption, future code rolled
    // back) gets reset to English.
    if (!LANGUAGES.includes(cache.language)) cache.language = 'en';
    // Same for theme — unknown values fall back to dark.
    if (cache.theme !== 'dark' && cache.theme !== 'light') cache.theme = 'dark';
    // Same for answerStyle — unknown / missing falls back to informal so
    // old settings files don't crash on read.
    if (cache.answerStyle !== 'informal' && cache.answerStyle !== 'formal') {
      cache.answerStyle = 'informal';
    }
    if (cache.answerLength !== 'brief' && cache.answerLength !== 'standard' && cache.answerLength !== 'detailed') {
      cache.answerLength = 'standard';
    }
    // layoutMode + windowBounds defensive normalisation.
    if (cache.layoutMode !== 'compact' && cache.layoutMode !== 'full') {
      cache.layoutMode = 'compact';
    }
    if (typeof cache.windowBounds !== 'object' || cache.windowBounds === null) {
      cache.windowBounds = {};
    }
    // Coding prefs defensive normalisation.
    if (!CODING_LANGUAGES.includes(cache.codingLanguage)) cache.codingLanguage = 'python';
    if (cache.codingEffort !== 'fast' && cache.codingEffort !== 'careful') cache.codingEffort = 'fast';
    if (cache.codingTaskType !== 'solve' && cache.codingTaskType !== 'review') cache.codingTaskType = 'solve';
    // Defensive: an old settings file might be missing systemAudio entirely
    // or have an unrecognised kind. Fall back to the platform default rather
    // than letting the renderer crash on `.kind` deref.
    const kind = cache.systemAudio?.kind;
    if (kind !== 'desktop' && kind !== 'device' && kind !== 'off') {
      cache.systemAudio = DEFAULT_SYSTEM_AUDIO;
    }
    // Defensive: shortcuts must be non-empty strings. An empty value would
    // make globalShortcut.register throw; an absent value would crash on
    // the renderer-side `value=...` of a controlled input.
    if (typeof cache.pinShortcut !== 'string' || !cache.pinShortcut.trim()) {
      cache.pinShortcut = DEFAULT_PIN_SHORTCUT;
    }
    if (typeof cache.privacyShortcut !== 'string' || !cache.privacyShortcut.trim()) {
      cache.privacyShortcut = DEFAULT_PRIVACY_SHORTCUT;
    }
    if (typeof cache.hideShortcut !== 'string' || !cache.hideShortcut.trim()) {
      cache.hideShortcut = DEFAULT_HIDE_SHORTCUT;
    }
    if (typeof cache.codingCaptureShortcut !== 'string' || !cache.codingCaptureShortcut.trim()) {
      cache.codingCaptureShortcut = DEFAULT_CODING_CAPTURE_SHORTCUT;
    }
    return cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('settings', `load error: ${(err as Error).message}`);
    }
    cache = { ...DEFAULTS };
    return cache;
  }
}

/**
 * Synchronous accessor for the already-loaded settings. Returns DEFAULTS if
 * load() hasn't run yet. For hot paths (e.g. debounced window-bounds save)
 * that can't await — callers must have triggered load() earlier in startup,
 * which createMainWindow does.
 */
export function cached(): Settings {
  return cache ?? { ...DEFAULTS };
}

export async function save(partial: Partial<Settings>): Promise<Settings> {
  const current = await load();
  cache = { ...current, ...partial };
  try {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    log('settings', `save error: ${(err as Error).message}`);
  }
  return cache;
}
