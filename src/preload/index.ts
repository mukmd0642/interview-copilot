import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC,
  type LoginRequest,
  type LoginResult,
  type LoginError,
  type Settings,
  type Source,
  type TranscriptEvent,
  type AnswerChunk,
  type CaptionStatus,
  type InterviewContext,
  type Language,
  type AnswerStyle,
  type AnswerLength,
  type AppAction,
  type LayoutMode,
  type CodingStartRequest,
  type CodingStep,
  type CodingLanguage,
} from '../shared/ipc.js';

// Single typed surface exposed on window.api. Renderer code never touches
// raw ipcRenderer — that's deliberate, so the security boundary is one file
// instead of "anywhere a developer types ipcRenderer".

const api = {
  auth: {
    login: (req: LoginRequest): Promise<LoginResult | LoginError> =>
      ipcRenderer.invoke(IPC.Auth.Login, req),
    logout: (): Promise<{ ok: true }> => ipcRenderer.invoke(IPC.Auth.Logout),
    status: (): Promise<{ authenticated: boolean; email: string | null }> =>
      ipcRenderer.invoke(IPC.Auth.Status),
  },

  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.Settings.Get),
    set: (partial: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IPC.Settings.Set, partial),
  },

  window: {
    setPrivacy: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.Window.SetPrivacy, enabled),
    setTopMost: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.Window.SetTopMost, enabled),
    setOpacity: (value: number): Promise<number> =>
      ipcRenderer.invoke(IPC.Window.SetOpacity, value),
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.Window.Minimize),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.Window.Close),
    setShortcuts: (
      pin: string,
      privacy: string,
      hide: string,
      coding: string
    ): Promise<{ pinOk: boolean; privacyOk: boolean; hideOk: boolean; codingOk: boolean }> =>
      ipcRenderer.invoke(IPC.Window.SetShortcuts, { pin, privacy, hide, coding }),
    setLayout: (mode: LayoutMode): Promise<LayoutMode> =>
      ipcRenderer.invoke(IPC.Window.SetLayout, mode),
  },

  transcript: {
    start: (language: Language): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.Transcript.Start, { language }),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.Transcript.Stop),
    // Audio frames go via .send (one-way) — they're high-frequency and we
    // don't want to await each one. Buffers are transferred as ArrayBuffer.
    sendAudio: (source: Source, pcm24: ArrayBuffer, pcm16: ArrayBuffer): void => {
      ipcRenderer.send(IPC.Transcript.SendAudio, { source, pcm24, pcm16 });
    },
  },

  engine: {
    setContext: (ctx: InterviewContext): Promise<void> =>
      ipcRenderer.invoke(IPC.Engine.SetContext, ctx),
    setLanguage: (language: Language): Promise<void> =>
      ipcRenderer.invoke(IPC.Engine.SetLanguage, language),
    setStyle: (style: AnswerStyle): Promise<void> =>
      ipcRenderer.invoke(IPC.Engine.SetStyle, style),
    setLength: (length: AnswerLength): Promise<void> =>
      ipcRenderer.invoke(IPC.Engine.SetLength, length),
    toggleAnswers: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.Engine.ToggleAnswers, enabled),
  },

  coding: {
    startListening: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.Coding.StartListening),
    stopListening: (): Promise<void> => ipcRenderer.invoke(IPC.Coding.StopListening),
    start: (req: CodingStartRequest): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.Coding.Start, req),
    capture: (): Promise<void> => ipcRenderer.invoke(IPC.Coding.Capture),
    answer: (text: string): Promise<void> => ipcRenderer.invoke(IPC.Coding.Answer, { text }),
    solveNow: (): Promise<void> => ipcRenderer.invoke(IPC.Coding.SolveNow),
    resolveLanguage: (accept: boolean, language: CodingLanguage): Promise<void> =>
      ipcRenderer.invoke(IPC.Coding.ResolveLanguage, { accept, language }),
    verifyStep: (p: { index: number; total: number; file: string; instruction: string; code: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.Coding.VerifyStep, p),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.Coding.Cancel),
    transcribeGoal: (wavBase64: string): Promise<{ text: string } | { error: string }> =>
      ipcRenderer.invoke(IPC.Coding.TranscribeGoal, { wavBase64 }),
    onStep: (cb: (step: CodingStep) => void): (() => void) =>
      subscribe(IPC.Events.CodingStep, cb),
    onCaptureHotkey: (cb: () => void): (() => void) =>
      subscribe(IPC.Events.CodingCaptureHotkey, cb),
  },

  // ── Subscriptions. Each returns an unsubscribe function so React useEffect
  //    can return it directly for clean teardown. ────────────────────────────
  onTranscript: (cb: (evt: TranscriptEvent) => void): (() => void) =>
    subscribe(IPC.Events.Transcript, cb),

  onAnswer: (cb: (chunk: AnswerChunk) => void): (() => void) =>
    subscribe(IPC.Events.Answer, cb),

  onSummary: (cb: (text: string) => void): (() => void) =>
    subscribe(IPC.Events.Summary, cb),

  onStatus: (cb: (status: CaptionStatus) => void): (() => void) =>
    subscribe(IPC.Events.Status, cb),

  onMicSilence: (cb: () => void): (() => void) => subscribe(IPC.Events.SilenceMic, cb),

  // State changes that originate outside the renderer (global hotkeys etc.)
  onTopMost: (cb: (enabled: boolean) => void): (() => void) =>
    subscribe(IPC.Events.TopMost, cb),
  onPrivacy: (cb: (enabled: boolean) => void): (() => void) =>
    subscribe(IPC.Events.Privacy, cb),

  // Browser-style shortcut intercepted by main from inside a <webview>.
  // Renderer dispatches it the same way it would for an in-document keydown.
  onWebviewShortcut: (cb: (action: AppAction) => void): (() => void) =>
    subscribe(IPC.Events.WebviewShortcut, cb),

  /**
   * Diagnostic log from the renderer. Goes straight to %APPDATA%/.../app.log
   * via the main process. Use for catching errors that would otherwise
   * disappear into the DevTools console.
   */
  log: (category: string, message: string): void => {
    ipcRenderer.send(IPC.Diag.Log, { category, message });
  },
};

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
