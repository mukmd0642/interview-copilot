// Node port of the C# RealtimeTranscriptionClient. Connects to the OpenAI
// Realtime API in transcription-only mode (?intent=transcription) over a
// raw WebSocket. One instance per audio source (mic / system) per pipeline
// (fast / accurate).
//
// Behavioural notes mirrored from the C# version:
//   • gpt-realtime-whisper emits a continuous stream of deltas with NO
//     server-side turn boundaries. We synthesise IsFinal events client-side
//     when delta activity has been idle long enough. The idle threshold
//     varies by punctuation: '?' is grammatically complete so we fire fast;
//     a comma waits longer.
//   • gpt-4o-transcribe is the opposite — it requires turn_detection on,
//     batches utterances server-side, then dumps deltas immediately followed
//     by a completed event. We pass that completed event through unchanged.
//
// We deliberately do NOT serialise the websocket sends with a semaphore on
// the Node side: the `ws` library queues frames internally. This was a
// thread-safety guard on .NET; not needed here.

import { WebSocket } from 'ws';
import { log, q } from '../log.js';
import type { Language } from '../../shared/ipc.js';
import { apiLanguageCode } from '../../shared/language.js';

export interface RealtimeTranscriptEvent {
  itemId: string;
  contentIndex: number;
  text: string;
  isFinal: boolean;
}

export type ModelKind = 'gpt-realtime-whisper' | 'gpt-4o-transcribe';

const BASE_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

interface Options {
  apiKey: string;
  source: string;            // mic-fast, mic-accurate, system-fast, system-accurate
  language: Language;
  model: ModelKind;
  enableTurnDetection: boolean;
}

export class RealtimeTranscriptionClient {
  private ws: WebSocket | null = null;
  private disposed = false;

  // Client-side silence-detection state — only used for gpt-realtime-whisper
  // which doesn't produce server finals.
  private streamingText = '';
  private streamingItemId = '';
  private streamingContentIndex = 0;
  private lastDeltaAtMs = Date.now();
  private silenceTimer: NodeJS.Timeout | null = null;

