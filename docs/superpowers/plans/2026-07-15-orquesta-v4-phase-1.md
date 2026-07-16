# Orquesta V4 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 実装前に必要能力を分解し、ローカル資産と新規実装を証拠付きで比較し、専門家へ最小Context Packを渡せるPhase 1の縦切りを、三つのfixtureとV4 Workbenchでユーザーが5分以内に確認できる状態にする。

**Architecture:** 既存の`orquesta/`と`.orquesta/state/`はV3として残し、V4はnpm workspaceの新規packageと`.orquesta/v4/events.jsonl`へ横に追加する。V4のcanonical stateはappend-only Event Journalだけに置き、TaskIntent、Capability Graph、Provider、CandidateEvaluation、Resolution、Context Pack、Phase Reviewは決定論的projectionとして再構築する。Phase 1はlocal-only、proposal-only、manual-approval-onlyであり、Web探索、外部導入、Codex dispatch、Electron、Experience、Intent Graphは動かさない。

**Tech Stack:** Node.js 20以上、CommonJS、npm workspaces、`node:test`、Node標準のHTTP/crypto/fs API、静的HTML/CSS/JavaScript、dev-onlyの`playwright-core`と既存Chromeを使うbrowser smoke。runtime依存関係は追加しない。

## Global Constraints

- 承認済み設計は`docs/superpowers/specs/2026-07-15-orquesta-v4-design.md`である。実装中に仕様を広げない。
- 既存の`npm run dashboard`と`npm run check`のコマンド文字列と意味を変えない。V4は`npm run workbench:v4`と`npm run check:v4:phase1`からだけ起動する。
- `.orquesta/state/*.json`、vision、failures、reportsをV4 EventStoreへ移行しない。V4 runtimeは`.orquesta/v4/`だけへ書く。
- `actual_model`はruntime証拠が存在しないPhase 1では常に`null`とする。推薦やfixture値で補完しない。
- network、package install、外部送信、課金、秘密情報、Codex thread操作、製品コード変更を行うWorkbench commandを作らない。
- この計画をユーザーが実行承認した場合に限り、Task 12でreview harness用`playwright-core`をdevDependencyとして一度導入できる。それ以外の外部package、browser download、candidate自動導入は承認範囲外とする。
- Candidateの説明文やREADME本文をinstructionへ混ぜない。Phase 1 inventoryはmetadata、hash、短い説明だけを扱う。
- `build`をすべてのNeedの比較候補に入れる。hard gate失敗候補はscoreが高くても選択可能にしない。
- Context Compiler v1の入力は`TaskIntent + approved/proposed Resolution + agent contract`だけとする。`packages/intent-graph`を作らず、Intent Graphをimportしない。
- Phase Reviewの`approved`は、ユーザーの明示的な決定だけで生成する。テスト合格や時間経過で自動承認しない。
- HTTP bodyの`actor.type`、session ID、attestationをユーザー証拠として信用しない。Workbenchのsame-origin session、一回限りchallenge、target、candidate、decision、revision、review packet hashをtrusted approval adapterが照合し、actorとattestationを生成する。これはOS本人認証ではないため`local_interaction_unverified_identity`と表示する。
- EventStoreの破損・競合はfail-closedにする。自動切り捨て、自動lock奪取、競合revisionの自動選択をしない。
- 各taskはRED、GREEN、対象check、commitの順で終える。別taskの未完成コードを同じcommitへ混ぜない。
- browser smokeが実行できない場合、DOM unit testで代用して「browser確認済み」とは書かない。Phase 1 reviewをblockする。

## File Map

```text
apps/
  workbench/
    package.json
    server.js
    src/{api.js,service.js,state-view.js,approval-session.js}
    public/{index.html,styles.css,app.js,view-model.js}
    scripts/{browser-smoke.js,review-capture.js}
    test/{api.test.js,approval-session.test.js,view-model.test.js,static-assets.test.js}
packages/
  contracts/
    package.json
    src/{index.js,canonical-json.js,validator.js}
    schemas/{task-intent,capability-need,capability-provider,candidate-evaluation,audition,resolution,context-pack,event-batch,phase-review,approval-attestation}.schema.json
    test/contracts.test.js
  event-store/
    package.json
    src/{index.js,atomic-replace.js,cleanup.js,lock.js,journal.js,projection-store.js,recovery.js,diagnostics.js,errors.js}
    test/{commit.test.js,crash-worker.js,recovery.test.js,replay.test.js,onedrive-live.test.js}
  core/
    package.json
    src/{index.js,task-intent.js,commands.js,projectors.js,phase-review.js,review-packet.js}
    test/{commands.test.js,phase-review.test.js,vertical-slice.test.js,review-packet.test.js}
  capability-compiler/
    package.json
    src/{index.js,normalize.js,rule-source.js,graph.js}
    test/compiler.test.js
  scouts/
    package.json
    src/{index.js,inventory.js,repository-source.js,package-source.js,codex-source.js,fixture-source.js}
    test/{inventory.test.js,scout.test.js}
  audit/
    package.json
    src/{index.js,hard-gates.js,score.js}
    test/audit.test.js
  capability-resolver/
    package.json
    src/{index.js,build-candidate.js,resolve.js}
    test/resolver.test.js
  context-compiler/
    package.json
    src/{index.js,agent-contract.js,compile.js}
    test/context-compiler.test.js
fixtures/
  v4/phase1/
    compiler-rules.json
    local-reuse/{task-intent.json,providers.json,expected.json}
    adapt-vs-build/{task-intent.json,providers.json,expected.json}
    blocked-candidate/{task-intent.json,providers.json,expected.json}
scripts/v4/
  {phase-boundary-check.js,phase-boundary-check.test.js}
  browser-preflight.js
  run-fixture.js
  verify-phase1.js
docs/testing/orquesta-v4-phase1-review.md
orquesta.capabilities.json
package-lock.json
```

`.orquesta/v4/`はruntime生成物なのでGitへ追加しない。source fixtureは`fixtures/v4/phase1/`へ置く。

## Ownership and Execution Waves

| Wave | Task | Primary owner | Independent gate |
|---|---|---|---|
| A | 1-2 | `implementation-001` | `protocol-architect-001`が契約とPhase境界を確認 |
| B | 3-4 | `implementation-001` | `protocol-architect-001`がcommit/recovery証拠を確認 |
| C | 5と6を並列、その後7-9 | `implementation-001` | orchestratorが依存と責任境界を照合 |
| D | 10-11 | `implementation-001` | API contract test |
| E | 12 | `implementation-001` | `dashboard-ux-001`がUX、`bootstrap-qa-001`が実ブラウザを独立確認 |
| F | 13 | `implementation-001` | `bootstrap-qa-001`がfull gateを独立実行し、orchestratorがpacketを受理する |

orchestratorはtask作成、handoff、report照合、変更要求、受理だけを行い、専門taskの実装を代行しない。実行時のOrquesta task IDは、その時点の`.orquesta/state/tasks.json`から衝突しない番号を割り当てる。各handoffのContext Packへ、この計画の`Files`をtask-scoped `allowed_files`として正確に入れる。既存agent baselineに新しい`apps/**`や`packages/**`が無い場合、無言で違反せず、対象taskだけの明示grantとしてstateへ記録する。

---

## Task 1: Freeze the V3 Boundary and Add the Workspace Shell

**Owner:** `implementation-001`

**Files:**

- Create: `scripts/v4/phase-boundary-check.js`
- Create: `scripts/v4/phase-boundary-check.test.js`
- Create: `scripts/v4/browser-preflight.js`
- Create: `apps/workbench/package.json`
- Create: `packages/contracts/package.json`
- Create: `packages/event-store/package.json`
- Create: `packages/core/package.json`
- Create: `packages/capability-compiler/package.json`
- Create: `packages/scouts/package.json`
- Create: `packages/audit/package.json`
- Create: `packages/capability-resolver/package.json`
- Create: `packages/context-compiler/package.json`
- Create: `package-lock.json`
- Modify: `package.json`

- [ ] **Step 1: Write the RED boundary test**

`scripts/v4/phase-boundary-check.test.js`で、既存V3 entry point、V4 workspace、Phase 1禁止directoryを検査する。

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("V3 entry points remain unchanged", () => {
  assert.equal(pkg.private, false);
  assert.equal(pkg.scripts.dashboard, "node orquesta/dashboard-server.js");
  assert.match(pkg.scripts.check, /^node --check orquesta\/dashboard-server\.js/);
});

