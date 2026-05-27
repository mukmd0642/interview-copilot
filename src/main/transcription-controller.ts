// Orchestrates the four realtime clients + interview engine for one session.
// Lives in the main process; renderer talks to it via IPC.
//
// The dual fast/accurate pipeline is the same idea as the C# build:
//   • Fast (gpt-realtime-whisper, no turn detection) → live caption preview.
//     Deltas update the per-source live text; client-side silence detection
//     synthesises finals.
//   • Accurate (gpt-4o-transcribe, server VAD on) → engine input + canonical
//     transcript. Only IsFinal events matter from this stream.
//
// We do NOT yet port BatchCorrectionClient or the end-of-session full
// re-transcription path; both are quality enhancements rather than core
// behaviour and can land in a follow-up.

import type { BrowserWindow } from 'electron';
import { log, q } from './log.js';
import * as auth from './auth.js';
import * as settings from './settings.js';
import { RealtimeTranscriptionClient } from './openai/realtime-client.js';
import type { RealtimeTranscriptEvent, ModelKind } from './openai/realtime-client.js';
import { InterviewEngine } from './openai/interview-engine.js';
import {
  IPC,
  type Source,
  type Language,
  type AnswerStyle,
  type TranscriptEvent,
  type TranscriptEntry,
  type AnswerChunk,
  type CaptionStatus,
  type InterviewContext,
} from '../shared/ipc.js';
import { containsForbiddenScript } from '../shared/script-filter.js';

interface TranscriptEntryInternal {
  source: Source;
  text: string;
  wallTime: number;
}

class TranscriptionController {
  // Four realtime clients, in the same layout as Form1.cs.
  private micFast: RealtimeTranscriptionClient | null = null;
  private systemFast: RealtimeTranscriptionClient | null = null;
  private micAccurate: RealtimeTranscriptionClient | null = null;
  private systemAccurate: RealtimeTranscriptionClient | null = null;

  private engine: InterviewEngine | null = null;
  private answersEnabled = true;

  private entries: TranscriptEntryInternal[] = [];
  private active = false;
  private language: Language = 'en';
  private window: BrowserWindow | null = null;

  attachWindow(window: BrowserWindow): void {
    this.window = window;
  }

