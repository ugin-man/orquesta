# GitHub Install Bootstrap Smoke Test

Date: 2026-06-22

## Purpose

Verify that the public GitHub version of Orquesta can be installed as a Codex skill and used to bootstrap a separate project.

## Source

- Repository: `https://github.com/ugin-man/orquesta`
- Skill path: `orquesta/`
- Install target: `$CODEX_HOME/skills/orquesta`

## Result

Status: passed with notes

The GitHub-installed skill was used from a separate mostly empty project. Orquesta created the file-backed project state, appointed the calling chat as the orchestrator, renamed and pinned the orchestrator thread, created the four foundation sessions, wrote readiness reports, and served the dashboard from the target project.

## Observed Bootstrap Output

The target project received:

- `.orquesta/CURRENT_ORCHESTRA.md`
- `.orquesta/state/*.json`
- `.orquesta/setup/options.json`
- `.orquesta/vision/*`
- `.orquesta/failures/*`
- `.orquesta/user_tasks/queue.json`
- `.orquesta/reports/SETUP001-*.md`
- `.agents/skills/orquesta/`
- `.orquesta/dashboard-server.js`
- `.orquesta/assets/dashboard/`

Foundation agents created:

- `orchestrator`
- `user-liaison`
- `vision-curator`
- `error-concierge`
- `orquesta-admin`

## Dashboard Port Behavior

The default dashboard port `4177` was already in use. The bootstrap run recorded this as a failure incident and started the dashboard on fallback port `4178`.

Verified API summary:

- `setupStatus=ready`
- `agentCount=5`
- `taskCount=1`
- `incidentCount=1`

## Notes

- This confirms that the GitHub-distributed skill can be installed and used by Codex in a separate project.
- The current bootstrap path is still mostly protocol-driven: the agent builds state files from the references rather than calling a dedicated bootstrap script.
- A future `orquesta/scripts/bootstrap` helper would make clean-project setup more deterministic and easier to verify.

## Follow-Up Candidates

- Add a first-class bootstrap script that creates `.orquesta` state skeletons.
- Add a deterministic dashboard port selection helper.
- Add a smoke-test checklist to the README.
