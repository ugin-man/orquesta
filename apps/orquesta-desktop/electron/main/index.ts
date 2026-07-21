import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { CoreHost } from './core-host';
import { registerDesktopIpc } from './ipc-handlers';
import { createMainWindowOptions } from './window-options';
import { RepositoryService } from './repository-service';
import { DESKTOP_IPC } from '../shared/host-contract';
import { AttachmentService } from './attachment-service';
import { useFakeRuntimeCore } from './startup-mode';
import { SetupDraftStore } from './setup-draft-store';
import { resolveSetupLaunchIntent } from './setup-launch-intent';
import { SetupSourceService } from './setup-source-service';

if (squirrelStartup) app.quit();

const preloadPath = path.join(__dirname, 'preload.cjs');
const coreEntryPath = useFakeRuntimeCore(process.env) && !app.isPackaged
  ? path.join(__dirname, 'core-e2e.cjs')
  : path.join(__dirname, 'core.cjs');
const coreHost = new CoreHost({
  coreEntryPath,
  fork: (entryPath) => utilityProcess.fork(entryPath, [], { serviceName: 'Orquesta Core' })
});
const setupSources = new SetupSourceService();

let mainWindow: BrowserWindow | null = null;
let repositories: RepositoryService | null = null;
let setupDrafts: SetupDraftStore | null = null;
let quittingAfterServiceStop = false;
const initialLaunchIntent = resolveSetupLaunchIntent({ argv: process.argv, env: process.env, cwd: process.cwd() });

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
    const query: Record<string, string> = {};
    if (process.env.ORQUESTA_E2E === '1') {
      query.lang = 'en';
      query.startup = 'instant';
    }
    if (fixture) query.fixture = fixture;
    void window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), Object.keys(query).length ? { query } : undefined);
  }
  return window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const intent = resolveSetupLaunchIntent({ argv, env: process.env, cwd: workingDirectory });
    if (intent && repositories) void repositories.selectRoot(intent.rootPath, 'detected_root');
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.orquesta.desktop');
    setupDrafts = new SetupDraftStore({ storePath: path.join(app.getPath('userData'), 'setup-draft.json') });
    if (!await setupDrafts.read()) {
      await setupDrafts.save({
        revision: 1,
        status: 'draft',
        source: {
          kind: 'new_project',
          parentPath: path.join(app.getPath('documents'), 'Orquesta Projects'),
          folderName: 'New Orquesta Project'
        },
        projectName: 'New Orquesta Project',
        description: '',
        questions: [],
        answers: []
      });
    }
    repositories = new RepositoryService({
      registryPath: path.join(app.getPath('userData'), 'repositories.json'),
      coreHost,
      initialRootPath: initialLaunchIntent?.rootPath ?? null,
      prepareSetupSource: async (source) => {
        await setupDrafts?.save({
          revision: 1,
          status: 'draft',
          source,
          projectName: path.basename(source.rootPath),
          description: '',
          questions: [],
          answers: []
        });
      },
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
    }, {
      readDraft: () => setupDrafts?.read() ?? Promise.resolve(null),
      saveDraft: async (draft) => { await setupDrafts?.save(draft); },
      chooseSource: async (kind) => {
        const current = await setupDrafts?.read();
        if (kind === 'detected_root') return current?.source.kind === 'detected_root' ? current.source : null;
        if (kind === 'new_project') {
          return {
            kind,
            parentPath: path.join(app.getPath('documents'), 'Orquesta Projects'),
            folderName: current?.projectName || 'New Orquesta Project'
          };
        }
        if (kind === 'public_github') return current?.source.kind === 'public_github' ? current.source : null;
        const options = { title: 'Choose existing project folder', properties: ['openDirectory' as const] };
        const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
        return selection.canceled || !selection.filePaths[0] ? null : { kind, rootPath: selection.filePaths[0] };
      },
      start: async (draft) => {
        const materialized = await setupSources.materialize(draft.source);
        let started;
        try {
          started = await coreHost.startSetup({ rootPath: materialized.rootPath, draft });
        } catch (error) {
          await materialized.rollback().catch(() => undefined);
          throw error;
        }
        const selected = await repositories?.selectRoot(started.rootPath);
        if (!selected || selected.status !== 'accepted') {
          throw new Error(selected && selected.status !== 'accepted' ? selected.reason : 'Setup project could not be opened');
        }
        await setupDrafts?.clear();
        return started;
      }
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
