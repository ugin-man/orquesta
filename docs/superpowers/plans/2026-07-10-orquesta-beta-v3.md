# Orquesta Beta V3 implementation plan

> For implementation agents: use this as the working plan. Do not invent task ids in this file. Create Orquesta tasks later from the orchestrator, using ids that do not conflict with `.orquesta/state/tasks.json`.

Goal: implement Orquesta Beta V3 as `0.3.0-beta.0`, with file-backed control audit, completion envelopes, specialist capacity circuits, question observations, failure intake, adaptive model route records, and a focused dashboard Control Plane/Audit view.

Architecture: keep the repository-owned path first. Product-level Codex tool streams, thread messaging, and model override are optional adapters. If an adapter is unavailable, the system records recommendations and manual evidence only. Dispatch acceptance, turn start, progress, report production, and actual-model proof remain distinct. Required specialist capacity loss opens a fail-closed circuit instead of allowing orchestrator-only substitution.

Tech stack: Node.js scripts, `orquesta/dashboard-server.js`, static dashboard HTML/CSS/JS, `.orquesta` JSON state, npm checks, browser DOM smoke.

## Phase 1: atomic state foundation

Files:

- Create: `orquesta/scripts/json-state.js`
- Create: `orquesta/scripts/json-state.test.js`
- Modify: `orquesta/dashboard-server.js`
- Modify: `orquesta/scripts/report-question-candidates-check.js`
- Modify: `package.json`

- [ ] Step 1: write RED tests for atomic writes

Add tests in `orquesta/scripts/json-state.test.js`.

Cases:

- writes valid UTF-8 JSON with trailing newline
- creates parent directories
- preserves a `.bak` backup when requested
- restores backup when target JSON is corrupt
- removes temp files after success
- refuses to continue when target and backup are both invalid
- does not rewrite a UTF-8 Japanese file just because console display may be mojibake

Run:

```powershell
node orquesta/scripts/json-state.test.js
```

Expected RED:

```text
Cannot find module
```

or:

```text
json-state test failed
```

- [ ] Step 2: implement `json-state.js`

Export these interfaces:

```js
readJsonFile(filePath, defaultValue)
writeJsonAtomic(filePath, data, options = {})
updateJsonAtomic(filePath, defaultValue, updater, options = {})
appendJsonlAtomic(filePath, event, options = {})
recoverJsonFile(filePath, options = {})
```

Rules:

- write temp file in same directory
- use UTF-8
- use `fs.renameSync` for final move
- create `.bak` only when `backup: true`
- return structured result with `status`, `path`, `backupPath`, `tempPath`, `writtenAt`
- throw with `code: "JSON_STATE_UNRECOVERABLE"` when recovery cannot find valid JSON

- [ ] Step 3: replace only the first write paths

Change these first:

- `dashboard-server.js` `writeJsonTo()`
- `appendEvent()`
- question candidate inbox writes in `report-question-candidates-check.js`

Do not replace every write path in one pass.

- [ ] Step 4: add npm scripts

Modify `package.json`:

```json
"test:json-state": "node orquesta/scripts/json-state.test.js"
```

Add `node --check orquesta/scripts/json-state.js`, `node --check orquesta/scripts/json-state.test.js`, and `npm run test:json-state` to `npm run check`.

- [ ] Step 5: GREEN

Run:

```powershell
npm run test:json-state
npm run check
```

Expected:

```text
json-state tests passed
Orquesta encoding check passed: .orquesta
```

## Phase 2: completion envelope and control audit

Files:

- Create: `orquesta/scripts/completion-envelope-check.js`
- Create: `orquesta/scripts/completion-envelope-check.test.js`
- Create: `orquesta/scripts/control-audit.js`
- Create: `orquesta/scripts/control-audit.test.js`
- Create: `orquesta/scripts/capacity-gate.js`
- Create: `orquesta/scripts/capacity-gate.test.js`
- Create: `.orquesta/state/capacity.json`
- Modify: `orquesta/dashboard-server.js`
- Modify: `package.json`

- [ ] Step 1: RED completion envelope tests

Test cases:

- valid `completion_envelope` block passes
- missing block fails for staged-in `specialist_required`
- report-only task can have no command checks only with explicit reason
- fallback that weakens browser, visual, runtime, or acceptance evidence fails without approval
- invalid timestamp fails
- delegation evidence must match task state
- `question_candidates_status` must be `submitted` or `none`

Run:

```powershell
node orquesta/scripts/completion-envelope-check.test.js
```

