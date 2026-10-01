#!/usr/bin/env node
/**
 * Draws the tray and app icons into `src-tauri/icons` (a plain shield with a check mark; the tray
 * has a grey variant for "not protecting" and a red-dot variant for "a warning in the last hour").
 * No image dependencies: PNG and ICO are written by hand. Run `node scripts/make-icons.mjs`; the
 * output is committed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(out, { recursive: true });

const BLUE = [31, 79, 216];
const GREY = [138, 143, 152];
const RED = [220, 38, 38];
const WHITE = [255, 255, 255];

function inShield(x, y) {
  if (y < 0.1 || y > 0.95) return false;
  const half = y <= 0.55 ? 0.36 : 0.36 * Math.sqrt(Math.max(0, 1 - ((y - 0.55) / 0.4) ** 2));
  return Math.abs(x - 0.5) <= half;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inCheck(x, y) {
  return distToSegment(x, y, 0.33, 0.5, 0.46, 0.63) < 0.045 || distToSegment(x, y, 0.46, 0.63, 0.68, 0.34) < 0.045;
}

/** RGBA pixels, 4x4 supersampled. */
function draw(size, color, redDot) {
  const px = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < N; sj++) {
        for (let si = 0; si < N; si++) {
          const x = (i + (si + 0.5) / N) / size;
          const y = (j + (sj + 0.5) / N) / size;
          let c = null;
          if (redDot && Math.hypot(x - 0.76, y - 0.26) < 0.17) c = RED;
          else if (redDot && Math.hypot(x - 0.76, y - 0.26) < 0.22) c = WHITE;
          else if (inShield(x, y)) c = inCheck(x, y) ? WHITE : color;
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a += 255;
          }
        }
      }
      const n = N * N;
      const o = (j * size + i) * 4;
      const cov = a / 255;
      px[o] = cov ? Math.round(r / cov) : 0;
      px[o + 1] = cov ? Math.round(g / cov) : 0;
      px[o + 2] = cov ? Math.round(b / cov) : 0;
      px[o + 3] = Math.round(a / n);
    }
  }
  return px;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.concat([Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4)]));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 32-bit DIB image for an ICO entry (bottom-up BGRA plus an all-zero AND mask). */
function dib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dir = [];
  let offset = 6 + 16 * entries.length;
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size === 256 ? 0 : e.size;
    d[1] = e.size === 256 ? 0 : e.size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.data.length;
    dir.push(d);
  }
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.data)]);
}

const write = (name, data) => writeFileSync(join(out, name), data);

write("tray-shield.png", png(64, draw(64, BLUE, false)));
write("tray-grey.png", png(64, draw(64, GREY, false)));
write("tray-alert.png", png(64, draw(64, BLUE, true)));
write("32x32.png", png(32, draw(32, BLUE, false)));
write("128x128.png", png(128, draw(128, BLUE, false)));
write("icon.png", png(256, draw(256, BLUE, false)));
write(
  "icon.ico",
  ico([
    ...[16, 32, 48].map((size) => ({ size, data: dib(size, draw(size, BLUE, false)) })),
    { size: 256, data: png(256, draw(256, BLUE, false)) },
  ]),
);
console.log(`Wrote icons to ${out}`);
