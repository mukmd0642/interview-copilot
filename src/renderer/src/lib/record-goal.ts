// Push-to-talk recorder for the coding-mode voice goal. Records the mic via
// MediaRecorder, decodes to mono 16 kHz PCM, wraps in a minimal WAV, and
// hands base64 to main for one-shot transcription (gpt-4o-transcribe).
//
// We encode WAV ourselves rather than ship the browser's webm/opus blob
// because the OpenAI transcription endpoint is happiest with wav/mp3/m4a and
// our main-process helper already labels the upload audio/wav.

export interface GoalRecorder {
  stop: () => Promise<string>; // resolves to base64 WAV (16 kHz mono PCM16)
  cancel: () => void;
}

export async function startGoalRecording(): Promise<GoalRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const chunks: BlobPart[] = [];
  const rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  rec.start();

  const cleanup = (): void => stream.getTracks().forEach((t) => t.stop());

  return {
    cancel: () => {
      try { rec.stop(); } catch { /* ignore */ }
      cleanup();
    },
    stop: () =>
      new Promise<string>((resolve, reject) => {
        rec.onstop = async () => {
          cleanup();
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
            const buf = await blob.arrayBuffer();
            const ctx = new AudioContext();
            const decoded = await ctx.decodeAudioData(buf);
            await ctx.close();
            const wav = encodeWav16kMono(decoded);
            resolve(arrayBufferToBase64(wav));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        try { rec.stop(); } catch (err) { reject(err as Error); }
      }),
  };
}

// Downmix to mono, resample to 16 kHz (linear — fine for speech), PCM16 WAV.
function encodeWav16kMono(buf: AudioBuffer): ArrayBuffer {
  const targetRate = 16_000;
  const chCount = buf.numberOfChannels;
  const srcLen = buf.length;
  // Downmix.
  const mono = new Float32Array(srcLen);
  for (let c = 0; c < chCount; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < srcLen; i++) {
      mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / chCount;
    }
  }
  // Resample.
  const ratio = buf.sampleRate / targetRate;
  const outLen = Math.floor(srcLen / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, mono[Math.floor(i * ratio)]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  // WAV container.
  const bytes = new ArrayBuffer(44 + out.length * 2);
  const dv = new DataView(bytes);
  const wstr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + out.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, targetRate, true); dv.setUint32(28, targetRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) dv.setInt16(44 + i * 2, out[i]!, true);
  return bytes;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
