import { ipcMain } from 'electron';
import { IPC, type LoginRequest, type Settings } from '../shared/ipc.js';
import * as auth from './auth.js';
import * as settings from './settings.js';
import * as win from './window.js';
import { log } from './log.js';

export function registerIpc(): void {
  // ── Auth ────────────────────────────────────────────────────────────────
  ipcMain.handle(IPC.Auth.Login, async (_, req: LoginRequest) => {
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
  ipcMain.handle(IPC.Settings.Get, async () => {
    return settings.load();
  });

  ipcMain.handle(IPC.Settings.Set, async (_, partial: Partial<Settings>) => {
    return settings.save(partial);
  });

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

  // ── Transcript / Engine: registered as stubs for now; real implementation
  //    in the next turn (RealtimeTranscriptionClient + InterviewEngine ports).
  ipcMain.handle(IPC.Transcript.Start, async () => {
    log('ipc', 'Transcript.Start (stub — engine port not yet wired)');
    return { ok: false, message: 'Transcription pipeline not yet implemented' };
  });
  ipcMain.handle(IPC.Transcript.Stop, async () => {
    log('ipc', 'Transcript.Stop (stub)');
  });
  ipcMain.on(IPC.Transcript.SendAudio, () => {
    /* stub */
  });
  ipcMain.handle(IPC.Engine.SetContext, async () => {
    /* stub */
  });
  ipcMain.handle(IPC.Engine.SetLanguage, async () => {
    /* stub */
  });
  ipcMain.handle(IPC.Engine.ToggleAnswers, async () => {
    /* stub */
  });

  log('ipc', 'IPC handlers registered');
}
