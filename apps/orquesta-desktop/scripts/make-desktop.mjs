import { access, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, '..');
const temporaryOut = await mkdtemp(path.join(os.tmpdir(), 'orquesta-forge-'));
const forgeCli = path.join(appRoot, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
const finalPackageDirectory = path.join(appRoot, 'out', 'Orquesta-win32-x64');
const finalMakeDirectory = path.join(appRoot, 'out', 'make');

function runForgeMake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [forgeCli, 'make', '--platform', 'win32', '--arch', 'x64'], {
      cwd: appRoot,
      env: { ...process.env, ORQUESTA_FORGE_OUT_DIR: temporaryOut },
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Electron Forge make failed with exit code ${code}`));
    });
  });
}

try {
  await runForgeMake();
  const temporaryPackageDirectory = path.join(temporaryOut, 'Orquesta-win32-x64');
  const temporaryMakeDirectory = path.join(temporaryOut, 'make');
  await Promise.all([access(temporaryPackageDirectory), access(temporaryMakeDirectory)]);
  await Promise.all([
    rm(finalPackageDirectory, { force: true, recursive: true }),
    rm(finalMakeDirectory, { force: true, recursive: true })
  ]);
  await mkdir(path.dirname(finalMakeDirectory), { recursive: true });
  await Promise.all([
    cp(temporaryPackageDirectory, finalPackageDirectory, { recursive: true }),
    cp(temporaryMakeDirectory, finalMakeDirectory, { recursive: true })
  ]);
} finally {
  await rm(temporaryOut, { force: true, recursive: true });
}
