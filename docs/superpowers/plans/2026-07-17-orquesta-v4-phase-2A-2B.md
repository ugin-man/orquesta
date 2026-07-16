# Orquesta V4 Phase 2A and 2B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the accepted Phase 1 kernel through bounded live acquisition, Codex-harness Audition, and truthful Codex-native execution, ending Phase 2 with a correlated acceptance review packet and no application shell.

**Architecture:** New acquisition, audition, codex-adapter, and evidence-fabric workspaces sit beside the accepted Phase 1 packages. Every external boundary is injectable for deterministic tests. Canonical decisions remain Event Journal commands and projections; caches are derived state. App Server stdio is the primary runtime adapter, the TypeScript SDK is the secondary adapter, and repository-only is the honest no-execution fallback.

**Tech Stack:** Node.js 20+, CommonJS, `node:test`, JSON Schema through `@orquesta/contracts`, the existing V4 EventStore, Codex App Server JSONL over stdio, and exact `@openai/codex-sdk@0.144.5` loaded through dynamic import.

## Global Constraints

- Use `C:\Users\kouki\OneDrive\ドキュメント\Orquesta\.worktrees\orquesta-v4-phase1` on `codex/orquesta-v4-phase1`.
- Treat `C:\Users\kouki\OneDrive\ドキュメント\Orquesta\.orquesta` as canonical Orquesta state. Product worktree state is not routing or acceptance evidence.
- Preserve all accepted Phase 1 and Phase 1.5 contracts, the 18-batch/42-event fixture histories, V3 behavior, and the current `npm run check` meaning.
- Keep Phase 2 to 2A Acquisition and 2B Codex-native execution. Do not add Electron, PWA, Tauri, installer, OS build, application UI, daily-use UX, dashboard redesign, or Phase 3 learning.
- Do not build a second filesystem sandbox, network firewall, credential vault, command-risk parser, identity layer, or runtime approval engine. Query and execution effects are authorized semantically; Codex enforces runtime safety.
- Web and registry content is untrusted data. Never turn fetched instructions into agent instructions or commands.
- Keep recommended, requested, applied, and actual model evidence separate. `actual_model` remains `null` unless an App Server or approved hook event proves it. SDK `0.144.5` provides no independent actual-model evidence.
- A recorded request, accepted dispatch, and started turn are different states. Repository fallback cannot emit started-turn evidence.
- Every production behavior begins with a focused failing test and an observed expected failure.
- Phase 1.5 reviews and corrections remain cycles on the original implementation task. Do not create auxiliary review or fix task entries.
- Each task below declares its risk-adaptive lane. Escalate the same task if implementation discovers a higher-risk effect.
- Run each focused command once at its step. Run the complete Phase 2 verification matrix only in Task 13.
- Do not push.

## Fixed Policies

```js
const ACQUISITION_LIMITS = Object.freeze({
  max_requests_per_need: 8,
  max_requests_per_connector: 2,
  max_candidates: 3
});

const CACHE_TTL_MS = Object.freeze({
  official_docs: 24 * 60 * 60 * 1000,
  registry: 60 * 60 * 1000,
  github: 60 * 60 * 1000,
  ui_catalog: 24 * 60 * 60 * 1000
});

const TRUST_TIERS = Object.freeze([
  "local", "official", "curated", "community", "unknown"
]);
```

Cache entries without `fetched_at`, `expires_at`, source identity, response hash, and redaction status are invalid. A stale entry may be shown as historical evidence but cannot satisfy a live-source requirement.

## File Map

- Create contracts: `live-source-query`, `live-source-result`, `audition-plan`, `audition-result`, `install-approval-target`, `runtime-evidence`, and `codex-dispatch` schemas.
- Create `packages/acquisition/` for connector contracts, bounded query coordination, TTL cache, and the four live connectors.
- Extend `packages/audit/` for Phase 2 source facts and hard-gate evidence.
- Create `packages/audition/` for semantic plans, Codex profile preflight, execution evidence, and bounded cleanup verification.
- Extend `packages/core/` for install authorization and runtime/evidence commands without changing legacy command behavior.
- Create `packages/codex-adapter/` for the common contract, App Server stdio, TypeScript SDK, and repository-only adapters.
- Create `packages/evidence-fabric/` for correlation and evidence normalization.
- Create `fixtures/v4/phase2/` and `scripts/v4/` deterministic and live vertical-slice verification.
- Update root scripts, Orquesta protocol mirrors, state schema, README, and Phase 2 review documentation only after production behavior is green.
- Do not create `apps/desktop`, application UI files, or a plugin bundle in this plan. App Server and SDK expose the required lifecycle and approval surfaces. If fixed-runtime schema inspection disproves that, stop Phase 2 and amend the approved design before adding a minimal evidence-only plugin.

---

### Task 1: Add Phase 2 shared contracts

**Risk-adaptive lane:** standard. This changes shared validation across multiple package boundaries.

