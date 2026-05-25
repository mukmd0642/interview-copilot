import { ipcMain, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import {
  IPC,
  type LoginRequest,
  type Settings,
  type Source,
  type Language,
  type InterviewContext,
} from '../shared/ipc.js';
import * as auth from './auth.js';
import * as settings from './settings.js';
import * as win from './window.js';
import { transcriptionController } from './transcription-controller.js';
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

  ipcMain.handle(IPC.Engine.ToggleAnswers, async (_, enabled: boolean) => {
    transcriptionController.toggleAnswers(enabled);
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
