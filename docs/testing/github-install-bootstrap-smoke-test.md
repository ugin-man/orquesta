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

## Operational Findings

Formal recorded incidents: 1

Operational issues observed during the smoke test:

1. GitHub skill installation completed without issue.
2. The default dashboard port `4177` was occupied and produced `EADDRINUSE`.
3. A foundation agent initially misread HTTP 200 on `4177` as dashboard success, but that response came from another process. Dashboard verification must check `/api/state` for the current project, not only page availability.
4. `error-concierge` initially reported no failures because it read state before `F001` was recorded. The report had to be refreshed after the incident and repair card existed.
5. `agents.json` and `sessions.json` temporarily disagreed about active, idle, and standby states while foundation threads were still finishing. Final setup corrected all foundation agents to standby.
6. Some report text remained stale after state was corrected. Orquesta should treat JSON state as authoritative and reports as point-in-time snapshots.
7. PowerShell and Node quoting around Japanese text caused command-check friction. Future scripts should avoid embedding non-ASCII literals in shell-generated JavaScript and use UTF-8 or Unicode escapes where needed.
8. A later dashboard visualizer check found that `node --check` alone is not enough for UI changes. A helper-name typo can pass syntax checks but crash the browser render and leave the map showing only the user node.

## Follow-Up Candidates

- Add a first-class bootstrap script that creates `.orquesta` state skeletons.
- Add a deterministic dashboard port selection helper.
- Make dashboard verification check `/api/state` and current project identity.
- Add a report freshness rule: JSON state is current truth; reports are snapshots.
- Run a browser DOM smoke check after dashboard UI changes: verify `[data-agent-id]` nodes render and browser console has no `ReferenceError`, `TypeError`, or `SyntaxError`.
- Add a smoke-test checklist to the README.
