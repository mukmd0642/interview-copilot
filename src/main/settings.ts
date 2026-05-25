import { app } from 'electron';
import { promises as fs } from 'fs';
import path from 'path';
import type { Settings } from '../shared/ipc.js';
import { log } from './log.js';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS: Settings = {
  jobDescription: '',
  resume: '',
  language: 'en',
};

let cache: Settings | null = null;

export async function load(): Promise<Settings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    cache = { ...DEFAULTS, ...parsed };
    // Defensive: clamp language to known values.
    if (cache.language !== 'en' && cache.language !== 'es') cache.language = 'en';
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