**Files:**

- Create: `packages/contracts/schemas/live-source-query.schema.json`
- Create: `packages/contracts/schemas/live-source-result.schema.json`
- Create: `packages/contracts/schemas/audition-plan.schema.json`
- Create: `packages/contracts/schemas/audition-result.schema.json`
- Create: `packages/contracts/schemas/install-approval-target.schema.json`
- Create: `packages/contracts/schemas/runtime-evidence.schema.json`
- Create: `packages/contracts/schemas/codex-dispatch.schema.json`
- Modify: `packages/contracts/src/validator.js`
- Modify: `packages/contracts/test/contracts.test.js`

**Interfaces:**

- `live-source-query`: current `need_id`, normalized query terms, allowed connector IDs, request budget, candidate limit, and `requested_at`.
- `live-source-result`: connector ID, trust tier, fetched/expires timestamps, status, candidate records, source evidence, cache status, and redaction status.
- `audition-plan`: candidate/version/hash, TaskIntent/Resolution binding, workspace or temporary root, expected Codex profile, permitted effects, steps, expected evidence, cleanup plan, and approval refs.
- `audition-result`: exact plan ID, observed profile, steps, side effects, evidence refs, verdict, and cleanup evidence.
- `install-approval-target`: candidate/version/source hash, dependency and lockfile preview hashes, target workspace, effects, expiry, and review packet binding.
- `runtime-evidence`: source, correlation, event kind, captured time, thread/turn refs, payload hash/ref, redaction, and separate model fields.
- `codex-dispatch`: adapter kind, request status, thread/turn refs, requested/applied model, and evidence refs.

- [ ] **Step 1: Write contract RED tests**

Add valid objects for all seven schemas. Reject unknown fields, duplicate connector IDs, budgets above the fixed limits, stale timestamps with `expires_at <= fetched_at`, missing source hashes, profile-less Audition results, unbound install targets, actual models without evidence refs, and dispatch objects that claim `turn_started` without a turn-start evidence ref.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/contracts/test/contracts.test.js
```

Expected: FAIL because the seven schema names are not registered.

- [ ] **Step 3: Implement the schemas and semantic validators**

Register all names in `SCHEMA_NAMES`. Add deterministic semantic checks in `validator.js` for timestamp ordering, fixed budgets, unique sorted arrays, actual-model evidence binding, and dispatch/turn-start separation. Keep `additionalProperties: false` on every durable object.

- [ ] **Step 4: Run GREEN**

```powershell
node --test packages/contracts/test/contracts.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add packages/contracts
git commit -m "feat(v4): define Phase 2 evidence contracts"
```

---

### Task 2: Add bounded acquisition policy and derived cache

**Risk-adaptive lane:** standard. It adds network-aware policy and a derived file cache without making external calls yet.

**Files:**

- Create: `packages/acquisition/package.json`
- Create: `packages/acquisition/src/policy.js`
- Create: `packages/acquisition/src/connector.js`
- Create: `packages/acquisition/src/cache.js`
- Create: `packages/acquisition/src/coordinator.js`
- Create: `packages/acquisition/src/index.js`
- Create: `packages/acquisition/test/policy.test.js`
- Create: `packages/acquisition/test/cache.test.js`
- Create: `packages/acquisition/test/coordinator.test.js`

**Interfaces:**

```js
function createLiveSourceConnector({ id, trustTier, transport, search }) {}
function createAcquisitionCache({ cacheRoot, clock }) {}
function searchLiveSources({ query, connectors, cache, clock }) {}
```

`transport.request({ method, url, headers, body, timeout_ms })` is injected. It returns `{ status, headers, body, captured_at }`. Connector configuration may receive credentials, but cache and evidence serializers receive only `redacted_headers` and never token, cookie, authorization, or query-secret values.

- [ ] **Step 1: Write policy, cache, and coordinator RED tests**

Prove exact limits, deterministic connector order, code-unit ordering, candidate dedupe by provider/source hash, maximum three output candidates, maximum eight total requests, maximum two per connector, and fail-closed incomplete budgets. Prove cache hit, exact expiry equality treated as stale, hash mismatch rejection, invalid JSON rejection, source identity mismatch rejection, and no credential values in serialized cache.

- [ ] **Step 2: Run RED**

```powershell
npm test --workspace @orquesta/acquisition
```

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement policy and cache**

Use canonical hashes from `@orquesta/contracts`. Cache under the injected root with one file per canonical query hash. Write through same-directory temp plus atomic rename, never in-place. Cache is derived and disposable; it must not advance Event Journal state.

- [ ] **Step 4: Implement coordinator**

Consume budget before transport calls, not after. Stop on three candidates, exhausted requests, or all connectors complete. Return source failures and stale entries as evidence without silently replacing live results. Do not interpret fetched prose as commands.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/acquisition
git add packages/acquisition
git commit -m "feat(v4): bound live acquisition and cache evidence"
```

