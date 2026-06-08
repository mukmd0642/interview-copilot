import { ipcMain, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import {
  IPC,
  type LoginRequest,
  type Settings,
  type Source,
  type Language,
  type AnswerStyle,
  type AnswerLength,
  type LayoutMode,
  type InterviewContext,
  type CodingStartRequest,
  type CodingLanguage,
} from '../shared/ipc.js';
import * as auth from './auth.js';
import * as settings from './settings.js';
import * as win from './window.js';
import { registerGlobalShortcuts } from './shortcuts.js';
import { transcriptionController } from './transcription-controller.js';
import { codingController } from './coding-controller.js';
import { log } from './log.js';

export function registerIpc(): void {
  // ── Auth ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.Auth.Login, async (_: IpcMainInvokeEvent, req: LoginRequest) => {
    return auth.login(req);
  });
  ipcMain.handle(IPC.Auth.Logout, async () => {
    auth.clearSession();
    return { ok: true };
  });
  ipcMain.handle(IPC.Auth.Status, async () => {
    const s = auth.currentSession();
    return { authenticated: s != null, email: s?.email ?? null };
  });

  // ── Settings ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.Settings.Get, async () => settings.load());
  ipcMain.handle(IPC.Settings.Set, async (_, partial: Partial<Settings>) =>
    settings.save(partial)
  );

  // ── Window controls ─────────────────────────────────────────────────────
  ipcMain.handle(IPC.Window.SetPrivacy, async (_, enabled: boolean) => win.setPrivacy(enabled));
  ipcMain.handle(IPC.Window.SetTopMost, async (_, enabled: boolean) => win.setTopMost(enabled));
  ipcMain.handle(IPC.Window.SetOpacity, async (_, value: number) => win.setOpacity(value));
  ipcMain.handle(IPC.Window.Minimize, async () => {
    win.getMainWindow()?.minimize();
  });
  ipcMain.handle(IPC.Window.Close, async () => {
    win.getMainWindow()?.close();
  });
  ipcMain.handle(IPC.Window.SetLayout, async (_, mode: LayoutMode) => win.setLayout(mode));
  // Re-register global hotkeys with user-supplied accelerators and persist
  // them so they survive a restart. Returns per-binding ok flags so the
  // renderer can surface "Ctrl+T is already taken by something else"
  // without us having to invent a new error channel.
  ipcMain.handle(
    IPC.Window.SetShortcuts,
    async (_, payload: { pin: string; privacy: string; hide: string; coding: string }) => {
      const result = registerGlobalShortcuts(payload.pin, payload.privacy, payload.hide, payload.coding);
      await settings.save({
        pinShortcut: payload.pin,
        privacyShortcut: payload.privacy,
        hideShortcut: payload.hide,
        codingCaptureShortcut: payload.coding,
      });
      return result;
    }
  );

  // ── Transcript / Engine ─────────────────────────────────────────────────
  ipcMain.handle(IPC.Transcript.Start, async (_, { language }: { language: Language }) => {
    const mainWin = win.getMainWindow();
    if (mainWin) transcriptionController.attachWindow(mainWin);
    return transcriptionController.start(language);
  });

  ipcMain.handle(IPC.Transcript.Stop, async () => {
    await transcriptionController.stop();
  });

  // Audio frames come via .send (one-way, fire-and-forget). The 'on' channel
  // is intentionally not `handle` — we don't want the renderer to await each
  // 20-ms chunk; that would round-trip back-pressure on every frame.
  ipcMain.on(
    IPC.Transcript.SendAudio,
    (_: IpcMainEvent, payload: { source: Source; pcm24: ArrayBuffer; pcm16: ArrayBuffer }) => {
      transcriptionController.pushAudio(payload.source, payload.pcm24);
    }
  );

  ipcMain.handle(IPC.Engine.SetContext, async (_, ctx: InterviewContext) => {
    transcriptionController.setEngineContext(ctx);
    await settings.save({ jobDescription: ctx.jobDescription, resume: ctx.resume });
  });

  ipcMain.handle(IPC.Engine.SetLanguage, async (_, language: Language) => {
    transcriptionController.setEngineLanguage(language);
    await settings.save({ language });
  });

  ipcMain.handle(IPC.Engine.SetStyle, async (_, style: AnswerStyle) => {
    transcriptionController.setAnswerStyle(style);
    await settings.save({ answerStyle: style });
  });

  ipcMain.handle(IPC.Engine.SetLength, async (_, length: AnswerLength) => {
    transcriptionController.setAnswerLength(length);
    await settings.save({ answerLength: length });
  });

  ipcMain.handle(IPC.Engine.ToggleAnswers, async (_, enabled: boolean) => {
    transcriptionController.toggleAnswers(enabled);
  });

  // ── Coding mode (agentic) ─────────────────────────────────────────────────
  ipcMain.handle(IPC.Coding.StartListening, async () => codingController.startListening());
  ipcMain.handle(IPC.Coding.StopListening, async () => { await codingController.stopListening(); });
  ipcMain.handle(IPC.Coding.Start, async (_, req: CodingStartRequest) => {
    const mainWin = win.getMainWindow();
    if (mainWin) codingController.attachWindow(mainWin);
    return codingController.start(req);
  });
  ipcMain.handle(IPC.Coding.Capture, async () => { await codingController.recapture(); });
  ipcMain.handle(IPC.Coding.Answer, async (_, payload: { text: string }) => {
    await codingController.answer(payload?.text ?? '');
  });
  ipcMain.handle(IPC.Coding.SolveNow, async () => { await codingController.solveNow(); });
  ipcMain.handle(
    IPC.Coding.ResolveLanguage,
    async (_, payload: { accept: boolean; language: CodingLanguage }) => {
      await codingController.resolveLanguage(payload?.accept ?? false, payload?.language ?? 'python');
    }
  );
  ipcMain.handle(
    IPC.Coding.VerifyStep,
    async (_, p: { index: number; total: number; file: string; instruction: string; code: string }) => {
      await codingController.verifyStep(p);
    }
  );
  ipcMain.handle(IPC.Coding.Cancel, async () => { codingController.cancel(); });
  ipcMain.handle(IPC.Coding.TranscribeGoal, async (_, payload: { wavBase64: string }) => {
    return transcribeGoal(payload?.wavBase64 ?? '');
  });

  // ── Renderer diagnostics ────────────────────────────────────────────────
  // One-way log channel; messages land in the same app.log alongside the
  // main process's own entries, with the category prefixed "renderer/".
  ipcMain.on(
    IPC.Diag.Log,
    (_: IpcMainEvent, payload: { category: string; message: string }) => {
      if (!payload || typeof payload.category !== 'string' || typeof payload.message !== 'string') return;
      log(`renderer/${payload.category}`, payload.message);
    }
  );

  log('ipc', 'IPC handlers registered');
}

/**
 * One-shot transcription of a recorded goal (push-to-talk voice goal in
 * coding mode). Decoupled from the live realtime pipeline — just a single
 * REST call to gpt-4o-transcribe. Returns { text } or { error }.
 */
async function transcribeGoal(wavBase64: string): Promise<{ text: string } | { error: string }> {
  const key = auth.apiKey();
  if (!key) return { error: 'Not signed in' };
  if (!wavBase64) return { error: 'No audio' };
  try {
    const bytes = Buffer.from(wavBase64, 'base64');
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'goal.wav');
    form.append('model', 'gpt-4o-transcribe');
    form.append('response_format', 'json');
    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { error: `OpenAI ${resp.status}: ${body.slice(0, 200)}` };
    }
    const json = (await resp.json()) as { text?: string };
    return { text: (json.text ?? '').trim() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
