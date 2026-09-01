export const generationMarkerName: string;
export const buildIdPattern: RegExp;

export function explicitLoadTestExclusions(
  environment?: NodeJS.ProcessEnv,
): string[];

export function validateGenerationOutput(options: {
  productRoot: string;
  outDir: string | undefined;
  buildId: string | undefined;
  nonce: string | undefined;
}): string;

export function assertViteBundleCapacity(
  bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>,
  limits?: { maxEntries?: number; maxBytes?: number },
): { entries: number; totalBytes: number };