test("Phase 1 exposes only the V4 workbench surface", () => {
  assert.deepEqual(pkg.workspaces, ["apps/*", "packages/*"]);
  assert.equal(pkg.scripts["workbench:v4"], "node apps/workbench/server.js --feature v4");
  for (const blocked of [
    "apps/desktop",
    "packages/codex-adapter",
    "packages/experience",
    "packages/intent-graph",
    "plugins/orquesta"
  ]) assert.equal(fs.existsSync(path.join(root, blocked)), false, blocked);
});
```

Run:

```powershell
node --test scripts/v4/phase-boundary-check.test.js
```

Expected RED: `pkg.workspaces`または`workbench:v4`が存在せず、1件以上failする。

- [ ] **Step 2: Add workspace and V4-only commands**

`package.json`へ次だけを追加し、既存script本文は編集しない。

```json
{
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "workbench:v4": "node apps/workbench/server.js --feature v4",
    "test:v4:phase1": "npm run test --workspaces --if-present && node --test scripts/v4/phase-boundary-check.test.js",
    "check:v4:phase1": "node scripts/v4/phase-boundary-check.js && npm run test:v4:phase1",
    "fixture:v4:phase1": "node scripts/v4/run-fixture.js",
    "review:v4:phase1": "node scripts/v4/verify-phase1.js"
  }
}
```

`phase-boundary-check.js`は、上の禁止directory、既存V3 entry point、`.orquesta/`、`output/`、`node_modules/`が`.gitignore`対象であること、Node major versionが20以上であることを確認し、違反時はexit 1にする。外部runtime dependencyは0、root devDependencyはTask 12で追加する`playwright-core`だけを許可する。

`browser-preflight.js --check-chrome-only`は`ORQUESTA_CHROME_PATH`とWindows標準のChrome install pathだけを調べ、executable pathとversionを表示する。Chromeが無ければ`BROWSER_RUNNER_UNAVAILABLE`で止める。`npx`、browser download、network fallbackは行わない。

- [ ] **Step 3: Register dependency-free workspace packages**

各workspace manifestは`private: true`、`version: "0.4.0-preview.1"`、`scripts.test: "node --test"`を持つ。package間の依存はnpm workspaceだけに限定する。例:

```json
{
  "name": "@orquesta/event-store",
  "version": "0.4.0-preview.1",
  "private": true,
  "main": "src/index.js",
  "scripts": { "test": "node --test" },
  "dependencies": { "@orquesta/contracts": "*" }
}
```

workspace dependency graphは次に固定する。

- `event-store`、`capability-compiler`、`scouts`、`audit`、`context-compiler`は`contracts`へ依存する。
- `capability-resolver`は`contracts`と`audit`へ依存する。
- `core`はcontracts、event-store、compiler、scouts、audit、resolver、context-compilerへ依存する。
- `workbench`はcoreとevent-storeへ依存する。

外部package dependencyは追加しない。

```powershell
npm install --ignore-scripts --offline
npm ls --workspaces --depth=0
node scripts/v4/browser-preflight.js --check-chrome-only
```

Expected: 9 workspace packageが表示され、外部packageの取得は0。`node_modules/`はGit対象外、`package-lock.json`はsourceとして保持する。

Task 1時点のlockfileにはworkspace link以外の`resolved` registry artifactが0件であることをtestする。rootの`private: false`と既存publish metadataは変えず、新しいV4 workspace packageだけを`private: true`にする。

- [ ] **Step 4: Make the boundary test GREEN**

```powershell
node --test scripts/v4/phase-boundary-check.test.js
node scripts/v4/phase-boundary-check.js
npm run check
```

Expected:

```text
# pass 2
Orquesta V4 Phase 1 boundary check passed
Orquesta encoding check passed: .orquesta
```

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json apps/workbench/package.json packages scripts/v4/phase-boundary-check.js scripts/v4/phase-boundary-check.test.js scripts/v4/browser-preflight.js
git commit -m "build: add isolated V4 workspace boundary"
```

## Task 2: Implement Shared Contracts and Deterministic Validation

**Owner:** `implementation-001`

**Independent review:** `protocol-architect-001`

**Depends on:** Task 1

**Files:**

- Modify: `packages/contracts/package.json`
- Create: `packages/contracts/src/index.js`
- Create: `packages/contracts/src/canonical-json.js`
- Create: `packages/contracts/src/validator.js`
- Create: `packages/contracts/schemas/task-intent.schema.json`
- Create: `packages/contracts/schemas/capability-need.schema.json`
- Create: `packages/contracts/schemas/capability-provider.schema.json`
- Create: `packages/contracts/schemas/candidate-evaluation.schema.json`
- Create: `packages/contracts/schemas/audition.schema.json`
- Create: `packages/contracts/schemas/resolution.schema.json`
- Create: `packages/contracts/schemas/context-pack.schema.json`
- Create: `packages/contracts/schemas/event-batch.schema.json`
- Create: `packages/contracts/schemas/phase-review.schema.json`
- Create: `packages/contracts/schemas/approval-attestation.schema.json`
- Create: `packages/contracts/test/contracts.test.js`

- [ ] **Step 1: Write RED contract tests**

最低限、次を実データで落とす。

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateContract, validatePhaseApprovalBinding, canonicalHash } = require("../src");

const validIntent = {
  task_intent_id: "TI-local-reuse",
  raw_request_ref: "fixture:local-reuse",
  desired_outcome: "既存のUTF-8 atomic helperを再利用する",
  acceptance_criteria: ["既存helperの証拠pathとhashが出る"],
  constraints: ["network禁止", "product code変更禁止"],
  risk: { impact: "low", reversible: true },
  authority_boundary: { agent_may: ["propose"], user_only: ["approve"] },
  assumptions: [],
  status: "compiled"
};

test("TaskIntent rejects missing acceptance criteria", () => {
  const invalid = { ...validIntent, acceptance_criteria: [] };
  assert.equal(validateContract("task-intent", invalid).ok, false);
});

test("canonical hash ignores object key order", () => {
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
});

test("actual_model cannot be invented in Phase 1 evidence", () => {
  const evaluation = {
    evaluation_id: "CE-phase1-example",
    need_id: "NEED-example",
    candidate_id: "PROVIDER-example",
    policy_version: "phase1-v1",
    axes: {
      task_fit: { value: 80, reason: "fixture capability match" },
      integration_ease: { value: 80, reason: "same Node runtime" },
      evidence_strength: { value: 70, reason: "source hash present" },
      maintainability: { value: 70, reason: "local source" },
      security: { value: 80, reason: "no executable download" },
      license_fit: { value: 100, reason: "MIT metadata" },
      exit_option: { value: 90, reason: "single reference removal" },
      cost: { value: 100, reason: "no fee" }
    },
    uncertainty_penalty: 5,
    weighted_sum: 81,
    candidate_score: 76,
    hard_gate_results: [],
    eligibility: "eligible",
    actual_model: null
  };
  assert.equal(evaluation.actual_model, null);
  assert.equal(validateContract("candidate-evaluation", evaluation).ok, true);
});

test("approval attestation rejects secrets and request-supplied actors", () => {
  const base = {
    source: "local_workbench_confirmation",
    challenge_id: "CHALLENGE-001",
    target_id: "RES-001",
    target_revision: 12,
    review_packet_hash: "a".repeat(64),
    token_hash: "b".repeat(64),
    captured_at: "2026-07-15T00:00:00.000Z",
    expires_at: "2026-07-15T00:10:00.000Z",
    identity_assurance: "local_interaction_unverified_identity"
  };
  assert.equal(validateContract("approval-attestation", { ...base, raw_token: "secret" }).ok, false);
  assert.equal(validateContract("approval-attestation", { ...base, actor: { type: "user" } }).ok, false);
});

test("phase approval rejects packet hash and revision mismatch", () => {
  const result = validatePhaseApprovalBinding({
    phaseReview: { review_packet_hash: "a".repeat(64), journal_revision: 12 },
    attestation: { review_packet_hash: "b".repeat(64), target_revision: 11 }
  });
  assert.deepEqual(result.errors.map((error) => error.code).sort(), [
    "approval_packet_hash_mismatch",
    "approval_revision_mismatch"
  ]);
});
```

Run:

```powershell
npm test --workspace @orquesta/contracts
```

Expected RED: `Cannot find module '../src'`。

- [ ] **Step 2: Implement canonical JSON and the schema subset**

`canonical-json.js`はobject keyを再帰sortし、array順は保存し、`undefined`を拒否する。`canonicalHash(value)`はUTF-8 canonical JSONのSHA-256 hexを返す。

`validator.js`が実装するJSON Schema keywordは次に限定する。

```js
const SUPPORTED_KEYWORDS = new Set([
  "$id", "$schema", "type", "required", "properties", "items",
  "enum", "const", "minItems", "minimum", "maximum", "pattern",
  "additionalProperties", "anyOf", "oneOf"
]);
```

未知keywordを無視せずschema load時に失敗させる。validation resultは次の形に固定する。

```js
{
  ok: false,
  errors: [{ path: "$.acceptance_criteria", code: "minItems", message: "must contain at least 1 item" }]
}
```

- [ ] **Step 3: Add all ten schemas**

各schemaは`additionalProperties: false`を基本にし、将来拡張が必要な`payload`と`evidence metadata`だけobjectを許可する。enumは承認済み設計へ合わせる。

```js
const STATUS = {
  taskIntent: ["draft", "compiled", "approved", "superseded"],
  resolution: ["proposed", "approved", "changes_requested", "rejected"],
  phaseReview: ["in_progress", "ready_for_user_review", "changes_requested", "approved"],
  resolutionMode: ["reuse", "adapt", "build", "ask", "abandon"],
  capabilityKind: ["code", "tool", "knowledge", "data", "permission", "runtime", "service", "asset", "human_judgment", "evidence"]
};
```

`candidate-evaluation`は8軸の0-100値、各軸理由、`uncertainty_penalty`、hard gate結果、`actual_model: null`を必須にする。`event-batch`は`sequence`、`expected_revision`、`batch_id`、actor、correlation ID、1件以上のeventを必須にする。`approval-attestation`はsource、challenge ID、target ID、target revision、token hash、captured/expiry time、identity assuranceを必須にし、生token、secret、request-supplied actorを禁止する。

`phase-review`の`ready_for_user_review`と`approved`には`review_packet_ref`、`review_packet_hash`、`build_ref`、artifact hash mapを必須にする。approval attestationのtarget revisionとpacket hashが同じreview cycleを指さなければvalidation errorにする。

- [ ] **Step 4: Export one stable public surface**

```js
module.exports = {
  SCHEMA_NAMES,
  canonicalJson,
  canonicalHash,
  loadSchema,
  validateContract,
  assertContract,
  validatePhaseApprovalBinding
};
```

各packageはこのindex以外のcontracts内部fileを直接importしない。

- [ ] **Step 5: GREEN and protocol gate**

```powershell
npm test --workspace @orquesta/contracts
node --check packages/contracts/src/validator.js
npm run check
```

Expected: 全contract test pass、V3 check pass。protocol reviewerは、field名、status、Phase 1の`actual_model: null`、`phase-review approved`のユーザー限定をreportで確認する。

- [ ] **Step 6: Commit**

```powershell
git add packages/contracts
git commit -m "feat(v4): add shared Phase 1 contracts"
```

## Task 3: Implement the Event Journal Commit Protocol

**Owner:** `implementation-001`

**Independent review:** `protocol-architect-001`

**Depends on:** Task 2

**Files:**

- Modify: `packages/event-store/package.json`
- Create: `packages/event-store/src/index.js`
- Create: `packages/event-store/src/atomic-replace.js`
- Create: `packages/event-store/src/lock.js`
- Create: `packages/event-store/src/journal.js`
- Create: `packages/event-store/src/errors.js`
- Create: `packages/event-store/test/commit.test.js`
- Create: `packages/event-store/test/crash-worker.js`

- [ ] **Step 1: Write RED commit and idempotency tests**

Public APIを先に固定する。

```js
const store = createEventStore({
  stateRoot,
  workspaceId: "fixture-workspace",
  hostId: "test-host",
  clock: () => "2026-07-15T00:00:00.000Z"
});