Expected: all acquisition tests PASS.

---

### Task 3: Implement four live connectors with injectable transport

**Risk-adaptive lane:** standard. Connector production code can access network, but tests remain injected and offline.

**Files:**

- Create: `packages/acquisition/src/connectors/official-docs.js`
- Create: `packages/acquisition/src/connectors/registry.js`
- Create: `packages/acquisition/src/connectors/github.js`
- Create: `packages/acquisition/src/connectors/ui-catalog.js`
- Create: `packages/acquisition/src/normalize.js`
- Modify: `packages/acquisition/src/index.js`
- Create: `packages/acquisition/test/connectors.test.js`
- Create: `fixtures/v4/phase2/transports/official-docs.json`
- Create: `fixtures/v4/phase2/transports/registry.json`
- Create: `fixtures/v4/phase2/transports/github.json`
- Create: `fixtures/v4/phase2/transports/ui-catalog.json`

**Connector boundaries:**

- `official-docs`: allowlisted OpenAI or product-owner documentation origins; trust `official`.
- `registry`: configured official package registry endpoint; trust `official` for registry metadata, not for package claims.
- `github`: GitHub repository metadata; trust `curated` only for configured owners, otherwise `community`.
- `ui-catalog`: configured allowlisted catalog endpoint; trust `curated`.
- Every record includes connector ID, canonical source URI, version or revision when available, response hash, fetched/expiry time, license evidence refs, and unknown fields.

- [ ] **Step 1: Write connector RED tests from transport fixtures**

Test success, empty result, 404, 429 with retry metadata, 5xx, malformed JSON, body over 1 MiB, redirect outside the allowlist, credential-bearing URL rejection, duplicate records, missing license, and source-order stability. Assert no connector executes a command, imports `child_process`, or performs network access without the injected transport.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/acquisition/test/connectors.test.js
```

Expected: FAIL because connector modules do not exist.

- [ ] **Step 3: Implement minimal parsers**

Parse only documented response fields needed for `CapabilityProvider` and source evidence. Keep body excerpts out of durable state. Preserve response hash and a local raw-artifact ref when the caller opts to retain a redacted response.

- [ ] **Step 4: Run GREEN and package regression**

```powershell
npm test --workspace @orquesta/acquisition
```

Expected: PASS with transport call counts at or below policy limits.

- [ ] **Step 5: Commit Task 3**

```powershell
git add packages/acquisition fixtures/v4/phase2/transports
git commit -m "feat(v4): add bounded live source connectors"
```

---

### Task 4: Expand static Audit for live evidence

**Risk-adaptive lane:** standard. It changes selection evidence across Audit and Resolver boundaries.

**Files:**

- Create: `packages/audit/src/phase2-facts.js`
- Modify: `packages/audit/src/hard-gates.js`
- Modify: `packages/audit/src/index.js`
- Modify: `packages/audit/test/audit.test.js`
- Modify: `packages/capability-resolver/test/resolver.test.js`

**Interface:**

```js
function auditLiveCandidate({ candidate, need, sourceEvidence, policyVersion }) {}
```

It emits facts and unknowns for license, maintenance, security, compatibility, accessibility, cost, trust, and freshness. It does not make legal or vulnerability claims from missing evidence.

- [ ] **Step 1: Write RED tests**

Prove source facts override candidate self-report only when exact field authority is present. License unknown remains ineligible; login/payment/secret/external-send remain blocked; stale source evidence cannot clear a hard gate; inaccessible required UI stays ineligible; missing maintenance or cost remains explicit unknown. Duplicate or contradictory source facts fail with one stable structured error independent of input order.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/audit/test/audit.test.js packages/capability-resolver/test/resolver.test.js
```

Expected: FAIL because `auditLiveCandidate` is absent.

- [ ] **Step 3: Implement Phase 2 fact authority**

