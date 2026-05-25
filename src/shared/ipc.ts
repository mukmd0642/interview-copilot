// Single source of truth for IPC channel names and payload shapes.
// Both main and renderer import from here so a typo can't drift the two ends.

export type Source = 'mic' | 'system';
export type Language = 'en' | 'es';

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

export interface Settings extends InterviewContext {
  language: Language;
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

  // Main → Renderer (send)
  Events: {
    Transcript: 'event:transcript', // payload: TranscriptEvent
    Answer: 'event:answer',         // payload: AnswerChunk
    Summary: 'event:summary',       // payload: string
    Status: 'event:status',         // payload: CaptionStatus
    SilenceMic: 'event:silenceMic',
  },
} as const;
