---
name: agent-runtime-estimator
description: Estimate bounded AI/Codex agent work in agent execution time and uncertainty instead of human developer hours or business days. Use when asked how long the AI itself will take, when preparing a per-task ETA for Orquesta, or when a workflow needs a machine-readable runtime estimate. Do not use as a human labor estimate or as a whole-project scheduler.
---

# Agent Runtime Estimator

Estimate the work the current AI agent must actually perform. Never start from how long a human developer, analyst, designer, or team would take, and never convert human days using a speed multiplier.

Read `references/estimate-contract.md` before producing a machine-readable estimate. Run `scripts/validate-estimate.js` when the estimate will be consumed by another system or persisted.

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
   - Prefer observed runtime from comparable runs: same model/reasoning setting, repository/task class, and tool environment.
   - With no useful history, use the cold-start normalized-unit prior: one serial work unit = 2 minutes P50 and 4 minutes P80.
   - This is only a bootstrap prior. Keep cold-start confidence at 0.5 or lower.
   - Add known blocking tool/command wait to elapsed time instead of inflating active time.
   - Split heavy reasoning or multi-stage changes into multiple units rather than silently making one unit huge.
   - When observations exist, calibrate with median observed active-minutes-per-critical-unit for P50 and the 80th percentile for P80 from the most comparable profile.

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

## Anti-patterns

- Never say “this is normally a one-week engineering task, therefore the AI needs one week.”
- Never use a universal conversion such as “AI is 20x faster than a human.”
- Never sum every parallel branch to produce elapsed time.
- Never turn unknown approval or queue latency into a made-up number.
- Never use token count alone as runtime.
- Never report high confidence from a cold-start profile.

## Orchestrator boundary

This skill estimates one bounded task or one agent assignment. A project/workflow scheduler should consume per-task estimates, dependency edges, parallelism, resource constraints, and external gates, then calculate the project critical path separately. Summing per-task ETAs is not a valid project schedule.
