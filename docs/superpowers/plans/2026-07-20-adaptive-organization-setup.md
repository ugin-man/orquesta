# Adaptive Organization and Initial Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Orquesta's fixed first-run roster with a three-agent foundation, project-derived specialists, and a task-time organization preflight that changes every organizational element autonomously except creating a new production line.

**Status:** Complete on 2026-07-20. Final implementation includes post-provisioning setup completion and one formal organization revision per terminal provisioning batch. Independent review accepted with zero unresolved findings.

**Architecture:** Add strict durable contracts first, then implement a pure Core organization model and two-pass preflight. A thin atomic state adapter will migrate legacy projects and connect the Core decisions to the existing setup server. Desktop will consume the resulting explicit organization projection and will use the existing bundled Codex App Server adapter to provision specialist threads.

**Tech Stack:** Node.js 20 CommonJS packages, JSON Schema through `@orquesta/contracts`, `node:test`, Electron 43, TypeScript 5.7, React 19, Vitest 4, existing `@orquesta/codex-adapter`.

## Global Constraints

- The only organization change that requires user approval is creation of a new production line.
- Persist that rule as `organization_changes: "autonomous_except_new_line"`.
- Reuse, task split, same-role scaling, new roles, dedicated leads, and permanent transfers between existing lines are autonomous and audit logged.
- External cost, credentials, secrets, destructive actions, and publication keep their existing Codex approval boundaries.
- Foundation agents for new projects are exactly `orchestrator`, `user-support`, and `orquesta-admin`.
- Do not create `user-liaison`, `vision-curator`, `error-concierge`, or `bootstrap-qa-001` as unconditional new-project agents.
- Never create temporary cross-line assignments.
- Every newly provisioned specialist must own at least one executable task.
- Do not impose a minimum specialist count.
- Preserve legacy agent IDs, threads, task history, reports, and conversations during migration.
- Use one atomic organization revision per accepted state transition; do not dual-write divergent v1 and v2 organization state.
- Add no runtime dependency.
- Do not overwrite or commit unrelated Desktop worktree changes.
- Do not push.

---

## File Map

### Durable contracts

- `packages/contracts/schemas/role-definition.schema.json`: canonical reusable role definition.
- `packages/contracts/schemas/agent-capability-profile.schema.json`: verified capability, scope, and availability of one agent.
- `packages/contracts/schemas/organization-state.schema.json`: teams, memberships, lines, relationships, revision, and policy.
- `packages/contracts/schemas/organization-decision.schema.json`: deterministic preflight decision and approval boundary.
- `packages/contracts/schemas/specialist-plan-v2.schema.json`: first executable batch, selected specialists, and future candidates.
- `packages/contracts/src/validator.js`: registers schemas and cross-record validation hooks.
- `packages/contracts/test/contracts.test.js`: contract acceptance and rejection fixtures.

### Pure Core

- `packages/core/src/organization-model.js`: defaults, invariants, canonical roles, and decision application.
- `packages/core/src/organization-preflight.js`: structural pass, staffing pass, reason codes, line proposal gate.
- `packages/core/src/adaptive-setup.js`: Project Understanding Packet normalization, first batch selection, foundation and specialist planning.
- `packages/core/src/index.js`: public exports.
- `packages/core/test/organization-model.test.js`: invariant and autonomous change tests.
- `packages/core/test/organization-preflight.test.js`: fast/deep decision matrix.
- `packages/core/test/adaptive-setup.test.js`: project-specific initial roster fixtures.

### Atomic repository state

- `orquesta/scripts/organization-state.js`: read, migrate, and atomically commit v2 organization state.
- `orquesta/scripts/organization-state.test.js`: legacy migration, idempotency, rollback, and support-agent merge tests.
- `orquesta/scripts/adaptive-setup-state.js`: Core-to-repository setup state adapter and provisioning requests.
- `orquesta/scripts/adaptive-setup-state.test.js`: setup plan and production-state integration tests.

### Setup server and skill protocol

