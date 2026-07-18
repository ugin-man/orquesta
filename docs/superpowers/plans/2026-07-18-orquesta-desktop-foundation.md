# Orquesta Desktop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 承認済みReact Rendererを正式repositoryへ取り込み、Windows上で開発、test、packageできるElectronアプリ基盤を作る。

**Architecture:** Rendererは既存Vite buildを保ち、Electron main、preload、Orquesta Coreはesbuildで個別にCommonJS bundleへ変換する。Mainはwindowとprocess lifecycle、Coreは将来の`.orquesta`とCodex接続、Preloadは小さい型付きAPIだけを担当する。Electron ForgeはpackageとWindows installer生成だけに使い、実験的なForge Vite pluginへ依存しない。

**Tech Stack:** Electron 43.1.1、Electron Forge 7.11.2、React 19、TypeScript、Vite 8、esbuild、Vitest、Playwright Electron

## Global Constraints

- Windows上のElectronを正式な製品実行環境にする。外部ブラウザを製品として開かない。
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`を固定する。
- Rendererから`fs`、`path`、`child_process`、Electron、Codex App Serverへ直接触れない。
- Mainはwindow、native dialog、process lifecycle、IPC中継に限定する。
- Coreは別utility processとして起動し、Main終了時に残さない。
- Renderer source、fixture、既存testを維持する。誤生成画像と監査用screenshotは取り込まない。
- App Server、`.orquesta`実読込、組織図改修、書き込みactionはこの計画へ混ぜない。
- Node.js 22.12.0以上を使い、依存versionはlockfileへ固定する。
- Electronの基本セキュリティ設定は入れるが、独自の多段審査機構は追加しない。

---

### Task 1: Renderer sourceを正式repositoryへ取り込む

**Files:**
- Create: `apps/orquesta-desktop/package.json`
- Create: `apps/orquesta-desktop/package-lock.json`
- Create: `apps/orquesta-desktop/index.html`
- Create: `apps/orquesta-desktop/vite.config.ts`
- Create: `apps/orquesta-desktop/vitest.config.ts`
- Create: `apps/orquesta-desktop/playwright.config.ts`
- Create: `apps/orquesta-desktop/playwright.visual.config.ts`
- Create: `apps/orquesta-desktop/tsconfig.json`
- Create: `apps/orquesta-desktop/tsconfig.app.json`
- Create: `apps/orquesta-desktop/tsconfig.node.json`
- Create: `apps/orquesta-desktop/src/**`
- Create: `apps/orquesta-desktop/tests/unit/**`
- Create: `apps/orquesta-desktop/tests/browser/**`
- Create: `apps/orquesta-desktop/tests/visual/**`
- Create: `apps/orquesta-desktop/public/reference/orquesta-desktop-home-approved.png`
- Create: `apps/orquesta-desktop/public/reference/paper-grain.png`
- Create: `apps/orquesta-desktop/scripts/serve-dist.mjs`
- Create: `apps/orquesta-desktop/scripts/validate-lockfile.mjs`
- Create: `apps/orquesta-desktop/README.md`
- Create: `apps/orquesta-desktop/README-UI-HANDOFF.md`
- Create: `apps/orquesta-desktop/VALIDATION.md`

**Interfaces:**
- Consumes: `C:\Users\kouki\Downloads\orquesta-desktop-renderer-handoff-fixed.zip`、SHA-256 `36F4E7823CABFCD2B5AE88AFC3DFF6A3719258F12CA0B865FD9E750BBC9AF50C`
- Produces: `apps/orquesta-desktop`の再現可能なReact Renderer source

- [ ] **Step 1: packageのhashとpath安全性を再確認する**

Run:

```powershell
Get-FileHash C:\Users\kouki\Downloads\orquesta-desktop-renderer-handoff-fixed.zip -Algorithm SHA256
```

Expected: `36F4E7823CABFCD2B5AE88AFC3DFF6A3719258F12CA0B865FD9E750BBC9AF50C`

- [ ] **Step 2: 既存Renderer sourceを機械的に取り込む**

`apps/orquesta-desktop`を作り、handoff内の同名directoryから次を除外してcopyする。

```text
node_modules/
dist/
test-results/
artifacts/
tests/visual/__screenshots__/ 以外の一時screenshot
誤生成された画像
```

- [ ] **Step 3: clean installを実行する**

Run:

```powershell
cd apps/orquesta-desktop
npm ci --no-audit --no-fund
```

Expected: exit 0

- [ ] **Step 4: 既存Rendererのbaselineを確認する**

Run:

```powershell
npm run test
npm run build
npm run validate:lockfile
```

Expected: unit 22/22以上、build exit 0、lockfile validation exit 0

- [ ] **Step 5: importだけをcommitする**

```powershell
git add apps/orquesta-desktop
git commit -m "feat: import desktop renderer source"
```

---

### Task 2: Electron host契約をtest-firstで作る

**Files:**
- Create: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Create: `apps/orquesta-desktop/electron/main/window-options.ts`
- Create: `apps/orquesta-desktop/electron/main/window-options.test.ts`
- Create: `apps/orquesta-desktop/electron/core/protocol.ts`
- Create: `apps/orquesta-desktop/electron/core/protocol.test.ts`
- Modify: `apps/orquesta-desktop/vitest.config.ts`

**Interfaces:**
- Produces: `DesktopHostApi`、`CoreRequest`、`CoreEvent`、`createMainWindowOptions(preloadPath)`
- Consumes: Task 1のVitest環境

- [ ] **Step 1: secure window optionsの失敗testを書く**

```ts
import { describe, expect, test } from 'vitest';
import { createMainWindowOptions } from './window-options';

describe('createMainWindowOptions', () => {
  test('keeps the renderer isolated from Node and sandboxed', () => {
    const options = createMainWindowOptions('C:\\app\\preload.cjs');
    expect(options.webPreferences).toMatchObject({
      preload: 'C:\\app\\preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
    expect(options.minWidth).toBe(1180);
    expect(options.minHeight).toBe(720);
    expect(options.show).toBe(false);
  });
});
```

- [ ] **Step 2: REDを確認する**

Run:

```powershell
npx vitest run electron/main/window-options.test.ts
```

Expected: `Cannot find module './window-options'`

- [ ] **Step 3: 最小window optionsを実装する**

```ts
import type { BrowserWindowConstructorOptions } from 'electron';

export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#efede8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}
```

- [ ] **Step 4: Core protocolの失敗testを書く**

```ts
import { describe, expect, test } from 'vitest';
import { isCoreEvent } from './protocol';

describe('isCoreEvent', () => {
  test('accepts ready and rejects arbitrary objects', () => {
    expect(isCoreEvent({ type: 'core.ready', version: 1 })).toBe(true);
    expect(isCoreEvent({ type: 'core.ready', version: '1' })).toBe(false);
    expect(isCoreEvent({ type: 'anything' })).toBe(false);
  });
});
```

- [ ] **Step 5: REDを確認する**

Run:

```powershell
npx vitest run electron/core/protocol.test.ts
```

Expected: `Cannot find module './protocol'`

- [ ] **Step 6: 型とvalidatorを最小実装する**

```ts
export type CoreRequest = { type: 'core.shutdown' } | { type: 'core.ping'; correlationId: string };
export type CoreEvent =
  | { type: 'core.ready'; version: 1 }
  | { type: 'core.pong'; correlationId: string }
  | { type: 'core.stopped' };

export function isCoreEvent(value: unknown): value is CoreEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.type === 'core.ready') return event.version === 1;
  if (event.type === 'core.pong') return typeof event.correlationId === 'string';
  return event.type === 'core.stopped';
}
```

- [ ] **Step 7: GREENと既存unitを確認する**

Run:

```powershell
npm run test
```

Expected: all unit tests pass

- [ ] **Step 8: 契約をcommitする**

```powershell
git add apps/orquesta-desktop/electron apps/orquesta-desktop/vitest.config.ts
git commit -m "test: define secure desktop host contracts"
```

---

### Task 3: Main、Preload、Core processを実装する

**Files:**
- Create: `apps/orquesta-desktop/electron/main/index.ts`
- Create: `apps/orquesta-desktop/electron/main/core-host.ts`
- Create: `apps/orquesta-desktop/electron/main/core-host.test.ts`
- Create: `apps/orquesta-desktop/electron/preload/index.ts`
- Create: `apps/orquesta-desktop/electron/core/index.ts`
- Create: `apps/orquesta-desktop/src/electron-env.d.ts`

**Interfaces:**
- Consumes: `DesktopHostApi`、`CoreRequest`、`CoreEvent`、`createMainWindowOptions`
- Produces: Electron main entry、sandboxed preload、utility-process Core lifecycle

- [ ] **Step 1: CoreHost state machineの失敗testを書く**

```ts
import { describe, expect, test, vi } from 'vitest';
import { CoreHost } from './core-host';

test('marks ready only after a validated core.ready event', () => {
  const host = new CoreHost({ fork: vi.fn() });
  expect(host.status()).toBe('stopped');
  host.acceptEvent({ type: 'core.ready', version: 1 });
  expect(host.status()).toBe('ready');
  host.acceptEvent({ type: 'core.ready', version: '1' });
  expect(host.status()).toBe('ready');
});
```

- [ ] **Step 2: REDを確認する**

Run: `npx vitest run electron/main/core-host.test.ts`

Expected: `Cannot find module './core-host'`

- [ ] **Step 3: CoreHostを最小実装する**

`CoreHost`は`utilityProcess.fork()`をdependencyとして受け、ready、stopping、stoppedを管理する。任意objectをeventとして採用せず、`isCoreEvent()`を通す。`stop()`は`core.shutdown`を一度だけ送り、timeout後はchildをkillする。

- [ ] **Step 4: Preload APIを実装する**

公開するAPIは次だけにする。

```ts
export interface DesktopHostApi {
  getHostInfo(): Promise<{ platform: 'win32'; coreStatus: 'starting' | 'ready' | 'stopped' }>;
  pingCore(correlationId: string): Promise<{ correlationId: string }>;
}
```

`contextBridge.exposeInMainWorld('orquestaDesktop', api)`を使い、生の`ipcRenderer`を公開しない。

- [ ] **Step 5: Main entryを実装する**

Mainは次を行う。

```text
app single-instance lock
app.setAppUserModelId('com.orquesta.desktop')
utility process Core起動
BrowserWindow作成
ready-to-show後にshow
devはORQUESTA_RENDERER_URLをloadURL
productionはpackage内dist/index.htmlをloadFile
will-navigateを拒否
setWindowOpenHandlerでdeny
window-all-closedでquit
before-quitでCore停止
```

- [ ] **Step 6: Core entryを実装する**

Coreは起動時に`{ type: 'core.ready', version: 1 }`を送り、pingへpongを返し、shutdownでstoppedを送ってexit 0する。`.orquesta`やApp Serverはまだ読まない。

- [ ] **Step 7: GREENを確認する**

Run:

```powershell
npm run test
```

Expected: all unit tests pass

- [ ] **Step 8: process基盤をcommitする**

```powershell
git add apps/orquesta-desktop/electron apps/orquesta-desktop/src/electron-env.d.ts
git commit -m "feat: add Electron host and Core process"
```

---

### Task 4: 再現可能なbuild、dev起動、packageを作る

**Files:**
- Create: `apps/orquesta-desktop/scripts/build-desktop.mjs`
- Create: `apps/orquesta-desktop/scripts/dev-desktop.mjs`
- Create: `apps/orquesta-desktop/scripts/desktop-paths.mjs`
- Create: `apps/orquesta-desktop/scripts/desktop-paths.test.mjs`
- Create: `apps/orquesta-desktop/forge.config.cjs`
- Modify: `apps/orquesta-desktop/package.json`
- Modify: `apps/orquesta-desktop/package-lock.json`
- Modify: `apps/orquesta-desktop/.gitignore`
- Modify: `apps/orquesta-desktop/README.md`

**Interfaces:**
- Consumes: Task 3のentry files
- Produces: `npm run dev:desktop`、`npm run build:desktop`、`npm run package:win`、`npm run make:win`

- [ ] **Step 1: path解決の失敗testを書く**

```js
import assert from 'node:assert/strict';
import { resolveDesktopPaths } from './desktop-paths.mjs';

const paths = resolveDesktopPaths('C:\\repo\\apps\\orquesta-desktop');
assert.equal(paths.rendererDist, 'C:\\repo\\apps\\orquesta-desktop\\dist');
assert.equal(paths.electronDist, 'C:\\repo\\apps\\orquesta-desktop\\dist-electron');
```

- [ ] **Step 2: REDを確認する**

Run: `node scripts/desktop-paths.test.mjs`

Expected: `Cannot find module './desktop-paths.mjs'`

- [ ] **Step 3: script-relative path解決を実装する**

`resolveDesktopPaths(appRoot)`は`dist`、`dist-electron`、main、preload、Coreの絶対pathを返す。`process.cwd()`だけで配布pathを決めない。

- [ ] **Step 4: ElectronとForge依存を正確に固定する**

Run:

```powershell
npm install --save-exact electron-squirrel-startup@1.0.1
npm install --save-dev --save-exact electron@43.1.1 esbuild@0.28.1 @electron-forge/cli@7.11.2 @electron-forge/maker-squirrel@7.11.2 @electron-forge/maker-zip@7.11.2
```

`package.json`へ次を追加する。

```json
{
  "main": "dist-electron/main.cjs",
  "productName": "Orquesta",
  "description": "Windows desktop client for Orquesta multi-agent coordination",
  "author": "Orquesta",
  "scripts": {
    "dev:desktop": "node scripts/dev-desktop.mjs",
    "build:desktop": "npm run build && node scripts/build-desktop.mjs",
    "start:desktop": "npm run build:desktop && electron .",
    "package:win": "npm run build:desktop && electron-forge package --platform win32 --arch x64",
    "make:win": "npm run build:desktop && electron-forge make --platform win32 --arch x64",
    "test:desktop-unit": "vitest run electron",
    "test:desktop-smoke": "npm run build:desktop && playwright test --config=playwright.electron.config.ts"
  }
}
```

- [ ] **Step 5: build scriptを実装する**

`build-desktop.mjs`はesbuild APIでmain、preload、Coreを`dist-electron/*.cjs`へbundleする。platformは`node`、formatは`cjs`、targetはElectron同梱Nodeに合わせ、`electron`をexternalにする。

- [ ] **Step 6: dev scriptを実装する**

`dev-desktop.mjs`は空きloopback portでViteを起動し、HTTP readyを待ち、`ORQUESTA_RENDERER_URL`を渡してElectronをforeground起動する。どちらかが終了したらもう一方を止め、stderrを隠さない。外部ブラウザは開かない。

- [ ] **Step 7: Forge configを実装する**

```js
module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Orquesta',
    executableName: 'Orquesta',
    ignore: [/^\/.git($|\/)/, /^\/tests($|\/)/, /^\/artifacts($|\/)/, /^\/test-results($|\/)/]
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'Orquesta', setupExe: 'OrquestaSetup.exe' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] }
  ]
};
```

- [ ] **Step 8: buildを確認する**

Run:

```powershell
node scripts/desktop-paths.test.mjs
npm run build:desktop
```

Expected: `dist/index.html`、`dist-electron/main.cjs`、`preload.cjs`、`core.cjs`が存在し、exit 0

- [ ] **Step 9: build基盤をcommitする**

```powershell
git add apps/orquesta-desktop
git commit -m "build: add Windows Electron toolchain"
```

---

### Task 5: Electron integration testとWindows packageを検証する

**Files:**
- Create: `apps/orquesta-desktop/playwright.electron.config.ts`
- Create: `apps/orquesta-desktop/tests/electron/desktop-shell.spec.ts`
- Create: `apps/orquesta-desktop/scripts/measure-desktop.mjs`
- Create: `apps/orquesta-desktop/docs/validation/desktop-foundation.md`
- Modify: `apps/orquesta-desktop/package.json`

**Interfaces:**
- Consumes: package済みElectron host、`window.orquestaDesktop`
- Produces: Windows smoke証拠、起動時間、memory、package footprintの記録

- [ ] **Step 1: Electron smokeの失敗testを書く**

```ts
import { _electron as electron, expect, test } from '@playwright/test';

test('loads the Orquesta renderer inside an isolated Electron window', async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle(/Orquesta/);
  expect(await page.evaluate(() => typeof (window as Window & { require?: unknown }).require)).toBe('undefined');
  expect(await page.evaluate(() => window.orquestaDesktop.getHostInfo())).toMatchObject({ platform: 'win32' });
  await expect(page.getByLabel('Orquesta Map')).toBeVisible();
  await app.close();
});
```

- [ ] **Step 2: REDを確認する**

Run: `npm run test:desktop-smoke`

Expected: testがhost API、entry、またはElectron起動未接続を理由に失敗する

- [ ] **Step 3: smokeに必要な不足だけ修正する**

Host API、title、main entry、preload path、Core ready待ちのうち、失敗原因になった箇所だけを修正する。testを弱めない。

- [ ] **Step 4: Electron smokeをGREENにする**

Run:

```powershell
npm run test:desktop-smoke
```

Expected: Electron smoke 1/1以上pass、app.close後にElectron childが残らない

- [ ] **Step 5: packageを生成する**

Run:

```powershell
npm run package:win
```

Expected: `out/Orquesta-win32-x64/Orquesta.exe`が存在する

- [ ] **Step 6: package済みexeをsmokeする**

`measure-desktop.mjs`はpackage済みexeを起動し、Home readyまでの時間、60秒後working set、directory footprintをJSONとMarkdownへ記録して終了する。測定失敗を0として記録せず、commandをexit 1にする。

Run:

```powershell
node scripts/measure-desktop.mjs out/Orquesta-win32-x64/Orquesta.exe
```

Expected: cold start、idle working set、footprintが`docs/validation/desktop-foundation.md`へ実測値として記録される

- [ ] **Step 7: 全Foundation検証を実行する**

Run:

```powershell
npm run test
npm run build:desktop
npm run test:desktop-smoke
npm run package:win
npm run validate:lockfile
```

Expected: すべてexit 0。visual regressionはWindows/Electron専用baselineを作るまでFoundation合格条件へ含めない。

- [ ] **Step 8: Desktop Foundationをcommitする**

```powershell
git add apps/orquesta-desktop
git commit -m "test: verify packaged Orquesta desktop foundation"
```

---

## Completion Boundary

この計画が完了しても、Orquesta Desktop全体は完成ではない。次に`Map Stabilization`、`Read-only Integration`、`Runtime Actions`を別計画で実装する。

この計画の完了条件は、承認済みRendererがWindowsのElectron windowとpackage済み`Orquesta.exe`で起動し、secure preload、utility-process Core、再現可能なbuild、Electron smoke、実測記録がそろっていることである。