Expected RED:

```text
Cannot find module
```

- [ ] Step 2: implement completion envelope checker

Export:

```js
extractCompletionEnvelope(text)
inspectCompletionEnvelope(reportPath, task, options = {})
validateCompletionEnvelope(envelope, task, options = {})
```

The checker reads UTF-8 and returns:

```js
{
  present,
  status,
  envelope,
  errors,
  warnings
}
```

- [ ] Step 3: RED control audit tests

Test cases:

- missing handoff on staged-in `specialist_required` is blocker
- accepted staged-in task without report path is blocker
- missing completion envelope is blocker
- stale sessions during live claim is blocker
- weak fallback without approval is blocker
- pending question observations are counted
- incident candidates are counted
- legacy accepted tasks are warning or ignored according to rollout mode
- dispatch acceptance without correlated turn-start or report evidence is not a running specialist
- one ambiguous pre-start error does not claim usage exhaustion
- two correlated pre-start failures open the target circuit with unknown cause unless stronger evidence exists
- a user-confirmed or product-confirmed usage limit enters cooldown
- cooldown expiry permits one probe and does not directly restore availability
- unavailable required specialist plus no eligible fallback pauses the critical path
- open specialist circuit plus orchestrator substitution is a blocker
- fallback role, independence, capacity, requested model, actual model, and evidence downgrade are audited

Run:

```powershell
node orquesta/scripts/control-audit.test.js
```

Expected RED:

```text
Cannot find module
```

- [ ] Step 4: implement `control-audit.js`

Inputs:

- `.orquesta/state/tasks.json`
- `.orquesta/state/trigger_audit.json`
- `.orquesta/state/sessions.json`
- `.orquesta/state/capacity.json`
- `.orquesta/vision/question_candidates.json`
- `.orquesta/failures/incidents.json`
- `.orquesta/failures/incident_candidates.json`
- `.orquesta/failures/incident_clusters.json`

Output:

- `.orquesta/state/control_audit.json`

CLI:

```powershell
node orquesta/scripts/control-audit.js
```

Expected output:

```text
control audit clear: .orquesta/state/control_audit.json
```

or:

```text
control audit blockers: .orquesta/state/control_audit.json
```

- [ ] Step 5: integrate report review

In `dashboard-server.js`, update `reviewSpecialistReport()`:

- inspect `question_candidates`
- inspect `completion_envelope`
- run task-scoped control review before `accept`
- block only staged-in tasks at first
- return `409` with clear errors when blocked
- append events `control_review_passed` or `control_review_blocked`

- [ ] Step 6: add scripts

Modify `package.json`:

```json
"audit:control": "node orquesta/scripts/control-audit.js",
"test:completion-envelope": "node orquesta/scripts/completion-envelope-check.test.js",
"test:control-audit": "node orquesta/scripts/control-audit.test.js"
```

Add them to `npm run check`.

- [ ] Step 7: GREEN

Run:

```powershell
npm run test:completion-envelope
npm run test:control-audit
npm run audit:control
npm run check
```

Expected:

```text
completion-envelope tests passed
control-audit tests passed
control audit clear: .orquesta/state/control_audit.json
Orquesta encoding check passed: .orquesta
```

## Phase 3: question observation and failure intake

Files:

- Modify: `orquesta/scripts/report-question-candidates-check.js`
- Modify: `orquesta/scripts/report-question-candidates-check.test.js`
- Create: `orquesta/scripts/incident-intake.js`
- Create: `orquesta/scripts/incident-intake.test.js`
- Modify: `orquesta/scripts/foundation-trigger-audit.js`
- Modify: `orquesta/scripts/foundation-trigger-audit.test.js`
- Modify: `package.json`

- [ ] Step 1: RED question observation tests

Cases:

- candidate accepts optional `observation`
- low priority workflow candidate can become `observation`
- `user_emergence_value` accepts only `low`, `medium`, `high`
- raw candidates do not become user-facing questions directly
- duplicate observation does not duplicate inbox entries

Run:

```powershell
npm run test:question-candidates
```

Expected RED:

```text
question-candidates error: observation field is invalid
```

- [ ] Step 2: update question candidate schema logic

Add observation support without breaking old candidates:

```js
observation: {
  value_type,
  user_emergence_value,
  decision_cluster_id,
  suggested_action,
  reason
}
```

Default old candidates to:

```json
{
  "value_type": "maintenance_note",
  "user_emergence_value": "low",
  "suggested_action": "curator_review"
}
```