- `orquesta/dashboard-server.js`: uses adaptive setup instead of fixed candidates.
- `orquesta/SKILL.md`: three-agent foundation and autonomous organization policy.
- `orquesta/references/initial-setup.md`: six real setup phases and single confirmation.
- `orquesta/references/orchestration-protocol.md`: organization preflight before execution policy.
- `orquesta/references/agent-contract.md`: role, team, line, scope, and organization decision binding.
- `orquesta/references/state-schema.md`: v2 state paths and migration behavior.
- `orquesta/references/user-support.md`: merged user-facing support role.
- `orquesta/scripts/foundation-trigger-audit.js`: audits `user-support` rather than three retired support agents.
- `orquesta/scripts/foundation-trigger-audit.test.js`: merged trigger behavior.

### Desktop provisioning and projection

- `apps/orquesta-desktop/electron/core/specialist-provisioner.ts`: creates or resumes Codex threads and commits provisioning status.
- `apps/orquesta-desktop/electron/core/specialist-provisioner.test.ts`: App Server success, retry, and failure truthfulness.
- `apps/orquesta-desktop/electron/core/repository-reader.ts`: reads `roles.json` and `organization.json` explicitly.
- `apps/orquesta-desktop/electron/core/repository-reader.test.ts`: v2 and legacy diagnostic fixtures.
- `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`: organization projection and setup provisioning UI types.
- `apps/orquesta-desktop/src/renderer/features/map/organization.ts`: explicit v2 grouping with diagnostic-only legacy fallback.
- `apps/orquesta-desktop/tests/unit/organization-model.test.ts`: no name-regex grouping for v2 data.

### Integration

- `scripts/v4/adaptive-organization-fixtures.test.js`: small, multi-line, same-role, unknown, and migration fixtures.
- `package.json`: focused test scripts and aggregate check.

---

### Task 1: Add durable organization contracts

**Files:**
- Create: `packages/contracts/schemas/role-definition.schema.json`
- Create: `packages/contracts/schemas/agent-capability-profile.schema.json`
- Create: `packages/contracts/schemas/organization-state.schema.json`
- Create: `packages/contracts/schemas/organization-decision.schema.json`
- Create: `packages/contracts/schemas/specialist-plan-v2.schema.json`
- Modify: `packages/contracts/src/validator.js`
- Modify: `packages/contracts/test/contracts.test.js`

**Interfaces:**
- Consumes: existing `assertContract(name, value)` registry and canonical JSON rules.
- Produces: contract names `role-definition`, `agent-capability-profile`, `organization-state`, `organization-decision`, `specialist-plan-v2`.

- [ ] **Step 1: Write failing registry and fixture tests**

Add fixtures that establish these exact decisions:

```js
const organizationDecision = {
  decision_id: "OD-0123456789ab",
  task_intent_id: "TI-0123456789ab",
  organization_revision: 1,
  input_hash: "a".repeat(64),
  mode: "deep",
  selected_action: "add_role",
  reason_codes: ["CAPABILITY_GAP"],
  requires_user_approval: false,
  approval_state: "not_required",
  proposed_line: null,
  created_at: timestamp
};
```

Reject a new-line decision unless `requires_user_approval` is true and `approval_state` is `pending_user` or `approved`. Reject every non-line decision when it claims user approval is required.

- [ ] **Step 2: Run the contract test and observe RED**

Run: `node --test packages/contracts/test/contracts.test.js`

Expected: FAIL because the five schema names are not registered.

- [ ] **Step 3: Add the five strict schemas and semantic validators**

Register the names in `SCHEMA_NAMES`. Add `organizationDecisionErrors()` and `organizationStateErrors()` to enforce cross-record rules that JSON Schema cannot express:

```js
function organizationDecisionErrors(value) {
  if (!isPlainObject(value)) return [];
  const lineAction = value.selected_action === "propose_line";
  const errors = [];
  if (lineAction !== value.requires_user_approval) {
    errors.push(schemaError("$.requires_user_approval", "organization_line_approval", "must be true only for propose_line"));
  }
  if (!lineAction && value.approval_state !== "not_required") {
    errors.push(schemaError("$.approval_state", "organization_approval_scope", "must be not_required outside propose_line"));
  }
  return errors;
}
```

