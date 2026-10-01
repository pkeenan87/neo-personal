#!/usr/bin/env node
/**
 * Generates the toolbar icon set (`_specs/browser-extension.md` "Popup and toolbar icon"): a
 * simple flat shield glyph in Neo's blue for the enrolled state, and a grey variant for
 * not-enrolled/disconnected. One-time generator (re-run only if the glyph changes); the output
 * PNGs are committed under `public/icon/`, like other small static assets in the repo.
 *
 * Pure Node (`zlib` only) — no image library dependency for four tiny fixed-size PNGs.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public", "icon");

const BLUE = [0x1d, 0x4e, 0x89, 0xff]; // shield fill
const BLUE_DARK = [0x12, 0x33, 0x5c, 0xff]; // shield outline
const GREY = [0x9a, 0xa3, 0xae, 0xff];
const GREY_DARK = [0x6b, 0x72, 0x7c, 0xff];

/** 1 = outline, 2 = fill, 0 = transparent, sampled on a 16x16 grid and scaled up. */
// prettier-ignore
const SHIELD_16 = [
  "0000011111100000",
  "0000122222210000",
  "0001222222221000",
  "0011222222222100",
  "0112222222222210",
  "0122222222222210",
  "0122222112222210",
  "0122221001222210",
  "0122221001222210",
  "0122222112222210",
  "0122222222222210",
  "0012222222222100",
  "0011222222221000",
  "0001222222210000",
  "0000122221000000",
  "0000011111000000",
].map((row) => row.split("").map(Number));

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = makeCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = table[(crc ^ buf[i]) & 0xff];
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes an RGBA pixel buffer (no filtering, one scanline filter byte 0 per row) as a PNG. */
function encodePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixels(x, y);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function shieldPixels(size, fill, outline) {
  const grid = SHIELD_16;
  const scale = size / grid.length;
  return (x, y) => {
    const gx = Math.min(grid.length - 1, Math.floor(x / scale));
    const gy = Math.min(grid.length - 1, Math.floor(y / scale));
    const v = grid[gy][gx];
    if (v === 0) return [0, 0, 0, 0];
    return v === 1 ? outline : fill;
  };
}

const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  writeFileSync(join(outDir, `${size}.png`), encodePng(size, shieldPixels(size, BLUE, BLUE_DARK)));
  writeFileSync(join(outDir, `${size}-grey.png`), encodePng(size, shieldPixels(size, GREY, GREY_DARK)));
}
console.log(`Wrote ${SIZES.length * 2} icons to ${outDir}`);
