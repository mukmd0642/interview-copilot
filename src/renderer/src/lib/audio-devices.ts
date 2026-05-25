// Helpers for enumerating audio input devices for the SetupDialog's
// "Interviewer audio source" picker.
//
// MediaDevices.enumerateDevices() returns labels only AFTER the user has
// granted mic permission — that's a privacy guard in Chromium. We make a
// throwaway getUserMedia call first to satisfy that, then enumerate, then
// stop the throwaway stream.

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  // Heuristic: is this device likely a virtual loopback (BlackHole, Loopback,
  // VB-CABLE, Soundflower, Stereo Mix, etc.)? Used to highlight obvious
  // candidates in the picker.
  isLikelyLoopback: boolean;
}

const LOOPBACK_HINTS = [
  'blackhole',
  'loopback',
  'vb-cable',
  'vb cable',
  'soundflower',
  'voicemeeter',
  'cable input',
  'cable output',
  'stereo mix',
  'what u hear',
  'wave out mix',
];

function isLikelyLoopback(label: string): boolean {
  const lower = label.toLowerCase();
  return LOOPBACK_HINTS.some((hint) => lower.includes(hint));
}

export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  // Trigger the permission prompt (if needed) so labels are populated.
  // Some Chromium builds return empty labels before the prompt is satisfied
  // even for already-granted permissions; the cheapest way to be sure is
  // to open + immediately close a stream.
  let warmup: MediaStream | null = null;
  try {
    warmup = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    /* user denied — we'll still get deviceIds, just no labels */
  } finally {
    warmup?.getTracks().forEach((t) => t.stop());
  }

  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d): d is MediaDeviceInfo => d.kind === 'audioinput')
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || 'Unnamed audio input',
      isLikelyLoopback: isLikelyLoopback(d.label || ''),
    }))
    // Suppress the synthetic "default" / "communications" duplicates Chromium
    // emits on Windows when the user has no specific device picked — they
    // confuse the picker and pointing at them does the same thing as
    // chromeMediaSource: 'desktop' from the wrong side.
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
}
