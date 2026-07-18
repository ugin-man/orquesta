import { build } from 'vite';
import { rm, rename } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'dist');
const staging = path.join(root, '.dist-staging');

await rm(staging, { force: true, recursive: true });

try {
  await build({
    configFile: false,
    root,
    base: './',
    build: {
      emptyOutDir: false,
      minify: false,
      outDir: staging,
      sourcemap: false,
      target: 'es2022'
    }
  });

  await rm(output, { force: true, recursive: true });
  await rename(staging, output);
} catch (error) {
  await rm(staging, { force: true, recursive: true });
  throw error;
}