Reuse immutable Phase 1 weights and score math. Add no keyword-based legal, threat, or vulnerability classifier. Bind each authoritative fact to source evidence ID and hash. Preserve partial facts and unrelated unknowns.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/audit
npm test --workspace @orquesta/capability-resolver
git add packages/audit packages/capability-resolver/test/resolver.test.js
git commit -m "feat(v4): audit live candidate evidence"
```

---

### Task 5: Implement Audition planning, profile preflight, and cleanup evidence

**Risk-adaptive lane:** critical. This boundary authorizes network, dependency, and workspace effects while relying on Codex for enforcement.

**Files:**

- Create: `packages/audition/package.json`
- Create: `packages/audition/src/plan.js`
- Create: `packages/audition/src/profile.js`
- Create: `packages/audition/src/runner.js`
- Create: `packages/audition/src/cleanup.js`
- Create: `packages/audition/src/index.js`
- Create: `packages/audition/test/plan.test.js`
- Create: `packages/audition/test/profile.test.js`
- Create: `packages/audition/test/runner.test.js`
- Create: `packages/audition/test/cleanup.test.js`

**Interfaces:**

```js
function createAuditionPlan(input) {}
function compareCodexProfile({ planned, actual }) {}
async function runAudition({ plan, harness, evidenceSink }) {}
async function verifyAuditionCleanup({ plan, before, after, fsAdapter }) {}
```

`harness.inspectProfile()` and `harness.run(plan)` are injected Codex-owned runtime operations. Orquesta compares semantic scope and records evidence; it does not enforce filesystem or network access itself.

- [ ] **Step 1: Write RED tests**

Cover deterministic plan IDs; TaskIntent/Resolution/candidate/hash binding; missing profile; actual profile broader than planned; unavailable profile; worktree and temporary-root containment; symlink escape; created/modified/deleted file manifests; network and dependency effects; cleanup residue; cleanup path escape; replacement after inspection; and primary plus cleanup failures. A broader or unverifiable profile must return `blocked` before `harness.run`.

- [ ] **Step 2: Run RED**

```powershell
npm test --workspace @orquesta/audition
```

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement plan and profile comparison**

Require exact allowed roots and effects. The comparison may reject a broader Codex profile but may not create or mutate Codex profiles. Record actual profile source and captured time.

- [ ] **Step 4: Implement execution and bounded cleanup verification**

Run only through the injected harness. Snapshot exact approved roots before and after. Cleanup may remove only paths created beneath the dedicated Audition root and must reject root, junction, symlink, or unknown paths. Preserve evidence when cleanup is incomplete.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/audition
git add packages/audition
git commit -m "feat(v4): plan and verify Codex-harness auditions"
```

---

### Task 6: Add the install semantic approval gate

**Risk-adaptive lane:** critical. Dependency installation is externally consequential and user-authorized.

**Files:**

- Create: `packages/core/src/install-approval.js`
- Modify: `packages/core/src/commands.js`
- Modify: `packages/core/src/projectors.js`
- Modify: `packages/core/src/index.js`
- Modify: `packages/core/test/commands.test.js`
- Create: `packages/core/test/install-approval.test.js`

**Interfaces:**

```js
function createInstallApprovalTarget(input) {}
```

Add commands `candidate.install.request` and `candidate.install.authorize`. Authorization reuses trusted in-process user approval verification and binds exact candidate, version, source hash, dependency preview, lockfile preview, target workspace, effects, Resolution revision, and review packet hash. It does not install anything.

- [ ] **Step 1: Write RED tests**

Reject missing or stale Resolution, changed candidate/version/hash, changed lockfile preview, expired approval, body-derived actor/attestation, duplicate authorization, and authorization without the current target. Prove the command commits one authorization event and replay restores it. Prove install execution remains absent from Core.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/core/test/install-approval.test.js packages/core/test/commands.test.js
```

Expected: FAIL because the target and commands do not exist.

- [ ] **Step 3: Implement target and commands**

Use the existing `verifyUserApproval` seam. Event types are `candidate.install.requested` and `candidate.install.authorized`. A later Codex turn may perform the install only when its Context Pack carries the current authorization evidence ref; Codex still handles runtime command approval.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/core
git add packages/core
git commit -m "feat(v4): bind install authorization to candidate evidence"
```

---

### Task 7: Define CodexAdapter and repository-only fallback

**Risk-adaptive lane:** standard. It adds an adapter boundary but no live process yet.

**Files:**

- Create: `packages/codex-adapter/package.json`
- Create: `packages/codex-adapter/src/errors.js`
- Create: `packages/codex-adapter/src/contract.js`
- Create: `packages/codex-adapter/src/repository-adapter.js`
- Create: `packages/codex-adapter/src/index.js`
- Create: `packages/codex-adapter/test/contract.test.js`
- Create: `packages/codex-adapter/test/repository-adapter.test.js`

**Common contract:**

```js
const CODEX_ADAPTER_METHODS = Object.freeze([
  "capabilities", "createThread", "resumeThread", "startTurn",
  "steerTurn", "interruptTurn", "respondToApproval",
  "subscribeEvents", "readActualModel"
]);
```

All methods return the design `AdapterResult`. Failure statuses are `unsupported`, `unauthorized`, `unavailable`, `rejected`, or `failed`. Every call consumes or returns a caller-provided correlation ID.

- [ ] **Step 1: Write RED tests**

Prove detached results, stable failure shapes, no accepted/started conflation, no actual-model inference, and no secret fields in evidence. Repository adapter must return `unsupported` for every runtime action, emit no runtime events, and create only a handoff draft through a separate explicit repository method.

- [ ] **Step 2: Run RED**

```powershell
npm test --workspace @orquesta/codex-adapter
```

Expected: FAIL because the workspace does not exist.

- [ ] **Step 3: Implement contract and fallback**

