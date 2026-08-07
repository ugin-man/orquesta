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

Human-visible thread titles may use Japanese and a star mark. Use these canonical titles:

- `orchestrator`: `★ Orquesta 統括者`
- `orquesta-admin`: `Orquesta 管理係 Luca`
- `user-support`: `Orquesta 利用者支援係`
- first production specialist: `Orquesta <日本語の役割名>`
- second and later seats in the same role: `Orquesta <日本語の役割名> 2`, `Orquesta <日本語の役割名> 3`

Do not expose provisioning XML, warning IDs, or machine IDs such as `implementation-001` as Codex task titles.

Existing `user-liaison`, `vision-curator`, and `error-concierge` records are preserved as `superseded` history and point to `user-support`. New projects never generate those three legacy seats.

## First Invocation

The calling chat becomes the orchestrator foundation agent.

Rename the calling Codex thread to `★ Orquesta 統括者` and pin it when thread tools are available. If the title or pin cannot be changed, still record the calling thread as the orchestrator in state and report the skipped UI action.

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
- `orquesta-admin`: Orquesta setup, Desktop handoff, diagnostic dashboard, option packs, and configuration.

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
- Orquesta Desktop launch for the selected project root
- diagnostic dashboard startup and URL reporting when intentionally requested
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
3. Rename the calling thread to `★ Orquesta 統括者` when possible.
4. Pin the calling thread when possible.
5. Add exactly `orchestrator`, `user-support`, and `orquesta-admin` to the foundation in `agents.json`.
6. Create or reuse the three foundation Codex sessions.
7. Launch Orquesta Desktop with `node "<orquesta-skill-root>\scripts\desktop-launch.js" --project-root "<project-root>"`, where `<orquesta-skill-root>` is the absolute directory containing the active `SKILL.md`; this passes `--orquesta-project <project-root>` to the Desktop executable.
8. Verify that the Desktop process accepted the selected project root. If the Desktop executable cannot be found or launched, stop with an installation blocker instead of opening a browser.
9. Start and verify the web dashboard only when a diagnostic browser surface is intentionally needed. Verify it with `/api/state`, not only HTTP 200.
10. Report the verified dashboard URL in chat when the diagnostic server is running. Do not auto-open it through the operating system's default browser.
11. Ask for the project folder, project name, and project description. Prefill what can be inferred from the selected repository. Ask zero to three optional clarification questions only when evidence is insufficient; skipping them must not block setup.
12. Atomically create the six-phase `.orquesta/setup/setup_state.json`, store the intake in `.orquesta/setup/project_intake.json`, and build a bounded Project Understanding Packet.
13. During project understanding, infer an initial project archetype from manifests, directories, and file kinds. The project description is supporting evidence, not the only classifier.
14. Save `.orquesta/project/layout.json`, `lifecycle.json`, and `structure-setup.json`, including the structure template version and setup answers. Generate `.orquesta/context/initial-context-view.json` before production routing.
15. For a new project, create only one entry document and the one primary directory needed by the inferred first component. For an existing project, use shadow mode: do not move, rename, or rewrite project files.
16. Create the initial Completion Map and first executable work.
17. Run the normal organization preflight against that work. Create no fixed roster and no minimum number of specialists.
18. Create the initial roles, lines, teams, memberships, agents, and task ownership in one organization revision.
19. Prepare a provisioning batch capped at three concurrent requests. Each specialist must own at least one executable task.
20. Follow the runtime binding for each accepted specialist. In `codex_hosted`, create the task with the callable Codex thread tool in the selected project, record its thread ID, then let Desktop send the bounded handoff. In `standalone`, Desktop may create the thread through its owned App Server. If the required Codex thread tool is unavailable in `codex_hosted`, stop with a visible provisioning blocker instead of falling back.
21. Mark a specialist operational only after thread and turn evidence exists. Keep failures on the same agent ID as `provisioning_failed` for retry.
22. Report why each initial role and line exists and move to the Home screen after one integrated setup check.

If the diagnostic dashboard server cannot start, record a failure incident only when that diagnostic surface was required. A dashboard failure does not replace or invalidate a working Desktop session.

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

## Desktop Handoff And Browser Isolation

Orquesta Desktop is the primary surface. Resolve the absolute directory containing the active `SKILL.md` and use it as `<orquesta-skill-root>`:

```powershell
node "<orquesta-skill-root>\scripts\desktop-launch.js" --project-root "<project-root>"
```

Do not prepend another `orquesta` directory when `<orquesta-skill-root>` already ends in `orquesta`. The launcher must resolve the Orquesta Desktop executable and pass `--orquesta-project <project-root>`. Never replace this with `Start-Process <url>` or another default-browser command.

