# Repository integration

The desktop app now reads an Orquesta project directly instead of using renderer fixtures. The project picker stores only the recent-project registry in Electron's `userData` directory. It does not write to the selected project.

## Source files

The reader requires these files:

- `.orquesta/state/agents.json`
- `.orquesta/state/tasks.json`

It also reads these files when they exist:

- `.orquesta/state/sessions.json`
- `.orquesta/state/events.jsonl`
- `.orquesta/vision/questions.json`
- `.orquesta/failures/incidents.json`

Every JSON file is capped at 16 MB. Resolved paths must stay inside the selected project, including when a path contains a symlink.

## Evidence rules

An `active` agent is not shown as Working on that label alone. Working requires a non-terminal task, confirmed turn-start evidence, and a session or heartbeat no older than ten minutes. An `in_progress` task label does not count as turn-start or progress evidence by itself.

Requested model and actual model stay separate. The UI keeps `actualModel` unknown unless a separate actual-model evidence field is present.

Open questions and incidents can appear in Attention. An incident becomes a repair item only when its canonical record explicitly sets `user_action_required` to true.

## Refresh and failure behavior

Electron watches the state, vision, and failures directories with a short debounce. A valid update replaces the snapshot. A malformed update keeps the last valid snapshot visible, marks it offline, and clears proven working status until a valid read succeeds.

The first launch shows one Desktop setup intake for source selection, project details, Codex account state, and explicit Start approval. The selected project stays read only until Start. Later launches restore the last readable project, and the project switcher can open another folder or return to any of the 24 most recent projects.

## Verification

The unit suite checks projection, stale evidence, unsupported model claims, bounded reads, source-byte preservation, registry persistence, watcher refresh, IPC validation, and preload filtering.

The Electron integration test opens a temporary real `.orquesta` project, observes a canonical agent-file change from two agents to three, and confirms the task file bytes remain unchanged.

`tests/electron/initial-setup.spec.ts` uses a clean Desktop `userData` directory and an empty detected project. It confirms that the intake is visible, no setup state exists before Start, and Start creates canonical Phase 1 with `orchestrator`, `user-support`, and `orquesta-admin`. It then restarts Electron and confirms that the same `setup_id` resumes. The account response in this test comes from the fake App Server fixture; it does not prove a real ChatGPT account session.