- [ ] Step 3: RED incident intake tests

Cases:

- one command failure creates one candidate, no repair card
- same local fingerprint twice promotes or flags open
- quality-degrading fallback creates candidate requiring approval
- same-quality fallback closes as noise
- invalid timestamp fails
- fingerprint removes temp paths, timestamps, thread ids, and volatile ports

Run:

```powershell
node orquesta/scripts/incident-intake.test.js
```

Expected RED:

```text
Cannot find module
```

- [ ] Step 4: implement incident intake

Export:

```js
createIncidentCandidate(input, options = {})
fingerprintIncident(input)
classifyIncidentCandidate(candidate)
appendIncidentCandidate(root, candidate)
clusterIncidentCandidates(root, options = {})
```

Write:

- `.orquesta/failures/incident_candidates.json`
- `.orquesta/failures/incident_clusters.json`

- [ ] Step 5: connect trigger audit

Update `foundation-trigger-audit.js` so `error-concierge` can see:

- open incident candidates above threshold
- repeated global fingerprints
- quality degradation candidates requiring user approval

The active failure trigger and its evidence list must include only incidents whose status is exactly `open`. Mitigated or resolved incidents remain in history but cannot keep `wake_needed` or `wake_required` active. Add regressions for mitigated F004/F005 plus open F006, then for all three mitigated.

No user task creation here.

- [ ] Step 6: scripts and GREEN

Add:

```json
"test:incident-intake": "node orquesta/scripts/incident-intake.test.js"
```

Run:

```powershell
npm run test:question-candidates
npm run test:incident-intake
npm run test:triggers
npm run check
```

Expected:

```text
question-candidates tests passed
incident-intake tests passed
foundation-trigger-audit tests passed
Orquesta encoding check passed: .orquesta
```

## Phase 4: adaptive model policy and escalation

Files:

- Create: `orquesta/scripts/model-policy.js`
- Create: `orquesta/scripts/model-policy.test.js`
- Create: `.orquesta/state/model_policy.json` only in test fixtures or migration flow, not by this report
- Modify: `orquesta/dashboard-server.js`
- Modify: `package.json`

- [ ] Step 1: RED model policy tests

Cases:

- low ambiguity, low consequence, narrow context recommends Luna
- normal multi-file work recommends Terra
- high ambiguity or high consequence recommends Sol review
- repeated failure history escalates
- unnecessary Sol usage returns warning
- normal implementation starts on Terra even when final semantic acceptance requires Sol
- deterministic audit and clustering first passes recommend Luna
- more than two concurrent specialist turns is rejected or queued
- tasks in one dependency chain do not run concurrently
- a second semantic review requires failed evidence or a material revision
- handoff payloads use artifact paths and deltas instead of repeating full context
- product adapter unavailable leaves `actual_model: null`

Run:

```powershell
node orquesta/scripts/model-policy.test.js
```

Expected RED:

```text
Cannot find module
```

- [ ] Step 2: implement model policy

Export:

```js
defaultModelPolicy()
scoreControlSignals(task, context = {})
recommendModelRoute(task, policy, context = {})
recordModelRoute(tasksState, taskId, route, options = {})
```

Do not switch models. Only write route recommendation.

Implement the budget policy with these defaults:

- `max_concurrent_specialist_turns: 2`
- `max_concurrent_turns_per_dependency_chain: 1`
- `max_escalations_per_task: 1`
- `max_semantic_review_rounds: 1`
- Terra for normal implementation, Luna for deterministic triage, and Sol for orchestration, hard judgment, or bounded escalation
- file-backed delta handoffs and 60/120/240 second thread polling backoff

Do not label local cumulative Codex counters as billing tokens. They may be used as a coarse diagnostic signal only when their source and limitations are shown.

- [ ] Step 3: add product adapter boundary

Add `orquesta/scripts/product-adapter.js` only if implementation needs a shared module. Its default adapter is `repository_only`.

Interface:

```js
getProductAdapter()
dispatchMessage(input)
requestModelOverride(input)
readToolEvents(input)
```

Default results:

```json
{ "status": "unsupported", "adapter_id": "repository_only" }
```

- [ ] Step 4: dashboard server state exposure

Extend `/api/state` with:

- `modelPolicy`
- task `model_route`
- task `control_signals`
- task `escalation_history`

- [ ] Step 5: GREEN

Run:

```powershell
npm run test:model-policy
npm run check
```

Expected:

