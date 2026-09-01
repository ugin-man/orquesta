export interface RgbaImage {
  width: number;
  height: number;
  pixels: Buffer;
}

export const CANONICAL_SHA256: string;
export const SYMBOL_SOURCE_RECT: Readonly<{ x: number; y: number; width: number; height: number }>;
export const SYMBOL_MASTER: Readonly<{ width: number; height: number; x: number; y: number }>;
export function sha256(value: Buffer): string;
export function decodeRgbaPng(buffer: Buffer): RgbaImage;
export function encodeRgbaPng(image: RgbaImage): Buffer;
export function createSymbolMaster(source: RgbaImage): RgbaImage;
export function createAppIconMaster(source: RgbaImage): RgbaImage;
