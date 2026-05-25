// AudioWorklet processor — runs on the audio thread, receives blocks of 128
// float samples at the AudioContext's sample rate (we force 24 kHz when
// building the context), and accumulates them into ~50 ms PCM16 frames
// before posting to the main thread.
//
// Why a worklet rather than a ScriptProcessorNode:
//   - SPN is deprecated and runs on the main thread (jank risk).
//   - Worklets run on the dedicated audio thread; back-pressure-free.
//
// Why 50 ms frames:
//   - The Realtime API accepts any chunking, but tiny frames (4 ms = 128
//     samples at 24 kHz) add a lot of IPC overhead. 50 ms keeps the
//     end-to-end latency well under the ~300 ms VAD silence threshold while
//     reducing the IPC rate from 250 Hz to 20 Hz.
//
// This file is loaded into AudioWorkletGlobalScope via a Blob URL — see
// audio-capture.ts. AudioWorkletProcessor / registerProcessor are scope
// globals so we don't import anything.

const FRAME_MS = 50;
const SAMPLE_RATE = 24000;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 1200 samples @ 24 kHz

class Pcm24Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = new Float32Array(FRAME_SAMPLES);
    this._writeIndex = 0;
    const opts = (options && options.processorOptions) || {};
    this._source = opts.source === 'system' ? 'system' : 'mic';
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const samples = input[0] ? input[0].length : 0;
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const ch = input[c];
        sum += ch ? ch[i] : 0;
      }
      const sample = sum / channels;
      this._buffer[this._writeIndex++] = sample;
      if (this._writeIndex >= FRAME_SAMPLES) {
        this._flush();
        this._writeIndex = 0;
      }
    }
    return true;
  }

  _flush() {
    // Float32 [-1..1] → PCM16 little-endian. Fresh ArrayBuffer per frame so
    // the transfer is clean and the audio thread doesn't reuse memory the
    // main thread might be reading.
    const pcm = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      let v = this._buffer[i];
      if (v < -1) v = -1;
      else if (v > 1) v = 1;
      pcm[i] = (v * 32767) | 0;
    }
    this.port.postMessage({ source: this._source, pcm24: pcm.buffer }, [pcm.buffer]);
  }
}

registerProcessor('pcm24-processor', Pcm24Processor);
