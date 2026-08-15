# Agent Runtime Estimator

A standalone Agent Skill for estimating how long an AI agent itself is likely to spend on a bounded task.

It is designed to avoid a common failure mode: answering an AI-runtime question with human engineering estimates such as “three business days” or “two weeks.” Instead, the skill decomposes the task into agent-native work units, separates parallel work from the serial critical path, and reports uncertainty as P50/P80 runtime ranges.

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

## Calibration

The default cold-start prior is intentionally low-confidence. When comparable completed-run data is available, replace it with observed active-minutes-per-critical-unit statistics for the same model/reasoning/task/tool profile.

## Scope

This skill estimates one bounded task or one agent assignment. It is not a human labor estimator and it is not a whole-project scheduler. Project scheduling should be a separate layer that consumes task estimates plus dependencies, concurrency limits, and external gates.

## License

MIT. See `LICENSE`.