The web dashboard is a diagnostic fallback, not the Orquesta Desktop application. When the user explicitly asks to open that diagnostic surface:

- verify the dashboard URL belongs to the current project through `/api/state`
- use the available browser-control skill and let that skill choose or reuse its supported browser and tab binding
- first apply the current TaskIntent, project policy, `forbidden_actions`, live stop state, and manual-only constraints; pass browser-family and tab-count/reuse limits to the skill, and let the more restrictive authority win
- preserve the skill's ownership checks; do not claim or change an unrelated generic tab
- do not hardcode a browser executable or hand the URL to the operating system's default browser
- stop when the browser-control skill cannot establish an unambiguous binding

Do not auto-open browser tabs during setup or resume.

## Setup Evidence And User Confirmation

Desktop process evidence, the selected `--orquesta-project` root, setup state, foundation thread IDs, and rendered Desktop state are the deterministic setup checks. A user's visual confirmation may be retained as optional UAT evidence, but it is not a generic setup blocker. Do not invent a missing "final-use confirmation" requirement when the acceptance contract does not explicitly call for user UAT.

## Non-English State Safety

Orquesta must support projects whose visible names, questions, reports, and dashboard text are not English.

When setup or a specialist writes user-visible non-ASCII text into `.orquesta` state:

- Do not write Japanese or other non-ASCII JSON through shell snippets unless the command path has been proven UTF-8 safe.
- Prefer `apply_patch`, a UTF-8-aware script file, or Unicode-escaped JavaScript literals for generated state.
- After writing state, run `npm run check:encoding` from the Orquesta repository root when available.
- Treat repeated literal question marks in user-visible state, Unicode replacement characters, and strong mojibake signatures as setup failures.
- Damage examples quoted as inline code in Markdown or hash-protected handoff conversation provenance are allowed. Never rewrite a handoff manifest merely to satisfy the validator.
- If the dashboard displays garbled questions or names, inspect the source JSON first. Do not start by changing the dashboard renderer.

The dashboard server also reports encoding warnings in `/api/state` under `health.encodingWarnings`.

## First-Run Menu

Keep the first message short. Use this shape:

```md
Orquesta is ready to set up this project.

This chat is now the production orchestrator: `★ Orquesta 統括者`.

Desktop:
Orquesta Desktop opened for the selected project.

Diagnostic dashboard:
http://127.0.0.1:4177/ (only when running)

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
- Talk to `★ Orquesta 統括者` to plan and route production work.

## Setup State

`.orquesta/setup/options.json` should track:

- bootstrap status
- orchestrator thread ID
- orchestrator title policy
- orchestrator pin policy
- foundation agent IDs
- foundation readiness or blockers
- legacy pack metadata when present
- Desktop executable and selected project root
- diagnostic dashboard URL when running
- admin session ID
- setup status
- setup notes

`.orquesta/setup/setup_state.json` should track the real six phases: environment, project understanding, foundation, planning, specialists, and operation. `.orquesta/setup/wizard.json` remains a compatibility projection for older clients and should not be treated as the canonical setup engine.

The operation phase also installs a project-local `PostCompact` hook at `.orquesta/runtime/session-rotation-hook.cjs` and merges its command into `.codex/hooks.json` without removing existing hooks. Codex requires a trust review for project hooks. Report that one-time review honestly; do not bypass it. The hook only counts compactions and persists session-health state. Ownership cutover still requires a verified successor receipt.

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

`.orquesta/project/structure-setup.json` should track:

- project structure template version
- inferred archetype and its evidence scores
- setup answers used to initialize the structure
- whether setup used `new_minimal` or `existing_shadow`
- generated or preserved manifest status
- exact created directories and files
- an always-empty `moved_paths` list during initial setup

The initial Context View is a compact projection, not a copied specialist knowledge tree. Add later components by extending the Layout Manifest; do not rebuild or replace the existing project structure.

Initial setup never performs a physical migration of an existing project. When cleanup becomes useful, generate `.orquesta/project/migration-plan.json` as a dry-run. The plan binds every move to the current workspace fingerprint and source hash, lists path-reference rewrites, and includes reverse moves for rollback. Identical content is only a review hint; it is not enough to retire either file. Reject project escapes, symlink candidates, target collisions, and plans without complete rollback evidence.

Apply no move, rewrite, manifest update, quarantine, or deletion until the user approves the entire Migration Plan. A deletion requires a separate destructive confirmation. This planning and approval boundary must work without Orquesta Desktop running.

The source of truth stays file-backed. The first-run chat is not enough.