const result = store.commit({
  batch_id: "BATCH-001",
  expected_revision: 0,
  actor: { type: "agent", id: "orchestrator" },
  correlation_id: "TI-local-reuse",
  events: [{
    event_id: "EV-001",
    schema_version: 1,
    type: "task.intent.created",
    payload: validTaskIntent,
    evidence_refs: []
  }]
});

assert.equal(result.status, "committed");
assert.equal(result.sequence, 1);
assert.equal(store.commit(sameBatch).status, "idempotent");
assert.throws(() => store.commit({ ...sameBatch, events: changedEvents }), {
  code: "EVENT_BATCH_ID_CONFLICT"
});
```

追加case:

- wrong `expected_revision`は`EVENT_REVISION_CONFLICT`
- 重複`event_id`はcommit前に拒否
- journalは一物理行一batch、UTF-8、末尾newline
- lock metadataに`owner_pid`、`host_id`、`nonce`、`acquired_at`、`target_revision`がある
- stale dead-owner lockを自動削除しない
- 二processの同一revision commitは片方だけ成功する

Run:

```powershell
npm test --workspace @orquesta/event-store -- --test-name-pattern="commit|idempotent|lock"
```

Expected RED: Task 1はmanifestだけを作るため、`Cannot find module '../src'`またはpackage main不在でfailする。

- [ ] **Step 2: Implement fail-closed lock ownership**

`lock.js`のpublic surfaceを固定する。

```js
acquireJournalLock({ journalPath, hostId, targetRevision, timeoutMs })
releaseJournalLock(lock)
inspectJournalLock(journalPath)
```

lockは`openSync(path, "wx")`で作り、metadataを書いたhandleを`fsyncSync`してから取得成功にする。timeout後もowner生存またはtransitionを証明できないlockを盗まない。releaseはnonce一致を再読してから行う。

- [ ] **Step 3: Implement atomic replacement and pending record**

`atomic-replace.js`は既存`orquesta/scripts/json-state.js`と同じ、同一directoryのtemp file、flush、backup保持、atomic rename、再読検証を使う。ただしV3 helperを変更せず、V4 EventStore専用にする。

pending recordは次を必須にする。

```js
{
  pending_version: 1,
  workspace_id: "fixture-workspace",
  journal_path: ".orquesta/v4/events.jsonl",
  batch_id: "BATCH-001",
  expected_revision: 0,
  next_sequence: 1,
  serialized_batch: "{\"journal_version\":1,\"sequence\":1}",
  sha256: "64-lowercase-hex",
  created_at: "2026-07-15T00:00:00.000Z"
}
```

- [ ] **Step 4: Implement the nine-stage commit**

`journal.js`は次のfailure injection pointを持つ。これはtest-only optionで、Workbench APIへ公開しない。

```js
const CRASH_POINTS = [
  "before_pending_write",
  "after_pending_fsync",
  "after_temp_journal_fsync",
  "after_journal_rename",
  "after_journal_verify",
  "after_projection_write",
  "before_pending_delete"
];
```

Task 3ではprojection writeをno-op callbackとして呼び、Task 4で実体を接続する。commit成功はjournal再読で`sequence`、`batch_id`、hashが一致した後だけ返す。

- [ ] **Step 5: Run controlled abort tests and prove a real crash leaves a blocker**

まず7 pointをcontrolled errorで中断し、lock release後に同じbatchをretryして、journal内の`batch_id`と`event_id`が1件ずつになることを確認する。次に`crash-worker.js`を`after_pending_fsync`で`process.exit(86)`させ、lockとpendingが残り、通常commitが`EVENT_STALE_LOCK`でfail-closedになることを確認する。Task 3ではtest temp rootを検証後にtest harnessが撤去するだけで、製品recoveryはまだ行わない。7 pointすべての実process crashからの復旧はTask 4で行う。

```powershell
npm test --workspace @orquesta/event-store -- --test-name-pattern="crash"
```

Expected: controlled abort 7件とreal crash blocker 1件がpassし、通常pathがstale lockを盗まない。

- [ ] **Step 6: GREEN and commit**

```powershell
npm test --workspace @orquesta/event-store -- --test-name-pattern="commit|idempotent|lock|crash"
npm run check
git add packages/event-store
git commit -m "feat(v4): add durable event journal commits"
```

## Task 4: Add Replay, Projections, Diagnostics, and Explicit Recovery

**Owner:** `implementation-001`

**Independent review:** `protocol-architect-001`

**Depends on:** Task 3

**Files:**

- Create: `packages/event-store/src/projection-store.js`
- Create: `packages/event-store/src/recovery.js`
- Create: `packages/event-store/src/diagnostics.js`
- Create: `packages/event-store/src/cleanup.js`
- Create: `packages/event-store/test/recovery.test.js`
- Create: `packages/event-store/test/replay.test.js`
- Create: `packages/event-store/test/onedrive-live.test.js`
- Modify: `packages/event-store/src/index.js`
- Modify: `packages/event-store/src/journal.js`

- [ ] **Step 1: Write RED replay equivalence tests**

```js
const first = store.replay({ reducers, initialState });
for (const filePath of store.listProjectionPaths()) {
  assert.equal(path.relative(path.join(stateRoot, "projections"), filePath).startsWith(".."), false);
  store.removeArtifact(filePath);
}
const rebuilt = store.rebuildProjections({ reducers, initialState });
assert.deepEqual(rebuilt.state, first.state);
assert.equal(rebuilt.watermark.journal_sequence, 3);
assert.equal(rebuilt.watermark.last_batch_id, "BATCH-003");
```

同じjournalを2回replayしてcanonical hashが一致すること、projection先行時は破棄再構築、遅延時は追従することもtestする。

- [ ] **Step 2: Write the recovery matrix as fixture tests**

以下を一件ずつ独立temp rootで再現する。

| Case | Expected |
|---|---|
| pendingあり、journalなし、revision一致 | inspectは`retry_commit`; `--apply`だけ再実行 |
| pendingあり、journalに同hash | projection再構築後pending削除 |
| pendingあり、同batch別hash | `blocked_conflict`、両方quarantine |
| 末尾途中行、valid `.bak`、一意pending | 壊れたjournalをquarantineし、明示applyで復旧 |
| 末尾途中行、backup/pendingなし | `blocked_corruption`、自動切り捨てなし |
| 中間破損 | read-only blocker |
| sequence gap | read-only blocker |
| duplicate sequence | read-only blocker |
| stale lock | inspectのみ。自動解除なし |
| OneDrive conflict copy | 両hashとmtimeを報告し、revisionを選ばない |
| projection遅延 | 自動再構築可 |
| projection先行/hash不一致 | projectionを破棄し再構築可 |

各blocked resultは`last_valid_sequence`、`quarantine_paths`、`required_user_decision`を返す。

- [ ] **Step 3: Implement read-only inspect and explicit apply**

```js
const inspection = store.inspectRecovery();
// inspection mutates nothing
const applied = store.applyRecovery({
  recoveryId: inspection.recovery_id,
  action: "retry_pending_commit",
  operator: { type: "local_operator", id: "explicit-recovery-command" }
});
```

`applyRecovery`のoperatorはCLIまたはWorkbench serviceが固定し、request payloadからuser actorを受けない。直前inspectionのhashが現在のartifact hashと一致しない場合、`RECOVERY_STATE_CHANGED`で停止する。quarantineはcopyとhash確認を先に行い、元fileの移動に失敗した場合はblockerを返す。競合revisionの選択はPhase 1のapply actionに含めず、ユーザー判断待ちのまま止める。

- [ ] **Step 4: Persist projection watermarks atomically**

各projection fileは次のwrapperを持つ。

```js
{
  projection_version: 1,
  journal_sequence: 3,
  last_batch_id: "BATCH-003",
  journal_hash: "64-lowercase-hex",
  data: {}
}
```

projectionの手編集を検出したらjournalから再構築する。projection failureでjournal commitを未commit扱いにせず、pendingを残してrecovery対象にする。

このprojection実体を接続した後、`crash-worker.js`を7 pointすべてで本当にprocess exitさせる。各caseは`inspectRecovery()`、明示的`applyRecovery()`、同一batch retryの順で処理し、最終journalとprojectionでbatch/eventが一回だけ適用されることを確認する。

- [ ] **Step 5: Run OneDrive live smoke**

`cleanup.js`に`removeArtifact(filePath, options)`と`removeProbeTree(probeRoot, workspaceRoot)`を実装する。fileは既存V3と同じbounded retry付き`unlinkSync`、probe directoryはresolved pathがworkspace内かつ`.orquesta/v4/.probe-` prefixであることを確認し、既知artifactをleaf-firstで削除して空directoryだけを`rmdirSync`する。V4 source/testでrecursive `fs.rmSync`を禁止するtestを加える。

`onedrive-live.test.js`は現在workspace内の`.orquesta/v4/.probe-<pid>/`だけを使う。cross-processで24 batchをcommitし、`EVENT_REVISION_CONFLICT`を受けたworkerは最新revisionを再読して有限回retryする。最終的にsequence 1-24、batch重複なし、残留lockなし、`removeProbeTree`後のartifact 0件を確認する。

```powershell
node --test packages/event-store/test/onedrive-live.test.js
```

Expected:

```text
# pass 1
# fail 0
```

- [ ] **Step 6: Full GREEN, protocol report, and commit**

```powershell
npm test --workspace @orquesta/event-store
node --test --test-name-pattern="process crash" packages/event-store/test/recovery.test.js
npm run check
git add packages/event-store
git commit -m "feat(v4): add deterministic replay and recovery"
```

Protocol reportがcommit順、7 crash point、12 recovery case、OneDrive live smoke、fail-closed caseを個別に確認するまでWave Cへ進まない。

## Task 5: Create TaskIntent and Capability Compiler v1

**Owner:** `implementation-001`

**Depends on:** Task 2

**Files:**

- Modify: `packages/core/package.json`
- Create: `packages/core/src/task-intent.js`
- Modify: `packages/capability-compiler/package.json`
- Create: `packages/capability-compiler/src/index.js`
- Create: `packages/capability-compiler/src/normalize.js`
- Create: `packages/capability-compiler/src/rule-source.js`
- Create: `packages/capability-compiler/src/graph.js`
- Create: `packages/capability-compiler/test/compiler.test.js`
- Create: `fixtures/v4/phase1/compiler-rules.json`

- [ ] **Step 1: Write RED deterministic compiler tests**

同じTaskIntentとrule catalogをkey順だけ変えて2回compileし、Graphのcanonical hashが一致することを確認する。

```js
const graphA = compileCapabilities({ taskIntent, rules });
const graphB = compileCapabilities({ taskIntent: reorderKeys(taskIntent), rules: reorderRuleKeys(rules) });
assert.deepEqual(graphA, graphB);
assert.equal(graphA.graph_hash, graphB.graph_hash);
assert.ok(graphA.needs.every((need) =>
  need.verification_method || need.unresolved_reason
));
```

追加case:

- NFKCと小文字化で同じruleが一致する
- 同じkind、正規化description、verification methodのNeedをdedupeする
- 同じdescriptionでもverification methodが異なれば勝手に統合しない
- dependency cycleは`CAPABILITY_GRAPH_CYCLE`
- 不明dependency IDは`CAPABILITY_GRAPH_UNKNOWN_DEPENDENCY`
- rule未一致時は、捏造したcode Needではなく`human_judgment` Needを1件出す

Run:

```powershell
npm test --workspace @orquesta/capability-compiler
```

Expected RED: Task 1はmanifestだけを作るため、`Cannot find module '../src'`またはpackage main不在でfailする。

- [ ] **Step 2: Implement TaskIntent creation as an outcome contract**

`createTaskIntent(input)`はraw requestを実装命令として保存せず、成果契約をschema検査する。

```js
createTaskIntent({
  rawRequestRef: "fixture:local-reuse",
  desiredOutcome: "既存のatomic JSON helperを再利用できるか判断する",
  acceptanceCriteria: ["provider pathとhashがある", "build候補と比較される"],
  constraints: ["network禁止", "product code変更禁止"],
  risk: { impact: "low", reversible: true },
  authorityBoundary: { agent_may: ["inspect", "propose"], user_only: ["approve"] },
  assumptions: []
});
```

IDは`TI-`とcanonical hash先頭12文字で作る。clockやrandom値をIDへ入れない。

- [ ] **Step 3: Implement a bounded deterministic rule source**

Phase 1のCompilerは一般自然言語理解を装わない。`compiler-rules.json`のruleだけを使い、各Needへ`rule_id`とmatched fieldをprovenanceとして残す。

```json
{
  "rule_id": "ui-browser-evidence-v1",
  "match": {
    "any_terms": ["ui", "画面", "workbench"],
    "acceptance_terms": ["browser", "ブラウザ"]
  },
  "emits": [
    {
      "kind": "asset",
      "description": "再利用可能なUI構成要素",
      "verification_method": "候補のsource path、license、compatibilityを確認する"
    },
    {
      "kind": "evidence",
      "description": "実ブラウザ操作証拠",
      "verification_method": "console errorなしでfixture完走を記録する",
      "depends_on_emit": [0]
    }
  ]
}
```

rule match対象は`desired_outcome`と`acceptance_criteria`だけに限定し、Web本文やProvider説明を入力へ入れない。

- [ ] **Step 4: Build and validate the DAG**

`compileCapabilities()`の返却を固定する。

```js
{
  graph_id: "CG-<12 hex>",
  task_intent_id: "TI-<12 hex>",
  compiler_version: 1,
  needs: [],
  edges: [],
  unresolved_need_ids: [],
  provenance: [],
  graph_hash: "64-lowercase-hex"
}
```

Needとedgeを安定ID順にsortしてからhashする。循環、重複、verification欠落をGraph生成時に止める。

- [ ] **Step 5: GREEN and commit**

```powershell
npm test --workspace @orquesta/capability-compiler
npm test --workspace @orquesta/contracts
git add packages/core/package.json packages/core/src/task-intent.js packages/capability-compiler fixtures/v4/phase1/compiler-rules.json
git commit -m "feat(v4): compile task intents into capability graphs"
```

## Task 6: Build Local Inventory and Scout v1

**Owner:** `implementation-001`

**Depends on:** Task 2

**Parallel with:** Task 5

**Files:**

- Modify: `packages/scouts/package.json`
- Create: `packages/scouts/src/index.js`
- Create: `packages/scouts/src/inventory.js`
- Create: `packages/scouts/src/repository-source.js`
- Create: `packages/scouts/src/package-source.js`
- Create: `packages/scouts/src/codex-source.js`
- Create: `packages/scouts/src/fixture-source.js`
- Create: `packages/scouts/test/inventory.test.js`
- Create: `packages/scouts/test/scout.test.js`
- Create: `orquesta.capabilities.json`

- [ ] **Step 1: Write RED inventory-source tests using fake roots**

testは実ユーザーの`~/.codex`へ依存せず、temp projectとtemp Codex homeを注入する。

```js
const inventory = collectLocalInventory({
  projectRoot: fakeProject,
  codexHome: fakeCodexHome,
  fixtureCatalogPath: path.join(fakeProject, "providers.json"),
  clock: () => "2026-07-15T00:00:00.000Z"
});

