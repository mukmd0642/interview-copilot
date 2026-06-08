// Sets up the two audio capture streams (mic + interviewer audio) and wires
// them through an AudioWorklet that emits PCM16 @ 24 kHz frames over IPC
// to the main process.
//
// Cross-platform audio sourcing
// ─────────────────────────────
// The candidate's own voice ("mic") is always a plain getUserMedia call —
// works identically on Win/Mac/Linux.
//
// The interviewer side ("system") is the tricky one and depends on platform:
//
//   Windows / Linux: capture the full system audio mix via
//     `chromeMediaSource: 'desktop'`. This works regardless of which app
//     plays the audio (native Zoom / Teams / Meet / browser tab — all
//     fine). The candidate joins the meeting normally and we tap the OS
//     speaker output.
//
//   macOS: Apple sandboxes system audio — `chromeMediaSource: 'desktop'`
//     gives back a silent stream. The supported workaround is a virtual
//     audio device (BlackHole, Loopback by Rogue Amoeba, etc.) routed as
//     a Multi-Output: the OS plays through it, the device exposes itself
//     as an audio INPUT, and we capture it via standard
//     `getUserMedia({ deviceId })`.
//
// The mode is configured in Settings (settings.systemAudio) and passed
// in here as `SystemAudioMode`. See SetupDialog for the picker UI.

import type { SystemAudioMode } from '../../../shared/ipc';

// The worklet ships as a static file under src/renderer/public/pcm-worklet.js
// so it's served by Vite at /pcm-worklet.js in dev and copied alongside
// index.html in prod. AudioWorklet.addModule() resolves the path against
// the page's baseURI, so the same relative path works in both modes.
//
// Why not a blob: URL? We tried that. Some Electron / Chromium versions
// CSP-block AudioWorklet loads from blob: even with `worker-src blob:`
// declared, and the error surfaces as the spec-required "The user aborted
// a request." which is famously hard to debug. Static-file = 'self' = no
// CSP gymnastics needed.
const WORKLET_URL = './pcm-worklet.js';

interface CaptureHandle {
  stop: () => Promise<void>;
}

interface SetupOptions {
  systemAudio: SystemAudioMode;
  onError: (source: 'mic' | 'system', message: string) => void;
  onWarn: (source: 'mic' | 'system', message: string) => void;
  // Whether to open the candidate's microphone. Interview mode needs it (the
  // candidate's own voice is transcribed); code mode does NOT — it only
  // listens to the interviewer — so it passes false to avoid lighting the
  // OS "mic in use" indicator and streaming PCM that's dropped main-side.
  captureMic?: boolean;
}

async function makeContext(): Promise<AudioContext> {
  // Native browser resampling. We ask for 24 kHz directly; the browser does
  // a proper anti-aliased resample under the hood (much better than the
  // linear-interp pass from the original WinForms build).
  log(`makeContext: AudioContext(24000) state=before-create`);
  const ctx = new AudioContext({ sampleRate: 24_000, latencyHint: 'interactive' });
  log(`makeContext: created, actualSampleRate=${ctx.sampleRate}, state=${ctx.state}`);
  // Some browsers / OS combos start the context suspended; explicit resume
  // is cheap and avoids weird "addModule never finishes" hangs.
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (err) { log(`makeContext: resume failed ${(err as Error).message}`); }
  }
  try {
    log(`makeContext: addModule url=${WORKLET_URL} baseURI=${document.baseURI}`);
    await ctx.audioWorklet.addModule(WORKLET_URL);
    log('makeContext: addModule ok');
  } catch (err) {
    log(`makeContext: addModule FAILED ${(err as Error).name}: ${(err as Error).message}`);
    throw err;
  }
  return ctx;
}

const log = (msg: string): void => window.api.log('audio-capture', msg);

