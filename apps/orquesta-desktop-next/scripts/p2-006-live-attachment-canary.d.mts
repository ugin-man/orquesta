/// <reference types="node" />

export interface RuntimeAttestation {
  version: string;
  executableSha256: string;
  executableSha256Verified: boolean;
  contractRef: string;
}

export interface LiveAttachmentProof {
  status: 'passed' | 'failed';
  mode: 'image' | 'text-resume';
  failure_code: string | null;
  pinned_runtime: Record<string, unknown>;
  attachment: Record<string, unknown>;
  cleanup: Record<string, unknown>;
  privacy: Record<string, unknown>;
  limits: Record<string, unknown>;
}

export function resolveRuntimeComponentReceipt(options: {
  receiptPath: string;
  repositoryRoot?: string | null;
  releaseVerifier?: (input: {
    repositoryRoot: string;
    attestationPath: string;
    desktopExe: string;
  }) => Record<string, any>;
}): Promise<{
  receiptKind: 'runtime-component' | 'desktop-release-attestation';
  manifestPath: string;
  sdkPackageRoot: string;
}>;

export function renderCodePng(
  code: string,
  options?: { scale?: number; padding?: number },
): Buffer;

export function assertSanitizedAttachmentProof<T>(proof: T, secrets?: string[]): T;

export function verifyResolvedRuntimeMeasurement(
  runtime: Record<string, unknown>,
  manifest: Record<string, unknown>,
  measuredSha256: string,
): RuntimeAttestation;

export function attestPinnedAttachmentRuntime(options?: {
  sdkPackageRoot?: string;
  manifestPath?: string;
  runtimeResolver?: (options: Record<string, unknown>) => Record<string, unknown>;
  fileHasher?: (filePath: string) => Promise<string>;
  manifestReader?: (manifestPath: string) => Promise<Record<string, unknown>>;
}): Promise<RuntimeAttestation>;

export function runLiveAttachmentCanary(options?: {
  mode?: 'image' | 'text-resume';
  adapterFactory?: () => Record<string, any>;
  runtimeAttestor?: () => Promise<RuntimeAttestation>;
  runtimeReceiptKind?: string;
  timeoutMs?: number;
  now?: () => string;
  temporaryDirectory?: string;
  codeFactory?: () => string;
  sourceRemover?: (path: string) => void;
}): Promise<LiveAttachmentProof>;
