import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const size = 256;
const scale = 4;
const canvasSize = size * scale;
const pixels = new Uint8Array(canvasSize * canvasSize * 4);

function setPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= canvasSize || y >= canvasSize) return;
  const index = (Math.floor(y) * canvasSize + Math.floor(x)) * 4;
  pixels.set(color, index);
}

function circle(cx, cy, radius, fill, stroke = null, strokeWidth = 0) {
  const left = Math.floor(cx - radius - strokeWidth);
  const right = Math.ceil(cx + radius + strokeWidth);
  const top = Math.floor(cy - radius - strokeWidth);
  const bottom = Math.ceil(cy + radius + strokeWidth);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      if (stroke && distance <= radius && distance >= radius - strokeWidth) setPixel(x, y, stroke);
      else if (distance < radius - strokeWidth) setPixel(x, y, fill);
    }
  }
}

function line(x1, y1, x2, y2, width, color) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let step = 0; step <= steps; step += 1) {
    const ratio = steps ? step / steps : 0;
    circle(x1 + (x2 - x1) * ratio, y1 + (y2 - y1) * ratio, width / 2, color);
  }
}

const warm = [244, 241, 234, 255];
const ink = [23, 23, 21, 255];
pixels.fill(0);
circle(128 * scale, 128 * scale, 116 * scale, warm, ink, 2.5 * scale);
line(128 * scale, 72 * scale, 128 * scale, 112 * scale, 3 * scale, ink);
line(128 * scale, 136 * scale, 83 * scale, 181 * scale, 3 * scale, ink);
line(128 * scale, 136 * scale, 173 * scale, 181 * scale, 3 * scale, ink);
for (const [x, y, filled] of [[128, 58, false], [128, 124, true], [76, 194, false], [180, 194, false]]) {
  circle(x * scale, y * scale, 17 * scale, filled ? ink : warm, ink, 3 * scale);
  if (filled) circle(x * scale, y * scale, 6 * scale, warm);
}

const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const totals = [0, 0, 0, 0];
    for (let sy = 0; sy < scale; sy += 1) {
      for (let sx = 0; sx < scale; sx += 1) {
        const source = (((y * scale + sy) * canvasSize) + x * scale + sx) * 4;
        for (let channel = 0; channel < 4; channel += 1) totals[channel] += pixels[source + channel];
      }
    }
    const target = (y * size + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) rgba[target + channel] = Math.round(totals[channel] / (scale * scale));
  }
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  scanlines[row] = 0;
  rgba.copy(scanlines, row + 1, y * size * 4, (y + 1) * size * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 0;
header[7] = 0;
header[8] = 0;
header[9] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(appRoot, 'assets');
await mkdir(assets, { recursive: true });
await Promise.all([
  writeFile(path.join(assets, 'orquesta.png'), png),
  writeFile(path.join(assets, 'orquesta.ico'), Buffer.concat([header, png]))
]);
