# Initial Setup Protocol

## Purpose

Define what Orquesta does when it is installed or invoked for the first time in a new project.

The first user experience should not be a blank state. When Orquesta is called in a project chat, that calling chat becomes the production orchestrator. Orquesta then creates one support seat and one administration seat, understands the selected project, and provisions only the specialists needed for the first executable work.

## Naming Policy

Separate machine IDs from human-visible names.

Foundation agents are unique system seats, not numbered production specialists. New projects should use these canonical foundation IDs:

- `orchestrator`
- `user-support`
- `orquesta-admin`

Do not put Japanese text, star marks, emoji, or decorative symbols in agent IDs, JSON keys, file names, or state references. Use ASCII IDs for anything machines read.

Human-visible thread titles may use Japanese and a star mark. The orchestrator thread should be titled `★ Orquesta 統括`.

Existing `user-liaison`, `vision-curator`, and `error-concierge` records are preserved as `superseded` history and point to `user-support`. New projects never generate those three legacy seats.

## First Invocation

The calling chat becomes the orchestrator foundation agent.

Rename the calling Codex thread to `★ Orquesta 統括` and pin it when thread tools are available. If the title or pin cannot be changed, still record the calling thread as the orchestrator in state and report the skipped UI action.

The orchestrator owns:

- production routing
- task decomposition
- state synchronization
- specialist contracts
- acceptance checks
- final user reports

The orchestrator must not:

- absorb every specialist context file
- independently turn raw user answers into adopted direction without support triage
- silently retry repeated environment failures after a support wake trigger
- create production specialists before the foundation setup is complete

## Foundation Sessions

Create or reuse these sessions immediately after the calling chat is recorded as the orchestrator:

- `user-support`: event-driven question curator, answer interpreter, failure triage, repair-card author, and user-side task coordinator.
- `orquesta-admin`: Orquesta setup, dashboard handoff, option packs, and configuration.

These are foundation sessions, not production feature teams. They should usually return to `standby` after their readiness or setup report.

Foundation bootstrap must be idempotent:

- If a required foundation agent already exists with a valid thread ID, reuse it.
- If a foundation thread is missing, create only the missing thread.
- If a thread cannot be created, record the missing role as blocked and continue only with a clear user-visible setup blocker.
- Never create duplicate foundation agents with new IDs just because setup is run twice.

## Orquesta Admin

`orquesta-admin` manages Orquesta itself, not the product being built.

`orquesta-admin` owns:

- first-run orientation
- dashboard startup and dashboard URL handoff
- Orquesta configuration and tuning requests
- optional feature-pack proposals
- initial specialist roster recommendations
- explaining what Orquesta can and cannot do in the current project

`orquesta-admin` must not:

- become the production orchestrator
- implement product features
- interpret raw vision answers
- classify raw failures into repair cards
  - bypass the organization preflight or create a new line without product-level user approval
- hide options behind long reports

## Bootstrap Flow

When `.orquesta/CURRENT_ORCHESTRA.md` is missing:

1. Create the `.orquesta` state skeleton.
2. Record the calling chat as `orchestrator`.
3. Rename the calling thread to `★ Orquesta 統括` when possible.
4. Pin the calling thread when possible.
5. Add exactly `orchestrator`, `user-support`, and `orquesta-admin` to the foundation in `agents.json`.
6. Create or reuse the three foundation Codex sessions.
7. Start the dashboard server if possible.
8. Verify the dashboard with `/api/state`, not only HTTP 200.
9. Open the verified dashboard URL in the user's external browser when possible.
10. Give the verified dashboard URL in chat even if browser opening succeeds.
11. Ask for the project folder, project name, and project description. Prefill what can be inferred from the selected repository.
12. Store the intake in `.orquesta/setup/project_intake.json` and build a bounded Project Understanding Packet.
13. Ask zero to three optional clarification questions only when the evidence is insufficient. Skipping them must not block setup.
14. Create the six-phase `.orquesta/setup/setup_state.json`, initial Completion Map, and first executable work.
15. Run the normal organization preflight against that work. Create no fixed roster and no minimum number of specialists.
16. Create the initial roles, lines, teams, memberships, agents, and task ownership in one organization revision.
17. Prepare a provisioning batch capped at three concurrent requests. Each specialist must own at least one executable task.
18. Use the existing Codex App Server path to create each accepted specialist thread and send its bounded handoff.
19. Mark a specialist operational only after thread and turn evidence exists. Keep failures on the same agent ID as `provisioning_failed` for retry.
20. Report why each initial role and line exists and move to the Home screen after one integrated setup check.

If the dashboard server cannot start, record a failure incident and let the trigger audit wake `user-support` when user knowledge or action is actually needed.

If setup is interrupted, resume from `.orquesta/setup/options.json` instead of starting over.

## Dashboard Verification

Do not treat an HTTP 200 from `http://127.0.0.1:4177/` as proof that the current project dashboard is running. Another Orquesta project or unrelated process may already own the port.

Verify dashboard ownership by requesting `/api/state` from the candidate port and checking:

- the response parses as JSON
- `source` is `server`
- the returned state includes the current project's `.orquesta` data
- `project_cwd` or equivalent session/project paths match the current project when available
- expected foundation agent IDs are present

