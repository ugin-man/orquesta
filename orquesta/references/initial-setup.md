# Initial Setup Protocol

## Purpose

Define what Orquesta does when it is installed or invoked for the first time in a new project.

The first user experience should not be a blank state. When Orquesta is called in a project chat, that calling chat becomes the production orchestrator. Orquesta then creates the minimum foundation sessions needed for user collaboration, vision alignment, failure repair, and Orquesta configuration before it starts planning production work.

## Naming Policy

Separate machine IDs from human-visible names.

Foundation agents are unique system seats, not numbered production specialists. New projects should use these canonical foundation IDs:

- `orchestrator`
- `user-liaison`
- `vision-curator`
- `error-concierge`
- `orquesta-admin`

Do not put Japanese text, star marks, emoji, or decorative symbols in agent IDs, JSON keys, file names, or state references. Use ASCII IDs for anything machines read.

Human-visible thread titles may use Japanese and a star mark. The orchestrator thread should be titled `★ Orquesta 統括`.

Existing projects that already use `*-001` foundation IDs may keep them until a deliberate migration task updates dashboard code, state files, reports, and references together.

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
- independently interpret raw vision answers into adopted direction
- silently retry repeated environment failures after a concierge wake trigger
- create production specialists before the foundation setup is complete

## Foundation Sessions

Create or reuse these sessions immediately after the calling chat is recorded as the orchestrator:

- `user-liaison`: user-facing desk and user-side task queue coordinator.
- `vision-curator`: event-driven question curator and answer interpreter.
- `error-concierge`: event-driven failure clustering and user repair-card specialist.
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
- create specialist threads without user approval or current setup policy
- hide options behind long reports

## Bootstrap Flow

When `.orquesta/CURRENT_ORCHESTRA.md` is missing:

1. Create the `.orquesta` state skeleton.
2. Record the calling chat as `orchestrator`.
3. Rename the calling thread to `★ Orquesta 統括` when possible.
4. Pin the calling thread when possible.
5. Add the foundation agents to `agents.json`.
6. Create or reuse the four foundation Codex sessions.
7. Start the dashboard server if possible.
8. Verify the dashboard with `/api/state`, not only HTTP 200.
9. Open the verified dashboard URL in the user's external browser when possible.
10. Give the verified dashboard URL in chat even if browser opening succeeds.
11. Present a short first-run menu.
12. Record selected options, title policy, pin policy, dashboard open status, and bootstrap status in `.orquesta/setup/options.json`.
13. Create or update `.orquesta/setup/wizard.json` so the dashboard can show the user's current setup step.
14. Ask the user to describe the project they want to make, and store the submitted description in `.orquesta/setup/project_intake.json`.
15. Generate required project questions from that description and block production until the required questions are answered. The dashboard setup wizard can trigger this generation and should surface the required questions first.
16. Have `vision-curator` interpret the answers as provisional thinking seeds, not user commands.
17. Convert the interpretation into discussion seeds, strong signals, candidate rules, AI counterproposals, and `do_not_adopt_yet` items.
18. Ask the user to review the important adoption candidates unless the candidate is a low-risk operating rule.
19. Create or revise `.orquesta/project/completion_map.json`: the large pieces required to finish the project. Treat this map as a proposal until the user approves it.
20. Ask for user approval of the Completion Map before creating production specialists. The dashboard setup wizard may record this approval in `.orquesta/setup/wizard.json`, but must reject approval while required setup questions remain unanswered.
21. Only then classify the approved map and propose production roles such as `implementation-001`, `visual-art-001`, `world-lore-001`, `playtest-qa-001`, or project-specific teams.

If the dashboard server cannot start, record a failure incident and ask whether to wake `error-concierge` after it exists.

If setup is interrupted, resume from `.orquesta/setup/options.json` instead of starting over.

## Dashboard Verification

Do not treat an HTTP 200 from `http://127.0.0.1:4177/` as proof that the current project dashboard is running. Another Orquesta project or unrelated process may already own the port.

Verify dashboard ownership by requesting `/api/state` from the candidate port and checking:

- the response parses as JSON
- `source` is `server`
- the returned state includes the current project's `.orquesta` data
- `project_cwd` or equivalent session/project paths match the current project when available
- expected foundation agent IDs are present

If the default port is occupied by another process, record an incident such as `local_server_startup` and start the dashboard on a fallback port. Update `.orquesta/setup/options.json`, `.orquesta/CURRENT_ORCHESTRA.md`, and the final user report with the actual verified dashboard URL.

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

Optional packs:
- Game Production Core
- Vision Alignment
- Failure Concierge
- User Liaison Desk
- Orquesta Admin
- Research Team
- Playtest QA
- Asset Pipeline

Tell me which packs to enable, or say "minimal" to start with only the orchestrator and foundation sessions.
```

## Option Packs

Store available options in `.orquesta/setup/options.json`.

Default packs:

- `minimal_core`: production orchestrator plus foundation sessions.
- `game_production_core`: implementation, visual-art, world-lore, playtest-qa.
- `vision_alignment`: vision-curator, vision questions, answer batches, adopted vision docs.
- `failure_concierge`: failure incident log and repair cards.
- `user_liaison_desk`: user task queue and user-facing ask coordination.
- `orquesta_admin`: setup options, dashboard handoff, and Orquesta tuning.
- `research_team`: future pack for external research and method discovery.
- `asset_pipeline`: future pack for art, sprite, audio, and asset production workflows.

Future Orquesta versions may add packs. Keep packs data-driven and optional.

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
- enabled packs
- available packs
- dashboard URL
- admin session ID
- setup status
- setup notes

`.orquesta/setup/wizard.json` should track:

- setup status
- current setup step
- visible step list
- project intake gate state
- required-question gate state
- Completion Map approval state

`.orquesta/setup/project_intake.json` should track:

- project title
- project description
- submission status
- source
- update time

The source of truth stays file-backed. The first-run chat is not enough.
