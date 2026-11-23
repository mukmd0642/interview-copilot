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

/**
 * Interview-view layout:
 *   'compact' — single-column overlay: thin interviewer strip, big answer,
 *     collapsible YOU/notes. Small footprint, corner-friendly, for live use.
 *   'full'    — rebalanced multi-panel: narrow left column (THEM/YOU/KEY
 *     stacked) + dominant answer. For a second monitor / prep.
 */
export type LayoutMode = 'compact' | 'full';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Answer style controls how gpt-5 formats suggested answers.
 *
 *   'informal' (default) — flowing spoken-prose, conversational tone with
 *     contractions, bullets only for genuine lists. Matches the WinForms
 *     build and is best for live behavioural / experience / culture
 *     questions the candidate reads aloud.
 *
 *   'formal' — structured, document-style answers. Lead with a one-line
 *     direct answer, then bullets for details / steps / trade-offs /
 *     comparisons. Brief section labels OK ("Background:", "What I did:",
 *     "Result:"). Useful for technical interviews where the candidate
 *     wants to dictate structured points or for take-home / panel rounds.
 *
 * Both styles still write speakable sentences — even formal answers get
 * read aloud, just in a more structured way.
 */
export type AnswerStyle = 'informal' | 'formal';

/**
 * How long suggested answers should be. The candidate reads these ALOUD in
 * real time, so the default is tight enough to deliver naturally:
 *   'brief'    — punchy, ~1 paragraph (read in ~30-45s).
 *   'standard' — substantive but readable (~60-90s). The default.
 *   'detailed' — full essay-length answers (~2-3 min) for prep / 2nd-monitor.
 */
export type AnswerLength = 'brief' | 'standard' | 'detailed';

export interface Settings extends InterviewContext {
  language: Language;
  systemAudio: SystemAudioMode;
  theme: Theme;
  answerStyle: AnswerStyle;
  answerLength: AnswerLength;
  // Interview-view layout mode + remembered window geometry PER mode (each
  // mode remembers its own size/position, so toggling compact↔full restores
  // what you last had for that mode rather than cramming one into the
  // other's dimensions).
  layoutMode: LayoutMode;
  windowBounds: { compact?: WindowBounds; full?: WindowBounds };
  // Coding mode preferences (persisted so the picker + speed choice stick).
  codingLanguage: CodingLanguage;
  codingEffort: CodingEffort;
  codingTaskType: CodingTaskType;
  // Electron accelerator strings (e.g. "CommandOrControl+\\"). Defaults
  // chosen to match the original Cluely-style binding so existing users
  // don't have to reconfigure; expose them in Setup so users on layouts
  // that lack backslash (AZERTY, JIS, some Nordic) can pick something
  // they can actually type.
  pinShortcut: string;
  privacyShortcut: string;
  // Toggles full window hide. Hidden = not in taskbar/Alt+Tab/screen at
  // all; pressing the chord again restores the window on top of other
  // windows and focuses it. Default uses a letter (not \\) so it works
  // on every keyboard layout out of the box.
  hideShortcut: string;
  // Coding mode capture/solve. Global so it fires while focus is in the
  // editor/CoderPad: starts a solve (or re-captures mid-session).
  codingCaptureShortcut: string;
}

// Defaults are duplicated in src/main/settings.ts (authoritative load path)
// and used by the renderer to seed the SetupDialog before settings.get()
// resolves. Keep these in sync if the literal strings ever change.
export const DEFAULT_PIN_SHORTCUT = 'CommandOrControl+\\';
export const DEFAULT_PRIVACY_SHORTCUT = 'CommandOrControl+Shift+\\';
export const DEFAULT_HIDE_SHORTCUT = 'CommandOrControl+Shift+H';
export const DEFAULT_CODING_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+Space';

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

// ── Coding (agentic) mode ───────────────────────────────────────────────────
//
// A multi-capture agent for live coding interviews. The candidate sets a
// goal (typed or spoken), the agent looks at screenshots, and — crucially —
// when it needs more it ASKS THE CANDIDATE to navigate (scroll / open a
// file) rather than driving the editor itself, because the editor is the
// thing being screen-shared and autonomous cursor movement would be visible
// to the interviewer. The candidate is the hands; the agent is the brain.

export type CodingEffort = 'fast' | 'careful';

/**
 * What the agent is being asked to do:
 *   'solve'  — produce a solution to a coding task (the default).
 *   'review' — review existing code: surface findings (bugs, smells, risks,
 *              praise) + questions to raise. Common in technical interviews,
 *              and for collaboratively reviewing what was just built after a
 *              live-coding round.
 */
