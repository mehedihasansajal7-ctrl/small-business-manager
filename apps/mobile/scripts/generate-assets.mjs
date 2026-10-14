/**
 * Generates the placeholder app icons so `app.json` never points at a missing file
 * (a broken asset makes `expo prebuild` / EAS fail with a confusing error).
 *
 * These are flat-colour placeholders on purpose: a real brand icon can replace the
 * PNGs in ./assets without touching any code. Run with:
 *
 *   node scripts/generate-assets.mjs
 *
 * Dependency-free: PNG is written by hand (signature + IHDR + IDAT + IEND) using
 * Node's zlib, so this needs nothing beyond a Node install.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'assets');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Solid-colour RGBA PNG with an optional centred lighter square. */
function solidPng(size, [r, g, b, a], accent) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const inset = Math.floor(size * 0.28);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      const inAccent = accent && x > inset && x < size - inset && y > inset && y < size - inset;
      const [cr, cg, cb, ca] = inAccent ? accent : [r, g, b, a];
      raw[offset] = cr;
      raw[offset + 1] = cg;
      raw[offset + 2] = cb;
      raw[offset + 3] = ca;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GREEN = [15, 123, 79, 255];
const CREAM = [242, 244, 247, 255];

mkdirSync(assetsDir, { recursive: true });
writeFileSync(join(assetsDir, 'icon.png'), solidPng(1024, GREEN, CREAM));
writeFileSync(join(assetsDir, 'adaptive-icon.png'), solidPng(1024, GREEN, CREAM));
writeFileSync(join(assetsDir, 'splash.png'), solidPng(512, GREEN, null));

console.log(`Wrote placeholder assets to ${assetsDir}`);
