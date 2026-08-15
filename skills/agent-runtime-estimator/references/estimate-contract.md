# Estimate Contract

Produce a JSON object with this shape when another system will consume the estimate:

```json
{
  "version": 1,
  "scope": {
    "task": "bounded task description",
    "done_signal": "observable completion condition",
    "environment": "model/reasoning/repository/tool profile"
  },
  "work": {
    "critical_path_units_p50": 0,
    "critical_path_units_p80": 0,
    "total_units_p50": 0,
    "total_units_p80": 0,
    "parallel_branches": 1,
    "unit_breakdown": [
      { "kind": "inspect", "p50": 0, "p80": 0, "note": "" }
    ]
  },
  "runtime": {
    "agent_active_minutes": { "p50": 0, "p80": 0 },
    "elapsed_minutes": { "p50": 0, "p80": 0 },
    "human_intervention_minutes": { "p50": 0, "p80": 0 }
  },
  "calibration": {
    "mode": "cold_start",
    "profile_key": "",
    "sample_count": 0,
    "active_minutes_per_critical_unit": { "p50": 2, "p80": 4 }
  },
  "external_gates": [],
  "uncertainty_drivers": [],
  "confidence": 0.4
}
```

## Invariants

- All minute and unit values are finite non-negative numbers.
- For every range, P80 must be greater than or equal to P50.
- `total_units_*` must be greater than or equal to `critical_path_units_*`.
- `elapsed_minutes` must be greater than or equal to `agent_active_minutes` for the same percentile.
- `parallel_branches` is an integer greater than or equal to 1.
- `confidence` is between 0 and 1 inclusive.
- `calibration.mode` is `cold_start`, `historical`, or `hybrid`.
- A cold-start estimate should not claim confidence above 0.5.
- Unknown external gate latency is represented by a gate object rather than added to elapsed minutes.

## External gate object

```json
{
  "name": "human approval",
  "status": "unknown_wait",
  "blocks_done_signal": true,
  "known_wait_minutes": null
}
```

`known_wait_minutes` may be a non-negative number only when the wait is actually known or bounded by the execution environment. Otherwise use `null`.

## Calibration observation

A completed run may be recorded outside the skill package with these fields:

```json
{
  "model": "gpt-x",
  "reasoning": "high",
  "task_class": "coding",
  "execution_mode": "codex",
  "tool_profile": "local-tests",
  "critical_path_units": 7,
  "actual_agent_active_minutes": 11.5,
  "actual_elapsed_minutes": 16.2
}
```

The useful ratios are actual minutes divided by critical-path units. Keep profiles comparable; do not pool a different known model or reasoning setting merely to increase sample count.

Raw observations are storage data, not prompt context. `scripts/calibration-store.js compact` reduces them to a small `calibration.json` containing only P50/P80 per-unit statistics and sample counts for each profile. Normal estimation should read at most the selected compact profile entry.

Active time is optional because some hosts can reliably observe only wall-clock elapsed time. Missing active-time observations must not prevent elapsed-time calibration.

## Project scheduling boundary

This contract intentionally does not contain a whole-project finish date. A scheduler must combine task estimates with dependency edges, concurrency/resource limits, and external gates and then compute a critical path. Summing task elapsed times is wrong when tasks can overlap.