The dashboard server should choose the port before startup instead of repeatedly launching and failing. Prefer the last port recorded in `.orquesta/setup/options.json` for this project, then `4177`, then scan nearby ports. If the selected port still races and becomes occupied at listen time, rescan and retry.

If the default port is occupied by another process, record the selected fallback in `.orquesta/setup/options.json`, `.orquesta/CURRENT_ORCHESTRA.md`, and the final user report with the actual verified dashboard URL. Treat expected port occupation as dashboard routing state; only create a failure incident when startup still blocks or needs user-side action.

## Dashboard Browser Handoff

After the dashboard URL is verified, try to open it in the user's normal external browser so the user notices the dashboard exists.

Use the safest platform command available:

- Windows PowerShell: `Start-Process <verified-dashboard-url>`
- macOS: `open <verified-dashboard-url>`
- Linux: `xdg-open <verified-dashboard-url>`

Rules:

- Open only the verified URL for the current project.
- Do not open a URL before `/api/state` proves the dashboard belongs to this project.
- Record whether browser opening was attempted and whether it appeared to succeed in `.orquesta/setup/options.json`.
- If opening fails, do not treat setup as failed. Report the URL clearly and let the user open it manually.
- Do not repeatedly open browser tabs on every setup resume. Only auto-open during first successful dashboard verification, or when the user explicitly asks.

## Non-English State Safety

Orquesta must support projects whose visible names, questions, reports, and dashboard text are not English.

When setup or a specialist writes user-visible non-ASCII text into `.orquesta` state:

- Do not write Japanese or other non-ASCII JSON through shell snippets unless the command path has been proven UTF-8 safe.
- Prefer `apply_patch`, a UTF-8-aware script file, or Unicode-escaped JavaScript literals for generated state.
- After writing state, run `npm run check:encoding` from the Orquesta repository root when available.
- Treat repeated literal question marks such as `???` in `.orquesta` JSON as a setup failure, not cosmetic text.
- If the dashboard displays garbled questions or names, inspect the source JSON first. Do not start by changing the dashboard renderer.

The dashboard server also reports encoding warnings in `/api/state` under `health.encodingWarnings`.

## First-Run Menu

Keep the first message short. Use this shape:

```md
Orquesta is ready to set up this project.

This chat is now the production orchestrator: `★ Orquesta 統括`.

Dashboard:
http://127.0.0.1:4177/

I can help with:
- creating long-lived specialist Codex sessions
- keeping task/state/report files synchronized
- showing the active team and user-side tasks on the dashboard
- separating creative vision, user tasks, and failure repair workflows

First setup is short:
1. Confirm the project folder, name, and description.
2. Answer or skip any optional clarification questions.
3. Watch Orquesta build the foundation, plan, initial specialists, and operating state.
4. Adjust the organization and priorities during normal operation.
```

## Legacy Option Packs

Existing projects may retain option-pack metadata in `.orquesta/setup/options.json`, but packs do not generate the first team and are not a setup gate. New specialists come from executable work and capability needs.

Default packs:

- `minimal_core`: compatibility label for the three-agent foundation.
- `game_production_core`: implementation, visual-art, world-lore, playtest-qa.
- `vision_alignment`, `failure_concierge`, and `user_liaison_desk`: legacy labels now served by `user-support`.
- `orquesta_admin`: setup options, dashboard handoff, and Orquesta tuning.
- `research_team`: future pack for external research and method discovery.
- `asset_pipeline`: future pack for art, sprite, audio, and asset production workflows.

Keep legacy pack data readable, but never use it as a fixed specialist roster.

## Organization Authority After Setup

The organization preflight may autonomously reuse an agent, split work, add a member, add a role, assign a lead, or permanently transfer an agent between existing lines. Only `propose_line` creates a product-level user task and waits for approval. A rejected line proposal stays rejected; it must not be silently converted into a temporary cross-line assignment. Codex harness approvals remain independent of this product rule.

## Relationship To Orchestrator

`orquesta-admin` manages Orquesta as a system.

`orchestrator` manages production work inside the project.

The user may talk to either:

- Talk to `orquesta-admin` to tune Orquesta itself.
- Talk to `★ Orquesta 統括` to plan and route production work.

## Setup State

`.orquesta/setup/options.json` should track:

- bootstrap status
- orchestrator thread ID
- orchestrator title policy
- orchestrator pin policy
- foundation agent IDs
- foundation readiness or blockers
- legacy pack metadata when present
- dashboard URL
- admin session ID
- setup status
- setup notes

`.orquesta/setup/setup_state.json` should track the real six phases: environment, project understanding, foundation, planning, specialists, and operation. `.orquesta/setup/wizard.json` remains a compatibility projection for older clients and should not be treated as the canonical setup engine.

- setup status
- current setup step
- visible step list
- project intake gate state
- optional-question status without a completion gate
- setup autopilot finalization state
- initial team preparation state

`.orquesta/setup/project_intake.json` should track:

- project title
- project description
- submission status
- source
- update time

The source of truth stays file-backed. The first-run chat is not enough.