  isActive(): boolean {
    return this.active;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(language: Language): Promise<{ ok: boolean; message?: string }> {
    if (this.active) {
      return { ok: false, message: 'Transcription already running' };
    }
    const apiKey = auth.apiKey();
    if (!apiKey) {
      return { ok: false, message: 'Not signed in' };
    }
    log('controller', 'start');
    this.language = language;
    this.entries = [];

    this.status('Connecting live captions…', 'info');

    // Fast: gpt-realtime-whisper streams deltas in real-time → live caption.
    this.micFast = this.makeClient(apiKey, 'mic-fast', language, 'gpt-realtime-whisper', false);
    this.systemFast = this.makeClient(apiKey, 'system-fast', language, 'gpt-realtime-whisper', false);

    // Accurate: gpt-4o-transcribe with server_vad → engine input.
    this.micAccurate = this.makeClient(apiKey, 'mic-accurate', language, 'gpt-4o-transcribe', true);
    this.systemAccurate = this.makeClient(apiKey, 'system-accurate', language, 'gpt-4o-transcribe', true);

    // Wire transcript events with the right pipeline tag so the renderer
    // can route them correctly without IPC string parsing.
    this.attachFast(this.micFast, 'mic');
    this.attachFast(this.systemFast, 'system');
    this.attachAccurate(this.micAccurate, 'mic');
    this.attachAccurate(this.systemAccurate, 'system');

    // Surface status only from the fast clients to avoid duplicate toasts.
    this.micFast.onStatus = (s) => this.status(s, 'info');
    this.systemFast.onStatus = (s) => this.status(s, 'info');

    // Mic-side silence is the strongest signal that the candidate has
    // finished speaking — useful to the renderer for auto-flushing a
    // pending buffered answer (so the candidate doesn't have to look up
    // and click "Next ▼" while reading the current one aloud).
    // We deliberately don't forward system-side silence: an interviewer
    // pause isn't a candidate cue and would auto-advance answers the
    // candidate hasn't gotten to.
    this.micFast.onSilence = () => this.send(IPC.Events.SilenceMic, undefined);

    await Promise.all([
      this.micFast.connect(),
      this.systemFast.connect(),
      this.micAccurate.connect(),
      this.systemAccurate.connect(),
    ]);

    if (!this.micFast.isConnected && !this.systemFast.isConnected) {
      this.status('Failed to start live captions.', 'error');
      await this.stop();
      return { ok: false, message: 'OpenAI realtime connect failed for both channels' };
    }

    // Engine: only spun up if answers are enabled.
    if (this.answersEnabled) {
      const settingsNow = await settings.load();
      this.engine = new InterviewEngine(apiKey, language, {
        onAnswerChunk: (text, isDone) => this.sendAnswer({ text, done: isDone }),
        onSummary: (text) => this.sendSummary(text),
      });
      this.engine.setContext(settingsNow.jobDescription, settingsNow.resume);
      this.engine.setAnswerStyle(settingsNow.answerStyle);
    }

    this.active = true;
    this.status(
      this.answersEnabled
        ? 'Listening  ·  Live captions + answer suggestions'
        : 'Listening  ·  Live captions only',
      'info'
    );
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (!this.active && !this.micFast && !this.systemFast) return;
    log('controller', 'stop');
    this.active = false;

    this.engine?.dispose();
    this.engine = null;

    const tasks = [
      this.micFast?.disconnect(),
      this.systemFast?.disconnect(),
      this.micAccurate?.disconnect(),
      this.systemAccurate?.disconnect(),
    ].filter(Boolean) as Array<Promise<void>>;

    this.micFast = null;
    this.systemFast = null;
    this.micAccurate = null;
    this.systemAccurate = null;

    await Promise.allSettled(tasks);
    this.status('Stopped.', 'info');
  }

  // ── Audio ingestion ────────────────────────────────────────────────────
  //
  // Audio arrives from the renderer's audio worklet as PCM16 @ 24 kHz.
  // We forward to both fast and accurate clients for the matching source.
  // The realtime API accepts ~20-50 ms frames cleanly; backpressure is
  // handled by the ws library's internal queue.

  pushAudio(source: Source, pcm24: ArrayBuffer): void {
    if (!this.active) return;
    if (source === 'mic') {
      this.micFast?.sendAudio(pcm24);
      this.micAccurate?.sendAudio(pcm24);
    } else {
      this.systemFast?.sendAudio(pcm24);
      this.systemAccurate?.sendAudio(pcm24);
    }
  }

  // ── Engine controls ────────────────────────────────────────────────────

  setEngineContext(ctx: InterviewContext): void {
    this.engine?.setContext(ctx.jobDescription, ctx.resume);
  }

  setEngineLanguage(language: Language): void {
    this.language = language;
    this.engine?.setLanguage(language);
  }

  setAnswerStyle(style: AnswerStyle): void {
    this.engine?.setAnswerStyle(style);
  }

  toggleAnswers(enabled: boolean): void {
    this.answersEnabled = enabled;
    this.engine?.setAnswersEnabled(enabled);
  }

  getTranscriptEntries(): TranscriptEntry[] {
    return this.entries.map((e) => ({ source: e.source, text: e.text, wallTime: e.wallTime }));
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private makeClient(
    apiKey: string,
    sourceLabel: string,
    language: Language,
    model: ModelKind,
    enableTurnDetection: boolean
  ): RealtimeTranscriptionClient {
    return new RealtimeTranscriptionClient({
      apiKey,
      source: sourceLabel,
      language,
      model,
      enableTurnDetection,
    });
  }

  private attachFast(client: RealtimeTranscriptionClient, source: Source): void {
    client.onTranscript = (evt) => {
      // Drop transcripts containing non-Latin scripts. en/es/pt-BR all use
      // Latin, so a single CJK / Cyrillic / Arabic / etc. character is a
      // model hallucination — most often happens on quiet/low-signal
      // segments where Whisper invents content.
      if (this.shouldRejectByScript(evt, source, 'fast')) return;
      this.emitTranscript(evt, source, 'fast');
    };
  }

  private attachAccurate(client: RealtimeTranscriptionClient, source: Source): void {
    client.onTranscript = (evt: RealtimeTranscriptEvent) => {
      if (this.shouldRejectByScript(evt, source, 'accurate')) return;
      // Forward to the renderer so it can sync state (and let users see the
      // "canonical" arrival), then route IsFinal events to the engine.
      this.emitTranscript(evt, source, 'accurate');
      if (!evt.isFinal) return;
      const text = evt.text.trim();
      if (!text) return;
      this.entries.push({ source, text, wallTime: Date.now() });
      if (source === 'mic') {
        this.engine?.notifyCandidateSpoke(text);
      } else {
        this.engine?.notifyInterviewerSpoke(text);
      }
    };
  }

  private shouldRejectByScript(
    evt: RealtimeTranscriptEvent,
    source: Source,
    pipeline: 'fast' | 'accurate'
  ): boolean {
    if (!containsForbiddenScript(evt.text)) return false;
    log(
      'controller',
      `script-filter DROPPED [${pipeline}/${source}] ${evt.isFinal ? 'FINAL' : 'delta'}: ${q(evt.text, 80)}`
    );
    return true;
  }

  private emitTranscript(
    evt: RealtimeTranscriptEvent,
    source: Source,
    pipeline: 'fast' | 'accurate'
  ): void {
    const payload: TranscriptEvent = {
      source,
      itemId: evt.itemId,
      contentIndex: evt.contentIndex,
      text: evt.text,
      isFinal: evt.isFinal,
      pipeline,
    };
    this.send(IPC.Events.Transcript, payload);
  }

  private sendAnswer(chunk: AnswerChunk): void {
    this.send(IPC.Events.Answer, chunk);
  }

  private sendSummary(text: string): void {
    this.send(IPC.Events.Summary, text);
  }

  private status(message: string, level: CaptionStatus['level']): void {
    log('controller', `status[${level}] ${q(message, 120)}`);
    this.send(IPC.Events.Status, { message, level });
  }

  private send<T>(channel: string, payload: T): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log('controller', `send(${channel}) failed: ${(err as Error).message}`);
    }
  }
}

// Single global controller — one session at a time. If we later need
// multi-window or multi-session support, swap to a Map keyed by window id.
export const transcriptionController = new TranscriptionController();
