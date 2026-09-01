import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CANONICAL_SHA256,
  decodeRgbaPng,
  SYMBOL_MASTER,
  SYMBOL_SOURCE_RECT,
} from '../scripts/generate-brand-assets.mjs';

const productRoot = resolve(import.meta.dirname, '..');
const canonicalPath = resolve(productRoot, 'public', 'brand', 'orquesta-startup.png');
const symbolPath = resolve(productRoot, 'public', 'brand', 'orquesta-symbol.png');
const appIconPath = resolve(productRoot, 'src-tauri', 'icon-source', 'orquesta-app-icon.png');
const iconDirectory = resolve(productRoot, 'src-tauri', 'icons');

const expectedIconFiles = [
  '128x128.png', '128x128@2x.png', '32x32.png', '64x64.png', 'icon.icns', 'icon.ico', 'icon.png',
  'Square107x107Logo.png', 'Square142x142Logo.png', 'Square150x150Logo.png', 'Square284x284Logo.png',
  'Square30x30Logo.png', 'Square310x310Logo.png', 'Square44x44Logo.png', 'Square71x71Logo.png',
  'Square89x89Logo.png', 'StoreLogo.png',
] as const;

const legacyIconHashes = new Set([
  'd5677e0665d94866fe90d356937a7453d18dc7f36c29a5a3f3bc1680cd3bce85',
  'a953deccd3c6a15dfc32bcfd0a20d78fdc76da2f4c1346b99abe1519e1260520',
  '3fad6e176a60305f75543ad82513c05f364732dc5f3edae976a60e7a15f6a95e',
  '8babcdfc21873dd6dd161c3dcf06f6a5ca7606e723f1ff4443d1e0b60a35dac4',
  '162777a4a5483d74aecbc18b4be7e66281bb123a26c778942c811ee16c7a3a6b',
  '5ef63fd184a9986e733d173d043f5e398348f21439f74647c300da0f8d8ee860',
  '00e51638edf578bbfbbc63a94dd25182c845b736d778f91b7a1697f7f09de8a2',
  'dd4664f14ea42069100642a1c84b5bfe4c4d234f6fcebcda1b9cfb7bf79a7eab',
  '4780e12035d18286e87e2bf4c92cf62e4faaeb6fc381ba1e643b6d53497a8c5d',
  '84eaf83f40dc2b65676f5de3ef51d620eafd70318023b8e97242f8ef2c8024bd',
  'a373e6dd301a99d48e2b485d6e5e8fab0114b1e54c83e8bad95e7e2990f30f91',
  'dfd4087cecda98b35574d4ddcb95309ea47231e63405f170127806578dffc837',
  '643de107c541607ad75b32b3c99aa6ca8a068dee431f334c293c90f28154573f',
  '9565c4b04e9ae1b2c66b75421651b357901f8fab8f1c664c52f2d7c10d0b8d31',
  '82b6817757130bb7f2e3772d01380c5cac4dd7858cb36cbffa8ad2e03f688188',
  '2f56366ffb3de2d1e2b597043bde769fdaddbb94377f0a929511483bd4f5336e',
  '983d51224b6bd59c813980dd27607619ee6862c80968a8e17985a087b4042417',
  // The superseded Gothic mark generated during the first correction pass.
  'b2af5b440b46bb5fee5381bfd51d4b9c45ef9f92ef3e1dc87e0915a7fd22caa2',
  '091cf52779d8712002993995c6916069541af22ce5f948daef8cf859ac4a9bc7',
  '2eadd719586174c7a3d9626a46f5c47c3d60c52214be535646d90149fc42f878',
  '107277dd43d3028eb9b53ff057e9952d97c542fb134e04cb86c64f3c6621835f',
  '36984f3f2b9cb36cb8081014b7d06d9fcdef175f2ea6825d14a6980e03de76d9',
  '3f7490df6b628463e876feba202066df7eec8fc8d4656461ae43b5910161f08b',
  '965068cb31cc3132139a00a24b693f6b3a45ef1dd690ac266018cac499392a61',
  '8279c547160cf67e010c048918fae8da4ef0dc44d0560002fc5c957e67a4a6fb',
  '42326f1ba49953d5bb2ccad80233edeb4c7029e7d58dcce08fd7f8c2bbd5491b',
  '454f31795eeb4bcf7b92d22c56d60e5e20429bb33aea916e619f42850ac6cf95',
  '0f16dfc167471eea45baeb19d87eb422087dc7ba5885ff0bc45e1912b795ce65',
  'abca72453ecb090cfdf5c49bb8089c3e39ccb9a0af8c8632900b182f5ba49a0f',
  '1c6bd0afa975f180a909376ed450aeb422a64c5360c9aa452a45555e178f1535',
  '72b4475d9bde61d29192fdee54646c86573f289115e2f6f4925cc124544cba7f',
  'a8a8212d39531d44f12fd54e6b350e386f0e65a33daf2c91df0b27cbc17a1a9c',
  '9797dd4d04e8a01a5bcff8f469281694844c0511b03600dc3e1dec94a4826372',
  'f3c0c78471c177faf67ff3eb3140d215f9d487cac20a776254ae697915defee3',
  'a86f7837847f0c6eaaa67156c9bf5c9fe4bd3629675c01f27ff9a6b168c47439',
]);

