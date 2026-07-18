# Orquesta V4 Desktop Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the approved Electron desktop shell with Orquesta V4, run the coordinator through one pinned bundled Codex runtime, expose real conversation/approval/V4 operational state, and ship a measured Windows x64 package without duplicating the canonical V4 or Codex Adapter logic.

**Architecture:** Electron Main owns Windows-only window, dialog, registry, safe deep-link, and IPC work. The forked Orquesta Core owns repository interpretation, file watching, V4 journal replay, runtime lifecycle, approval relay, and conversation projection. Renderer receives typed snapshots and actions only. `@orquesta/codex-adapter` is the only Codex protocol implementation; the Desktop deletes its raw App Server client after the canonical adapter is wired.

**Tech Stack:** Electron 43, React 19, TypeScript 5.7, Vite 7, Vitest 4, Playwright Electron, Node.js 22, Orquesta V4 CommonJS workspace packages, `@openai/codex-sdk@0.144.5`, `@openai/codex@0.144.5`, and the npm alias `@openai/codex-win32-x64 -> @openai/codex@0.144.5-win32-x64`.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-07-18-orquesta-v4-desktop-integration-design.md`. If this plan and the design disagree, stop and amend the plan before changing product code.
- Use `superpowers:test-driven-development` for every behavior change: add one failing test, run it and confirm the intended failure, implement the smallest behavior, then rerun the focused test.
- Keep commits scoped to the task described below. Do not combine later cleanup with an earlier behavior commit.
- Do not discover Codex through `PATH`, `ORQUESTA_CODEX_PATH`, WindowsApps, the registry, an arbitrary executable parameter, or `shell: true`.
- Do not add a second safety-policy engine. Codex remains responsible for sandboxing and approvals; Orquesta transports approval requests and records the user's decision.
- Never report `thread/start.model` or the requested model as `actualModel`. `actualModel` remains `null` unless a runtime event independently observes it.
- Keep `apps/orquesta-desktop` outside the root npm workspace. Its independent lockfile is intentional because the Windows runtime is large and platform-specific.
- Main must not parse `.orquesta` product state. Core must not open arbitrary external URLs or Windows dialogs. Renderer must not receive raw absolute runtime paths, tokens, or App Server messages.
- Keep the central map visually dominant and keep every agent visible. The integration work must not collapse idle agents or replace the existing free pan/zoom map.
- Runtime staging happens only for packaging and the dedicated packaged-runtime test. Normal renderer/unit builds must not copy the approximately 390 MiB runtime.
- Human review gates are after Slice 3 and after Slice 5. Do not claim either gate passed without the user's explicit review.

---

## Task 1: Merge V4 and preserve the independent Desktop dependency boundary

**Files:**

- Create: `scripts/v4/desktop-workspace-boundary.test.js`
- Modify: `scripts/v4/phase-boundary-check.js`
- Modify: `scripts/v4/phase-boundary-check.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/superpowers/specs/2026-07-15-orquesta-v4-design.md`
- Verify: `docs/superpowers/specs/2026-07-18-orquesta-v4-desktop-integration-design.md`

- [x] Record the pre-merge commits and merge V4 without squashing:

  ```powershell
  git rev-parse HEAD
  git rev-parse codex/orquesta-v4-phase1
  git merge --no-ff codex/orquesta-v4-phase1
  ```

  Expected conflict: only `docs/superpowers/specs/2026-07-15-orquesta-v4-design.md`.

- [x] Resolve the V4 design conflict by retaining the Phase 2-refined V4 text, including its original Desktop exclusion, then add one short note that the separately approved Desktop phase is governed by `docs/superpowers/specs/2026-07-18-orquesta-v4-desktop-integration-design.md`. Do not rewrite Phase 2A/2B as if Desktop had already been included.

- [x] Add the failing workspace-boundary test. It must parse root `package.json` and assert the exact workspace list:

  ```js
  assert.deepEqual(packageJson.workspaces, ["apps/workbench", "packages/*"]);
  assert.equal(fs.existsSync(path.join(root, "apps/orquesta-desktop/package-lock.json")), true);
  ```

- [x] Run the test and confirm it fails because V4 currently uses `apps/*`:

  ```powershell
  node --test scripts/v4/desktop-workspace-boundary.test.js
  ```

- [x] Change root `workspaces` to exactly `apps/workbench` and `packages/*`, run `npm install` at the repository root, and keep `apps/orquesta-desktop/package-lock.json` untouched in this task.

- [x] Update the existing Phase 1 boundary checker and its test to accept the exact workspace list above while still rejecting `apps/desktop`, Phase 3 packages, and plugin surfaces. Assert that `apps/orquesta-desktop` exists but has no root lockfile workspace link.

- [x] Run the focused and merged baselines:

  ```powershell
  node --test scripts/v4/desktop-workspace-boundary.test.js
  npm run check:v4:phase1
  npm run check:v4:phase15
  npm run check:v4:phase2
  npm test --prefix apps/orquesta-desktop
  ```

- [x] Commit:

  ```powershell
  git add package.json package-lock.json scripts/v4/desktop-workspace-boundary.test.js docs/superpowers/specs/2026-07-15-orquesta-v4-design.md
  git commit -m "merge: integrate V4 with desktop branch"
  ```

---

## Task 2: Install and stage the exact pinned Windows Codex runtime

**Files:**

- Modify: `apps/orquesta-desktop/package.json`
- Modify: `apps/orquesta-desktop/package-lock.json`
- Modify: `.gitignore`
- Create: `apps/orquesta-desktop/scripts/prepare-codex-runtime.mjs`
- Create: `apps/orquesta-desktop/scripts/prepare-codex-runtime.test.mjs`
- Create: `apps/orquesta-desktop/electron/core/runtime-location.ts`
- Create: `apps/orquesta-desktop/electron/core/runtime-location.test.ts`
- Create: `apps/orquesta-desktop/electron/core/runtime-integrity.ts`
- Create: `apps/orquesta-desktop/electron/core/runtime-integrity.test.ts`
- Modify: `apps/orquesta-desktop/forge.config.cjs`
- Modify: `apps/orquesta-desktop/scripts/make-desktop.mjs`

- [ ] Add failing tests which require `prepareCodexRuntime()` to copy only these package directories into `.runtime-staging/codex-runtime/node_modules/@openai/` and reject any version mismatch:

  ```text
  codex-sdk                 0.144.5
  codex                     0.144.5
  codex-win32-x64           0.144.5-win32-x64
  ```

  The test must also assert that a fourth sibling package is not copied and that the returned SDK root ends with `node_modules\@openai\codex-sdk`.

- [ ] Add failing `runtime-location.test.ts` cases for both locations:

  ```ts
  resolveDesktopSdkPackageRoot({ packaged: false, appRoot: 'C:\\app', resourcesPath: 'ignored' })
  // C:\app\node_modules\@openai\codex-sdk

  resolveDesktopSdkPackageRoot({ packaged: true, appRoot: 'ignored', resourcesPath: 'C:\\Program Files\\Orquesta\\resources' })
  // C:\Program Files\Orquesta\resources\codex-runtime\node_modules\@openai\codex-sdk
  ```

- [ ] Run both focused tests and confirm the missing module/function failures:

  ```powershell
  node --test apps/orquesta-desktop/scripts/prepare-codex-runtime.test.mjs
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- runtime-location.test.ts
  ```

- [ ] Add these exact Desktop dependencies, then run `npm install` inside `apps/orquesta-desktop`:

  ```json
  {
    "@orquesta/codex-adapter": "file:../../packages/codex-adapter",
    "@openai/codex-sdk": "0.144.5",
    "@openai/codex": "0.144.5",
    "@openai/codex-win32-x64": "npm:@openai/codex@0.144.5-win32-x64"
  }
  ```

- [ ] Implement `prepare-codex-runtime.mjs` with `fs.cp`, strict `package.json` name/version checks, a clean staging-directory replacement, and an exported `prepareCodexRuntime({ appRoot, stagingRoot })`. It must never resolve from global npm locations.

- [ ] During staging, verify that Desktop `package-lock.json` has registry `resolved` and `integrity` fields for all three OpenAI packages. Write `runtime-manifest.json` containing the exact package names/versions plus relative path, byte length, and SHA-256 for each copied `package.json` and the selected `codex.exe`. Add failing tamper tests, then implement `verifyDesktopRuntimeIntegrity()` to compare the packaged files to that manifest immediately before the first App Server spawn. This detects install/copy corruption; the final docs must still state that an unsigned package cannot resist an attacker who can modify both application and manifest.

- [ ] Implement `resolveDesktopSdkPackageRoot()` as a pure path function. It returns the development root under Desktop `node_modules`, or the packaged root under `process.resourcesPath/codex-runtime/node_modules`.

- [ ] Add `.runtime-staging/` to `.gitignore`. Add Forge `extraResource` for `.runtime-staging/codex-runtime` with destination `codex-runtime`. Invoke staging immediately before Forge in `make-desktop.mjs`; do not invoke it from `build`, `build:host`, or renderer tests.

- [ ] Verify exact installation and focused tests:

  ```powershell
  npm ls --prefix apps/orquesta-desktop @orquesta/codex-adapter @openai/codex-sdk @openai/codex @openai/codex-win32-x64
  node --test apps/orquesta-desktop/scripts/prepare-codex-runtime.test.mjs
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- runtime-location.test.ts
  npm run validate:lockfile --prefix apps/orquesta-desktop
  ```

- [ ] Commit:

  ```powershell
  git add .gitignore apps/orquesta-desktop/package.json apps/orquesta-desktop/package-lock.json apps/orquesta-desktop/scripts/prepare-codex-runtime.mjs apps/orquesta-desktop/scripts/prepare-codex-runtime.test.mjs apps/orquesta-desktop/electron/core/runtime-location.ts apps/orquesta-desktop/electron/core/runtime-location.test.ts apps/orquesta-desktop/electron/core/runtime-integrity.ts apps/orquesta-desktop/electron/core/runtime-integrity.test.ts apps/orquesta-desktop/forge.config.cjs apps/orquesta-desktop/scripts/make-desktop.mjs
  git commit -m "build: stage pinned Codex runtime for desktop"
  ```

---

## Task 3: Add canonical thread history and runtime metadata operations

**Files:**

- Modify: `packages/codex-adapter/protocol/app-server-schema.json`
- Modify: `packages/codex-adapter/src/contract.js`
- Modify: `packages/codex-adapter/src/app-server-adapter.js`
- Modify: `packages/codex-adapter/src/repository-adapter.js`
- Modify: `packages/codex-adapter/src/sdk-adapter.js`
- Modify: `packages/codex-adapter/test/contract.test.js`
- Modify: `packages/codex-adapter/test/app-server-adapter.test.js`
- Modify: `packages/codex-adapter/test/repository-adapter.test.js`
- Modify: `packages/codex-adapter/test/sdk-adapter.test.js`

- [ ] Add failing contract tests requiring these new capability methods on all adapters:

  ```js
  readThread({ correlationId, threadId, includeTurns: true })
  runtimeInfo({ correlationId, probe: false })
  shutdown({ correlationId })
  ```

  `readThread` may return `unsupported` on Repository and SDK adapters. `runtimeInfo({ probe: false })` must not spawn a process; `probe: true` may initialize App Server to collect platform/user-agent evidence. Neither form may include an executable path. `shutdown` must return a completed result even when the adapter was never started.

- [ ] Add a failing App Server schema test for `thread/read` with `params_required: ["threadId"]` and `response_required: ["thread"]`. `includeTurns` is optional and must default to `true` in the adapter.

- [ ] Run the focused tests and confirm the missing capability/schema failures:

  ```powershell
  node --test packages/codex-adapter/test/contract.test.js packages/codex-adapter/test/app-server-adapter.test.js packages/codex-adapter/test/repository-adapter.test.js packages/codex-adapter/test/sdk-adapter.test.js
  ```

- [ ] Extend `CAPABILITY_METHODS` and the capability objects without renaming or weakening any existing operation.

- [ ] Implement App Server `readThread` through the canonical validator and transport:

  ```js
  const params = { threadId, includeTurns };
  validateRequest("thread/read", params);
  const result = await transport.request("thread/read", params);
  validateResponse("thread/read", result);
  return success("readThread", correlationId, { thread_id: threadId, thread: result.thread });
  ```

- [ ] Implement `runtimeInfo` from validated runtime and, only with `probe: true`, initialize metadata. Return package names/versions, target triple, platform family/OS, user agent, and adapter name. Exclude `executable_path`, `codexHome`, environment variables, and authentication material.

- [ ] Implement Repository/SDK behavior exactly as tested: Repository and SDK `readThread` return `unsupported`; Repository `shutdown` is a completed no-op; SDK `shutdown` aborts tracked streams and clears internal state; both return non-secret package/adapter metadata from `runtimeInfo`.

- [ ] Run the full adapter suite and V4 Phase 2 check:

  ```powershell
  npm test --workspace @orquesta/codex-adapter
  npm run check:v4:phase2
  ```

- [ ] Commit:

  ```powershell
  git add packages/codex-adapter
  git commit -m "feat: extend canonical Codex adapter operations"
  ```

---

## Task 4: Give the JSONL transport a bounded graceful shutdown

**Files:**

- Modify: `packages/codex-adapter/src/jsonl-transport.js`
- Modify: `packages/codex-adapter/src/app-server-adapter.js`
- Modify: `packages/codex-adapter/test/jsonl-transport.test.js`
- Modify: `packages/codex-adapter/test/app-server-adapter.test.js`

- [ ] Add failing transport tests for all shutdown paths:

  - `shutdown()` ends stdin and resolves when the child emits `exit`.
  - pending requests reject with `App Server transport shut down`.
  - a child which does not exit is killed after the supplied timeout.
  - two concurrent `shutdown()` calls share one promise and kill at most once.
  - a protocol failure followed by `shutdown()` still ends or kills the child.

- [ ] Run the focused test and confirm `shutdown` is absent:

  ```powershell
  node --test packages/codex-adapter/test/jsonl-transport.test.js
  ```

- [ ] Implement `shutdown({ timeoutMs = 1500 } = {})` on the transport. Register the exit listener before calling `stdin.end()`, reject pending requests once, and call `process.kill()` only if the exit timeout expires. Keep `close(reason)` as the immediate protocol-failure path.

- [ ] Store the resolved runtime and initialize response in App Server adapter state. Wire adapter `shutdown` to `approvalRelay.reset()`, clear turn/thread maps and listeners, await `transport.shutdown()`, then null all transport/runtime initialization state so a later operation can restart cleanly.

- [ ] Run the adapter suite twice to catch leaked process/listener state:

  ```powershell
  npm test --workspace @orquesta/codex-adapter
  npm test --workspace @orquesta/codex-adapter
  ```

- [ ] Commit:

  ```powershell
  git add packages/codex-adapter/src/jsonl-transport.js packages/codex-adapter/src/app-server-adapter.js packages/codex-adapter/test/jsonl-transport.test.js packages/codex-adapter/test/app-server-adapter.test.js
  git commit -m "fix: shut down Codex App Server cleanly"
  ```

---

## Task 5: Replace the Desktop's duplicate runtime client with the canonical adapter

**Files:**

- Create: `apps/orquesta-desktop/electron/core/desktop-codex-service.ts`
- Create: `apps/orquesta-desktop/electron/core/desktop-codex-service.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/handler.ts`
- Modify: `apps/orquesta-desktop/electron/core/handler.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/index.ts`
- Delete: `apps/orquesta-desktop/electron/core/app-server-client.ts`
- Delete: `apps/orquesta-desktop/electron/core/app-server-client.test.ts`
- Delete: `apps/orquesta-desktop/electron/core/codex-executable.ts`
- Delete: `apps/orquesta-desktop/electron/core/codex-executable.test.ts`
- Delete: `apps/orquesta-desktop/electron/core/codex-runtime.ts`
- Delete: `apps/orquesta-desktop/electron/core/codex-runtime.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.test.ts`
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.test.ts`
- Modify: `apps/orquesta-desktop/src/contracts/bridge.ts`
- Modify: `apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts`

- [ ] Add failing service tests with an injected canonical adapter double. Require `DesktopCodexService` to:

  - create or resume the saved coordinator thread;
  - wrap non-orchestrator text in `<orquesta_target agent_id="…">` without exposing the wrapper in history;
  - pass `cwd` and image inputs to `createThread`/`resumeThread` and `startTurn`;
  - pass only `cwd` and model/input fields needed for the turn, omitting `approvalPolicy` and `sandbox` so the bundled Codex runtime applies the user's Codex configuration;
  - return `recommendedModel`, `requestedModel`, and `appliedModel` separately while `actualModel` stays `null` until `model_observed`;
  - invoke adapter `shutdown()` once.

- [ ] Add a failing source-boundary test which scans `apps/orquesta-desktop/electron` and rejects `ORQUESTA_CODEX_PATH`, `WindowsApps`, `where.exe`, `shell: true`, and imports of the three deleted runtime modules.

- [ ] Run focused tests and confirm the missing service/boundary failures:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- desktop-codex-service.test.ts handler.test.ts protocol.test.ts
  ```

- [ ] Implement `DesktopCodexService` with `createAppServerAdapter({ sdkPackageRoot })`. The SDK root comes only from `resolveDesktopSdkPackageRoot()` and the adapter resolves the executable inside that pinned installation.

- [ ] Before creating the packaged adapter, call `verifyDesktopRuntimeIntegrity()` once and cache only the successful result for that Core process. Add typed `runtime.info` Core request/result and `getRuntimeInfo({ probe: boolean })` host/Preload/Renderer bridge methods returning this non-secret DTO:

  ```ts
  export interface RuntimeInfoUi {
    status: 'not_started' | 'ready' | 'unavailable';
    adapter: 'app_server';
    sdkVersion: string | null;
    codexVersion: string | null;
    runtimeVersion: string | null;
    targetTriple: string | null;
    platformFamily: string | null;
    platformOs: string | null;
    userAgent: string | null;
    integrity: 'verified' | 'unverified' | 'failed';
  }
  ```

  Do not include `codexHome`, executable paths, usernames, environment values, or tokens.

- [ ] Map canonical adapter events into Core protocol events. Use these exact distinctions:

  ```ts
  type RuntimeModelEvidence = {
    recommendedModel: string | null;
    requestedModel: string | null;
    appliedModel: string | null;
    actualModel: string | null;
    actualModelEvidence: 'proven' | 'reported' | 'inferred' | 'unknown';
  };
  ```

  `model_observed` may set `actualModel` and `actualModelEvidence: 'proven'`; no other event may do so.

- [ ] On canonical `turn_completed`, read the completed thread once, project the newest agent message, emit `agent_message`, then emit the completed state. Add tests proving the UI never invents an agent reply from a progress item and does not duplicate the same message when history is opened later.

- [ ] Update Core handler/index lifecycle and delete the duplicate client/runtime/executable modules and their tests. The product must have one protocol validator, one approval relay, and one runtime resolver after this commit.

- [ ] Verify focused, full Desktop, and adapter tests:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop
  npm test --prefix apps/orquesta-desktop
  npm test --workspace @orquesta/codex-adapter
  rg -n "ORQUESTA_CODEX_PATH|WindowsApps|where\.exe|shell:\s*true|app-server-client|codex-executable|codex-runtime" apps/orquesta-desktop/electron
  ```

  Expected `rg` result: no production matches; only the boundary test may contain the forbidden strings.

- [ ] Commit:

  ```powershell
  git add apps/orquesta-desktop/electron/core apps/orquesta-desktop/electron/main apps/orquesta-desktop/electron/shared apps/orquesta-desktop/electron/preload apps/orquesta-desktop/src/contracts/bridge.ts apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts
  git commit -m "refactor: use canonical Codex adapter in desktop core"
  ```

---

## Task 6: Move repository projection and watching from Main into Core

**Files:**

- Move: `apps/orquesta-desktop/electron/main/repository-reader.ts` -> `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Move: `apps/orquesta-desktop/electron/main/repository-reader.test.ts` -> `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- Create: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Create: `apps/orquesta-desktop/electron/core/repository-runtime.test.ts`
- Create: `apps/orquesta-desktop/electron/main/project-registry.ts`
- Create: `apps/orquesta-desktop/electron/main/project-registry.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/handler.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.ts`

- [ ] Add failing protocol tests for:

  ```ts
  { type: 'repository.select', correlationId, projectId, rootPath }
  { type: 'repository.get-snapshot', correlationId }
  { type: 'repository.snapshot.result', correlationId, snapshot }
  { type: 'repository.snapshot.changed', snapshot }
  { type: 'repository.close', correlationId }
  ```

  Validate project IDs and bounded paths with the existing guards.

- [ ] Add failing repository-runtime tests proving that Core reads `.orquesta/state`, watches `.orquesta/state`, `.orquesta/vision`, `.orquesta/failures`, and `.orquesta/v4`, debounces changes, retains the last snapshot as offline on read failure, and closes all watchers on project switch/shutdown.

- [ ] Add a failing Main-boundary test which rejects imports of `repository-reader`, `@orquesta/core`, or `@orquesta/event-store` from `electron/main`.

- [ ] Run the focused tests and confirm they fail before moving behavior:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- repository-runtime.test.ts project-registry.test.ts repository-service.test.ts core-host.test.ts protocol.test.ts
  ```

- [ ] Move the pure reader unchanged first and rerun its existing tests from Core. Then extract only app-owned registry persistence, recent-project selection, directory choice, and coordinator-thread ID into `project-registry.ts`.

- [ ] Implement `RepositoryRuntime` in Core. `RepositoryService` in Main chooses/selects a root and asks `CoreHost` to project it; it never opens product state files itself. `CoreHost` forwards snapshot result/change events to existing IPC subscribers.

- [ ] Preserve lazy Core startup: no selected project keeps Core stopped; selecting a project starts Core. Runtime initialization remains lazy inside Core until the user sends, reads conversation, or opens runtime metadata.

- [ ] Run unit and Electron repository integration tests:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop
  npm run build:desktop --prefix apps/orquesta-desktop
  Push-Location apps/orquesta-desktop
  npx playwright test --config=playwright.electron.config.ts tests/electron/repository-integration.spec.ts
  Pop-Location
  ```

- [ ] Commit:

  ```powershell
  git add apps/orquesta-desktop/electron/core apps/orquesta-desktop/electron/main
  git commit -m "refactor: move repository state into desktop core"
  ```

---

## Task 7: Relay Codex approval requests into Attention without adding a policy engine

**Files:**

- Modify: `apps/orquesta-desktop/src/contracts/bridge.ts`
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.ts`
- Modify: `apps/orquesta-desktop/electron/core/desktop-codex-service.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Modify: `apps/orquesta-desktop/electron/main/core-host.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Modify: `apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts`
- Modify: `apps/orquesta-desktop/src/bridges/mock-bridge.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/attention/AttentionCard.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/attention-card.test.tsx`

- [ ] Replace the generic resolution input with a discriminated union and add failing compile/runtime tests:

  ```ts
  export type AttentionResolutionInput =
    | { kind: 'runtime_approval'; id: string; decision: string }
    | { kind: 'repository_action'; id: string; resolution: string; note?: string | null };
  ```

  Runtime `decision` is validated against the exact `response_options` sent by Codex; the UI must not invent a smaller universal allow/deny vocabulary.

- [ ] Extend `AttentionUiItem` with an optional non-secret runtime approval descriptor containing `requestId`, `method`, `threadId`, `turnId`, and `responseOptions`. Add failing tests proving repository attention items remain read-only and runtime approval cards show only valid response buttons.

- [ ] Run focused tests and confirm current `attentionResolution: false` behavior fails the new runtime case:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- attention-card.test.tsx desktop-repository-bridge.test.ts protocol.test.ts
  ```

- [ ] Project canonical `approval_requested` events into the current Core repository snapshot as `type: 'approval'`, `blocking: true`, `priority: 'blocker'`. Do not write them into canonical `.orquesta` files. Resolve them only through adapter `respondToApproval()`.

- [ ] Set Desktop bridge `attentionResolution: true` only when the item has `kind: 'runtime_approval'`; keep existing repository items read-only. Once a response succeeds, remove the live item and append a local resolved history entry.

- [ ] Test accept, decline/cancel, invalid option, duplicate response, and App Server shutdown with an outstanding request.

- [ ] Run full Desktop unit tests and adapter tests:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop
  npm test --workspace @orquesta/codex-adapter
  ```

- [ ] Commit:

  ```powershell
  git add apps/orquesta-desktop
  git commit -m "feat: relay Codex approvals through desktop attention"
  ```

---

## Task 8: Complete conversation history, truthful failure UI, and Codex draft fallback

**Files:**

- Modify: `apps/orquesta-desktop/electron/core/desktop-codex-service.ts`
- Modify: `apps/orquesta-desktop/electron/core/desktop-codex-service.test.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.ts`
- Modify: `apps/orquesta-desktop/electron/main/ipc-handlers.test.ts`
- Modify: `apps/orquesta-desktop/electron/shared/host-contract.ts`
- Modify: `apps/orquesta-desktop/electron/preload/host-api.ts`
- Modify: `apps/orquesta-desktop/src/contracts/bridge.ts`
- Modify: `apps/orquesta-desktop/src/bridges/desktop-repository-bridge.ts`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/composer/CommandComposer.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/conversation/ConversationHistory.tsx`
- Modify: `apps/orquesta-desktop/tests/unit/composer.test.tsx`
- Modify: `apps/orquesta-desktop/tests/electron/fixtures/fake-codex-app-server.cjs`
- Modify: `apps/orquesta-desktop/tests/electron/runtime-integration.spec.ts`

- [ ] Add failing history projection tests for multiple turns, Japanese text, agent/system items, target wrappers, empty history, limit 1-200, and stable newest-page ordering. The Renderer receives `ConversationPage`; it never receives raw App Server turns.

- [ ] Add failing safe-deep-link tests. The Renderer may call only:

  ```ts
  openCodexDraft({ targetAgentId, text }): Promise<UiActionResult>
  ```

  Main gets the selected project root from `project-registry`, constructs `codex://threads/new?prompt=...&path=...` with `URL`/`URLSearchParams`, and passes that generated URL to `shell.openExternal`. Reject empty/oversized text and never accept a Renderer-supplied URL or root path.

- [ ] Update the fake App Server to implement canonical `thread/read`, approval requests, runtime failure, and shutdown. Remove `ORQUESTA_CODEX_PATH` from `runtime-integration.spec.ts`; inject a test adapter/runtime location through a test-only Core factory boundary, not through production executable discovery.

- [ ] Run the focused tests and confirm the missing history/deep-link/fake-server behaviors:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- desktop-codex-service.test.ts composer.test.tsx ipc-handlers.test.ts
  ```

- [ ] Implement conversation pagination and display. When direct runtime dispatch is unavailable, keep the draft and show two distinct actions: Retry direct send, or Open as unsent draft in Codex. Never label the deep-link path as sent.

- [ ] Map failures into clear states:

  - runtime unavailable: setup/package problem, retryable after repair;
  - dispatch rejected before turn: message was not sent;
  - turn failed after acceptance: show the thread/turn and retain conversation access;
  - repository offline: sending disabled, viewing last snapshot allowed.

- [ ] Run Electron runtime integration with the fake server and the full Desktop check:

  ```powershell
  npm run build:desktop --prefix apps/orquesta-desktop
  Push-Location apps/orquesta-desktop
  npx playwright test --config=playwright.electron.config.ts tests/electron/runtime-integration.spec.ts
  Pop-Location
  npm run check --prefix apps/orquesta-desktop
  ```

- [ ] Commit:

  ```powershell
  git add apps/orquesta-desktop
  git commit -m "feat: complete desktop Codex interaction loop"
  ```

- [ ] Stop for the first user review. Demonstrate project switching, direct send, history, one approval, one failed turn, and the unsent Codex draft fallback. Record the user's decision before starting Task 9.

---

## Task 9: Project real V4 operational state inside Core

**Files:**

- Modify: `packages/core/src/commands.js`
- Modify: `packages/core/src/projectors.js`
- Modify: `packages/core/test/commands.test.js`
- Create: `packages/core/test/projectors.test.js`
- Modify: `scripts/v4/run-phase2-slice.js`
- Modify: `scripts/v4/run-phase2-slice.test.js`
- Create: `apps/orquesta-desktop/electron/core/v4-operations-projection.ts`
- Create: `apps/orquesta-desktop/electron/core/v4-operations-projection.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Modify: `apps/orquesta-desktop/electron/core/protocol.ts`
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`

- [ ] First add failing Core tests for three canonical record commands which are missing today:

  ```text
  acquisition.snapshot.record -> acquisition.snapshot.recorded
  candidate.audit.record     -> candidate.audit.recorded
  candidate.audition.record  -> candidate.audition.recorded
  ```

  `acquisition.snapshot.record` accepts `{ query, source_results, budget }`. The command boundary validates `query` as `live-source-query`, every source result as `live-source-result`, and the numeric budget fields against the query's maximum. It derives `query_id` as `LSQ-${canonicalHash(query).slice(0, 12)}`. The other two commands validate the existing `candidate-evaluation` and `audition-result` contracts. Persist only those validated summaries plus command identity, responsibility, correlation, and evidence refs; do not persist downloaded bodies, approval tokens, environment values, or unbounded process output.

- [ ] Add failing projector tests requiring `acquisition_snapshots`, `audit_evaluations`, and `audition_results` in `initialProjection()`, deterministic replacement by `query_id`/`evaluation_id`/`audition_plan_id`, and timeline entries for the three events. Retention is bounded to the latest 128 entries of each kind, sorted by sequence then stable ID.

- [ ] Update `run-phase2-slice.js` to record each validated source result, each candidate evaluation, and the authorized audition result before runtime dispatch. Extend `run-phase2-slice.test.js` to prove replay equivalence and that Phase 2 details survive a new process replay rather than existing only in the function return value.

- [ ] Run the new Core and Phase 2 tests and confirm they fail before command/projector implementation, then pass after the minimal implementation:

  ```powershell
  node --test packages/core/test/commands.test.js packages/core/test/projectors.test.js scripts/v4/run-phase2-slice.test.js
  npm run check:v4:phase2
  ```

- [ ] Define and test these bounded read-only Desktop DTOs; use nullable fields when the canonical source does not provide a value and never pass raw V4 objects to Renderer:

  ```ts
  export interface V4TaskIntentUi {
    id: string;
    desiredOutcome: string;
    acceptanceCriteria: string[];
    rawRequestRef: string;
  }

  export interface V4CapabilityNeedUi {
    id: string;
    description: string;
    kind: string;
    requiredLevel: string;
    status: string;
    confidence: number;
  }

  export interface V4ProviderUi {
    id: string;
    type: string;
    sourceUri: string;
    capabilities: string[];
    trustTier: string;
    availability: string;
    version: string;
    lastVerifiedAt: string;
    evidenceRefs: string[];
  }

  export interface V4CandidateEvaluationUi {
    id: string;
    candidateId: string;
    needId: string;
    score: number;
    eligibility: string;
    hardGates: Array<{ name: string; status: string; reason: string }>;
    actualModel: string | null;
  }

  export interface V4ResolutionUi {
    id: string;
    needId: string;
    mode: string;
    providerId: string | null;
    approvalStatus: string;
    totalCost: number;
  }

  export interface V4ContextPackUi {
    id: string;
    ownerAgentId: string;
    objective: string;
    requiredReading: string[];
    resolutionIds: string[];
    status: string;
  }

  export interface V4AcquisitionSourceUi {
    connectorId: string;
    trustTier: string;
    status: string;
    fetchedAt: string;
    expiresAt: string;
    candidateIds: string[];
    sourceEvidenceRefs: string[];
    cacheStatus: string;
  }

  export interface V4AcquisitionSnapshotUi {
    queryId: string;
    needId: string;
    queryTerms: string[];
    requestedAt: string;
    maxRequests: number;
    consumedRequests: number;
    remainingRequests: number;
    sources: V4AcquisitionSourceUi[];
  }

  export interface V4AuditionResultUi {
    planId: string;
    verdict: string;
    observedProfile: string;
    cleanupEvidence: string[];
    evidenceRefs: string[];
  }

  export interface V4EvidenceItemUi {
    id: string;
    kind: string;
    correlationId: string;
    threadId: string | null;
    turnId: string | null;
    predecessorId: string | null;
    ref: string | null;
    sequence: number;
  }

  export interface V4AuditTimelineItemUi {
    sequence: number;
    eventId: string;
    type: string;
    actorId: string;
    responsibility: string;
    commandName: string | null;
    scoutSkipReason: string | null;
    evidenceRefs: string[];
  }

  export interface V4OperationsSnapshot {
    available: boolean;
    revision: number;
    taskIntent: V4TaskIntentUi | null;
    capabilityNeeds: V4CapabilityNeedUi[];
    providers: V4ProviderUi[];
    candidateEvaluations: V4CandidateEvaluationUi[];
    latestResolutions: V4ResolutionUi[];
    contextPack: V4ContextPackUi | null;
    acquisitionSnapshots: V4AcquisitionSnapshotUi[];
    auditionResults: V4AuditionResultUi[];
    installRequest: { id: string; status: string; candidateId: string; expiresAt: string | null } | null;
    evidenceChains: Array<{ correlationId: string; items: V4EvidenceItemUi[] }>;
    runtimeCorrelations: Array<{ correlationId: string; dispatchEvidenceId: string | null; activeThreadId: string | null; activeTurnId: string | null }>;
    auditTimeline: V4AuditTimelineItemUi[];
    phaseReviews: Array<{ phaseId: string; status: string; reviewPacketRef: string; buildRef: string }>;
    limitation: string | null;
  }
  ```

- [ ] Add failing tests using real V4 fixture journals for empty, Phase 1, Phase 1.5, and Phase 2 state. Assert deterministic ordering, latest-resolution selection, bounded evidence chains, and `available: false` when `.orquesta/v4/events.jsonl` is absent.

- [ ] Run the projection test and confirm the module is missing:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- v4-operations-projection.test.ts
  ```

- [ ] Implement projection by calling `createEventStore({ stateRoot: path.join(root, '.orquesta', 'v4'), reducers: createProjectors(), initialState: initialProjection() }).replay()`. Map the returned V4 projection into the DTOs above. Limit timeline to 500 newest entries, evidence items to 32 per correlation, and displayed correlations to 128. Do not import Workbench `state-view.js`; it is fixture-navigation UI, not the canonical projection.

- [ ] Merge the V4 operations snapshot into `OrquestaUiSnapshot` and refresh it on `.orquesta/v4` changes. A malformed/recovery-blocked journal must preserve the previous base snapshot, set V4 `available: false`, and expose a concise limitation; it must not crash Core.

- [ ] Run the V4 and Desktop projection suites:

  ```powershell
  npm run check:v4:phase1
  npm run check:v4:phase15
  npm run check:v4:phase2
  npm run test:desktop-unit --prefix apps/orquesta-desktop
  ```

- [ ] Commit:

  ```powershell
  git add packages/core scripts/v4/run-phase2-slice.js scripts/v4/run-phase2-slice.test.js apps/orquesta-desktop/electron/core apps/orquesta-desktop/src/contracts/orquesta-ui.ts
  git commit -m "feat: persist and project V4 operations"
  ```

---

## Task 10: Replace the static Operations screen with the V4 control view

**Files:**

- Create: `apps/orquesta-desktop/src/renderer/features/operations/V4Operations.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/operations/CapabilityPanel.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/operations/AcquisitionPanel.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/operations/AuditPanel.tsx`
- Create: `apps/orquesta-desktop/src/renderer/features/operations/EvidencePanel.tsx`
- Delete: `apps/orquesta-desktop/src/renderer/features/operations/AdvancedOperations.tsx`
- Create: `apps/orquesta-desktop/tests/unit/v4-operations.test.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/app/DesktopRendererApp.tsx`
- Modify: `apps/orquesta-desktop/src/renderer/features/i18n/messages.ts`
- Modify: `apps/orquesta-desktop/src/renderer/styles/global.css`

- [ ] Add failing UI tests for all four tabs at 1366x768 and 1440x900. Require panel-local scrolling, no document/body overflow, keyboard tab navigation, Japanese/English labels, empty V4 state, and unavailable/recovery-limitation state.

- [ ] Run the focused test and confirm the components are missing:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- v4-operations.test.tsx
  ```

- [ ] Implement the four read-only panels:

  - Capability: task intent, needs, graph, chosen resolution;
  - Acquisition: providers, evaluations, install request/authorization state;
  - Audit: command identity, responsibility, scout skip reason, sequence;
  - Evidence: correlation chains, runtime dispatch/turn state, report and acceptance evidence.

- [ ] Fetch `RuntimeInfoUi` with `probe: false` when Operations opens and show adapter, pinned versions, target, health, and integrity status in the Evidence panel. The initial `not_started` state must not start Codex merely to populate the panel; add an explicit Refresh runtime status button which calls `probe: true` and is the only metadata action in this otherwise read-only overlay.

- [ ] Keep language control in the Operations overlay. Do not add action buttons for install, approval, or recovery until a later design explicitly defines those mutations.

- [ ] Preserve the home map geometry. The overlay may cover the workspace while open, but closing it must restore the exact map viewport and selected agent/task.

- [ ] Run accessibility, visual, browser, and Electron smoke tests:

  ```powershell
  npm run check --prefix apps/orquesta-desktop
  npm run test:desktop-smoke --prefix apps/orquesta-desktop
  ```

- [ ] Commit:

  ```powershell
  git add apps/orquesta-desktop/src apps/orquesta-desktop/tests/unit/v4-operations.test.tsx
  git commit -m "feat: add V4 desktop operations view"
  ```

---

## Task 11: Verify the real packaged runtime and correct performance gates

**Files:**

- Modify: `apps/orquesta-desktop/scripts/desktop-metrics.mjs`
- Modify: `apps/orquesta-desktop/scripts/desktop-metrics.test.mjs`
- Modify: `apps/orquesta-desktop/scripts/measure-desktop.mjs`
- Create: `apps/orquesta-desktop/scripts/verify-packaged-runtime.mjs`
- Create: `apps/orquesta-desktop/scripts/verify-packaged-runtime.test.mjs`
- Create: `apps/orquesta-desktop/tests/electron/packaged-runtime.spec.ts`
- Create: `apps/orquesta-desktop/tests/electron/runtime-responsiveness.spec.ts`
- Modify: `apps/orquesta-desktop/tests/electron/map-stability.spec.ts`
- Modify: `apps/orquesta-desktop/package.json`
- Modify: `apps/orquesta-desktop/docs/validation/desktop-foundation.md`
- Modify: `apps/orquesta-desktop/docs/validation/desktop-foundation.json`
- Create: `apps/orquesta-desktop/docs/validation/packaged-runtime.md`

- [ ] Add failing metrics tests that remove the obsolete 350 MiB total-footprint pass/fail gate. Keep cold start at 4,000 ms and idle working set at 400 MiB. Report these sizes separately without pretending the bundled Codex runtime is free:

  ```text
  ui_core_footprint_bytes
  codex_runtime_footprint_bytes
  total_footprint_bytes
  ```

- [ ] Add failing package-verifier tests requiring the three exact package metadata files, the real regular `codex.exe`, and absence of extra `@openai` package directories inside packaged `resources/codex-runtime/node_modules/@openai`.

- [ ] Run focused tests and confirm current footprint logic/package verifier fail:

  ```powershell
  npm run test:desktop-scripts --prefix apps/orquesta-desktop
  node --test apps/orquesta-desktop/scripts/verify-packaged-runtime.test.mjs
  ```

- [ ] Implement the split footprint report and package verifier. Add scripts:

  ```json
  {
    "verify:packaged-runtime": "node scripts/verify-packaged-runtime.mjs out/Orquesta-win32-x64/resources",
    "test:packaged-runtime": "playwright test --config=playwright.electron.config.ts tests/electron/packaged-runtime.spec.ts"
  }
  ```

- [ ] Run `npm run make:win`. Verify the packaged application starts its bundled App Server with no runtime override environment variable, initializes, creates a temporary project thread, accepts one harmless prompt, receives a turn-started event, reads the thread, then shuts down without an orphan `codex.exe`. The test must use a temporary user-data directory and delete the temporary project afterward.

- [ ] Extend `map-stability.spec.ts` with the existing 35-agent fixture. Measure pan and wheel-zoom through `requestAnimationFrame`; fail if any single main-thread stall is 500 ms or longer. Keep the existing Windows scale coverage at 100%, 125%, 150%, and 200%, and assert readable major labels plus no body/document overflow at each scale.

- [ ] Add `runtime-responsiveness.spec.ts` using a delayed fake turn. While the turn is active, type 100 characters in Composer and pan/zoom the map; require every input to appear in order and no 500 ms main-thread stall. After project switch and app exit, assert the old watcher produces no snapshot event and the fake/runtime child process is gone.

- [ ] Run the 60-second idle measurement with no selected project and with a selected idle project. The first proves lazy Core/runtime startup; the second proves the selected-project baseline. Then run the leak measurement from 5 minutes through 30 minutes and require total working-set growth of at most 75 MiB. Record all three measurements and process trees.

  ```powershell
  npm run make:win --prefix apps/orquesta-desktop
  npm run verify:packaged-runtime --prefix apps/orquesta-desktop
  npm run test:packaged-runtime --prefix apps/orquesta-desktop
  npm run measure:desktop --prefix apps/orquesta-desktop
  $env:ORQUESTA_MEASURE_IDLE_MS='1800000'; npm run measure:desktop --prefix apps/orquesta-desktop; Remove-Item Env:ORQUESTA_MEASURE_IDLE_MS
  ```

- [ ] If the real Codex turn requires a normal Codex approval/login interaction, record that exact state and complete it through the same packaged UI. Do not bypass it with hidden environment credentials or change the global approval policy.

- [ ] Commit only after the real packaged runtime, shutdown/orphan check, cold start, and both memory measurements pass:

  ```powershell
  git add apps/orquesta-desktop/package.json apps/orquesta-desktop/scripts apps/orquesta-desktop/tests/electron/packaged-runtime.spec.ts apps/orquesta-desktop/tests/electron/runtime-responsiveness.spec.ts apps/orquesta-desktop/tests/electron/map-stability.spec.ts apps/orquesta-desktop/docs/validation
  git commit -m "test: validate packaged Codex desktop runtime"
  ```

---

## Task 12: Run the final requirement audit and prepare the user review build

**Files:**

- Modify: `apps/orquesta-desktop/README.md`
- Modify: `apps/orquesta-desktop/VALIDATION.md`
- Create: `apps/orquesta-desktop/docs/validation/v4-desktop-integration.md`
- Verify: `docs/superpowers/specs/2026-07-18-orquesta-v4-desktop-integration-design.md`
- Verify: `docs/superpowers/plans/2026-07-18-orquesta-v4-desktop-integration.md`

- [ ] Add documentation tests or link checks proving all validation commands and artifact paths in README/VALIDATION exist. Document the one-runtime architecture, project switching, approval relay, history, V4 Operations, fallback semantics, package size split, memory gates, and known limits.

- [ ] Run the complete deterministic suite from both dependency roots:

  ```powershell
  npm run check:v4:phase1
  npm run check:v4:phase15
  npm run check:v4:phase2
  npm run check
  npm run validate:lockfile --prefix apps/orquesta-desktop
  npm run test:desktop-scripts --prefix apps/orquesta-desktop
  npm run check --prefix apps/orquesta-desktop
  npm run test:desktop-smoke --prefix apps/orquesta-desktop
  npm run verify:packaged-runtime --prefix apps/orquesta-desktop
  npm run test:packaged-runtime --prefix apps/orquesta-desktop
  ```

- [ ] Run a source-boundary audit:

  ```powershell
  rg -n "ORQUESTA_CODEX_PATH|WindowsApps|where\.exe|shell:\s*true|approvalPolicy:\s*'never'|approvalPolicy:\s*\"never\"" apps/orquesta-desktop packages/codex-adapter
  rg -n "@orquesta/core|@orquesta/event-store|repository-reader" apps/orquesta-desktop/electron/main
  rg -n "actualModel.*model|actual_model.*applied" apps/orquesta-desktop packages/codex-adapter
  ```

  Expected result: only tests/docs explaining forbidden cases; no forbidden production discovery, Main projection imports, or applied-to-actual model assignment.

- [ ] Re-run the Electron security-boundary tests and inspect the production BrowserWindow configuration. Require `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, packaged local content only, denied arbitrary navigation/new-window requests, opaque attachment IDs, IPC input bounds, and no `process`, `require`, filesystem, or child-process API reachable from Renderer:

  ```powershell
  npm run test:desktop-unit --prefix apps/orquesta-desktop -- window-options.test.ts host-api.test.ts ipc-handlers.test.ts
  npm run test:desktop-smoke --prefix apps/orquesta-desktop
  ```

- [ ] Compare every approved design requirement to a test, command, screenshot, measurement, or explicit known limitation in `v4-desktop-integration.md`. A deterministic test is not browser proof; a fake App Server test is not real bundled-runtime proof. If the Setup/ZIP are not code-signed, state that limitation plainly in the review document and README.

- [ ] Run `git diff --check`, inspect `git status --short`, and verify the installer/ZIP plus validation artifacts exist:

  ```powershell
  git diff --check
  Get-ChildItem apps/orquesta-desktop/out/make -Recurse -File
  Get-ChildItem apps/orquesta-desktop/docs/validation -File
  ```

- [ ] Commit the review packet:

  ```powershell
  git add apps/orquesta-desktop/README.md apps/orquesta-desktop/VALIDATION.md apps/orquesta-desktop/docs/validation/v4-desktop-integration.md
  git commit -m "docs: publish V4 desktop review evidence"
  ```

- [ ] Stop for final user review. Provide the exact installer/portable package path, the two validation documents, the passed commands, measured cold start/memory/size values, and any remaining limitation. Do not merge or publish until the user explicitly accepts this gate.

---

## Completion Definition

This plan is complete only when all of the following are true:

- V4 and Desktop coexist on one branch with separate root/Desktop lockfiles.
- Desktop contains no duplicate raw Codex protocol/runtime resolver.
- The packaged app uses only the exact bundled Codex packages and can complete a real turn/history cycle.
- Codex approval requests are visible and answerable with the runtime-provided options.
- Main no longer interprets `.orquesta`; Core owns repository and V4 projection.
- Model evidence does not overclaim `actualModel`.
- V4 Capability, Acquisition, Audit, and Evidence panels show canonical projected state.
- The home map remains complete, pannable, zoomable, and visually dominant.
- No-project idle working set and selected-project idle working set are each at or below 400 MiB; cold start is at or below 4 seconds.
- UI/Core, runtime, and total package footprints are reported separately.
- Deterministic, browser, Electron, fake-runtime, and real packaged-runtime evidence are all clearly distinguished.
- Both user review gates have explicit user decisions.
