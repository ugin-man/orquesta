# Orquesta

Orquesta is a Codex skill for coordinating long-lived specialist Codex threads as a project team.

It is designed for human-in-the-loop game development and other creative software work where one disposable subagent is not enough. The orchestrator keeps state, specialists keep scoped context, and the dashboard shows what the team is doing.

## Beta Status

This repository is beta-quality. The core workflow is usable, but the bootstrap flow should still be tested in a clean project after installing from GitHub.

## What Orquesta Provides

- A long-lived orchestrator thread for routing, state, blockers, approvals, and final reports.
- Foundation roles:
  - `orchestrator`
  - `user-liaison`
  - `vision-curator`
  - `error-concierge`
  - `orquesta-admin`
- Numbered production specialist roles such as `visual-art-001`, `implementation-001`, `world-lore-001`, and `playtest-qa-001`.
- File-backed project state under `.orquesta/` in the target project.
- A local browser dashboard for team visualization, task state, user-side tasks, vision questions, and repair cards.

## Repository Layout

```text
orquesta/
  SKILL.md                     Codex skill entrypoint
  references/                  Operating protocols and state schemas
  assets/dashboard/            Static dashboard app
  dashboard-server.js          Local dashboard API/server
  agents/openai.yaml           Skill metadata
docs/
  design/                      Design notes
  research/                    Multi-agent research notes
package.json                   Dashboard start script
```

Local runtime folders are intentionally not published:

```text
.orquesta/   target-project state and reports
.agents/     local installed skill mirror
.codex/      local Codex metadata
```

## Install From GitHub For Testing

Clone this repository or add it as a source in the project where you want to test Orquesta.

Manual local install:

```powershell
$skillRoot = "$env:USERPROFILE\\.codex\\skills\\orquesta"
New-Item -ItemType Directory -Force -Path $skillRoot
Copy-Item -Recurse -Force .\\orquesta\\* $skillRoot
```

Then start a new Codex thread in your target project and ask Codex to use the `orquesta` skill.

Expected bootstrap behavior:

1. The calling chat becomes the orchestrator.
2. The orchestrator thread is renamed to `★ Orquesta 統括` and pinned when thread tools are available.
3. Orquesta creates or reuses foundation roles.
4. Orquesta initializes file-backed state under `.orquesta/`.
5. Orquesta gives you the dashboard URL.
6. Only after setup does it plan production specialists for the user's actual task.

## Dashboard

From the repository root:

```powershell
npm run dashboard
```

Open:

```text
http://127.0.0.1:4177/
```

The dashboard reads `.orquesta/` state from the current project and refreshes about every five seconds.

## Development Checks

```powershell
node --check orquesta/dashboard-server.js
node --check orquesta/assets/dashboard/app.js
```

## License

No license has been selected yet.
