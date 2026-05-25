// Single source of truth for IPC channel names and payload shapes.
// Both main and renderer import from here so a typo can't drift the two ends.

export type Source = 'mic' | 'system';

/**
 * Interview languages we support. All three use the Latin alphabet, which
 * lets us reject non-Latin transcripts as model hallucinations (Whisper /
 * gpt-4o-transcribe occasionally drop into Korean / Chinese / Arabic on
 * low-signal segments). See transcription-controller's script filter.
 *
 * Display labels and the OpenAI API hint code live in src/shared/language.ts.
 */
export type Language = 'en' | 'es' | 'pt-BR';

export const LANGUAGES: Language[] = ['en', 'es', 'pt-BR'];

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResult {
  email: string;
  // NOTE: the API key is intentionally NOT shipped to the renderer.
  // Main process holds it; renderer only learns "logged in: true".
  ok: true;
}

export interface LoginError {
  ok: false;
  code: 'invalid' | 'forbidden' | 'network' | 'timeout' | 'unknown';
  message: string;
}

export interface InterviewContext {
  jobDescription: string;
  resume: string;
}

/**
 * How to capture the "interviewer" audio (the other side of the meeting).
 *
 *   { kind: 'desktop' }       → Chromium's desktopCapturer with
 *                                chromeMediaSource: 'desktop'. Captures the
 *                                full system audio mix. Works on Windows
 *                                out of the box; returns a silent stream
 *                                on macOS (Apple sandboxes system audio).
 *
 *   { kind: 'device', id: ID } → getUserMedia({ deviceId: id }). For Mac
 *                                users this is BlackHole / Loopback —
 *                                the user routes the OS audio output
 *                                through a virtual input device, and we
 *                                capture it like a regular microphone.
 *
 *   { kind: 'off' }            → Don't capture system audio at all. Only
 *                                the candidate's mic is transcribed. Useful
 *                                for solo practice or when the user is
 *                                still setting up BlackHole.
 */
export type SystemAudioMode =
  | { kind: 'desktop' }
  | { kind: 'device'; deviceId: string; label?: string }
  | { kind: 'off' };

export type Theme = 'dark' | 'light';

export interface Settings extends InterviewContext {
  language: Language;
  systemAudio: SystemAudioMode;
  theme: Theme;
}

export interface TranscriptEvent {
  source: Source;
  itemId: string;
  contentIndex: number;
  text: string;
  isFinal: boolean;
  // Whether this came from the fast (whisper) or accurate (gpt-4o) pipeline.
  pipeline: 'fast' | 'accurate';
}

export interface TranscriptEntry {
  source: Source;
  text: string;
  wallTime: number; // ms since epoch
}

export interface AnswerChunk {
  // Empty string + done=false → START (clear answer box).
  // Empty string + done=true  → DONE (success).
  // Non-empty + done=true     → DONE-with-error-message.
  text: string;
  done: boolean;
}

export interface CaptionStatus {
  message: string;
  level: 'info' | 'warn' | 'error';
}

// ── IPC channel names ────────────────────────────────────────────────────────

export const IPC = {
  // Renderer → Main (invoke)
  Auth: {
    Login: 'auth:login',
    Logout: 'auth:logout',
    Status: 'auth:status',
  },
  Settings: {
    Get: 'settings:get',
    Set: 'settings:set',
  },
  Window: {
    SetPrivacy: 'window:setPrivacy', // payload: boolean
    SetTopMost: 'window:setTopMost', // payload: boolean
    SetOpacity: 'window:setOpacity', // payload: number (0..1)
    Minimize: 'window:minimize',
    Close: 'window:close',
  },
  Transcript: {
    Start: 'transcript:start', // payload: { language }
    Stop: 'transcript:stop',
    SendAudio: 'transcript:audio', // payload: { source, pcm24: ArrayBuffer, pcm16: ArrayBuffer }
  },
  Engine: {
    SetContext: 'engine:setContext', // payload: InterviewContext
    SetLanguage: 'engine:setLanguage', // payload: Language
    ToggleAnswers: 'engine:toggleAnswers', // payload: boolean
  },
  Export: {
    SaveTxt: 'export:txt',
    SaveSrt: 'export:srt',
  },

  // Renderer → Main (one-way diagnostic logging — surfaces JS errors into
  // %APPDATA%/interview-copilot/app.log so we don't have to ask the user
  // to open DevTools for every issue).
  Diag: {
    Log: 'diag:log',
  },

  // Main → Renderer (send)
  Events: {
    Transcript: 'event:transcript', // payload: TranscriptEvent
    Answer: 'event:answer',         // payload: AnswerChunk
    Summary: 'event:summary',       // payload: string
    Status: 'event:status',         // payload: CaptionStatus
    SilenceMic: 'event:silenceMic',
    // Fired when window state changes outside the renderer (e.g. global
    // hotkey toggling pin). Renderer uses these to keep toolbar buttons
    // in sync with reality.
    TopMost: 'event:topmost',       // payload: boolean
    Privacy: 'event:privacy',       // payload: boolean
  },
} as const;
