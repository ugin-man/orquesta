---
name: agent-runtime-estimator
description: Estimate bounded AI or Codex agent work in agent execution time and uncertainty instead of human developer hours or business days. Use when asked how long the AI itself will take, when comparing the runtime of alternative AI task plans, or when another workflow needs a machine-readable per-task runtime estimate. Do not use as a human labor estimate or as a whole-project scheduler.
---

# Agent Runtime Estimator

Estimate the work the current AI agent must actually perform. Never start from how long a human developer, analyst, designer, or team would take, and never convert human days using a speed multiplier.

Read `references/estimate-contract.md` before producing a machine-readable estimate. Run `scripts/validate-estimate.js` when the estimate will be consumed by another system or persisted.

## Inputs

Use the task as stated. When available, also use evidence about the execution environment: model or reasoning mode, repository or artifact size, relevant tools, test/build latency, likely external waits, and comparable prior runs.

Do not ask for information that is not needed to make a useful estimate. Missing calibration data is normal; represent it as lower confidence instead of blocking the estimate.

## Lightweight calibration

Calibration must stay cheap at estimate time.

- Never load raw runtime history into the model context for a normal estimate.
- If `~/.agent-runtime-estimator/calibration.json` exists, read only the single most relevant compact profile entry. The location may be overridden with `AGENT_RUNTIME_ESTIMATOR_HOME`.
- Match profiles by model, reasoning setting, task class, execution mode, and tool profile. Never pool a different known model or reasoning setting merely to increase sample count.
- Prefer the most specific compatible profile with useful samples. If none exists, use the cold-start prior.
- Raw observations belong in `history.jsonl` and are consumed only by `scripts/calibration-store.js compact`; they are not prompt context.
- Recording and compaction are optional. The skill must remain useful when the host cannot observe completion automatically.

A host, hook, or user may record a completed run with `scripts/calibration-store.js record`, then compact history with `scripts/calibration-store.js compact`. Hook integration is deliberately outside the core skill so a missing or broken lifecycle hook cannot break estimation.

## Procedure

1. Bound the task.
   - State the concrete done condition and execution environment.
   - Estimate only work required by the current task.
   - Do not add meetings, ticket handling, business-day padding, or hypothetical future scope.
   - Unknown approval, reply, queue, rate-limit, or other asynchronous latency is an external gate. Do not invent a completion time across it.

2. Decompose into agent work units.
   - One work unit is one coherent reasoning/action/verification slice that can be completed without redefining the task.
   - Kinds: `inspect`, `research`, `change`, `execute`, `verify`, `repair_cycle`, `review`.
   - Count ordinary-case and plausible-high-case units.
   - Separate parallel branches from the serial critical path. Parallel work affects total work but must not be summed linearly into elapsed time.

3. Estimate from the agent environment.
   - Prefer a compact calibrated profile from comparable runs when available.
   - With no useful calibration, use the cold-start normalized-unit prior: one serial work unit = 2 minutes P50 and 4 minutes P80.
   - This is only a bootstrap prior. Keep cold-start confidence at 0.5 or lower.
   - Add known blocking tool/command wait to elapsed time instead of inflating active time.
   - Split heavy reasoning or multi-stage changes into multiple units rather than silently making one unit huge.
   - When a selected profile has observed active-time statistics, use its P50/P80 active-minutes-per-critical-unit. Otherwise keep active-time calibration conservative and use elapsed calibration only for elapsed estimates.

4. Produce separate clocks.
   - `agent_active_minutes`: reasoning, tool calls, edits, inspection, and verification performed by the agent.
   - `elapsed_minutes`: wall-clock until the estimated done signal, including known blocking waits. It must be at least active time.
   - `human_intervention_minutes`: human labor required during the task, if any.
   - Unknown asynchronous waits go in `external_gates`, never in a fabricated elapsed estimate.

5. Express uncertainty.
   - Return P50 and P80, not one exact number.
   - P50 is the ordinary case.
   - P80 is the planning case with plausible rework and latency variance; it is not a worst-case promise.
   - Confidence measures the estimate model, not task-success probability.
   - Name the factors most likely to move the estimate.

6. Keep it revisable.
   - Re-estimate when discovery changes scope, tests reveal a new failure class, the environment changes, or an external gate clears with new information.
   - Do not revise merely because time has passed.
   - Preserve predicted and actual runtimes when actual data becomes available so future estimates can be calibrated.

## Default response

For ordinary conversational use, keep the result compact and include:

- `AI active`: P50 and P80.
- `Elapsed`: P50 and P80, or explicitly say that completion time is unbounded by a named external gate.
- `Human intervention`: P50 and P80 when non-zero or operationally relevant.
- `Basis`: critical-path work units and whether calibration is cold-start, hybrid, or historical.
- `Confidence`: a value from 0 to 1 plus the main uncertainty drivers.

Example shape:

`AI active: 18–34 min (P50/P80) | Elapsed: 22–46 min | Human: 0–5 min | Basis: 9/11 critical-path units, cold start | Confidence: 0.4`

When another system needs structured output, use the JSON contract in `references/estimate-contract.md` instead of inventing a new schema.

## Anti-patterns

- Never say “this is normally a one-week engineering task, therefore the AI needs one week.”
- Never use a universal conversion such as “AI is 20x faster than a human.”
- Never sum every parallel branch to produce elapsed time.
- Never turn unknown approval or queue latency into a made-up number.
- Never use token count alone as runtime.
- Never load the full raw calibration history into normal estimate context.
- Never report high confidence from a cold-start profile.

## Project-scheduling boundary

This skill estimates one bounded task or one agent assignment. A separate project/workflow scheduler may consume per-task estimates, dependency edges, parallelism, resource constraints, and external gates and then calculate the project critical path. Summing per-task ETAs is not a valid project schedule.
