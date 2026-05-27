import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import { LANGUAGES, type Settings } from '../shared/ipc.js';
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
    // Defensive: an old settings file might be missing systemAudio entirely
    // or have an unrecognised kind. Fall back to the platform default rather
    // than letting the renderer crash on `.kind` deref.
    const kind = cache.systemAudio?.kind;
    if (kind !== 'desktop' && kind !== 'device' && kind !== 'off') {
      cache.systemAudio = DEFAULT_SYSTEM_AUDIO;
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
