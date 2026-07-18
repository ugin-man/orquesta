import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';
import { buildDesktopHost } from './build-desktop.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, '..');

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForRenderer(url, processHandle) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Vite exited before it became ready (${processHandle.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The loopback server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

await buildDesktopHost();
const port = await reserveLoopbackPort();
const rendererUrl = `http://127.0.0.1:${port}`;
const viteCli = path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: appRoot,
  stdio: 'inherit'
});

let desktop;
try {
  await waitForRenderer(rendererUrl, vite);
  desktop = spawn(electronPath, ['.'], {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, ORQUESTA_RENDERER_URL: rendererUrl }
  });
  const exitCode = await new Promise((resolve) => desktop.once('exit', (code) => resolve(code ?? 1)));
  process.exitCode = exitCode;
} finally {
  if (desktop && desktop.exitCode === null) desktop.kill();
  if (vite.exitCode === null) vite.kill();
}
