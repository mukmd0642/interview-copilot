import { desktopCapturer, screen, nativeImage } from 'electron';
import { log } from './log.js';

// One-shot screen capture for the agentic coding mode.
//
// We use desktopCapturer.getSources with a large thumbnailSize rather than a
// getDisplayMedia video stream: we want a single still frame, not a feed.
// The "thumbnail" at full display resolution IS the screen contents.
//
// Our own window is excluded automatically — WDA_EXCLUDEFROMCAPTURE (Windows)
// / NSWindowSharingNone (macOS) keep it out of every capture surface,
// including this one. So the screenshot cleanly shows the editor behind our
// window with no copilot-in-its-own-screenshot artefact.
//
// macOS note: this requires the Screen Recording (TCC) permission; the first
// call triggers the OS prompt. It can also light the menu-bar recording
// indicator. On Windows there's no such permission or indicator.

export interface Capture {
  pngBase64: string;
  width: number;
  height: number;
}

// Code text is small, so we keep captures fairly large for legibility. We
// cap the long edge at this many px — enough to shrink a 4K display's token
// cost, but high enough that 11px editor font stays readable to the vision
// model. Vision 'detail: high' tiles the image regardless, so this mostly
// controls upload size and tiling count.
const MAX_LONG_EDGE = 1920;

export async function capturePrimaryScreen(): Promise<Capture> {
  const primary = screen.getPrimaryDisplay();
  // size is in DIPs; multiply by scaleFactor to request native pixels so a
  // HiDPI screen doesn't come back blurry.
  const scale = primary.scaleFactor || 1;
  const reqW = Math.round(primary.size.width * scale);
  const reqH = Math.round(primary.size.height * scale);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: reqW, height: reqH },
  });

  if (sources.length === 0) {
    throw new Error('No screen sources available to capture.');
  }

  // Pick the source matching the primary display when we can; otherwise the
  // first. (display_id correlation isn't available on every OS/Electron
  // combo, so fall back gracefully.)
  const primaryIdStr = String(primary.id);
  const chosen =
    sources.find((s) => s.display_id === primaryIdStr) ?? sources[0]!;

  let img = chosen.thumbnail;
  if (img.isEmpty()) {
    throw new Error('Captured an empty image (screen-recording permission may be denied).');
  }

  // Downscale if the long edge exceeds our cap, preserving aspect ratio.
  const size = img.getSize();
  const longEdge = Math.max(size.width, size.height);
  if (longEdge > MAX_LONG_EDGE) {
    const ratio = MAX_LONG_EDGE / longEdge;
    img = img.resize({
      width: Math.round(size.width * ratio),
      height: Math.round(size.height * ratio),
      quality: 'good',
    });
  }

  const out = img.getSize();
  const png = img.toPNG();
  const pngBase64 = png.toString('base64');
  log('capture', `primary screen ${out.width}x${out.height}, ${(png.length / 1024).toFixed(0)} KB`);

  return { pngBase64, width: out.width, height: out.height };
}

/** How many distinct displays are connected (for the multi-monitor warning). */
export function displayCount(): number {
  return screen.getAllDisplays().length;
}

// Re-export nativeImage so callers that need to decode/encode don't have to
// import electron directly. Currently unused outside this module but handy
// for a future region-crop feature.
export { nativeImage };