assert.deepEqual(new Set(inventory.sources.map((item) => item.source_type)), new Set([
  "repository", "package_manifest", "package_lock", "codex_skill", "codex_plugin", "codex_mcp", "fixture"
]));
assert.equal(JSON.stringify(inventory).includes("SECRET_VALUE"), false);
```

追加case:

- lockfile不在はerrorでなく`status: "absent"`
- `orquesta.capabilities.json`のsource pathがworkspace外なら拒否
- skillはfrontmatterのnameとdescriptionだけを読む
- pluginは`.codex-plugin/plugin.json`だけを読む
- MCPはserver名とtransport種別だけを保存し、command args、env、token、URL queryを保存しない
- 同じprovider IDの同hashはdedupe、別hashはconflict

- [ ] **Step 2: Define the honest repository capability manifest**

Phase 1は任意source codeを意味解析したふりをしない。repository providerは、`orquesta.capabilities.json`の明示metadata、`package.json`のexports/scripts/dependencies、fixture catalogから作る。

```json
{
  "version": 1,
  "providers": [
    {
      "provider_id": "repo-json-state-helper",
      "provider_type": "repository_code",
      "source_ref": "orquesta/scripts/json-state.js",
      "capabilities": ["atomic JSON write", "UTF-8 state persistence"],
      "trust_tier": "local",
      "license": "MIT"
    }
  ]
}
```

source refは存在、workspace内、regular fileであることを確認し、SHA-256とGit revisionをevidenceへ入れる。file本文はinventoryへコピーしない。

- [ ] **Step 3: Parse Codex metadata without ingesting instructions**

`codex-source.js`はSKILL.mdの先頭frontmatterだけを最大16 KiB読む。frontmatter後の本文をProvider説明やagent promptへ入れない。MCP configのsecret-bearing fieldは値を保存せず、存在だけ`redaction_status: "redacted"`にする。

- [ ] **Step 4: Implement bounded Scout v1**

```js
const result = scoutNeed({
  need,
  inventory,
  budget: { max_candidates: 3, max_sources: 4 },
  allowed_sources: ["repository", "package_manifest", "package_lock", "codex", "fixture"]
});
```

返却は`candidates`最大3件、`evidence_refs`、`unverified_fields`、`stop_reason`を持つ。`allowed_sources`へ`web`、`registry`、`remote`が来たら`SCOUT_SOURCE_NOT_ALLOWED_PHASE1`で拒否する。候補ゼロは`build`をScoutが捏造せず、Resolverへ未解決として返す。

- [ ] **Step 5: Prove there is no network path**

test child processで`global.fetch`、`http.request`、`https.request`をthrowへ置き換え、全sourceとScoutを実行してpassすることを確認する。

```powershell
npm test --workspace @orquesta/scouts
```

Expected: secret非保存、network call 0、候補上限3、source absenceを含む全test pass。

- [ ] **Step 6: Commit**

```powershell
git add packages/scouts
git commit -m "feat(v4): inventory local capability providers"
```

## Task 7: Implement Static Audit, Transparent Scoring, and Resolver v1

**Owner:** `implementation-001`

**Depends on:** Tasks 5-6

**Files:**

- Modify: `packages/audit/package.json`
- Create: `packages/audit/src/index.js`
- Create: `packages/audit/src/hard-gates.js`
- Create: `packages/audit/src/score.js`
- Create: `packages/audit/test/audit.test.js`
- Modify: `packages/capability-resolver/package.json`
- Create: `packages/capability-resolver/src/index.js`
- Create: `packages/capability-resolver/src/build-candidate.js`
- Create: `packages/capability-resolver/src/resolve.js`
- Create: `packages/capability-resolver/test/resolver.test.js`

- [ ] **Step 1: Write RED score and hard-gate tests**

重みをcodeに固定し、変更はversioned policyでしか行えないようにする。

```js
const WEIGHTS_V1 = Object.freeze({
  task_fit: 30,
  integration_ease: 15,
  evidence_strength: 15,
  maintainability: 10,
  security: 10,
  license_fit: 10,
  exit_option: 5,
  cost: 5
});
```

test case:

```js
const evaluated = evaluateCandidate({
  candidate: highFitUnknownLicense,
  need,
  axes: {
    task_fit: { value: 98, reason: "fixture match" },
    integration_ease: { value: 90, reason: "same runtime" },
    evidence_strength: { value: 80, reason: "source hash present" },
    maintainability: { value: 70, reason: "fixture release history" },
    security: { value: 90, reason: "no executable payload" },
    license_fit: { value: 0, reason: "license unknown" },
    exit_option: { value: 80, reason: "single-file removal" },
    cost: { value: 95, reason: "no fee" }
  },
  uncertaintyPenalty: 10
});
assert.equal(evaluated.eligibility, "rejected");
assert.ok(evaluated.hard_gate_results.some((gate) => gate.gate === "license" && gate.status === "fail"));
```

追加case:

- weighted sumは各寄与を小数2桁で返す
- `candidate_score = weighted_sum - uncertainty_penalty`
- 0未満は0へclamp、100超過はvalidation error
- security critical、license unknown/forbidden、runtime incompatibleはreject
- payment、login、secret、external sendは`needs_user`で、Phase 1ではeligibleにしない
- 高score rejected候補はeligible rankingへ入らない

```powershell
npm test --workspace @orquesta/audit
npm test --workspace @orquesta/capability-resolver
```

Expected RED: `audit/src`と`capability-resolver/src`が未作成のためmodule importでfailする。

- [ ] **Step 2: Implement static metadata audit only**

Phase 1 auditはfixture/local metadataの整合確認であり、法的判断や脆弱性scanを装わない。返却へ次を入れる。

```js
{
  audit_mode: "phase1_static_metadata",
  facts: [],
  unknowns: [],
  hard_gate_results: [],
  responsibility: {
    scout: "candidate_and_evidence_only",
    audit: "metadata_checks_only",
    audition: "disabled_until_phase2",
    orchestrator: "proposal_and_evidence_reconciliation",
    user: "all_phase1_adoption_approval"
  }
}
```

- [ ] **Step 3: Inject a comparable build candidate**

Resolverは各Needへ必ず`build-candidate.js`のsynthetic candidateを1件作る。見積もりの根拠がない項目を100点にせず、`unknowns`とuncertainty penaltyへ反映する。

```js
createBuildCandidate({ need, policyVersion: "phase1-v1" })
// provider_type: "new_build", trust_tier: "local", resolution_mode: "build"
```

- [ ] **Step 4: Implement Resolver v1**

```js
const proposal = resolveNeed({ need, scoutedCandidates, auditFacts, policy: WEIGHTS_V1 });
```

返却条件:

- `ranked_candidates`はbuildを含む最大3件
- `rejected_candidates`は別配列でscoreと棄却理由を保持
- `raw_score_leader`はeligibility適用前の最高score、`eligible_leader`はhard gate後の提案候補を別fieldで返す
- top案は`reuse | adapt | build | ask | abandon`
- top案にも`why_selected`、他候補へ`why_not_selected`
- `approval_status`は必ず`pending_user`
- 証拠不足で順位が確定しない場合は`inconclusive: true`と`ask`を返す

- [ ] **Step 5: GREEN and commit**

```powershell
npm test --workspace @orquesta/audit
npm test --workspace @orquesta/capability-resolver
git add packages/audit packages/capability-resolver
git commit -m "feat(v4): resolve capabilities with transparent gates"
```

## Task 8: Compile Minimal Context Packs Without Intent Graph

**Owner:** `implementation-001`

**Depends on:** Task 7

**Files:**

- Modify: `packages/context-compiler/package.json`
- Create: `packages/context-compiler/src/index.js`
- Create: `packages/context-compiler/src/agent-contract.js`
- Create: `packages/context-compiler/src/compile.js`
- Create: `packages/context-compiler/test/context-compiler.test.js`

- [ ] **Step 1: Write RED relevance and exclusion tests**

```js
const pack = compileContextPackV1({
  taskIntent,
  resolutions: [approvedResolution],
  agentContract: implementationAgent,
  workspaceRoot
});