```text
model-policy tests passed
Orquesta encoding check passed: .orquesta
```

## Phase 5: dashboard Control Plane/Audit

Files:

- Modify: `orquesta/assets/dashboard/index.html`
- Modify: `orquesta/assets/dashboard/app.js`
- Modify: `orquesta/assets/dashboard/styles.css`
- Modify: `orquesta/scripts/dashboard-dom-smoke.js`
- Modify: `package.json` if smoke flags are needed

- [ ] Step 1: RED dashboard smoke expectations

Add DOM smoke checks:

- Control Plane/Audit view exists
- Home still has current work, organization, attention queue
- control audit summary renders when `/api/state` includes `controlAudit`
- model route reason renders in task detail
- completion evidence status renders
- fallback approval required renders as action, not as accepted
- Home renders only paused or user-action-required capacity alerts and meaningful recovery
- Control Plane distinguishes queued, dispatch accepted, turn started, progress observed, report produced, and model verified
- Control Plane renders open circuit, cause confidence, cooldown or probe, fallback eligibility, and suppressed notification count
- raw question text and failure fingerprints are not shown on Home
- no auto thread creation button exists
- no auto model switch claim exists

Run against a fixture or running dashboard:

```powershell
npm run smoke:dashboard -- http://127.0.0.1:4177/
```

Expected RED before UI work:

```text
dashboard smoke failed: Control Plane view missing
```

- [ ] Step 2: add focused view shell

Add a separate nav/view:

```text
Control Plane
```

Sections:

- Summary
- Model Route
- Completion Evidence
- Question Observations
- Failure Clusters
- Repair Cards
- Approvals
- Dashboard Actions

Keep Home light.

- [ ] Step 3: render summaries

Use existing `/api/state` plus new fields:

- `controlAudit`
- `modelPolicy`
- `failures.incidentCandidates`
- `failures.incidentClusters`
- `vision.questionCandidates[].observation`
- `dashboardActions`

Render low/medium/high labels and short reasons first. Put raw details in collapsible detail.

- [ ] Step 4: dashboard actions

Add state-backed POST endpoints only after read-only display works:

- `POST /api/control/actions`
- `POST /api/control/model-route/review`
- `POST /api/control/fallback/review`
- `POST /api/control/wake-defer`

Each endpoint:

- requires `idempotency_key`
- writes `dashboard_actions.json`
- uses atomic write helper
- appends event after success
- does not message threads or switch models

- [ ] Step 5: browser GREEN

Run:

```powershell
npm run check
npm run dashboard
npm run smoke:dashboard -- http://127.0.0.1:4177/
```

Expected:

```text
Dashboard smoke passed
```

Also manually verify browser console has no `ReferenceError`, `TypeError`, or page error.

## Phase 6: protocol, bootstrap, docs, and version migration

Files:

- Modify: `orquesta/references/state-schema.md`
- Modify: `orquesta/references/orchestration-protocol.md`
- Modify: `orquesta/references/agent-contract.md`
- Modify: `orquesta/references/vision-alignment.md`
- Modify: `orquesta/references/failure-concierge.md`
- Modify: `README.md`
- Modify: `package.json`
- Modify: `.agents/skills/orquesta/references/*` only if this repo still mirrors installed skill references

- [ ] Step 1: RED docs consistency check

Use `rg` before docs edits:

```powershell
rg "0\\.3\\.0-beta\\.0|control_audit|completion_envelope|incident_candidates|model_policy|dashboard_actions|question observations" README.md package.json orquesta/references .agents/skills/orquesta/references
```

Expected RED:

```text
no matches for some new Beta V3 terms
```

- [ ] Step 2: update protocol references

Add:

- progressive gate scope
- completion envelope acceptance rule
- control audit startup and pre-acceptance rule
- incident candidate intake before retry/fallback
- question observations and meaning clusters
- model route recommendation boundaries
- product adapter no-fake-automation rule

- [ ] Step 3: update state schema

Document exact schemas from the spec:

- `control_audit.json`
- `model_policy.json`
- `dashboard_actions.json`
- `incident_candidates.json`
- `incident_clusters.json`
- task control fields
- completion envelope
- question observation fields

- [ ] Step 4: update agent contract

Specialist reports must include:

- `completion_envelope`
- `question_candidates`
- fallback disclosure
- model route evidence when assigned

Use progressive wording so low-risk legacy report-only work can be warning-only during migration.

- [ ] Step 5: update README and package version

Change:

