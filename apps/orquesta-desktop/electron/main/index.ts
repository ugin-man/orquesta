import path from 'node:path';
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { CoreHost } from './core-host';
import { registerDesktopIpc } from './ipc-handlers';
import { createMainWindowOptions } from './window-options';

if (squirrelStartup) app.quit();

const preloadPath = path.join(__dirname, 'preload.cjs');
const coreEntryPath = path.join(__dirname, 'core.cjs');
const coreHost = new CoreHost({
  coreEntryPath,
  fork: (entryPath) => utilityProcess.fork(entryPath, [], { serviceName: 'Orquesta Core' })
});

let mainWindow: BrowserWindow | null = null;
let quittingAfterCoreStop = false;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(createMainWindowOptions(preloadPath));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const rendererUrl = process.env.ORQUESTA_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    const requestedFixture = process.env.ORQUESTA_E2E === '1' ? process.env.ORQUESTA_E2E_FIXTURE : undefined;
    const fixture = requestedFixture && /^[a-z0-9-]+$/.test(requestedFixture) ? requestedFixture : undefined;
    void window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), fixture ? { query: { fixture } } : undefined);
  }
  return window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.orquesta.desktop');
    coreHost.start();
    registerDesktopIpc(ipcMain, coreHost);
    mainWindow = createMainWindow();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quittingAfterCoreStop || coreHost.status() === 'stopped') return;
  event.preventDefault();
  void coreHost.stop().finally(() => {
    quittingAfterCoreStop = true;
    app.quit();
  });
});
