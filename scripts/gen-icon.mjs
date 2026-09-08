// Generates a simple 1024x1024 app-icon.png with no external dependencies.
// Usage: node scripts/gen-icon.mjs <out.png>
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;

// ---- minimal PNG encoder -------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- pixel art -----------------------------------------------------------
const px = Buffer.alloc(SIZE * SIZE * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

const BG = [30, 33, 43]; // #1e212b
const FG = [255, 255, 255];
const ACCENT = [90, 180, 150];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    px[(y * SIZE + x) * 4 + 0] = BG[0];
    px[(y * SIZE + x) * 4 + 1] = BG[1];
    px[(y * SIZE + x) * 4 + 2] = BG[2];
    px[(y * SIZE + x) * 4 + 3] = 255;
  }
}

// Rounded-corner white "page"
const m = 260; // margin
const r = 90; // corner radius
for (let y = m; y < SIZE - m; y++) {
  for (let x = m; x < SIZE - m; x++) {
    const inCorner = (cx, cy) => {
      const dx = x < cx + r ? cx + r - x : x > cx + (SIZE - 2 * m) - r ? x - (cx + (SIZE - 2 * m) - r) : 0;
      const dy = y < cy + r ? cy + r - y : y > cy + (SIZE - 2 * m) - r ? y - (cy + (SIZE - 2 * m) - r) : 0;
      return dx * dx + dy * dy > r * r;
    };
    if (inCorner(m, m)) continue;
    set(x, y, FG[0], FG[1], FG[2]);
  }
}

// Three accent lines like markdown emphasis rules
const lineY = [430, 520, 610];
for (const ly of lineY) {
  for (let x = 370; x < 654; x++) set(x, ly, ACCENT[0], ACCENT[1], ACCENT[2]);
}

const out = process.argv[2] ?? "app-icon.png";
writeFileSync(out, encodePng(SIZE, SIZE, px));
console.log(`wrote ${out}`);
