# Agent Runtime Estimator

A standalone Agent Skill for estimating how long an AI agent itself is likely to spend on a bounded task.

It avoids a common failure mode: answering an AI-runtime question with human engineering estimates such as “three business days” or “two weeks.” Instead, the skill decomposes the task into agent-native work units, separates parallel work from the serial critical path, and reports uncertainty as P50/P80 runtime ranges.

## What it reports

- AI active time
- wall-clock elapsed time
- human intervention time when relevant
- critical-path work units versus total work
- external waits that cannot be honestly bounded
- calibration mode and confidence

## Install

Install or upload the entire `agent-runtime-estimator` directory as an Agent Skill in a compatible client. The package follows the Agent Skills structure with `SKILL.md` at its root and supporting files in `references/`, `scripts/`, and `agents/`.

After installation, invoke it explicitly as `$agent-runtime-estimator` or ask for an AI-native runtime estimate. Compatible clients may also select it automatically when the task matches its description.

## Example requests

- “Estimate how long you would actually need to inspect this repository, fix the failing tests, and verify the fix. Use AI runtime, not human developer time.”
- “Compare the expected AI runtime of these two implementation plans.”
- “Give me a machine-readable runtime estimate for this bounded research task.”

## Machine-readable output

See `references/estimate-contract.md`. Validate JSON estimates with:

`node scripts/validate-estimate.js estimate.json`

## Lightweight adaptive calibration

The skill works without history using a deliberately low-confidence cold-start prior. It can optionally improve for each user's actual environment without loading a growing history into the prompt.

Runtime observations are stored outside the skill package in `~/.agent-runtime-estimator/history.jsonl` by default. Set `AGENT_RUNTIME_ESTIMATOR_HOME` to use another directory. A completed run can be recorded with:

`node scripts/calibration-store.js record --model gpt-5.6-sol --reasoning high --task-class coding --execution-mode codex --tool-profile local-tests --units 8 --elapsed 14 --active 11`

Raw history is periodically reduced to a small `calibration.json`:

`node scripts/calibration-store.js compact`

Normal estimation reads only the most relevant compact profile entry, not the raw history. Prompt/token cost therefore stays bounded as observations accumulate.

Profiles keep model, reasoning setting, task class, execution mode, and tool profile separate. Fallback can relax tool profile or execution mode, but it never crosses a known model or reasoning setting merely to increase sample count.

Automatic lifecycle capture is intentionally an adapter concern. A Codex hook or another host may call the same record command when it can reliably observe completion, but the core skill does not depend on hooks and remains portable when they are unavailable.

## Scope

This skill estimates one bounded task or one agent assignment. It is not a human labor estimator and it is not a whole-project scheduler. Project scheduling should be a separate layer that consumes task estimates plus dependencies, concurrency limits, and external gates.

## License

MIT. See `LICENSE`.
