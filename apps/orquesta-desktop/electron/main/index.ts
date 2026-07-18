import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { CoreHost } from './core-host';
import { registerDesktopIpc } from './ipc-handlers';
import { createMainWindowOptions, createSplashWindowOptions, splashDocument } from './window-options';
import { RepositoryService } from './repository-service';
import { DESKTOP_IPC } from '../shared/host-contract';
import { AttachmentService } from './attachment-service';
import { createWindowReadinessGate, type WindowReadinessGate } from './window-readiness';
import { useFakeRuntimeCore } from './startup-mode';

if (squirrelStartup) app.quit();

const preloadPath = path.join(__dirname, 'preload.cjs');
const coreEntryPath = useFakeRuntimeCore(process.env) && !app.isPackaged
  ? path.join(__dirname, 'core-e2e.cjs')
  : path.join(__dirname, 'core.cjs');
const coreHost = new CoreHost({
  coreEntryPath,
  fork: (entryPath) => utilityProcess.fork(entryPath, [], { serviceName: 'Orquesta Core' })
});

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let repositories: RepositoryService | null = null;
let quittingAfterServiceStop = false;
let splashStartedAt = 0;
let readinessGate: WindowReadinessGate | null = null;

function createSplashWindow(): BrowserWindow {
  const window = new BrowserWindow(createSplashWindowOptions());
  splashStartedAt = Date.now();
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (splashWindow === window) splashWindow = null;
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashDocument())}`);
  return window;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(createMainWindowOptions(preloadPath));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  readinessGate = createWindowReadinessGate(() => {
    const reveal = () => {
      splashWindow?.close();
      splashWindow = null;
      window.show();
    };
    if (!splashWindow) reveal();
    else setTimeout(reveal, Math.max(0, 420 - (Date.now() - splashStartedAt)));
  });
  window.once('ready-to-show', () => readinessGate?.markWindowReady());
  window.on('closed', () => {
    readinessGate?.dispose();
    readinessGate = null;
    if (mainWindow === window) mainWindow = null;
  });

  const rendererUrl = process.env.ORQUESTA_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    const requestedFixture = process.env.ORQUESTA_E2E === '1' ? process.env.ORQUESTA_E2E_FIXTURE : undefined;
    const fixture = requestedFixture && /^[a-z0-9-]+$/.test(requestedFixture) ? requestedFixture : undefined;
    const query: Record<string, string> = {};
    if (process.env.ORQUESTA_E2E === '1') query.lang = 'en';
    if (fixture) query.fixture = fixture;
    void window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), Object.keys(query).length ? { query } : undefined);
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

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.orquesta.desktop');
    if (process.env.ORQUESTA_E2E !== '1') splashWindow = createSplashWindow();
    repositories = new RepositoryService({
      registryPath: path.join(app.getPath('userData'), 'repositories.json'),
      coreHost,
      initialRootPath: process.env.ORQUESTA_E2E === '1' ? process.env.ORQUESTA_E2E_PROJECT_ROOT : null,
      chooseDirectory: async () => {
        const options = { title: 'Open Orquesta project', properties: ['openDirectory' as const] };
        const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return selection.canceled ? null : selection.filePaths[0] ?? null;
      }
    });
    await repositories.initialize();
    const attachments = new AttachmentService({
      choosePaths: async () => {
        const options = {
          title: 'Attach images',
          properties: ['openFile' as const, 'multiSelections' as const],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
        };
        const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return selection.canceled ? [] : selection.filePaths;
      }
    });
    registerDesktopIpc(ipcMain, coreHost, repositories, attachments, {
      openExternal: (url) => shell.openExternal(url)
    });
    ipcMain.handle(DESKTOP_IPC.rendererReady, async () => {
      readinessGate?.markRendererReady();
      return { accepted: true };
    });
    mainWindow = createMainWindow();
    repositories.subscribe((snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_IPC.repositoryChanged, snapshot);
    });
    coreHost.subscribeRuntime((notification) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(DESKTOP_IPC.runtimeChanged, notification);
    });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quittingAfterServiceStop) return;
  event.preventDefault();
  void Promise.all([coreHost.stop(), repositories?.stop()]).finally(() => {
    quittingAfterServiceStop = true;
    app.quit();
  });
});
