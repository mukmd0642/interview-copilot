#!/usr/bin/env node
/**
 * Placeholder app-icon generator.
 *
 * Produces a 1024×1024 PNG at resources/icon.png. electron-builder picks
 * it up by filename and converts to .ico (Windows) and .icns (Mac) at
 * package time, so we don't need to ship three separate icon files.
 *
 * The design is intentionally geometric and bland so it's obvious it's a
 * placeholder. Replace with branded art before any public release — see
 * docs/BUILD.md for the icon filename conventions.
 *
 * Why pure Node (no `sharp` / `canvas` / `pngjs`): we just need a 1024²
 * placeholder, not a real graphics pipeline. PNG's wire format is small
 * enough to hand-roll, and zero new dependencies means no native-build
 * step on contributor machines.
 *
 * Run:
 *   node scripts/make-icon.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'resources', 'icon.png');

const SIZE = 1024;

// ── Design tokens (match the app's CSS palette) ─────────────────────────
const BG       = [0x18, 0x18, 0x1c]; // panel-bg
const ACCENT   = [0x00, 0x7a, 0xcc]; // accent
const FG       = [0xf0, 0xf0, 0xf5]; // fg
const ACC_SOFT = [0x82, 0xb4, 0xff]; // them-fg

// ── Pixel buffer (RGB, row-major) ───────────────────────────────────────
const pixels = Buffer.alloc(SIZE * SIZE * 3);

function fill(rgb) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 3;
      pixels[i] = rgb[0];
      pixels[i + 1] = rgb[1];
      pixels[i + 2] = rgb[2];
    }
  }
}

function setPx(x, y, rgb) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = ((y | 0) * SIZE + (x | 0)) * 3;
  pixels[i] = rgb[0];
  pixels[i + 1] = rgb[1];
  pixels[i + 2] = rgb[2];
}

function rect(x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      setPx(x, y, rgb);
    }
  }
}

/** Filled rounded rectangle. r = corner radius. */
function roundedRect(x0, y0, w, h, r, rgb) {
  const x1 = x0 + w, y1 = y0 + h;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Distance from nearest corner — if pixel is inside a corner-radius
      // region, only draw it when within r of the corner center.
      let dx = 0, dy = 0;
      if (x < x0 + r)      dx = x - (x0 + r);
      else if (x >= x1 - r) dx = x - (x1 - r - 1);
      if (y < y0 + r)      dy = y - (y0 + r);
      else if (y >= y1 - r) dy = y - (y1 - r - 1);
      if (dx === 0 && dy === 0) {
        setPx(x, y, rgb);
        continue;
      }
      if (dx * dx + dy * dy <= r * r) setPx(x, y, rgb);
    }
  }
}

// ── Compose ─────────────────────────────────────────────────────────────
// Layout: dark canvas → accent rounded square in center → three white
// horizontal bars suggesting transcript / answer lines, with the middle
// bar shorter for visual rhythm. One small accent-soft dot in the corner
// as a "live indicator" affordance.

fill(BG);

const cx = SIZE / 2;
const cy = SIZE / 2;
const cardSize = 720;
const cardRadius = 96;
roundedRect(
  cx - cardSize / 2,
  cy - cardSize / 2,
  cardSize,
  cardSize,
  cardRadius,
  ACCENT
);

// Three "transcript line" bars.
const barH = 56;
const barGap = 80;
const bars = [
  { w: 440, dx: 0  },
  { w: 360, dx: 40 },
  { w: 400, dx: 0  },
];
const totalH = bars.length * barH + (bars.length - 1) * barGap;
let by = cy - totalH / 2;
for (const b of bars) {
  rect(cx - b.w / 2 + b.dx, by, b.w, barH, FG);
  by += barH + barGap;
}

// Live indicator dot in top-right of the card.
const dotR = 36;
const dotCx = cx + cardSize / 2 - 110;
const dotCy = cy - cardSize / 2 + 110;
for (let dy = -dotR; dy <= dotR; dy++) {
  for (let dx = -dotR; dx <= dotR; dx++) {
    if (dx * dx + dy * dy <= dotR * dotR) setPx(dotCx + dx, dotCy + dy, ACC_SOFT);
  }
}

// ── PNG encoding ────────────────────────────────────────────────────────
// Wire format reference: https://www.w3.org/TR/png/
//   8-byte signature
//   IHDR (13 bytes) → dimensions + colour mode
//   IDAT (zlib-compressed) → row-major pixel data, each row prefixed
//                            with a 1-byte filter type (we use 0 = none)
//   IEND (empty) → terminator
// Each chunk: 4-byte length, 4-byte type, data, 4-byte CRC32.

function crc32(buf) {
  // Standard PNG CRC table — generated once.
  const tbl = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ tbl[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

function encodePng() {
  // Signature.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit depth, colour type, filter, compression, interlace.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8]  = 8;  // 8-bit per channel
  ihdr[9]  = 2;  // colour type 2 = RGB
  ihdr[10] = 0;  // compression: deflate
  ihdr[11] = 0;  // filter: adaptive
  ihdr[12] = 0;  // interlace: none

  // Build raw scanlines (each row prefixed with filter byte 0 = no filter).
  const rowBytes = SIZE * 3;
  const raw = Buffer.alloc((rowBytes + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (rowBytes + 1)] = 0;
    pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write ───────────────────────────────────────────────────────────────
mkdirSync(dirname(OUT), { recursive: true });
const png = encodePng();
writeFileSync(OUT, png);
console.log(`wrote ${OUT}  (${(png.length / 1024).toFixed(1)} KB)`);
