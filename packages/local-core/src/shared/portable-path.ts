import path from 'node:path';

function usesWindowsPathSyntax(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]/u.test(value);
}

function implementationFor(value: string): typeof path.posix | typeof path.win32 {
  return usesWindowsPathSyntax(value) ? path.win32 : path;
}

export function isPortableAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function portableBasename(value: string): string {
  return implementationFor(value).basename(value);
}

export function portableJoin(base: string, ...parts: string[]): string {
  return implementationFor(base).join(base, ...parts);
}

export function portableResolve(value: string): string {
  return implementationFor(value).resolve(value);
}
