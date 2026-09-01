import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

export const CANONICAL_SHA256 = '881f2910a8d7f188c1de4053a8802a2d6d27f1997c49eee07d93c2bb9689d0da';
// The supplied mark occupies a square-friendly central region. This fixed
// crop removes only outer whitespace; it does not threshold, trace, recolour,
// synthesize transparency, or resample any supplied pixel.
export const SYMBOL_SOURCE_RECT = Object.freeze({ x: 115, y: 98, width: 1024, height: 1024 });
export const SYMBOL_MASTER = Object.freeze({ width: 1024, height: 1024, x: 0, y: 0 });

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function decodeRgbaPng(buffer) {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('Brand source is not a PNG');
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let inputBytesPerPixel = 0;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Brand PNG must be non-interlaced 8-bit RGB or RGBA');
      }
      inputBytesPerPixel = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      compressed.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0 || compressed.length === 0) throw new Error('Brand PNG is incomplete');
  const rowLength = width * inputBytesPerPixel;
  const inflated = inflateSync(Buffer.concat(compressed));
  if (inflated.length !== height * (rowLength + 1)) throw new Error('Brand PNG has an unexpected decoded length');
  const decoded = Buffer.alloc(width * height * inputBytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * (rowLength + 1);
    const filter = inflated[sourceStart];
    const targetStart = y * rowLength;
    for (let x = 0; x < rowLength; x += 1) {
      const raw = inflated[sourceStart + 1 + x];
      const left = x >= inputBytesPerPixel ? decoded[targetStart + x - inputBytesPerPixel] : 0;
      const above = y > 0 ? decoded[targetStart - rowLength + x] : 0;
      const upperLeft = y > 0 && x >= inputBytesPerPixel ? decoded[targetStart - rowLength + x - inputBytesPerPixel] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filter}`);
      decoded[targetStart + x] = value & 0xff;
    }
  }
  if (inputBytesPerPixel === 4) return { width, height, pixels: decoded };
  const pixels = Buffer.alloc(width * height * 4);
  for (let input = 0, output = 0; input < decoded.length; input += 3, output += 4) {
    pixels[output] = decoded[input];
    pixels[output + 1] = decoded[input + 1];
    pixels[output + 2] = decoded[input + 2];
    pixels[output + 3] = 255;
  }
  return { width, height, pixels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

export function encodeRgbaPng({ width, height, pixels }) {
  if (pixels.length !== width * height * 4) throw new Error('RGBA pixel buffer has an unexpected length');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    pixels.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sourceOffset(image, x, y) {
  return (y * image.width + x) * 4;
}

function targetOffset(x, y) {
  return (y * SYMBOL_MASTER.width + x) * 4;
}

function copySymbolPixels(source, target) {
  const rect = SYMBOL_SOURCE_RECT;
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const from = sourceOffset(source, rect.x + x, rect.y + y);
      const to = targetOffset(SYMBOL_MASTER.x + x, SYMBOL_MASTER.y + y);
      source.pixels.copy(target, to, from, from + 4);
    }
  }
}

export function createSymbolMaster(source) {
  if (source.width !== 1254 || source.height !== 1254) throw new Error('Canonical startup logo dimensions changed');
  const pixels = Buffer.alloc(SYMBOL_MASTER.width * SYMBOL_MASTER.height * 4);
  copySymbolPixels(source, pixels);
  return { width: SYMBOL_MASTER.width, height: SYMBOL_MASTER.height, pixels };
}

export function createAppIconMaster(source) {
  // The supplied PNG already owns its white background. Keep that background
  // opaque instead of inventing alpha or a replacement platform plate.
  const symbol = createSymbolMaster(source);
  return { ...symbol, pixels: Buffer.from(symbol.pixels) };
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const productRoot = resolve(scriptDirectory, '..');
  const canonicalPath = resolve(productRoot, 'public', 'brand', 'orquesta-startup.png');
  const symbolPath = resolve(productRoot, 'public', 'brand', 'orquesta-symbol.png');
  const appIconPath = resolve(productRoot, 'src-tauri', 'icon-source', 'orquesta-app-icon.png');
  const iconDirectory = resolve(productRoot, 'src-tauri', 'icons');
  const canonical = await readFile(canonicalPath);
  if (sha256(canonical) !== CANONICAL_SHA256) throw new Error('Canonical startup logo hash mismatch');
  const source = decodeRgbaPng(canonical);
  const symbol = encodeRgbaPng(createSymbolMaster(source));
  const appIcon = encodeRgbaPng(createAppIconMaster(source));
  await mkdir(dirname(symbolPath), { recursive: true });
  await mkdir(dirname(appIconPath), { recursive: true });
  await writeFile(symbolPath, symbol);
  await writeFile(appIconPath, appIcon);
  const tauriCli = resolve(productRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const generated = spawnSync(
    process.execPath,
    [tauriCli, 'icon', appIconPath, '--output', iconDirectory],
    { cwd: productRoot, stdio: 'inherit' },
  );
  if (generated.error) throw generated.error;
  if (generated.status !== 0) throw new Error(`Tauri icon generation failed with exit code ${generated.status ?? 'unknown'}`);
  // Current Tauri CLI also emits mobile trees. This Windows desktop task owns
  // exactly the 17 root icon files, so remove only those just-created extras.
  await rm(resolve(iconDirectory, 'ios'), { recursive: true, force: true });
  await rm(resolve(iconDirectory, 'android'), { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ canonical: CANONICAL_SHA256, symbol: sha256(symbol), appIcon: sha256(appIcon) })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