Validate adapter capability declarations at construction. Repository fallback reports `adapter: repository_only`, `execution: unsupported`, and `actual_model: null`.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/codex-adapter
git add packages/codex-adapter
git commit -m "feat(v4): define truthful Codex adapter fallback"
```

---

### Task 8: Implement App Server JSONL stdio adapter

**Risk-adaptive lane:** critical. It starts a local Codex process and relays runtime approvals.

**Files:**

- Create: `packages/codex-adapter/src/jsonl-transport.js`
- Create: `packages/codex-adapter/src/app-server-adapter.js`
- Create: `packages/codex-adapter/protocol/app-server-schema.json`
- Create: `packages/codex-adapter/protocol/app-server-version.json`
- Create: `packages/codex-adapter/test/jsonl-transport.test.js`
- Create: `packages/codex-adapter/test/app-server-adapter.test.js`
- Create: `packages/codex-adapter/test/fixtures/fake-app-server.js`
- Modify: `packages/codex-adapter/src/index.js`

**Protocol contract:**

- Spawn the injected Codex executable with `app-server` without a shell through an injected `spawnProcess`; the default command is `codex` only when its path is spawnable.
- Use newline-delimited JSON with a 1 MiB maximum line and a 256-entry maximum pending request map.
- Send one `initialize` request, wait for its response, then send `initialized` before any thread request.
- Implement `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt` exactly.
- Keep request responses, notifications, and server-initiated approval requests separate.
- Emit `dispatch_accepted` from a successful `turn/start` response and `turn_started` only from a matching streamed notification.

- [ ] **Step 1: Capture and pin the installed App Server schema**

Run in a temporary output directory:

```powershell
codex app-server generate-json-schema --out output/v4-phase2-app-server-schema
codex --version
```

Normalize the generated request/notification subset into `app-server-schema.json` and store the exact CLI version plus source hash in `app-server-version.json`. Expected: both commands succeed. If schema generation is unavailable, stop Task 8 with `unsupported`; do not guess wire fields.

- [ ] **Step 2: Write transport and lifecycle RED tests**

Use the fake process to test partial lines, multiple lines, invalid UTF-8, invalid JSON, oversized lines, duplicate response IDs, unknown IDs, process exit, stderr redaction, pending-request rejection on exit, initialize ordering, repeated initialize, and bounded queue behavior.

Test start, resume, turn start, steer, interrupt, streamed item events, turn completion, out-of-order unrelated notifications, and server approval request/response. Validate fixtures against the pinned schema.

- [ ] **Step 3: Run RED**

```powershell
node --test packages/codex-adapter/test/jsonl-transport.test.js packages/codex-adapter/test/app-server-adapter.test.js
```

Expected: FAIL because transport and adapter modules do not exist.

- [ ] **Step 4: Implement transport and adapter**

Do not enable experimental WebSocket transport. Do not pass credentials on the command line. Do not synthesize thread IDs, turn IDs, approval IDs, or actual models. Normalize only schema-validated messages.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/codex-adapter
git add packages/codex-adapter
git commit -m "feat(v4): integrate Codex App Server over stdio"
```

---

### Task 9: Implement the TypeScript SDK adapter

**Risk-adaptive lane:** standard, escalating to critical for the one live dependency-install and runtime verification cycle.

**Files:**

- Create: `packages/codex-adapter/src/sdk-adapter.js`
- Create: `packages/codex-adapter/test/sdk-adapter.test.js`
- Modify: `packages/codex-adapter/package.json`
- Modify: `packages/codex-adapter/src/index.js`
- Modify: `package-lock.json`

**Interface mapping:**

- `createThread` -> `Codex.startThread()`.
- `resumeThread` -> `Codex.resumeThread(threadId)`.
- `startTurn` -> SDK `Thread.runStreamed()` so `thread.started`, `turn.started`, `item.*`, and `turn.completed` can be normalized.
- `interruptTurn` -> abort the adapter-owned active `AbortController` only while that turn is active; otherwise return `unsupported`.
- `steerTurn`, direct approval relay, and independent actual-model evidence are not exposed by SDK `0.144.5`; return `unsupported` and keep `actual_model: null`.
- The SDK runs server-side and inherits Codex runtime safety. Orquesta does not translate SDK options into a second policy layer.

- [ ] **Step 1: Write SDK RED tests with an injected factory**

Test new thread, resumed thread, `Thread.id`, `runStreamed()` lifecycle, final response artifact, active-turn AbortSignal cancellation, SDK error classification, unavailable package, unsupported steer and approval methods, correlation preservation, requested/applied model separation, and `actual_model: null`.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/codex-adapter/test/sdk-adapter.test.js
```

Expected: FAIL because `sdk-adapter.js` does not exist.

- [ ] **Step 3: Install and pin the official SDK**

```powershell
npm install @openai/codex-sdk@0.144.5 --workspace @orquesta/codex-adapter --save-exact
```

Expected: `packages/codex-adapter/package.json` and `package-lock.json` record `@openai/codex-sdk@0.144.5`, its `@openai/codex@0.144.5` dependency, and the selected optional Windows runtime package. Record package name, version, integrity, and install approval evidence in the implementation cycle.

- [ ] **Step 4: Implement dynamic import and capability reporting**

Use `await import("@openai/codex-sdk")` from CommonJS. Map `ThreadOptions` model, sandboxMode, workingDirectory, networkAccessEnabled, webSearchMode, and approvalPolicy without widening the approved Codex profile. Keep App Server primary because only it covers steer and direct approval relay. The SDK-bundled `@openai/codex` Windows runtime is the planned workaround for WindowsApps `codex.exe` child-process access denial, but mark that route unverified until the live probe starts a real turn.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/codex-adapter
git add packages/codex-adapter package-lock.json
git commit -m "feat(v4): add the Codex TypeScript SDK adapter"
```

