// Reject transcripts that contain characters from non-Latin writing systems.
//
// All our supported languages (en / es / pt-BR) use the Latin alphabet plus
// some diacritics. Whisper / gpt-4o-transcribe occasionally hallucinate
// non-Latin output on low-signal audio (we saw Korean Hangul appear during
// the first real test session). Dropping those at the boundary is cheaper
// and more reliable than trying to coax the model into staying in-language.
//
// We block specific Unicode blocks that we know we don't want, rather than
// allow-listing Latin — that way a stray "€" or curly quote doesn't
// trip the filter.

const FORBIDDEN_SCRIPT_RANGES: Array<[number, number]> = [
  // CJK
  [0x3040, 0x309F], // Hiragana
  [0x30A0, 0x30FF], // Katakana
  [0x3100, 0x312F], // Bopomofo
  [0x3130, 0x318F], // Hangul Compatibility Jamo
  [0x3400, 0x4DBF], // CJK Unified Ideographs Extension A
  [0x4E00, 0x9FFF], // CJK Unified Ideographs
  [0xAC00, 0xD7AF], // Hangul Syllables
  [0xF900, 0xFAFF], // CJK Compatibility Ideographs
  [0xFF66, 0xFF9F], // Halfwidth Katakana
  // Other non-Latin scripts that would clearly indicate hallucination for
  // an EN/ES/PT interview:
  [0x0400, 0x04FF], // Cyrillic
  [0x0500, 0x052F], // Cyrillic Supplement
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF], // Arabic
  [0x0700, 0x074F], // Syriac
  [0x0900, 0x097F], // Devanagari
  [0x0980, 0x09FF], // Bengali
  [0x0E00, 0x0E7F], // Thai
  [0x1000, 0x109F], // Myanmar
];

function isForbidden(code: number): boolean {
  for (const [lo, hi] of FORBIDDEN_SCRIPT_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/**
 * Returns true if the text contains ANY character from a non-Latin script
 * we don't support. A single such character is enough — the targeted
 * Latin languages (en, es, pt-BR) never legitimately need a CJK / Cyrillic /
 * Arabic / etc. character in transcribed speech.
 */
export function containsForbiddenScript(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Skip the ASCII low-bytes fast path — by far the most common case.
    if (code < 0x300) continue;
    if (isForbidden(code)) return true;
  }
  return false;
}
