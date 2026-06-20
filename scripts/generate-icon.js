// Generates media/icon.png (128x128) — a simple DB-cylinder mark on a dark
// rounded background. No image deps; encodes a PNG with the built-in zlib.
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const S = 128;
const buf = Buffer.alloc(S * S * 4);

const bg = [31, 31, 31];       // #1f1f1f
const accent = [88, 166, 255]; // a friendly SQL blue
const cx = 64;

function set(x, y, [r, g, b], a = 255) {
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

// rounded-rect background
const radius = 22;
function inRoundedRect(x, y) {
  const m = 6, min = m, max = S - m;
  if (x < min || x > max || y < min || y > max) return false;
  const dx = Math.min(x - (min + radius), max - radius - x, 0);
  const dy = Math.min(y - (min + radius), max - radius - y, 0);
  return dx * dx + dy * dy <= radius * radius;
}

// database cylinder: top ellipse + body + bottom ellipse
const rx = 34, ryTop = 12;
const topY = 40, botY = 88;
function onEllipse(x, y, cy) {
  const v = ((x - cx) ** 2) / (rx * rx) + ((y - cy) ** 2) / (ryTop * ryTop);
  return v >= 0.78 && v <= 1.0;
}
function insideBody(x, y) {
  if (y < topY || y > botY) return false;
  return ((x - cx) ** 2) / (rx * rx) <= 1.0;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (!inRoundedRect(x, y)) { set(x, y, [0, 0, 0], 0); continue; }
    set(x, y, bg);
    // body edges (left/right walls)
    if (insideBody(x, y)) {
      const edge = Math.abs(((x - cx) ** 2) / (rx * rx) - 1.0) < 0.06;
      if (edge) set(x, y, accent);
    }
    // the three rings
    if (onEllipse(x, y, topY) || onEllipse(x, y, 64) || onEllipse(x, y, botY)) {
      set(x, y, accent);
    }
  }
}

// PNG encode
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "media", "icon.png");
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