assert.deepEqual(pack.allowed_files, implementationAgent.allowed_files);
assert.deepEqual(pack.forbidden_actions, implementationAgent.forbidden_actions);
assert.ok(pack.required_reading.includes("orquesta/scripts/json-state.js"));
assert.equal(pack.required_reading.includes(".orquesta/vision/specialists/dashboard.md"), false);
assert.equal(JSON.stringify(pack).includes("intent_graph"), false);
assert.ok(pack.provenance.every((entry) => entry.source_ref && entry.source_hash));
```

追加case:

- proposed Resolutionはpreview生成可だが`status: "draft"`
- approved Resolutionだけなら`status: "ready"`
- agent `excluded_context`と一致するrefを除外し、理由を`omitted_context`へ残す
- workspace外path、missing file、allowed_files外のtask-owned fileを拒否
- expired Resolutionは`CONTEXT_INPUT_EXPIRED`
- irrelevant specialist docをagent contractのrequired listから丸ごとコピーしない

```powershell
npm test --workspace @orquesta/context-compiler
```

Expected RED: `Cannot find module '../src'`。

- [ ] **Step 2: Load only the named agent contract**

`loadAgentContract({ agentsPath, agentId })`は`.orquesta/state/agents.json`から該当agent objectだけを返す。全agent本文をContext Packへ入れない。Packにはcontract fileのpath、対象agent ID、hashだけをprovenanceとして残す。

- [ ] **Step 3: Define the relevance rule**

`required_reading`へ入るのは次の和集合だけとする。

1. selected Providerのworkspace内`source_ref`
2. Resolutionの`evidence_refs`が指すworkspace内artifact
3. TaskIntentのacceptanceで明示されたinterface/test file
4. agent contractのsymbolic baselineのうち`task-owned files`

その後、`excluded_context`を適用し、`allowed_files`外の書込対象を拒否する。agent contractの全`required_reading`を無条件でコピーしない。

- [ ] **Step 4: Emit the approved ContextPack contract**

```js
{
  context_pack_id: "CP-<12 hex>",
  task_intent_id: taskIntent.task_intent_id,
  owner_agent_id: implementationAgent.agent_id,
  objective: taskIntent.desired_outcome,
  acceptance_criteria: taskIntent.acceptance_criteria,
  adopted_decisions: [],
  capability_resolutions: [approvedResolution.resolution_id],
  required_reading: ["orquesta/scripts/json-state.js"],
  relevant_state_excerpts: [],
  interfaces: [],
  allowed_files: implementationAgent.allowed_files,
  forbidden_actions: implementationAgent.forbidden_actions,
  excluded_context: implementationAgent.excluded_context,
  evidence_requirements: taskIntent.acceptance_criteria,
  provenance: [],
  token_budget: null,
  expires_at: null,
  status: "ready"
}
```

Phase 1では`adopted_decisions`を空配列とし、存在しないIntent Graphから埋めない。

- [ ] **Step 5: GREEN and commit**

```powershell
npm test --workspace @orquesta/context-compiler
node scripts/v4/phase-boundary-check.js
git add packages/context-compiler
git commit -m "feat(v4): compile scoped specialist context packs"
```

## Task 9: Connect the Vertical Lifecycle Through Event-Sourced Commands

**Owner:** `implementation-001`

**Depends on:** Tasks 4-8

**Files:**

- Create: `packages/core/src/index.js`
- Create: `packages/core/src/commands.js`
- Create: `packages/core/src/projectors.js`
- Create: `packages/core/src/phase-review.js`
- Create: `packages/core/test/commands.test.js`
- Create: `packages/core/test/phase-review.test.js`
- Create: `packages/core/test/vertical-slice.test.js`

- [ ] **Step 1: Write RED command-guard tests**

Public command surfaceは次だけにする。

```js
const COMMANDS_V1 = [
  "task-intent.create",
  "capability.compile",
  "inventory.refresh-local",
  "resolution.propose",
  "resolution.approve",
  "context-pack.preview",
  "phase-review.request",
  "phase-review.decide"
];
```

test:

- unknown commandは拒否
- `resolution.approve`は注入された`verifyUserApproval()`がsession-bound challengeを一回だけ取り出し、current targetと完全一致を確認した場合だけ成功
- `phase-review.decide`でuser decisionを記録できるのは、decision、review packet hash、current revisionへ発行時からbindされた未使用challengeがある場合だけ
- request payloadの`actor: { type: "user" }`、session ID、attestationは、trusted adapter由来でなければ拒否
- check failureが1件でもあれば`phase-review.request`不可
- `phase-review.request`は存在するreview packet ref/hash、build ref、check結果を必須にし、temp testではpacket artifactとhashを先にseedする
- product file変更、network、install、Codex dispatchに対応するcommandが存在しない
- 同じcommand ID再送は同hashならidempotent、別payloadならconflict

```powershell
npm test --workspace @orquesta/core -- --test-name-pattern="command|phase review"
```

Expected RED: `commands.js`と`phase-review.js`が未作成、またはapproval verifier assertionがfailする。

- [ ] **Step 2: Map commands to atomic event batches**

一commandは一batchへまとめる。例:

```js
"capability.compile" => [
  { type: "capability.need.declared", payload: needA },
  { type: "capability.need.declared", payload: needB },
  { type: "capability.graph.compiled", payload: graphSummary }
]
```

`inventory.refresh-local`はProvider本文でなくmetadataとevidence refだけをevent化する。`resolution.propose`はCandidateEvaluation、棄却理由、responsibility境界、proposalを同じcorrelation IDで記録する。

- [ ] **Step 3: Implement deterministic projectors**

次のprojectionを作る。

```text
projections/task-intents.json
projections/capability-graphs.json
projections/providers.json
projections/candidate-evaluations.json
projections/resolutions.json
projections/context-packs.json
projections/phase-reviews.json
projections/timeline.json
```

Reducerはevent payloadを受けるpure functionとし、filesystem、clock、randomへ触れない。timelineはsequence、event ID、actor、responsibility、evidence refsを保持する。

- [ ] **Step 4: Enforce manual approval semantics**

`resolution.approve`は対象proposalがcurrent revisionであり、candidateがhard gate passであることを再確認する。`ask`と`abandon`もユーザー決定として記録できる。approval前はContext Packを`draft`としてpreviewできるが、specialist handoff用`ready`へしない。

approval commandのactorはrequest bodyから受けない。command handlerへ注入したtrusted in-process `verifyUserApproval(evidence, target)`が、service由来のsession IDとchallenge IDを使って一回限りのchallenge recordを取り出し、target ID、candidate ID、decision、current revision、review packet hash、expiryを完全一致で検証した場合だけ、server-derived actorをeventへ書く。process signatureやHMACは要求しない。eventへsession ID、CSRF token、challenge recordを保存せず、challenge ID、相関用token hash、source、identity assuranceだけを保存する。

Phase Review state transitionは次だけを許す。

```text
in_progress -> ready_for_user_review
ready_for_user_review -> changes_requested
ready_for_user_review -> approved
changes_requested -> ready_for_user_review
```

`approved`以降の再変更は新しいreview cycleを作り、過去eventを上書きしない。

projectorは承認adapterが入口で検証したredacted approval attestationをeventから再生し、UI sessionへ再問い合わせしない。`token_hash`はchallenge packetの相関用fingerprintであり、OS identityや暗号学的な本人性の証明には使わない。生cookie、CSRF token、challenge recordはjournalへ入れず、必要最小限のprovenanceだけをcanonical eventにする。

- [ ] **Step 5: Run one vertical temp-store integration**

`vertical-slice.test.js`はTaskIntent作成からContext Pack previewまでを実EventStoreへcommitし、journal削除なしでprojectionだけ消してreplayする。

```js
assert.equal(state.taskIntent.status, "compiled");
assert.ok(state.capabilityGraph.needs.length >= 1);
assert.ok(state.resolutions.every((item) => item.approval_status === "pending_user"));
assert.equal(state.contextPack.status, "draft");
assert.equal(state.phaseReview.status, "in_progress");
assert.equal(replayedHash, liveProjectionHash);
```

- [ ] **Step 6: GREEN, responsibility check, and commit**

```powershell
npm test --workspace @orquesta/core
npm test --workspace @orquesta/event-store
node scripts/v4/phase-boundary-check.js
git add packages/core
git commit -m "feat(v4): connect the Phase 1 event lifecycle"
```

orchestratorはtimelineからScout、static Audit、disabled Audition、domain specialist、orchestrator、userの責任表示を照合する。実行されていないAuditionを`completed`と表示するeventが1件でもあればchanges requestedにする。

## Task 10: Add the Three Review Fixtures and Golden Evidence

**Owner:** `implementation-001`

**Depends on:** Task 9

**Files:**

- Create: `fixtures/v4/phase1/local-reuse/task-intent.json`
- Create: `fixtures/v4/phase1/local-reuse/providers.json`
- Create: `fixtures/v4/phase1/local-reuse/expected.json`
- Create: `fixtures/v4/phase1/adapt-vs-build/task-intent.json`
- Create: `fixtures/v4/phase1/adapt-vs-build/providers.json`
- Create: `fixtures/v4/phase1/adapt-vs-build/expected.json`
- Create: `fixtures/v4/phase1/blocked-candidate/task-intent.json`
- Create: `fixtures/v4/phase1/blocked-candidate/providers.json`
- Create: `fixtures/v4/phase1/blocked-candidate/expected.json`
- Create: `scripts/v4/run-fixture.js`
- Modify: `packages/core/test/vertical-slice.test.js`

- [ ] **Step 1: Write RED golden assertions for all three fixture IDs**

```js
const cases = ["local-reuse", "adapt-vs-build", "blocked-candidate"];
for (const fixtureId of cases) {
  await t.test(fixtureId, () => {
    const actual = runFixture({ fixtureId, stateRoot: makeTempRoot(), clock: fixedClock });
    const expected = loadExpected(fixtureId);
    assert.deepEqual(stripRuntimeTimes(actual.reviewView), expected);
  });
}
```

golden outputへ絶対path、process ID、現在時刻を入れない。source ref、hash、score contribution、gate、Resolution、Context Pack reading、timeline typeを比較する。

```powershell
node --test --test-name-pattern="local-reuse|adapt-vs-build|blocked-candidate" packages/core/test/vertical-slice.test.js
```

Expected RED: 三fixture directoryまたは`expected.json`が存在しないためfailする。

- [ ] **Step 2: Implement `Local reuse`**

依頼は「UTF-8のJSON stateを安全に保存するhelperが必要」とする。repository providerは実在する`orquesta/scripts/json-state.js`を指し、`reuse`を`build`より上へ出す。

必須expected:

```json
{
  "fixture_id": "local-reuse",
  "proposed_mode": "reuse",
  "proposed_provider_id": "repo-json-state-helper",
  "scout_invoked": false,
  "build_candidate_present": true,
  "approval_status": "pending_user",
  "context_pack_status": "draft",
  "required_reading": ["orquesta/scripts/json-state.js"]
}
```

Scout省略理由は`local_inventory_satisfied_need`としてtimelineへ残す。

- [ ] **Step 3: Implement `Adapt versus build`**

依頼は「Workbenchのbrowser QAを再現可能にする」とする。既存`orquesta/scripts/dashboard-dom-smoke.js`とfixture skill metadataを候補にし、薄いpath/selector変更で使える`adapt`と、新規buildを同じscore表で比較する。fixture metadataには必要変更を`target URL引数、Workbench data-testid、fixture完走assertion`と明記する。候補としての静的比較であり、既存scriptをPhase 1 Workbenchへ実行済み、Audition済み、browser evidence取得済みとは表示しない。

必須expected:

```json
{
  "fixture_id": "adapt-vs-build",
  "proposed_mode": "adapt",
  "build_candidate_present": true,
  "top_candidate_count": 3,
  "approval_status": "pending_user",
  "context_pack_status": "draft",
  "audition_status": "disabled_until_phase2"
}
```

adaptの変更量、buildの保守費、両方のuncertaintyを理由へ書く。

- [ ] **Step 4: Implement `Blocked candidate`**

依頼は「admin UIに使うcomponent catalogを選ぶ」とする。機能適合scoreが最高でもlicense fixtureが`unknown`の候補をhard gateでrejectする。次点のlocal fixtureまたはbuildをproposalにする。

必須expected:

```json
{
  "fixture_id": "blocked-candidate",
  "highest_raw_score_provider_id": "ui-catalog-unknown-license",
  "highest_raw_score_eligible": false,
  "rejection_gate": "license",
  "build_candidate_present": true,
  "approval_status": "pending_user",
  "context_pack_status": "draft"
}
```

- [ ] **Step 5: Implement an idempotent fixture CLI**

```powershell
npm run fixture:v4:phase1 -- --fixture local-reuse --state-root .orquesta/v4
```

CLIは固定fixture ID以外を拒否する。同じfixtureを再実行した場合は同じcommand ID/hashでidempotentになり、eventを二重化しない。既存journalを削除またはresetしない。

- [ ] **Step 6: GREEN and commit**

```powershell
node --test packages/core/test/vertical-slice.test.js
npm run fixture:v4:phase1 -- --fixture local-reuse --state-root output/v4-fixture-smoke
npm run fixture:v4:phase1 -- --fixture adapt-vs-build --state-root output/v4-fixture-smoke
npm run fixture:v4:phase1 -- --fixture blocked-candidate --state-root output/v4-fixture-smoke
git add fixtures/v4/phase1 scripts/v4/run-fixture.js packages/core/test/vertical-slice.test.js
git commit -m "test(v4): add Phase 1 capability fixtures"
```

## Task 11: Expose a Fixed, Local-Only Workbench API

**Owner:** `implementation-001`

**Depends on:** Task 10

**Codex safety boundary:** Task 11はlocal fixtureの閲覧、replay、意味上の承認だけを扱い、command実行、install、web search、Codex dispatch、Auditionを持たない。OS権限、filesystem sandbox、network、credential、runtime approvalはCodex harnessへ任せ、Workbenchへ第二のsandbox、firewall、credential vault、command risk parserを追加しない。Task 11で守るのはloopback HTTP境界と、承認対象、candidate、journal revision、review packetのbindingである。Phase 2の実行機能はCodexの実profileをpreflightし、計画より広い場合にfail closedとする別taskで扱う。

**Files:**

- Modify: `apps/workbench/package.json`
- Create: `apps/workbench/server.js`
- Create: `apps/workbench/src/api.js`
- Create: `apps/workbench/src/service.js`
- Create: `apps/workbench/src/state-view.js`
- Create: `apps/workbench/src/approval-session.js`
- Create: `apps/workbench/test/api.test.js`
- Create: `apps/workbench/test/approval-session.test.js`

- [ ] **Step 1: Write RED feature flag and route tests**

testはserverをephemeral port、temp state rootで起動する。

```js
await assert.rejects(
  () => startWorkbench({ feature: null, stateRoot }),
  { code: "V4_FEATURE_FLAG_REQUIRED" }
);