---

### Task 10: Normalize approval relay and model evidence

**Risk-adaptive lane:** critical. Incorrect relay or model claims would cross user authority and evidence boundaries.

**Files:**

- Create: `packages/codex-adapter/src/approval-relay.js`
- Create: `packages/codex-adapter/src/model-evidence.js`
- Create: `packages/codex-adapter/test/approval-relay.test.js`
- Create: `packages/codex-adapter/test/model-evidence.test.js`
- Modify: `packages/codex-adapter/src/app-server-adapter.js`
- Modify: `packages/codex-adapter/src/sdk-adapter.js`

**Interfaces:**

```js
function normalizeApprovalRequest({ message, correlationId, threadId, turnId }) {}
function createModelEvidence({ recommended, requested, applied, runtimeEvent }) {}
```

Approval relay exposes the exact server request ID, method, thread/turn binding, redacted reason, requested effect, and response options. A caller decides; the adapter only returns the method-matched response. Install authorization and Codex runtime approval remain separate evidence.

- [ ] **Step 1: Write RED tests**

Reject an approval response with wrong request, thread, turn, correlation, method, option, or already-consumed ID. Preserve concurrent requests independently. Fail closed on process restart. Prove no auto-approval path.

For model evidence, test recommendation only, request only, applied configuration, explicit runtime model event, conflicting events, missing event, and adapter fallback. Only the explicit runtime event may populate actual model and its evidence ref.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/codex-adapter/test/approval-relay.test.js packages/codex-adapter/test/model-evidence.test.js
```

Expected: FAIL because normalization modules do not exist.

- [ ] **Step 3: Implement relay and model evidence**

Keep the relay in memory per App Server connection and journal normalized evidence through the caller. Do not persist raw approval prompt content, credentials, tool output, or hidden model configuration.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm test --workspace @orquesta/codex-adapter
git add packages/codex-adapter
git commit -m "feat(v4): preserve Codex approval and model truth"
```

---

### Task 11: Correlate runtime evidence through the Event Journal

**Risk-adaptive lane:** standard. It crosses adapter, Core, EventStore, report, and acceptance boundaries.

**Files:**

- Create: `packages/evidence-fabric/package.json`
- Create: `packages/evidence-fabric/src/normalize.js`
- Create: `packages/evidence-fabric/src/correlate.js`
- Create: `packages/evidence-fabric/src/index.js`
- Create: `packages/evidence-fabric/test/correlate.test.js`
- Modify: `packages/core/src/commands.js`
- Modify: `packages/core/src/projectors.js`
- Modify: `packages/core/src/index.js`
- Modify: `packages/core/package.json`
- Modify: `packages/core/test/commands.test.js`

**Event flow:**

```text
source.discovered -> candidate.audition.completed -> runtime.dispatch.accepted
-> runtime.turn.started -> runtime.progress.observed -> artifact.produced
-> report.produced -> acceptance.completed
```

All events bind `task_intent_id`, current Resolution ID, Context Pack ID, correlation ID, source evidence, and predecessor evidence where applicable.

- [ ] **Step 1: Write correlation RED tests**

Reject missing predecessors, wrong correlation, stale Resolution or Context Pack, dispatch without request, turn start without matching dispatch/thread/turn, artifact without active turn, report without artifact or explicit report ref, and acceptance without current evidence. Duplicate identical evidence is idempotent; same ID with different hash fails.

- [ ] **Step 2: Run RED**

```powershell
node --test packages/evidence-fabric/test/correlate.test.js packages/core/test/commands.test.js
```

Expected: FAIL because the package, commands, and projectors are absent.

- [ ] **Step 3: Implement normalization and Core commands**

Add commands `runtime.dispatch.record`, `runtime.event.record`, `artifact.record`, `report.record`, and `acceptance.record`. EventStore remains the only canonical writer. Projectors expose current runtime, evidence by correlation, artifacts, reports, and acceptance without storing large bodies.

- [ ] **Step 4: Run GREEN plus EventStore regression**

```powershell
npm test --workspace @orquesta/evidence-fabric
npm test --workspace @orquesta/core
npm test --workspace @orquesta/event-store
```

Expected: PASS; accepted Phase 1 fixture histories remain 18 batches and 42 events.