```json
"version": "0.3.0-beta.0"
```

README:

- title or beta status says Beta V3 / `0.3.0-beta.0`
- explains Control Plane/Audit view
- says model routing is recommendation/evidence unless product adapter exists
- says fallback approval is required when proof weakens

- [ ] Step 6: GREEN

Run:

```powershell
npm run check
rg "0\\.3\\.0-beta\\.0|control_audit|completion_envelope|incident_candidates|model_policy|dashboard_actions" README.md package.json orquesta/references
```

Expected:

```text
Orquesta encoding check passed: .orquesta
```

and matches for all new terms.

## Phase 7: unit, integration, live-thread, browser, and compaction QA

Files:

- Create: `docs/testing/orquesta-beta-v3-qa.md`
- Create: the assigned future task report under `.orquesta/reports/` only when the orchestrator creates that task
- Modify tests as needed

- [ ] Step 1: full unit suite

Run:

```powershell
npm run test:json-state
npm run test:completion-envelope
npm run test:control-audit
npm run test:incident-intake
npm run test:model-policy
npm run test:question-candidates
npm run test:triggers
npm run test:delegation
npm run test:approval
npm run check
```

Expected:

```text
json-state tests passed
completion-envelope tests passed
control-audit tests passed
incident-intake tests passed
model-policy tests passed
question-candidates tests passed
foundation-trigger-audit tests passed
delegation gate check passed
approval wait check passed
Orquesta encoding check passed: .orquesta
```

- [ ] Step 2: integration fixture

Create temp fixture state inside test code, not by editing live `.orquesta` manually.

Scenarios:

- specialist task with valid handoff, report, envelope, question candidates passes
- missing envelope blocks
- weak browser fallback without approval blocks
- incident candidate clusters
- user-actionable repair card does not become user task until accepted
- question observations cluster without becoming raw user questions

Expected:

```text
control integration tests passed
```

- [ ] Step 3: live-thread proof

Use a real Orquesta specialist task after implementation is ready.

Proof required:

- `tasks.json` has `routing_class: "specialist_required"`
- `handoff_sent_at` exists
- report exists
- report has valid `completion_envelope`
- report has valid `question_candidates`
- control audit passes or records exact blocker
- acceptance event is appended
- dispatch record distinguishes accepted from turn-start evidence

Do not claim live-thread proof from static fixture.

Also run one bounded failure flow and one recovery flow:

- two correlated pre-start failures open the observed target circuit without guessing the cause
- affected `specialist_required` work cannot be absorbed by the orchestrator
- cooldown expiry enters `probing`, not `available`
- only correlated turn-start evidence closes the circuit

- [ ] Step 4: browser proof

Run:

```powershell
npm run dashboard
npm run smoke:dashboard -- http://127.0.0.1:4177/
```

Expected:

```text
Dashboard smoke passed
```

Manual browser checks:

- Control Plane view opens
- Home remains focused
- no console/page errors
- no horizontal overflow
- stale sessions are visibly weak, not claimed live
- no automatic wake/thread/model action is implied
- dispatch accepted is not labelled as specialist running
- unknown start or usage cause is shown as unknown rather than guessed

- [ ] Step 5: compaction drill

Close or ignore chat context and use only state files:

- `.orquesta/state/tasks.json`
- `.orquesta/state/control_audit.json`
- `.orquesta/state/trigger_audit.json`
- `.orquesta/failures/incident_candidates.json`
- `.orquesta/failures/incident_clusters.json`
- `.orquesta/vision/question_candidates.json`

Expected written answer:

```text
next action, blocking evidence, owner, model route, fallback/user approval status can be explained in under 3 minutes
```

- [ ] Step 6: release gate

Before release:

```powershell
npm run check
npm run audit:triggers
npm run audit:control
npm run smoke:dashboard -- http://127.0.0.1:4177/
```

Expected:

```text
Orquesta encoding check passed: .orquesta
control audit clear
Dashboard smoke passed
```

If `control audit blockers` appears, release is blocked unless the blocker is documented as a legacy migration exception.

## Rollback plan

Rollback order:

- Disable hard gates by setting rollout mode to warning.
- Keep new state files but stop using them for acceptance.
- Revert dashboard Control Plane view only if it breaks Home or browser smoke.
- Revert version bump if release criteria were not met.
- Keep incident candidates and completion envelope data as evidence unless JSON corruption is proven.

Rollback commands depend on the future branch state. Do not use destructive `git reset --hard` without explicit user approval.