export type CodingTaskType = 'solve' | 'review';

export const CODING_LANGUAGES = [
  'python', 'javascript', 'typescript', 'java', 'cpp', 'c', 'csharp', 'go',
  'rust', 'kotlin', 'swift', 'ruby', 'php', 'scala', 'elixir', 'erlang',
  'dart', 'r', 'sql', 'bash', 'perl', 'lua', 'haskell',
] as const;
export type CodingLanguage = (typeof CODING_LANGUAGES)[number];

/**
 * One minimal, self-contained edit in a modification task. The candidate
 * applies these in order and reads the explanation aloud.
 */
export interface CodeEditStep {
  file: string;          // which file, e.g. "src/App.tsx"
  instruction: string;   // short imperative — what to change
  explanation: string;   // one sentence the candidate can say aloud
  // The edit itself, shown as an inline diff with line numbers so the
  // candidate knows exactly which lines to remove (oldCode) and add (code),
  // anchored at startLine (the line number visible in the editor gutter).
  code?: string;         // the NEW lines after this edit (added/replacement)
  oldCode?: string;      // the CURRENT lines being replaced (empty for a pure insertion)
  startLine?: number;    // 1-based line in the file where this edit begins
}

/** The final artefact the agent produces. */
export interface CodeSolution {
  approach: string;       // one-line description of the approach
  language: CodingLanguage;
  code: string;           // the solution, ready to type/paste (the "after")
  complexity: string;     // e.g. "Time O(n), Space O(1)"
  notes: string;          // edge cases / things to say aloud
  // Modification tasks (editing code already on the candidate's screen): the
  // agent sets isModification and returns originalCode (the current code of
  // the SAME region as `code`, transcribed from the screenshots) so the UI
  // can render a before/after diff, plus `steps` — the ordered MINIMAL edits
  // with per-step explanations (the primary view). Absent for fresh solutions.
  isModification?: boolean;
  originalCode?: string;
  steps?: CodeEditStep[];
}

export type ReviewSeverity = 'high' | 'medium' | 'low' | 'nit' | 'praise';

/** One observation in a code review. */
export interface ReviewFinding {
  location: string;          // "App.tsx:42", "useAuth hook", "the retry loop"
  severity: ReviewSeverity;
  issue: string;             // what's wrong / the observation
  suggestion: string;        // how to fix or improve (empty for pure praise)
}

/** The artefact a 'review' task produces (instead of a CodeSolution). */
export interface CodeReview {
  summary: string;           // 1-2 sentence overall assessment
  findings: ReviewFinding[]; // ordered most-important-first
  questions: string[];       // smart questions to raise with the interviewer
}

/**
 * One entry in the agent's running timeline. The renderer renders these as
 * a step list so the candidate can follow what the agent is doing and,
 * when needed, see exactly what to do next.
 */
export type CodingStep =
  // The agent took (or the candidate triggered) a screen capture.
  | { kind: 'capture'; n: number }
  // Agent is calling the model / reasoning.
  | { kind: 'thinking' }
  // Agent needs the candidate to navigate, then re-capture. This is the
  // load-bearing one — the instruction the candidate acts on.
  | { kind: 'instruction'; text: string }
  // Agent needs a clarification answered (typed or spoken).
  | { kind: 'question'; text: string }
  // The on-screen language/framework differs from the candidate's picked
  // default; the agent proposes switching before it solves. The candidate
  // confirms with one tap (or the solve hotkey) and the solve continues in
  // the chosen language.
  | { kind: 'suggest_language'; language: CodingLanguage; reason: string }
  // Agent produced the final solution.
  | { kind: 'solution'; solution: CodeSolution }
  // Agent produced a code review (task type 'review').
  | { kind: 'review'; review: CodeReview }
  // The interviewer asked a spoken question mid-session; this is the concise
  // answer for the candidate to read aloud. Shown as a dismissible banner,
  // independent of the solve/review phase.
  | { kind: 'answer'; question: string; answer: string }
  // Result of verifying that the candidate correctly applied a guided step
  // (guided-apply mode). ok=true → advance; false → message says what to fix.
  | { kind: 'verify'; index: number; ok: boolean; message: string }
  // Something went wrong; session is over.
  | { kind: 'error'; message: string }
  // Agent finished (after a solution, or because the candidate stopped).
  | { kind: 'done' };

