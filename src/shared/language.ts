// Language metadata — kept in one place so adding a 4th option (e.g. fr)
// later only touches this file plus the LANGUAGES array in ipc.ts.

import type { Language } from './ipc.js';

interface LangInfo {
  /** What we send to the OpenAI realtime API as the `language` hint. */
  apiCode: string;
  /** Short label for toolbar buttons (3 chars max). */
  shortLabel: string;
  /** Full name we use inside the LLM system prompts. */
  promptName: string;
}

const TABLE: Record<Language, LangInfo> = {
  'en':    { apiCode: 'en', shortLabel: 'EN',  promptName: 'English' },
  'es':    { apiCode: 'es', shortLabel: 'ES',  promptName: 'Spanish' },
  // OpenAI's transcription endpoint takes ISO-639-1 — there's no separate
  // pt-BR vs pt-PT hint. Send the generic 'pt' and rely on the prompt name
  // ("Brazilian Portuguese") to bias gpt-5 toward the right dialect for
  // answer generation.
  'pt-BR': { apiCode: 'pt', shortLabel: 'PT',  promptName: 'Brazilian Portuguese' },
};

export function apiLanguageCode(lang: Language): string {
  return TABLE[lang].apiCode;
}

export function languageShortLabel(lang: Language): string {
  return TABLE[lang].shortLabel;
}

export function languagePromptName(lang: Language): string {
  return TABLE[lang].promptName;
}

/** Next language in the toolbar cycle: en → es → pt-BR → en. */
export function nextLanguage(current: Language): Language {
  switch (current) {
    case 'en':    return 'es';
    case 'es':    return 'pt-BR';
    case 'pt-BR': return 'en';
  }
}
