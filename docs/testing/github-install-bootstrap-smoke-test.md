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
9. A later Vision Questions check found repeated literal question-mark replacement in `.orquesta/vision/questions.json` after non-ASCII state was written through an unsafe command path. This must be caught by `npm run check:encoding` and treated as a bootstrap failure for non-English users.

## Follow-Up Candidates

- Add a first-class bootstrap script that creates `.orquesta` state skeletons.
- Keep the deterministic dashboard port selection helper covered by `npm run test:ports`.
- Make dashboard verification check `/api/state` and current project identity.
- Add a report freshness rule: JSON state is current truth; reports are snapshots.
- Run a browser DOM smoke check after dashboard UI changes: verify `[data-agent-id]` nodes render and browser console has no `ReferenceError`, `TypeError`, or `SyntaxError`.
- Add a smoke-test checklist to the README.
- Keep `npm run check:encoding` in bootstrap/release checks so non-English users do not discover state encoding corruption manually in the dashboard.

## User-Run Retest Checklist

Status: ready for user execution

This retest must be done from a separate project or chat. The current Orquesta development checkout cannot fully prove the first-run experience because it already contains Orquesta state, dashboard files, specialists, and history.

### Setup

1. Open or create a small disposable project folder that is not `C:\Users\kouki\OneDrive\ドキュメント\Orquesta`.
2. Start a fresh Codex chat in that folder.
3. Confirm the Orquesta skill is installed at `C:\Users\kouki\.codex\skills\orquesta\SKILL.md`.
4. Ask Codex to initialize Orquesta in that disposable project.

Suggested prompt:

```text
orquesta スキルでこのテスト用プロジェクトを初期セットアップして。
GitHubインストール版のクリーンスモークテストなので、ダッシュボードURL、/api/state の確認結果、作成された基礎AI、文字化けの有無を最後に報告して。
```

### Required Success Checks

- `.orquesta/CURRENT_ORCHESTRA.md` exists in the disposable project.
- `.orquesta/state/agents.json`, `sessions.json`, `tasks.json`, `directives.json`, and `events.jsonl` exist and parse.
- `.orquesta/setup/options.json`, `wizard.json`, and `project_intake.json` exist or the setup report explains why a later step creates them.
- `.orquesta/vision/questions.json` exists and does not contain repeated literal question marks in Japanese question text.
- `.orquesta/failures/incidents.json` exists. If port `4177` is occupied but Orquesta cleanly chooses another free port, the selected port should be recorded in `.orquesta/setup/options.json`; an incident is only required when startup still blocks or asks the user for repair.
- The dashboard URL opens in an external browser.
- `GET /api/state` returns state from the disposable project, not from this Orquesta development checkout or another project.
- The Team Visualizer shows more than only the user node after the first live state load.
- The dashboard does not pass only because `http://127.0.0.1:4177/` returns HTTP 200. The check must confirm `/api/state` and the project path.
- If the dashboard runs on a fallback port, the final setup report and `.orquesta/setup/options.json` must agree on that same URL.
- The dashboard has Operations and User Tasks views. Setup appears as a compact card at the top of Operations, not as a separate required tab.
- Before project intake is submitted, Vision Questions must not show generic setup questions as if they were project-specific.
- After project intake, required setup questions can be generated from that project description.
- After required setup questions are answered, setup autopilot can prepare the initial Completion Map and initial specialist team without separate Completion Map, specialist-by-specialist, or first-task approval prompts.

### Result To Report Back

Please report:

- disposable project path
- dashboard URL
- `/api/state` project path or loaded-files summary
- foundation agents shown
- whether Japanese text rendered correctly
- any incidents recorded
- whether Team Visualizer showed the expected agents
- anything confusing in the first-run explanation

After the result comes back, the orchestrator should write `.orquesta/reports/T066-user-run-bootstrap-smoke-result.md`, update `T066`, and then decide whether `CM005.3` and `CM005.4` can move to `done`.

## 2026-06-23 User Retest Result

Status: failed, repaired locally, public reinstall still pending

The user ran the clean test in `C:\Users\kouki\OneDrive\ドキュメント\New project`. The setup created the foundation agents and found a verified project-owned dashboard on `http://127.0.0.1:4179/`, but the visible dashboard was stale:

- Team Visualizer showed only the user node.
- Setup tab was missing.
- Completion Map was missing.
- User Tasks showed a stale English sample question even though the project had zero state-backed questions.

Root cause:

- The installed skill at `C:\Users\kouki\.codex\skills\orquesta` had stale dashboard assets compared with the current Orquesta source checkout.
- The clean project copied those stale assets, so `/api/state` was correct but the rendered dashboard shell was old.

Local repair:

- Synced current dashboard assets, dashboard server, references, skill file, and encoding checker into the installed skill.
- Synced the same repaired dashboard bundle into `New project`.
- Restarted the verified dashboard on `4179`.

Post-repair checks at that time:

- `/api/state` returns `source=server`, five agents, five sessions, `New project` cwd, zero encoding warnings, and zero vision questions.
- HTML now includes Operations, Setup, and User Tasks tabs.
- HTML now includes Completion Map and Setup Wizard containers.
- Browser DOM check through Chrome rendered five `[data-agent-id]` nodes.
- The stale English sample question was not present.
- Browser console and page errors were empty.

Remaining gate:

- Commit and push the repaired Orquesta skill bundle to GitHub.
- Reinstall from `https://github.com/ugin-man/orquesta/tree/main/orquesta`.
- Rerun this smoke test from another clean project before marking the public GitHub install path fully passed.
