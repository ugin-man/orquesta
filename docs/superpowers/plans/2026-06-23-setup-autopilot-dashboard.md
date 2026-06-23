# Setup Autopilot Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Orquesta first-run setup finish automatically after project intake and required question answers, then show setup as a compact operations-card instead of a separate dashboard tab.

**Architecture:** Keep the file-backed setup state, but replace user-facing approval gates with an automatic finalization path. The dashboard keeps the question-answer UI in User Tasks and shows setup progress in Operations; detailed specialist/production preparation remains state-backed but is no longer a required setup conversation.

**Tech Stack:** Node.js dashboard server, static dashboard HTML/CSS/JS, `.orquesta` JSON state, npm smoke checks.

---

### Task 1: Server Setup Autopilot

**Files:**
- Modify: `orquesta/dashboard-server.js`
- Modify: `orquesta/references/initial-setup.md`
- Modify: `orquesta/references/state-schema.md`

- [ ] **Step 1: Change setup semantics**

Replace completion-map and specialist-plan approval gates with an automatic setup finalization rule:

```text
After project intake exists and all setup questions are answered, Orquesta may auto-finalize first-run setup by creating or refreshing:
- initial Completion Map
- initial Specialist Plan
- initial development step summary

The user can revise these after setup; they are not separate approval gates.
```

- [ ] **Step 2: Add an auto-finalize endpoint**

Add `POST /api/setup/auto-finalize` that:

```js
save/confirm Completion Map approval internally
generate specialist plan when missing
mark high-priority candidates as approve_now
mark wizard status as ready_for_operation
do not create sessions
do not message specialist threads
do not prepare first handoff tasks unless explicitly requested later
```

- [ ] **Step 3: Keep project-intake before questions**

Ensure `POST /api/setup/generate-questions` still rejects missing project intake and no dashboard state shows live required questions before project intake exists.

### Task 2: Dashboard Setup Card

**Files:**
- Modify: `orquesta/assets/dashboard/index.html`
- Modify: `orquesta/assets/dashboard/app.js`
- Modify: `orquesta/assets/dashboard/styles.css`

- [ ] **Step 1: Remove the separate setup tab**

Delete the Setup tab button and setup-only view panel from `index.html`.

- [ ] **Step 2: Add compact setup card to Operations**

Add a compact card at the top of Operations that shows:

```text
Initial setup
1. Describe project
2. Answer generated questions
3. Orquesta prepares initial map and team
4. Production can begin
```

It must be compact, collapsible after completion, and must not dominate the operations screen.

- [ ] **Step 3: Lock question UI before project intake**

If project intake is not submitted, the User Tasks question area shows a clear message asking the user to describe the project first.

- [ ] **Step 4: Auto-finalize after answers**

After all required setup questions are answered, expose one action:

```text
Finalize initial setup
```

This action calls `/api/setup/auto-finalize` and reports the generated initial map/team summary. It does not ask for separate completion-map, specialist, or first-task approval.

### Task 3: Verification

**Files:**
- Modify: `docs/testing/github-install-bootstrap-smoke-test.md`
- Create: `.orquesta/reports/T067-setup-autopilot-dashboard.md`

- [ ] **Step 1: Update smoke expectations**

The clean install smoke should expect:

```text
Operations/User Tasks tabs only
Setup card visible in Operations
No setup questions before project intake
Question generation requires project intake
Completion Map and specialist plan can be auto-finalized after answers
```

- [ ] **Step 2: Run checks**

Run:

```powershell
npm run check
```

Expected:

```text
Orquesta encoding check passed: .orquesta
```

- [ ] **Step 3: Browser smoke**

Verify through a real browser or dashboard DOM smoke:

```text
setup tab is absent
operations setup card is present
project-intake-before-question guard is visible when relevant
no console/page errors
```