- [ ] **Step 5: Commit Task 11**

```powershell
git add packages/evidence-fabric packages/core
git commit -m "feat(v4): correlate runtime and acceptance evidence"
```

---

### Task 12: Build deterministic and live Phase 2 vertical slices

**Risk-adaptive lane:** critical. The live path uses network, Codex runtime, possible dependency installation, and user approval.

**Files:**

- Create: `fixtures/v4/phase2/admin-ui/task-intent.json`
- Create: `fixtures/v4/phase2/admin-ui/source-policy.json`
- Create: `fixtures/v4/phase2/admin-ui/audition-policy.json`
- Create: `fixtures/v4/phase2/admin-ui/acceptance.json`
- Create: `scripts/v4/run-phase2-slice.js`
- Create: `scripts/v4/run-phase2-slice.test.js`
- Create: `scripts/v4/review-phase2-live.js`
- Create: `scripts/v4/review-phase2-live.test.js`

**Deterministic slice:** Uses injected transport and fake App Server fixtures. It proves every state transition and failure path without claiming live execution.

**Live slice:** Uses at least two reachable live connector families, one audited candidate, a user-authorized Audition, App Server primary or SDK secondary, a real Codex turn, an artifact or report, an acceptance check, and a review packet derived from journal evidence. Repository-only fallback is tested but cannot satisfy the live-turn requirement.

- [ ] **Step 1: Write deterministic vertical-slice RED tests**

Assert fixed input produces stable source/query/plan/correlation IDs; candidate limit three; one hard-gate rejection; profile preflight; approval wait; dispatch accepted before turn started; artifact/report hash; acceptance result; replay equivalence; and no actual-model claim without runtime evidence.

- [ ] **Step 2: Run RED**

```powershell
node --test scripts/v4/run-phase2-slice.test.js scripts/v4/review-phase2-live.test.js
```

Expected: FAIL because the scripts do not exist.

- [ ] **Step 3: Implement the deterministic slice**

Use a temporary state root and injected transports. Never read `expected.json` to construct actual output. Write the expected object only in tests and deep-compare exact review views.

- [ ] **Step 4: Implement the opt-in live reviewer**

Require all of:

```powershell
node scripts/v4/review-phase2-live.js --state-root <canonical-root> --allow-network --allow-codex-turn
```

The script must stop for explicit install approval when needed. It must never broaden Codex profile settings. Output goes to `output/v4-phase2-review/` with checks, source evidence, Audition report, runtime timeline, artifact/report hashes, limitations, and a Phase Review packet.

- [ ] **Step 5: Run deterministic GREEN**

```powershell
node --test scripts/v4/run-phase2-slice.test.js scripts/v4/review-phase2-live.test.js
```

Expected: PASS with no network or real Codex process in unit tests.

- [ ] **Step 6: Run one approved live slice**

Run the opt-in command once after the user approves any install/network effects. Expected: two live source families, one completed Audition with clean cleanup evidence, one real started/completed Codex turn, one artifact or report, one acceptance result, and a ready-for-user-review packet. If App Server and SDK are unavailable, record repository-only fallback and leave Phase 2 not ready.

- [ ] **Step 7: Commit Task 12 production and deterministic fixtures**

```powershell
git add fixtures/v4/phase2 scripts/v4/run-phase2-slice.js scripts/v4/run-phase2-slice.test.js scripts/v4/review-phase2-live.js scripts/v4/review-phase2-live.test.js
git commit -m "test(v4): prove the Phase 2 acquisition execution slice"
```

Do not commit generated `output/v4-phase2-review/` unless the accepted release evidence policy explicitly requires it.

---

### Task 13: Align protocol, package scripts, and Phase 2 acceptance

**Risk-adaptive lane:** standard. It aligns multiple public contracts after implementation is fixed.

**Files:**

- Modify: `orquesta/SKILL.md`
- Modify: `.agents/skills/orquesta/SKILL.md`
- Modify: `orquesta/references/orchestration-protocol.md`
- Modify: `orquesta/references/agent-contract.md`
- Modify: `orquesta/references/state-schema.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json` only if script metadata changes it
- Create: `docs/testing/orquesta-v4-phase2-review.md`
- Create: `scripts/v4/verify-phase2.js`
- Create: `scripts/v4/verify-phase2.test.js`

**Scripts:**

```json
{
  "test:v4:phase2": "node --test packages/acquisition/test packages/audit/test packages/audition/test packages/codex-adapter/test packages/evidence-fabric/test scripts/v4/run-phase2-slice.test.js scripts/v4/verify-phase2.test.js",
  "check:v4:phase2": "npm run test:v4:phase2 && node scripts/v4/verify-phase2.js",
  "review:v4:phase2": "node scripts/v4/review-phase2-live.js"
}
```

- [ ] **Step 1: Write documentation and verifier RED tests**