  // Event callbacks set by the controller. Kept as direct callbacks rather
  // than EventEmitter — we want each consumer (controller, UI) to handle
  // errors itself; emitter swallows would be confusing.
  onTranscript: ((evt: RealtimeTranscriptEvent) => void) | null = null;
  onSilence: (() => void) | null = null;
  onStatus: ((msg: string) => void) | null = null;
  onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor(private readonly opts: Options) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.disposed) return;

    this.ws = new WebSocket(BASE_URL, {
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      // 64 KB per frame matches the C# client; OpenAI never sends single
      // chunks bigger than that.
      maxPayload: 8 * 1024 * 1024,
    });

    return new Promise<void>((resolve) => {
      const ws = this.ws!;

      ws.once('open', () => {
        this.log('connected');
        this.onConnectionChange?.(true);
        this.onStatus?.(`[${this.opts.source}] Connected`);
        this.sendSessionConfig();

        // Silence-detection poll. 100 ms cadence keeps the fast-path
        // (300 ms threshold for '?') responsive without burning CPU —
        // it's a single time comparison.
        if (!this.opts.enableTurnDetection) {
          this.silenceTimer = setInterval(() => this.checkSilenceFinal(), 100);
        }
        resolve();
      });

      ws.on('message', (data) => {
        const json = typeof data === 'string' ? data : data.toString('utf-8');
        this.processMessage(json);
      });

      ws.on('close', () => {
        this.log('closed');
        this.onConnectionChange?.(false);
        if (this.silenceTimer) {
          clearInterval(this.silenceTimer);
          this.silenceTimer = null;
        }
      });

      ws.on('error', (err) => {
        this.log(`ws error: ${err.message}`);
        this.onStatus?.(`[${this.opts.source}] Disconnected: ${err.message}`);
        // resolve() is harmless if already fired; if not, we resolve so
        // the caller's Promise.all doesn't hang forever on connection refusal.
        resolve();
      });
    });
  }

  /**
   * Send raw PCM16 @ 24 kHz mono. Frames arrive ~every 20-50 ms from the
   * renderer's audio worklet.
   */
  sendAudio(pcm: ArrayBuffer | Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Convert to base64 on the way out. The realtime API expects base64
    // strings, not binary frames.
    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
    const msg = JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: buf.toString('base64'),
    });
    try {
      this.ws.send(msg);
    } catch (err) {
      this.log(`send failed: ${(err as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true;
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000, 'closing');
      } catch {
        /* ignore — closing path is best-effort */
      }
    }
    if (ws) {
      // Give the close handshake a moment to settle so the OpenAI side
      // sees a graceful disconnect instead of an abort.
      await new Promise<void>((r) => setTimeout(r, 50));
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private sendSessionConfig(): void {
    // The API takes an ISO-639-1 code; our internal Language type uses
    // BCP-47-ish identifiers (pt-BR). Map at the boundary.
    const apiLang = apiLanguageCode(this.opts.language);
    const inputConfig = this.opts.enableTurnDetection
      ? {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: this.opts.model, language: apiLang },
          // Mirrors the C# defaults: 400 ms silence is tight enough to feel
          // live but loose enough that slow speakers don't get sliced.
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 400,
          },
        }
      : {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: this.opts.model, language: apiLang },
        };

    const config = {
      type: 'session.update',
      session: { type: 'transcription', audio: { input: inputConfig } },
    };
    this.sendJson(config);
  }

  private sendJson(obj: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      this.log(`sendJson failed: ${(err as Error).message}`);
    }
  }

  /**
   * Idle-threshold by terminal punctuation, exactly as in the C# client.
   * '?' = grammatically complete, fire fast.
   * Comma/colon = speaker likely has more to say, wait longer.
   */
  private silenceThresholdForText(text: string): number {
    for (let i = text.length - 1; i >= 0; i--) {
      const c = text[i];
      if (c === undefined) continue;
      if (/\s/.test(c)) continue;
      if (c === '?') return 300;
      if (c === '.' || c === '!') return 700;
      if (c === ',' || c === ';' || c === ':') return 1500;
      return 900;
    }
    return 900;
  }

  private checkSilenceFinal(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.streamingText.length === 0) return;

    const threshold = this.silenceThresholdForText(this.streamingText);
    const idleMs = Date.now() - this.lastDeltaAtMs;
    if (idleMs < threshold) return;

    const finalText = this.streamingText.trim();
    const itemId = this.streamingItemId;
    const contentIndex = this.streamingContentIndex;
    this.streamingText = '';

    if (!finalText) return;
    this.log(`SYNTH FINAL[${itemId}/${contentIndex}]: ${q(finalText)}`);
    this.onTranscript?.({ itemId, contentIndex, text: finalText, isFinal: true });
    this.onSilence?.();
  }

  private processMessage(json: string): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(json);
    } catch (err) {
      this.log(`bad JSON: ${(err as Error).message}; head=${q(json, 120)}`);
      return;
    }
    const type = typeof msg.type === 'string' ? msg.type : '';

    switch (type) {
      case 'conversation.item.input_audio_transcription.completed': {
        // Server-emitted final (gpt-4o-transcribe path). Clear any partially-
        // accumulated streaming buffer so we don't double-fire.
        this.streamingText = '';
        const itemId = (msg.item_id as string | undefined) ?? '';
        const contentIndex = (msg.content_index as number | undefined) ?? 0;
        const text = ((msg.transcript as string | undefined) ?? '').trim();
        this.log(`SERVER FINAL[${itemId}/${contentIndex}]: ${q(text)}`);
        this.onTranscript?.({ itemId, contentIndex, text, isFinal: true });
        this.onSilence?.();
        break;
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const itemId = (msg.item_id as string | undefined) ?? '';
        const contentIndex = (msg.content_index as number | undefined) ?? 0;
        const delta = (msg.delta as string | undefined) ?? '';
        if (!delta) break;
        this.streamingText += delta;
        this.streamingItemId = itemId;
        this.streamingContentIndex = contentIndex;
        this.lastDeltaAtMs = Date.now();
        this.onTranscript?.({ itemId, contentIndex, text: delta, isFinal: false });
        break;
      }
      case 'error': {
        const errObj = msg.error as { message?: string } | undefined;
        const errMsg = errObj?.message ?? 'Unknown error';
        this.log(`ERROR from server: ${errMsg}`);
        this.onStatus?.(`[${this.opts.source}] Error: ${errMsg}`);
        break;
      }
      case 'session.created':
      case 'session.updated':
        this.log('session ready');
        this.onStatus?.(`[${this.opts.source}] Session ready`);
        break;
      case 'conversation.item.created':
      // Protocol-level acknowledgements / lifecycle markers we don't act
      // on. Logging the full JSON for each of these fills the vast
      // majority of a real session log; quiet them entirely. If we ever
      // need them back, just remove a case here.
      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech_stopped':
      case 'input_audio_buffer.committed':
      case 'conversation.item.added':
      case 'conversation.item.done':
        break;
      default:
        this.log(`UNHANDLED ${type}: ${q(json, 200)}`);
    }
  }

  private log(msg: string): void {
    log(`realtime/${this.opts.source}`, msg);
  }
}