const app = await startWorkbench({ feature: "v4", stateRoot, port: 0 });
const state = await fetch(`${app.url}/api/v4/state`).then((response) => response.json());
assert.equal(state.product, "Orquesta V4 Preview");
assert.equal(state.phase_id, "phase-1");
```

route tests:

- `GET /api/v4/state`
- `POST /api/v4/fixtures/local-reuse/load`
- `POST /api/v4/fixtures/adapt-vs-build/load`
- `POST /api/v4/fixtures/blocked-candidate/load`
- `POST /api/v4/approvals/challenge`
- `POST /api/v4/resolutions/:id/decision`
- `POST /api/v4/replay`
- `POST /api/v4/phase-review/decision`
- path traversal、未知fixture、1 MiB超body、invalid JSONは4xx
- `/api/v4/install`、`/dispatch`、`/web-search`は404

```powershell
npm test --workspace @orquesta/workbench -- --test-name-pattern="api|approval session"
```

Expected RED: `server.js`、API module、approval sessionが未作成のためmodule importでfailする。

- [ ] **Step 2: Bind only to loopback and a separate port range**

defaultは`127.0.0.1:4181`、競合時は既存`orquesta/scripts/dashboard-port-selection.js`の公開済み`findAvailableDashboardPort({ preferredPort, scanStart, scanEnd })`を再利用して4181-4281を探す。API testは4181を一時占有し、次のloopback portが選ばれることを確認する。`0.0.0.0`へbindしない。V3の4177とruntime optionを書き換えない。

- [ ] **Step 3: Build a redacted state view**

`state-view.js`はprojectionから次だけを返す。

```js
{
  product: "Orquesta V4 Preview",
  phase_id: "phase-1",
  phase_review: {},
  task_intents: [],
  capability_graphs: [],
  providers: [],
  candidate_evaluations: [],
  resolutions: [],
  context_packs: [],
  timeline: [],
  recovery: {},
  limitations: [
    "local sources only",
    "no installation",
    "no Codex dispatch",
    "Audition disabled until Phase 2",
    "actual model unavailable",
    "approval attests to a local Workbench interaction, not OS identity"
  ]
}
```

raw file本文、SKILL本文、MCP command/env、secret、absolute home pathを返さない。

- [ ] **Step 4: Bind a local approval challenge to the current target**

`approval-session.js`はHttpOnly/SameSite=Strict session cookie、exact Origin/CSRF check、serverが128 bit以上の乱数で生成する一回限りのopaque challengeを使う。Originは起動時のscheme、host、portとの完全一致を要求し、欠落または複数値を拒否する。CSRF tokenはsessionへbindする。challengeはsession、target ID、candidate IDまたはnull、decision、journal revision、review packet hash、10分以内のexpiryへbindする。bodyのactor、session ID、attestationは拒否する。challengeは同じlocal process内のUI操作を現在の対象へbindするもので、OS user identityや暗号学的な本人性を証明しない。

Nodeの`fetch`はcookie jarを持たないため、`approval-session.test.js`に`Set-Cookie`を保存し、次requestへ`Cookie`、`Origin`、CSRF tokenを明示して送るtest helperを置く。browserの暗黙挙動へ依存しない。

challenge発行requestは`target_type`、`target_id`、`candidate_id`またはnull、`decision`だけを受ける。serviceはcurrent projectionからcandidate、journal revision、review packet hashを導出し、request値が現在の対象と一致する場合だけrecordへ保存する。revision、packet hash、session IDをrequest bodyから受けない。

Resolution decision bodyは次だけを受ける。

```json
{
  "decision": "approved",
  "candidate_id": "provider-or-build-id",
  "challenge_id": "CHALLENGE-001"
}
```

serverは検証後に次を生成する。

```js
{
  actor: { type: "user", id: "local-workbench-user" },
  approval_evidence: {
    source: "local_workbench_confirmation",
    challenge_id: "CHALLENGE-001",
    target_revision: 12,
    token_hash: "64-lowercase-hex",
    captured_at: "2026-07-15T00:00:00.000Z",
    identity_assurance: "local_interaction_unverified_identity"
  }
}
```

`token_hash`は`challenge_id`、target、candidate、decision、revision、review packet hashのcanonical hashであり、HMACやidentity proofとして扱わない。serviceはrequest bodyから`challenge_id`だけを取り、cookieから得たsession IDを加えたserver-derived evidenceをCoreへ渡す。注入済み`verifyUserApproval`はそのevidenceでchallenge recordを一回だけ取り出し、Coreが渡すcurrent targetとの完全一致を確認してからredacted attestationを返す。

Phase Review approvalは明示的なconfirm操作を使い、challengeを`phase-1`、current revision、review packet hashへbindする。決まった文章の手入力は要求しない。使用済みchallenge、期限切れ、別session、別candidate、別revision、別packet hash、actorまたはattestation入りbody、OriginまたはCSRF不一致をAPI testで拒否する。testはtemp stateだけを使い、実projectのPhase Reviewをapproveしない。

challengeの取得、request decisionとの比較、削除はtrusted `verifyUserApproval`内でEventStore commitより前に同期的に一度だけ行い、独自の`active -> in_flight -> consumed`状態機械や失敗後のreactivationは作らない。Coreへ渡す`command_id`は`approval:<challenge_id>`とし、既存のcommand identity、EventStore revision conflict、idempotent batchを原子性の正本にする。commitが失敗した場合、古いchallengeは戻さず新しいchallengeを要求する。server restartではmemory上のchallengeをすべて失効させる。approvedからchanges_requestedへのdecision差し替え、parallel submit、commit failure、restart、expiryをtestし、approval eventが最大1件であることを確認する。

- [ ] **Step 5: GREEN and commit**

```powershell
npm test --workspace @orquesta/workbench
node apps/workbench/server.js
```

第二commandのExpected: `V4_FEATURE_FLAG_REQUIRED`でexit 1。次を実行すると起動する。

```powershell
node apps/workbench/server.js --feature v4 --port 0
```

Expected output: `Orquesta V4 Workbench: http://127.0.0.1:<port>/`。