const supersededBrandHashes = new Set([
  'dc8f1baaf12bc8c49b755e1f49263515306497c64723e95975a0d30999c3917c',
  'bd5f0e3dbde2968476ec25432f72623be9a4398e1492686840f4a1b29c9b23a2',
  '0ecc3e22b9e3d07b763de844bc9d02125889f1ea3294b05b9bc626b4ad61ea99',
]);

function hash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function pixel(image: ReturnType<typeof decodeRgbaPng>, x: number, y: number): Buffer {
  const offset = (y * image.width + x) * 4;
  return image.pixels.subarray(offset, offset + 4);
}

describe('Orquesta brand assets', () => {
  test('keeps the supplied startup lockup byte-for-byte', () => {
    const canonical = readFileSync(canonicalPath);
    expect(hash(canonical)).toBe(CANONICAL_SHA256);
    const image = decodeRgbaPng(canonical);
    expect([image.width, image.height]).toEqual([1254, 1254]);
    expect(supersededBrandHashes.has(hash(canonical))).toBe(false);
  });

  test('copies the fixed square crop exactly without removing the supplied white background', () => {
    const source = decodeRgbaPng(readFileSync(canonicalPath));
    const symbol = decodeRgbaPng(readFileSync(symbolPath));
    expect([symbol.width, symbol.height]).toEqual([SYMBOL_MASTER.width, SYMBOL_MASTER.height]);
    const expected = Buffer.alloc(symbol.pixels.length);
    for (let y = 0; y < SYMBOL_SOURCE_RECT.height; y += 1) {
      const sourceStart = ((SYMBOL_SOURCE_RECT.y + y) * source.width + SYMBOL_SOURCE_RECT.x) * 4;
      const targetStart = ((SYMBOL_MASTER.y + y) * symbol.width + SYMBOL_MASTER.x) * 4;
      source.pixels.copy(expected, targetStart, sourceStart, sourceStart + SYMBOL_SOURCE_RECT.width * 4);
    }
    expect(symbol.pixels.equals(expected)).toBe(true);
    let firstNonOpaquePixel = -1;
    for (let alpha = 3; alpha < symbol.pixels.length; alpha += 4) {
      if (symbol.pixels[alpha] !== 255) {
        firstNonOpaquePixel = Math.floor(alpha / 4);
        break;
      }
    }
    expect(firstNonOpaquePixel).toBe(-1);
    expect(supersededBrandHashes.has(hash(readFileSync(symbolPath)))).toBe(false);
  });

  test('uses the exact opaque crop as the app icon master', () => {
    const symbol = decodeRgbaPng(readFileSync(symbolPath));
    const appIcon = decodeRgbaPng(readFileSync(appIconPath));
    expect([appIcon.width, appIcon.height]).toEqual([SYMBOL_MASTER.width, SYMBOL_MASTER.height]);
    expect(appIcon.pixels.equals(symbol.pixels)).toBe(true);
    expect(pixel(appIcon, 0, 0)[3]).toBe(255);
    expect(supersededBrandHashes.has(hash(readFileSync(appIconPath)))).toBe(false);
  });

  test('contains the complete generated Tauri icon set and no legacy icon hash', () => {
    const entries = readdirSync(iconDirectory, { withFileTypes: true });
    const actualFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    expect(actualFiles).toEqual([...expectedIconFiles].sort());
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).toEqual([]);
    for (const file of expectedIconFiles) {
      const value = readFileSync(resolve(iconDirectory, file));
      expect(value.length).toBeGreaterThan(0);
      expect(legacyIconHashes.has(hash(value)), `${file} still has the legacy logo hash`).toBe(false);
    }
  });

  test('keeps every configured Tauri icon reference inside the generated set', () => {
    const config = JSON.parse(readFileSync(resolve(productRoot, 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
      bundle: { icon: string[] };
    };
    expect(config.bundle.icon).not.toHaveLength(0);
    for (const configured of config.bundle.icon) {
      const normalized = configured.replaceAll('\\', '/');
      expect(normalized.startsWith('icons/')).toBe(true);
      expect(expectedIconFiles).toContain(normalized.slice('icons/'.length) as typeof expectedIconFiles[number]);
      expect(readFileSync(resolve(productRoot, 'src-tauri', normalized)).length).toBeGreaterThan(0);
    }
  });

  test('uses the package-lock-pinned Tauri CLI for deterministic icon generation', () => {
    const lock = JSON.parse(readFileSync(resolve(productRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    expect(lock.packages['node_modules/@tauri-apps/cli']?.version).toBe('2.11.4');
  });
});