- [ ] **Step 4: Run focused contracts**

Run: `node --test packages/contracts/test/contracts.test.js`

Expected: PASS with all existing and five new contract fixtures.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- packages/contracts/schemas/role-definition.schema.json packages/contracts/schemas/agent-capability-profile.schema.json packages/contracts/schemas/organization-state.schema.json packages/contracts/schemas/organization-decision.schema.json packages/contracts/schemas/specialist-plan-v2.schema.json packages/contracts/src/validator.js packages/contracts/test/contracts.test.js
git commit -m "feat(orquesta): add adaptive organization contracts"
```

### Task 2: Implement the Core organization model

**Files:**
- Create: `packages/core/src/organization-model.js`
- Create: `packages/core/test/organization-model.test.js`
- Modify: `packages/core/src/index.js`

**Interfaces:**
- Consumes: the five contracts from Task 1 and `canonicalHash`.
- Produces: `createOrganizationState`, `canonicalRoleId`, `assertOrganizationInvariants`, `applyOrganizationDecision`, `agentCapabilityProviders`.

- [ ] **Step 1: Write failing invariant tests**

Cover unique IDs, existing references, one lead per team, lead membership, acyclic reporting, one line membership for line-scoped agents, project-scoped foundation exceptions, and no `temporary_assignment` field.

```js
test("project-scoped orchestrator may own two lines without joining either line", () => {
  const state = fixtureOrganization();
  state.lines.push({ ...state.lines[0], line_id: "core-line", owner_agent_id: "orchestrator" });
  assert.doesNotThrow(() => assertOrganizationInvariants(state));
});
```

- [ ] **Step 2: Run the test and observe RED**

Run: `node --test packages/core/test/organization-model.test.js`

Expected: FAIL because `organization-model.js` does not exist.

- [ ] **Step 3: Implement deterministic model helpers**

Use canonical role aliases without encoding semantics in numeric ID bands:

```js
function canonicalRoleId({ requestedRole, roles }) {
  const key = normalizeRoleText(requestedRole);
  const match = roles.find((role) => [role.role_id, ...role.aliases].some((value) => normalizeRoleText(value) === key));
  return match ? match.role_id : null;
}
```

`applyOrganizationDecision()` must increment one revision, use an idempotency key derived from decision ID and prior revision, and reject `propose_line` until its decision is approved.

- [ ] **Step 4: Run Core model and existing Core tests**

Run: `node --test packages/core/test/organization-model.test.js packages/core/test/*.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- packages/core/src/organization-model.js packages/core/src/index.js packages/core/test/organization-model.test.js
git commit -m "feat(orquesta): add canonical organization model"
```

### Task 3: Implement the two-pass organization preflight

**Files:**
- Create: `packages/core/src/organization-preflight.js`
- Create: `packages/core/test/organization-preflight.test.js`
- Modify: `packages/core/src/index.js`

**Interfaces:**
- Consumes: TaskIntent, work items, Capability Needs, resolved asset/tool providers, OrganizationState, RoleDefinitions, agent profiles, prior decisions.
- Produces: `analyzeTaskStructure(input)`, `evaluateStaffing(input)`, and `createOrganizationPreflight(input)` returning an `organization-decision` contract.

- [ ] **Step 1: Write the decision matrix tests**

Required cases:

```js
const cases = [
  ["matching agent", "reuse_agent", false],
  ["two acceptance roots", "split_task", false],
  ["durable capacity gap", "add_member", false],
  ["new capability in existing line", "add_role", false],
  ["closed management loop", "assign_lead", false],
  ["independent durable deliverable", "propose_line", true],
  ["missing evidence", "blocked_unknown", false]
];
```

Also assert that a task cannot be assigned across lines and that no output contains a temporary assignment.

Add two cost-control cases. An existing asset that satisfies the capability must be chosen before `add_role`. An identical input hash and organization revision must reuse the prior decision with `cache_hit: true` instead of rerunning deep analysis.

- [ ] **Step 2: Run the test and observe RED**

Run: `node --test packages/core/test/organization-preflight.test.js`

Expected: FAIL because the preflight module does not exist.

- [ ] **Step 3: Implement structural pass and staffing pass**

Structural pass checks acceptance roots, deliverables, ownership boundaries, partial acceptance, context boundaries, and durable independence. Staffing pass uses this strict order:

```js
const STAFFING_ORDER = Object.freeze([
  "capability",
  "context_scope",
  "ownership",
  "line",
  "capacity",
  "verification"
]);
```

Only `propose_line` sets `requires_user_approval: true`. New roles, members, leads, and permanent transfers are autonomous decisions with reason codes.

- [ ] **Step 4: Run focused and Core regression tests**

Run: `node --test packages/core/test/organization-preflight.test.js packages/core/test/*.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- packages/core/src/organization-preflight.js packages/core/src/index.js packages/core/test/organization-preflight.test.js
git commit -m "feat(orquesta): add organization preflight"
```

### Task 4: Build adaptive initial planning

**Files:**
- Create: `packages/core/src/adaptive-setup.js`
- Create: `packages/core/test/adaptive-setup.test.js`
- Modify: `packages/core/src/index.js`

**Interfaces:**
- Consumes: project intake evidence, Completion Map, capability graphs, role registry, organization state.
- Produces: `normalizeProjectUnderstanding`, `selectFirstExecutableBatch`, `createFoundationPlan`, `createAdaptiveSpecialistPlan`.

- [ ] **Step 1: Write project-specific roster tests**

Use four fixtures: small documentation project, Desktop and Core dual-deliverable project, game project, and unknown project. The first three must produce different specialist roles. Unknown evidence must create a user capability or blocked-unknown result rather than guessing.

```js
test("future milestone roles remain candidates without agents", () => {
  const plan = createAdaptiveSpecialistPlan(fixtureWithFutureReleaseTask());
  assert.equal(plan.selected_specialists.some((item) => item.role_id === "release"), false);
  assert.equal(plan.future_candidates.some((item) => item.role_id === "release"), true);
});
```

- [ ] **Step 2: Run the test and observe RED**

Run: `node --test packages/core/test/adaptive-setup.test.js`

Expected: FAIL because adaptive setup exports do not exist.

- [ ] **Step 3: Implement first-batch planning**

The foundation output must be exactly:

```js
const FOUNDATION = Object.freeze([
  { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", operational_status: "working" },
  { agent_id: "user-support", role_id: "user-support", organization_scope: "project", operational_status: "standby" },
  { agent_id: "orquesta-admin", role_id: "orquesta-admin", organization_scope: "project", operational_status: "working" }
]);
```

Calculate quantity from executable, non-conflicting work packages. Do not derive quantity from a minimum roster or future work.

- [ ] **Step 4: Run adaptive setup and Core regressions**

Run: `node --test packages/core/test/adaptive-setup.test.js packages/core/test/*.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- packages/core/src/adaptive-setup.js packages/core/src/index.js packages/core/test/adaptive-setup.test.js
git commit -m "feat(orquesta): plan adaptive initial teams"
```

### Task 5: Add atomic state migration and setup adapters

**Files:**
- Create: `orquesta/scripts/organization-state.js`
- Create: `orquesta/scripts/organization-state.test.js`
- Create: `orquesta/scripts/adaptive-setup-state.js`
- Create: `orquesta/scripts/adaptive-setup-state.test.js`

**Interfaces:**
- Consumes: `readJsonFile`, `writeJsonAtomic`, `updateJsonAtomic`, Core model and setup functions.
- Produces: `readOrganizationBundle`, `migrateLegacyOrganization`, `commitOrganizationTransition`, `prepareAdaptiveSetup`, `prepareProvisioningBatch`.

- [ ] **Step 1: Write migration and idempotency tests**

Create temporary repositories containing old five-agent state. Verify:

```js
assert.equal(next.agents.find((agent) => agent.agent_id === "user-support").lifecycle_state, "active");
assert.equal(next.agents.find((agent) => agent.agent_id === "user-liaison").lifecycle_state, "superseded");
assert.equal(next.agents.find((agent) => agent.agent_id === "vision-curator").superseded_by, "user-support");
assert.equal(next.agents.find((agent) => agent.agent_id === "error-concierge").superseded_by, "user-support");
```

Running migration twice must produce the same IDs and revision. A failed validation must leave every target file byte-identical.

- [ ] **Step 2: Run both tests and observe RED**

Run: `node orquesta/scripts/organization-state.test.js && node orquesta/scripts/adaptive-setup-state.test.js`

Expected: FAIL because both modules do not exist.

- [ ] **Step 3: Implement atomic bundle transitions**

Write a transition manifest first, validate all next documents, write each target using existing atomic JSON helpers, then mark the manifest committed. Recovery uses the `.bak` files and manifest revision. Never delete legacy agents or threads.

Provisioning batches use this shape:

```js
{
  provisioning_batch_id: "PB-...",
  organization_revision: 2,
  max_concurrent_provisioning: 3,
  requests: [{ agent_id: "implementation-002", task_id: "T002", status: "pending" }]
}
```

- [ ] **Step 4: Run state tests plus JSON-state regression**

Run: `node orquesta/scripts/organization-state.test.js && node orquesta/scripts/adaptive-setup-state.test.js && node orquesta/scripts/json-state.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- orquesta/scripts/organization-state.js orquesta/scripts/organization-state.test.js orquesta/scripts/adaptive-setup-state.js orquesta/scripts/adaptive-setup-state.test.js
git commit -m "feat(orquesta): add atomic organization state migration"
```

### Task 6: Replace the fixed setup engine

**Files:**
- Modify: `orquesta/dashboard-server.js`
- Modify: `orquesta/SKILL.md`
- Modify: `orquesta/references/initial-setup.md`
- Modify: `orquesta/references/orchestration-protocol.md`
- Modify: `orquesta/references/agent-contract.md`
- Modify: `orquesta/references/state-schema.md`
- Create: `orquesta/references/user-support.md`
- Modify: `orquesta/scripts/foundation-trigger-audit.js`
- Modify: `orquesta/scripts/foundation-trigger-audit.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 5 setup state adapter.
- Produces: six-phase setup API backed by real state, dynamic `specialist_plan` v2, three-agent foundation, merged support triggers.

- [ ] **Step 1: Add failing server source and behavior tests**

Add tests to `adaptive-setup-state.test.js` that assert the server no longer contains a fixed five-candidate function and that generated candidates derive from the provided first executable batch.

```js
assert.doesNotMatch(serverSource, /function buildSpecialistCandidates/);
assert.doesNotMatch(serverSource, /agent_id:\s*"bootstrap-qa-001"/);
```

- [ ] **Step 2: Run focused setup tests and observe RED**

Run: `node orquesta/scripts/adaptive-setup-state.test.js && node orquesta/scripts/foundation-trigger-audit.test.js`

Expected: FAIL on fixed candidates and old foundation assumptions.

- [ ] **Step 3: Replace setup planning and foundation defaults**

`generateSpecialistPlan()` calls `prepareAdaptiveSetup()` and writes schema version 2. `startProduction()` creates provisioning requests and marks tasks `provisioning`; it may not claim an agent active before a thread ID and handoff evidence exist.

Merge foundation triggers into `user-support`:

```js
const SUPPORT_TRIGGER_SOURCES = Object.freeze([
  "vision_questions",
  "repeated_failures",
  "user_tasks"
]);
```

Do not remove the old reference documents yet; change them to migration notes pointing to `user-support.md` so old reports remain understandable.

- [ ] **Step 4: Run focused setup, syntax, trigger, and encoding checks**

Run: `node --check orquesta/dashboard-server.js && node orquesta/scripts/adaptive-setup-state.test.js && node orquesta/scripts/foundation-trigger-audit.test.js && npm run check:encoding`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add -- orquesta/dashboard-server.js orquesta/SKILL.md orquesta/references/initial-setup.md orquesta/references/orchestration-protocol.md orquesta/references/agent-contract.md orquesta/references/state-schema.md orquesta/references/user-support.md orquesta/scripts/foundation-trigger-audit.js orquesta/scripts/foundation-trigger-audit.test.js package.json
git commit -m "feat(orquesta): replace fixed first-run organization"
```

### Task 7: Provision specialist Codex threads truthfully

**Files:**
- Create: `apps/orquesta-desktop/electron/core/specialist-provisioner.ts`
- Create: `apps/orquesta-desktop/electron/core/specialist-provisioner.test.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-runtime.ts`
- Modify: `apps/orquesta-desktop/electron/main/repository-service.ts`

**Interfaces:**
- Consumes: provisioning batch from Task 5 and existing `createAppServerAdapter()`.
- Produces: `provisionSpecialists({ root, batch, adapter, now })` and repository runtime method `provisionSetupSpecialists()`.

- [ ] **Step 1: Write fake-adapter provisioning tests**

Test successful thread creation and handoff, idempotent reuse of an existing thread ID, App Server failure, and partial batch continuation limited to three concurrent requests.

```ts
expect(result.requests[0]).toMatchObject({
  agentId: 'implementation-002',
  status: 'standby',
  threadId: 'thread-implementation-002',
  handoffStatus: 'accepted'
});
```

- [ ] **Step 2: Run the focused Desktop test and observe RED**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/specialist-provisioner.test.ts`

Expected: FAIL because the provisioner does not exist.

- [ ] **Step 3: Implement provisioning with the existing adapter**

For each pending request:

```ts
const thread = await adapter.createThread({ correlationId, params: { cwd: root } });
if (!thread.ok || !thread.thread_id) return failedRequest(request, thread.error);
const turn = await adapter.startTurn({ correlationId, threadId: thread.thread_id, input: handoffInput });
return turn.ok ? acceptedRequest(request, thread, turn) : failedRequest(request, turn.error);
```

Write session and agent status only after the corresponding adapter evidence exists. Reuse the same request and agent ID on retry.

- [ ] **Step 4: Run provisioner, adapter, and Desktop build checks**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/specialist-provisioner.test.ts && node --test packages/codex-adapter/test/app-server-adapter.test.js && npm --prefix apps/orquesta-desktop run build`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

Stage only the four files listed for Task 7 and verify `git diff --cached --name-only` before committing.

```powershell
git commit -m "feat(desktop): provision adaptive specialists"
```

### Task 8: Read and display explicit organization state

**Files:**
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.ts`
- Modify: `apps/orquesta-desktop/electron/core/repository-reader.test.ts`
- Modify: `apps/orquesta-desktop/src/contracts/orquesta-ui.ts`
- Modify: `apps/orquesta-desktop/src/renderer/features/map/organization.ts`
- Create: `apps/orquesta-desktop/tests/unit/organization-model.test.ts`

**Interfaces:**
- Consumes: `.orquesta/state/roles.json`, `organization.json`, and extended `agents.json`.
- Produces: explicit UI fields `roleId`, `teamId`, `lineId`, `position`, `organizationParentAgentId`, `delegatedByAgentId`, `organizationScope`, `lifecycleState`, `operationalStatus`, `organizationRevision`, and diagnostics.

- [ ] **Step 1: Write v2 projection and legacy fallback tests**

The v2 fixture must not infer grouping from names. A legacy fixture may infer, but must include `legacy_inferred_organization`.

```ts
expect(snapshot.organization?.diagnostics).not.toContain('legacy_inferred_organization');
expect(snapshot.agents.filter((agent) => agent.roleId === 'implementation')).toHaveLength(3);
```

- [ ] **Step 2: Run focused tests and observe RED**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/repository-reader.test.ts tests/unit/organization-model.test.ts`

Expected: FAIL because v2 organization files are not read.

- [ ] **Step 3: Add explicit projection and diagnostic-only fallback**

Read all v2 files through the existing confined-file boundary. Keep current name-regex grouping only inside a function named `inferLegacyOrganization()` and call it only when `organization.json` is missing.

Map the real six-phase setup state into `SetupUiSnapshot`; the existing setup experience must stop depending on the `setup-running` fixture when a repository is open. Current activity, recent activities, next activity, technical details, and provisioning failures come from repository state.

Do not edit the map layout algorithm or current setup visuals in this task.

- [ ] **Step 4: Run focused tests and Desktop build**

Run: `npm --prefix apps/orquesta-desktop run test -- electron/core/repository-reader.test.ts tests/unit/organization-model.test.ts && npm --prefix apps/orquesta-desktop run build`

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

Stage only Task 8 files, inspect the staged diff to ensure existing unrelated UI edits are excluded, then commit:

```powershell
git commit -m "feat(desktop): project explicit organization state"
```

### Task 9: Add integrated fixtures and retire legacy generation

**Files:**
- Create: `scripts/v4/adaptive-organization-fixtures.test.js`
- Modify: `package.json`
- Modify: `orquesta/dashboard-server.js`
- Modify: `orquesta/references/state-schema.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: `test:adaptive-organization` and `check:adaptive-organization` scripts, plus final legacy-generation absence checks.

- [ ] **Step 1: Write the end-to-end fixture test**

Run setup against temporary repositories for:

- a two-specialist small project
- Desktop and Core as separate proposed lines
- three same-role specialists in one approved line
- a new role created without user approval
- a dedicated lead assigned without user approval
- a new line blocked pending user approval
- old five-agent state migrated without deletion
- repeated execution producing no duplicate agents

- [ ] **Step 2: Run the fixture and observe the first failure**

Run: `node --test scripts/v4/adaptive-organization-fixtures.test.js`

Expected: FAIL until every real integration is connected.

- [ ] **Step 3: Remove remaining fixed-generation paths**

Remove only generation behavior. Preserve legacy readers and migration documentation. Add source assertions for these forbidden new-project paths:

```js
const forbidden = [
  "buildSpecialistCandidates",
  'agent_id: "bootstrap-qa-001"',
  'foundation_agent_ids: ["orchestrator", "user-liaison"'
];
```

- [ ] **Step 4: Run bounded integration checks**

Run:

```powershell
npm run test:adaptive-organization
npm run test:v4:phase1
npm run test:v4:phase15
node orquesta/scripts/json-state.test.js
npm --prefix apps/orquesta-desktop run build
```

Expected: all commands exit 0. Do not run browser stress or long-duration interaction tests here.

- [ ] **Step 5: Run one final milestone check**

Run: `npm run check:adaptive-organization`

Expected: contract, Core, state, setup, trigger, Desktop focused tests, syntax, and encoding all pass once.

- [ ] **Step 6: Commit Task 9**

```powershell
git add -- scripts/v4/adaptive-organization-fixtures.test.js package.json orquesta/dashboard-server.js orquesta/references/state-schema.md
git commit -m "test(orquesta): verify adaptive organization lifecycle"
```

## Execution Checkpoints

- Checkpoint 1 after Tasks 1-2: contracts and organization invariants are real, with no runtime behavior change.
- Checkpoint 2 after Tasks 3-4: pure decision engine and initial roster generation work in fixtures.
- Checkpoint 3 after Tasks 5-6: repository setup is functional with the three-agent foundation and dynamic specialists.
- Checkpoint 4 after Tasks 7-8: Desktop provisions threads and displays formal organization state.
- Checkpoint 5 after Task 9: legacy generation is removed and the integrated path is ready for user testing.

At each checkpoint, report the concrete capability gained and the focused commands that passed. Do not repeat long browser or memory tests until Checkpoint 5.