async function getMicStream(): Promise<MediaStream> {
  log('mic: getUserMedia({audio:true})');
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

async function getSystemAudioStream(mode: SystemAudioMode): Promise<MediaStream | null> {
  if (mode.kind === 'off') {
    log('system: kind=off — skipping');
    return null;
  }

  if (mode.kind === 'desktop') {
    // Modern Electron path. getDisplayMedia is intercepted by the main
    // process's setDisplayMediaRequestHandler, which returns
    // { video: <screen-source>, audio: 'loopback' }. The 'loopback' string
    // is the magic value that switches Chromium into system-audio-mix
    // capture mode on Windows.
    //
    // We request video: true because getDisplayMedia REQUIRES a video
    // constraint by spec — there's no audio-only mode. We immediately
    // stop and remove the video track once the stream is open so we
    // don't pay any pipeline cost for pixels we throw away.
    log('system: getDisplayMedia({video:true,audio:true}) for desktop loopback');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (err) {
      log(`system: getDisplayMedia rejected — ${(err as Error).name}: ${(err as Error).message}`);
      throw err;
    }

    log(
      `system: getDisplayMedia returned ${stream.getAudioTracks().length} audio / ${stream.getVideoTracks().length} video tracks`
    );
    // Discard video — we only want the audio half. Stopping the track
    // releases the screen-capture pipeline; removing it from the
    // MediaStream means our worklet's MediaStreamAudioSourceNode never
    // sees it either.
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t);
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error(
        'Desktop audio: no audio track returned (Windows.Graphics.Capture loopback may be unavailable on this build).'
      );
    }
    return stream;
  }

  // mode.kind === 'device' — capture from a specific audio input by id.
  // Used for BlackHole / Loopback on macOS, or any user-picked input.
  log(`system: getUserMedia({deviceId:${mode.deviceId.slice(0, 8)}…})`);
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: mode.deviceId },
      // Echo cancellation / noise suppression usually HURT meeting audio
      // captured via a virtual loopback device — they expect a human
      // mouth in front of a mic, not a clean digital signal.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
    video: false,
  });
}

function attachWorklet(
  ctx: AudioContext,
  stream: MediaStream,
  source: 'mic' | 'system'
): { node: AudioWorkletNode; sourceNode: MediaStreamAudioSourceNode } {
  const sourceNode = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm24-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    processorOptions: { source },
  });
  node.port.onmessage = (ev: MessageEvent<{ source: 'mic' | 'system'; pcm24: ArrayBuffer }>) => {
    const { source: src, pcm24 } = ev.data;
    // pcm16 is the same buffer at v0 (we don't generate a separate 16k path
    // until BatchCorrectionClient is ported). Send an empty buffer to keep
    // the IPC shape stable.
    window.api.transcript.sendAudio(src, pcm24, new ArrayBuffer(0));
  };
  sourceNode.connect(node);
  return { node, sourceNode };
}

export async function startCapture(opts: SetupOptions): Promise<CaptureHandle> {
  const ctx = await makeContext();

  let micStream: MediaStream | null = null;
  let sysStream: MediaStream | null = null;

  // Mic first — failing here is the only fatal case (no point starting
  // transcription if the candidate can't be heard). Skipped entirely in code
  // mode, which only wants interviewer audio.
  if (opts.captureMic !== false) {
    try {
      micStream = await getMicStream();
      attachWorklet(ctx, micStream, 'mic');
    } catch (err) {
      opts.onError('mic', (err as Error).message);
    }
  }

  // System audio is best-effort. On Mac with mode='off' this is intentional
  // (mic-only). We surface a warning so the user knows what's happening.
  try {
    sysStream = await getSystemAudioStream(opts.systemAudio);
    if (sysStream) {
      attachWorklet(ctx, sysStream, 'system');
    } else if (opts.systemAudio.kind === 'off') {
      opts.onWarn('system', 'Interviewer audio disabled in settings (mic-only mode).');
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (opts.systemAudio.kind === 'device') {
      opts.onError(
        'system',
        `Could not open audio input "${opts.systemAudio.label ?? opts.systemAudio.deviceId}": ${msg}`
      );
    } else if (opts.systemAudio.kind === 'desktop') {
      opts.onError('system', `Desktop audio capture failed: ${msg}`);
    } else {
      opts.onError('system', msg);
    }
  }

  return {
    stop: async () => {
      micStream?.getTracks().forEach((t) => t.stop());
      sysStream?.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {
        /* already closed */
      });
    },
  };
}