```powershell
git add apps/workbench/package.json apps/workbench/server.js apps/workbench/src apps/workbench/test/api.test.js apps/workbench/test/approval-session.test.js
git commit -m "feat(v4): expose the local Workbench API"
```

## Task 12: Build and Browser-Verify the Phase 1 Workbench

**Owner:** `implementation-001`

**Independent review:** `dashboard-ux-001`。**Independent QA:** `bootstrap-qa-001`

**Depends on:** Task 11

**Files:**

- Create: `apps/workbench/public/index.html`
- Create: `apps/workbench/public/styles.css`
- Create: `apps/workbench/public/app.js`
- Create: `apps/workbench/public/view-model.js`
- Create: `apps/workbench/scripts/browser-smoke.js`
- Create: `apps/workbench/scripts/review-capture.js`
- Create: `apps/workbench/test/view-model.test.js`
- Create: `apps/workbench/test/static-assets.test.js`
- Modify: `apps/workbench/src/api.js`
- Modify: `apps/workbench/server.js`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write RED pure view-model tests**

```js
const view = buildWorkbenchView(apiState, { selectedTaskIntentId: "TI-local-reuse" });
assert.equal(view.outcome.title, "既存のatomic JSON helperを再利用できるか判断する");
assert.ok(view.needs.every((need) => need.verification || need.unresolvedReason));
assert.ok(view.candidates.some((candidate) => candidate.mode === "build"));
assert.ok(view.candidates.some((candidate) => candidate.gates.some((gate) => gate.status === "fail")));
assert.equal(view.contextPack.intentGraphEnabled, false);
assert.equal(view.limits.actualModel, "unavailable");
```

HTML stringを返す関数ではなくplain view modelを返す。untrusted文字列は`textContent`で描画する。

同じpure functionをNode testとbrowserで使うため、`view-model.js`は副作用のないUMD形式にする。Nodeでは`module.exports`、browserでは`globalThis.OrquestaWorkbenchViewModel`だけを公開し、rendererへNode APIを露出しない。

```powershell
npm test --workspace @orquesta/workbench -- --test-name-pattern="view model|static assets"
```

Expected RED: `public/view-model.js`とstatic assetsが未作成のためfailする。

- [ ] **Step 2: Implement one six-step review flow**

画面は次の順にする。

1. Fixture / TaskIntent
2. Capability Graph
3. Candidate comparison
4. Resolution decision
5. Context Pack preview
6. Timeline / Replay / Phase Review

初期画面で三つのfixtureと「何を確認するか」を表示する。Candidate cardは総scoreだけでなく8軸の寄与、uncertainty penalty、hard gate、選ぶ理由、選ばない理由を見せる。rejected候補を非表示にしない。

`api.js`は`public/`の固定4 fileだけを配信し、`/`を`index.html`へmapする。request pathをfilesystem pathへ直接連結しない。`static-assets.test.js`は`/`、`/styles.css`、`/app.js`、`/view-model.js`のstatusとContent-Typeを確認し、`/../package.json`とencoded traversalを404にする。

- [ ] **Step 3: Make responsibility and limitations visible**

各fixtureに次を常時表示する。

```text
Scout: local metadata collection only
Audit: static fixture/local metadata checks
Audition: not run in Phase 1
Orchestrator: proposal and evidence reconciliation
User: adoption and phase approval
Codex runtime evidence: unavailable
Actual model: unknown / null
Approval identity: local interaction only; OS user identity is not verified
```

dispatch、実行、Auditionが動いたように見える動詞やspinnerを使わない。

- [ ] **Step 4: Implement accessible approval controls**

- hard gate fail候補のApprove buttonはdisabledで理由を関連付ける
- user decisionはconfirmation dialog後にPOSTする
- phase approvalはtarget、revision、review packetを表示する明示的なconfirm dialogを要求する
- keyboardでfixture切替、candidate比較、timeline展開、approvalまで操作できる
- scoreを色だけで表現しない
- 360pxと1440pxで横scrollなし。ただし比較表内の明示scroll containerは可