export interface CodingStartRequest {
  goal: string;            // what the candidate wants ("solve this", "fix the bug in retry()")
  language: CodingLanguage;
  effort: CodingEffort;
  taskType: CodingTaskType; // solve a problem, or review existing code
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
    // payload: LayoutMode. Main switches mode, resizes the window to that
    // mode's remembered bounds (or a sensible default), and persists.
    SetLayout: 'window:setLayout',
    // payload: { pin: string; privacy: string }
    // Re-registers the two global hotkeys. Returns { ok, pinOk, privacyOk }
    // so the renderer can show per-binding feedback when one collides with
    // a system shortcut and Electron rejects it.
    SetShortcuts: 'window:setShortcuts',
  },
  Transcript: {
    Start: 'transcript:start', // payload: { language }
    Stop: 'transcript:stop',
    SendAudio: 'transcript:audio', // payload: { source, pcm24: ArrayBuffer, pcm16: ArrayBuffer }
  },
  Engine: {
    SetContext: 'engine:setContext', // payload: InterviewContext
    SetLanguage: 'engine:setLanguage', // payload: Language
    SetStyle: 'engine:setStyle',     // payload: AnswerStyle
    SetLength: 'engine:setLength',   // payload: AnswerLength
    ToggleAnswers: 'engine:toggleAnswers', // payload: boolean
  },
  Coding: {
    // Start/stop listening to the interviewer (system audio) for coding
    // context. Begins when the candidate enters Code mode, independent of
    // any solve. payload: { language } / none.
    StartListening: 'coding:startListening',
    StopListening: 'coding:stopListening',
    // Begin an agent session: capture the first screenshot and start the
    // tool-calling loop. payload: CodingStartRequest. Returns { ok }.
    Start: 'coding:start',
    // Candidate navigated as instructed and wants a fresh capture fed into
    // the loop. No payload (capture happens main-side via desktopCapturer).
    Capture: 'coding:capture',
    // Candidate answered an ask_user question. payload: { text: string }
    Answer: 'coding:answer',
    // Force a solution now from what's been captured. No payload.
    SolveNow: 'coding:solveNow',
    // Respond to a suggest_language proposal. payload: { accept, language }.
    // accept=true switches the agent to `language` and continues the solve;
    // accept=false keeps the candidate's original pick.
    ResolveLanguage: 'coding:resolveLanguage',
    // Guided-apply: candidate applied a step; capture + verify it against the
    // expected change. payload: { index, total, file, instruction, code }.
    // Replies via a CodingStep of kind 'verify'.
    VerifyStep: 'coding:verifyStep',
    // Abort the current session. No payload.
    Cancel: 'coding:cancel',
    // One-shot transcription of a recorded goal (push-to-talk voice goal).
    // payload: { wavBase64: string }  Returns { text } or { error }.
    TranscribeGoal: 'coding:transcribeGoal',
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

  // Main → Renderer (send), continued
  // ──────────────────────────────────────────────────────────────────────
  // Webview shortcut dispatch
  //
  // When a <webview> has focus, keystrokes happen inside that webview's
  // renderer process and our window-level keydown listener never sees
  // them. Main process intercepts via `before-input-event`, matches the
  // input to one of our app actions, and pushes the action name to the
  // renderer over this channel. The renderer dispatches it the same way
  // it would for a native keydown.
  // ──────────────────────────────────────────────────────────────────────

  /** Action names produced by either renderer keydown or webview-shortcut. */
  // (declared as union below — placed here so the IPC table stays compact)

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
    // Webview-focused keystrokes that main intercepted and matched to an
    // app action. Payload: AppAction.
    WebviewShortcut: 'event:webviewShortcut',
    // Agentic coding mode — one event per timeline step. Payload: CodingStep.
    CodingStep: 'event:codingStep',
    // Fired when the global capture hotkey is pressed, so the renderer can
    // route it to either "start" or "next capture" depending on session
    // state. No payload.
    CodingCaptureHotkey: 'event:codingCaptureHotkey',
  },
} as const;

/**
 * Browser-style actions that fire from either renderer keydown (when the
 * top-level page has focus) or from webview interception (when focus is
 * inside an embedded <webview>). Keeping action names as strings — not as
 * a typed enum sent over IPC — means we don't need to share runtime enum
 * values across the process boundary; just the string union.
 */
export type AppAction =
  | 'new-tab'
  | 'close-tab'
  | 'toggle-history'
  | 'cycle-tab'
  | 'toggle-browser'
  | 'go-back'
  | 'go-forward';