Assert both Skill mirrors state the same 2A/2B boundary, no second safety layer, install approval separation, App Server/SDK/repository adapter order, dispatch/turn separation, model evidence separation, and Phase 1.5 same-task cycles. Assert state-schema documents caches as derived and Event Journal evidence as canonical.

Verifier cases cover all connectors, budgets, cache expiry, hard gates, Audition preflight/cleanup, install authorization, App Server lifecycle, SDK capabilities, repository fallback, approval relay, model evidence, correlation, replay, legacy Phase 1, and no application or Phase 3 files.

- [ ] **Step 2: Run RED**

```powershell
node --test scripts/v4/verify-phase2.test.js
```

Expected: FAIL because verifier and aligned documentation are absent.

- [ ] **Step 3: Update protocol and public documentation**

Document only implemented behavior. State that the Workbench remains Phase 1 review-only, Phase 2 has no application shell, and application productization awaits a separate user decision.

- [ ] **Step 4: Implement verifier and scripts**

`verify-phase2.js` returns one JSON-safe result with deterministic checks and references to live evidence when present. It must not turn absent live evidence into a pass.

- [ ] **Step 5: Run the full verification matrix once**

```powershell
npm run check:v4:phase2
npm run check:v4:phase15
npm run check:v4:phase1
npm run check
git diff --check
node orquesta/scripts/validate-state-encoding.js
```

Expected: all commands PASS, Phase 1 fixture histories remain unchanged, and no encoding errors occur.

- [ ] **Step 6: Verify forbidden scope and runtime truth**

```powershell
git diff --name-only 4ee490b..HEAD
rg -n -i "electron|tauri|pwa|installer|apps/desktop|experience ledger|intent graph" packages scripts fixtures apps package.json
rg -n "actual_model" packages scripts fixtures
```

Expected: no application shell, Phase 3 implementation, dashboard redesign, or unbound actual-model claim. References in negative tests or explicit exclusions are allowed only when assertions prove absence.

- [ ] **Step 7: Commit Task 13**

```powershell
git add orquesta/SKILL.md .agents/skills/orquesta/SKILL.md orquesta/references README.md package.json package-lock.json docs/testing/orquesta-v4-phase2-review.md scripts/v4/verify-phase2.js scripts/v4/verify-phase2.test.js
git commit -m "docs(v4): operationalize Phase 2A and 2B"
```

---

## Final Verification Matrix

| Requirement | Primary evidence |
|---|---|
| shared Phase 2 types | `packages/contracts/test/contracts.test.js` |
| trust, TTL, query, and three-candidate bounds | `packages/acquisition/test/policy.test.js` and `coordinator.test.js` |
| four injectable live connectors | `packages/acquisition/test/connectors.test.js` |
| static Audit expansion | `packages/audit/test/audit.test.js` |
| profile preflight and bounded cleanup | `packages/audition/test/` |
| install semantic approval | `packages/core/test/install-approval.test.js` |
| repository-only honesty | `packages/codex-adapter/test/repository-adapter.test.js` |
| App Server initialize/thread/turn/event lifecycle | `packages/codex-adapter/test/app-server-adapter.test.js` |
| TypeScript SDK capability mapping | `packages/codex-adapter/test/sdk-adapter.test.js` |
| approval relay and model truth | `packages/codex-adapter/test/approval-relay.test.js` and `model-evidence.test.js` |
| Evidence Fabric correlation and replay | `packages/evidence-fabric/test/correlate.test.js` and Core tests |
| deterministic vertical slice | `scripts/v4/run-phase2-slice.test.js` |
| real live-source to Codex-turn proof | `output/v4-phase2-review/` plus journal refs |
| V3, Phase 1, and Phase 1.5 compatibility | existing full checks |
| no second safety layer or application scope | exact diff and forbidden-surface scan |

## Stop Conditions

- Stop if live source freshness, trust, or license evidence cannot be stated honestly.
- Stop if the Codex actual execution profile cannot be obtained or is broader than the approved Audition plan.
- Stop if install authorization cannot bind exact candidate/version/source and lockfile preview.
- Stop if App Server protocol differs from the pinned generated schema.
- Stop if approval requests cannot be correlated to the exact connection, thread, turn, and request.
- Stop if App Server and SDK are unavailable; repository-only fallback is useful but does not complete 2B.
- Stop if a plugin becomes necessary for a required runtime truth field. Amend the design and plan before adding an evidence-only bundle.
- Stop if application UI or Phase 3 work enters the fixed implementation range.

## Completion Rule

Phase 2 is ready for user review only when 2A and 2B matrix rows have fresh evidence, the live slice includes a real Codex turn and artifact or report, replay reproduces the evidence timeline, recommended/requested/applied/actual model fields remain truthful, V3/Phase 1/Phase 1.5 checks pass, Critical and Important findings are zero, and the user receives a hashed review packet. `Phase 2 approved` completes Phase 2. Application productization remains a separate later dialogue and is not implied by this approval.