- [ ] **Step 5: Add real browser smoke**

`browser-smoke.js`は`--url`がなければtemp state rootとephemeral portでWorkbenchを子process起動し、完了後に確実に停止する。実ChromeまたはPlaywright Chromiumで次を行う。

browser driverはproduct runtimeへ入れず、review harnessのdevDependencyとしてここで初めて追加する。

```powershell
npm install --save-dev --ignore-scripts playwright-core
npm ls playwright-core --depth=0
node scripts/v4/browser-preflight.js --require-driver
```

`playwright-core`にはbrowserをdownloadさせない。`ORQUESTA_CHROME_PATH`またはWindowsの標準Chrome install pathから既存executableを解決し、見つからなければ`BROWSER_RUNNER_UNAVAILABLE`にする。preflightはdriver version、Chrome path/version、screenshot可否、console/page error listenerの最小起動を検査する。sourceとlockfileへ`npx`またはbrowser download commandが無いこともtestする。package-lockへ解決versionとintegrityを固定する。

```text
load local-reuse -> confirm reuse above build -> open Context Pack
load adapt-vs-build -> inspect score breakdown -> approve adapt in temp store
load blocked-candidate -> confirm top raw score is disabled by license gate
trigger replay -> confirm before/after projection hash equality
collect console errors and page errors -> both zero
```

test selectorは`data-testid`へ固定する。smokeは`output/v4-phase1-review/workbench.png`を保存する。

```powershell
node apps/workbench/scripts/browser-smoke.js --state-root output/v4-browser-smoke
```

Expected:

```text
Orquesta V4 Workbench browser smoke passed: 3 fixtures, 0 console errors, 0 page errors
```

Playwright/Chromeを起動できない場合はexit 1にし、review packetをreadyへしない。

- [ ] **Step 6: Independent QA and commit**

```powershell
npm test --workspace @orquesta/workbench
node apps/workbench/scripts/browser-smoke.js --state-root output/v4-browser-smoke
git add package.json package-lock.json apps/workbench/public apps/workbench/scripts apps/workbench/test/view-model.test.js apps/workbench/test/static-assets.test.js apps/workbench/src/api.js
git commit -m "feat(v4): add the Phase 1 capability Workbench"
```

`bootstrap-qa-001`は実装者のscreenshotだけを受け取らず、自分でserver起動、三fixture、console、keyboard、360px/1440px、replayを確認してreportを返す。

## Task 13: Build the Review Packet and Run the Full Phase Gate

**Owner:** `implementation-001`

**Independent QA:** `bootstrap-qa-001`。**Acceptance owner:** orchestrator。最終phase承認者はユーザー。

**Depends on:** Tasks 1-12

**Files:**

- Create: `packages/core/src/review-packet.js`
- Create: `packages/core/test/review-packet.test.js`
- Create: `scripts/v4/verify-phase1.js`
- Create: `docs/testing/orquesta-v4-phase1-review.md`
- Modify: `package-lock.json`
- Modify: `packages/core/src/index.js`

- [ ] **Step 1: Write RED packet-completeness tests**

packetは次のfieldが一つでも欠けたら生成失敗にする。

```js
const REQUIRED_PACKET_FIELDS = [
  "build_ref",
  "artifact_hashes",
  "five_minute_path",
  "fixture_results",
  "automated_checks",
  "browser_evidence",
  "browser_runner_versions",
  "approval_assurance",
  "tested_node_versions",
  "adopted_and_rejected",
  "known_gaps",
  "phase2_changes",
  "user_decision_location"
];
```

browser evidenceが`status: "not_run"`、V3 checkがfail、replay hash不一致、Phase 1禁止directoryが存在する場合は`ready_for_user_review`を生成しない。

```powershell
npm test --workspace @orquesta/core -- --test-name-pattern="review packet"
```

Expected RED: `review-packet.js`が未作成、またはrequired packet field assertionがfailする。

- [ ] **Step 2: Refresh and verify the dependency-free lockfile**

```powershell
npm install --package-lock-only --ignore-scripts --offline
npm ls --workspaces --depth=0
npm ls --omit=dev --depth=0
```

Expected: 9 workspace packageとdev-onlyの`playwright-core`だけが表示され、`--omit=dev`では外部runtime dependency 0。lockfileに`playwright-core`以外の外部package tarballが入った場合は、原因を除いて再生成する。

- [ ] **Step 3: Implement the full verifier**

`verify-phase1.js`は順に実行し、各command、exit code、開始/終了時刻、stdout要約、artifact hashを`output/v4-phase1-review/checks.json`へ記録する。

```text
node scripts/v4/phase-boundary-check.js
node --version
node scripts/v4/browser-preflight.js --require-driver
npm run check
npm run test:v4:phase1
node --test packages/event-store/test/onedrive-live.test.js
three fixture CLI runs in a fresh temp state root
Workbench API smoke
Workbench real-browser smoke
projection deletion and full replay hash comparison
```

一件failしたら残りの独立diagnosticは続けてよいが、最終statusは`changes_requested`にする。

- [ ] **Step 4: Generate the durable review packet**

成果物:

```text
output/v4-phase1-review/phase-1-review.md
output/v4-phase1-review/checks.json
output/v4-phase1-review/fixture-results.json
output/v4-phase1-review/workbench.png
output/v4-phase1-review/recovery-report.json
```

`phase-1-review.md`は5分手順、三fixtureの期待点、採用/棄却、既知gap、Phase 2で増える機能、停止条件の評価を自然な日本語で書く。未実装を将来計画と明記する。

`approval_assurance`は`local_ui_attestation_not_os_identity`とし、same-origin、CSRF、single-use challenge、revision/hash bindingで防ぐ範囲と、OS user identityまでは証明しない範囲をknown gapへ明記する。HMAC、独自sandbox、決まった確認文を安全性の根拠にしない。

`tested_node_versions`には実際にfull gateを通したversionだけを書く。Node 20実体で実行していない場合、`engines >=20`はAPI compatibility targetでありNode 20 runtime verificationは未完了、とknown gapへ残す。

`browser_runner_versions`には実際に使った`playwright-core` version、Chrome executable pathのredacted表示、Chrome versionを入れる。preflight結果だけでbrowser smoke成功を代用せず、`browser_evidence`へ三fixture、console/page error、screenshot hashを別に残す。

Phase Review eventはここで`phase.review.requested`を記録し、projectionを`ready_for_user_review`へする。`phase.review.approved`は生成しない。

- [ ] **Step 5: Run the full gate from a clean process**

```powershell
npm run review:v4:phase1
git status --short
```

Expected summary:

```text
V3 check: PASS
V4 contract/unit/integration tests: PASS
EventStore crash points: 7/7 PASS
Recovery matrix: 12/12 PASS
OneDrive live probe: PASS
Fixtures: 3/3 PASS
Workbench browser smoke: PASS
Projection replay hash: MATCH
Phase 1 status: ready_for_user_review
```

`git status`はsource変更と`package-lock.json`だけを示し、`.orquesta/v4`と`output/`は示さない。

- [ ] **Step 6: Commit the review harness**

```powershell
git add package-lock.json packages/core/src/review-packet.js packages/core/test/review-packet.test.js packages/core/src/index.js scripts/v4/verify-phase1.js docs/testing/orquesta-v4-phase1-review.md
git commit -m "test(v4): add the Phase 1 user review gate"
```

- [ ] **Step 7: Orchestrator acceptance and user checkpoint**

orchestratorは次を別々に確認する。

- implementation reportとcommit一覧
- protocol reportのEventStore/contract判定
- dashboard UX report
- independent browser QA report
- full verifierの実output
- Phase 1未実装一覧
- `actual_model: null`が維持されていること

内部checkを通してもPhase 1は完了扱いにしない。packetの絶対pathと5分手順をユーザーへ渡し、ユーザーの`Phase 1 approved`または変更要求を待つ。承認された場合だけPhase 2設計差分と実装計画へ進む。

## Final Verification Matrix

| Design acceptance | Owning test or evidence |
|---|---|
| Same input/inventory yields same Graph | `packages/capability-compiler/test/compiler.test.js` |
| Duplicate and cycle detection | Compiler tests |
| Verification method or unresolved reason on every Need | Compiler and contract tests |
| Top three, score breakdown, rejection reasons | Audit, Resolver, Workbench tests |
| Hard gate overrides score | Blocked candidate fixture and browser smoke |
| Build is always compared | Resolver tests and all three golden fixtures |
| Journal replay reproduces projections | EventStore replay tests and full gate |
| Seven commit crash points avoid double application | EventStore child-process crash tests |
| Recovery matrix follows approved table | EventStore recovery tests and report |
| Irrelevant specialist docs stay out | Context Compiler tests |
| Context v1 does not depend on Intent Graph | Boundary and Context Compiler tests |
| Responsibility boundaries remain visible | Core timeline assertions and Workbench |
| V3 remains working | Unchanged `npm run check` |
| Real browser has no console/page errors | Independent browser smoke |
| No install/network/product change before approval | Scout no-network tests and command allowlist |
| Phase approval is user-only | Core/API Phase Review tests |

## Stop Conditions Before User Review

次のどれかが起きた場合、見た目を整えて誤魔化さずPhase 1を`changes_requested`へ戻す。

- 三fixtureのうち一つでもCapability Graphを人間が大幅に書き直さないと成立しない。
- scoreの内訳より説明文だけで判断が変わり、比較表が選択に役立たない。
- OneDrive live probeまたはcrash/recovery matrixが不安定である。
- Context Packが必要fileを落とす、または無関係な専門家文書を入れる。
- Workbenchの一fixture完走が手動メモ比較より明確に重い。
- browser evidence、runtime evidence、Auditionの未実施を実施済みのように見せる箇所がある。

この場合はPhase 2へ進まず、問題が属するcontract、EventStore、Compiler、Resolver、Context Pack、Workbenchのtaskへ戻る。
