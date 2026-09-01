import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertViteBundleCapacity,
  explicitLoadTestExclusions,
  validateGenerationOutput,
} from './scripts/frontend-generation-policy.mjs';

const productRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => {
  const generationOutDir =
    command === 'build'
      ? validateGenerationOutput({
          productRoot,
          outDir: process.env.ORQUESTA_FRONTEND_OUT_DIR,
          buildId: process.env.ORQUESTA_FRONTEND_BUILD_ID,
          nonce: process.env.ORQUESTA_FRONTEND_BUILD_NONCE,
        })
      : undefined;
  const bundleMaxEntries =
    command === 'build'
      ? parseBoundedInteger('ORQUESTA_FRONTEND_BUNDLE_MAX_ENTRIES', 120)
      : 120;
  const bundleMaxBytes =
    command === 'build'
      ? parseBoundedInteger('ORQUESTA_FRONTEND_BUNDLE_MAX_BYTES', 60 * 1024 * 1024)
      : 60 * 1024 * 1024;

  return {
    plugins: [
      react(),
      {
        name: 'orquesta-frontend-generation-capacity',
        apply: 'build',
        generateBundle(_options, bundle) {
          assertViteBundleCapacity(bundle, {
            maxEntries: Math.min(120, bundleMaxEntries),
            maxBytes: Math.min(60 * 1024 * 1024, bundleMaxBytes),
          });
        },
      },
      {
        name: 'orquesta-dev-preview-entry',
        apply: 'serve',
        transformIndexHtml(html) {
          return html.replace('/src/main.tsx', '/src/preview-main.tsx');
        },
      },
    ],
    clearScreen: false,
    server: {
      host: '0.0.0.0',
      port: 1420,
      strictPort: true,
    },
    publicDir: command === 'build' ? false : 'public',
    build: {
      target: ['es2022', 'chrome120'],
      // Full production source maps exhaust the local Windows build process after
      // transformation; development retains Vite's normal source mapping while
      // release builds stay deterministic.
      sourcemap: false,
      // The coordinator creates a new UUID directory and a one-use marker.
      // Vite never deletes output; this also makes an incorrectly supplied env
      // incapable of recursively cleaning an existing directory.
      outDir: generationOutDir,
      emptyOutDir: false,
      chunkSizeWarningLimit: 1_250,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      // Node's built-in test suites have their own runner (`npm run test:runtime`).
      // Keeping them out of Vitest avoids executing node:test files as empty Vitest suites.
      exclude: [
        'runtime-node/**',
        'scripts/frontend-generation.test.mjs',
        ...explicitLoadTestExclusions(),
        'node_modules/**',
        'dist/**',
        'runtime-dist/**',
      ],
      restoreMocks: true,
      clearMocks: true,
    },
  };
});

function parseBoundedInteger(name: string, upperBound: number): number {
  const raw = process.env[name];
  if (!raw || !/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error(`frontend_generation_invalid_bundle_capacity:${name}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > upperBound) {
    throw new Error(`frontend_generation_invalid_bundle_capacity:${name}`);
  }
  return value;
}
