from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(relative: str, old: str, new: str) -> None:
    target = ROOT / relative
    source = target.read_text(encoding="utf-8")
    if new in source:
        return
    if old not in source:
        raise RuntimeError(f"Patch anchor missing in {relative}: {old[:100]!r}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8", newline="\n")


replace_once(
    "orquesta/scripts/setup-phase-handlers.js",
    "  const { task_profile: taskProfile, execution_plan: executionPlan } = createProfiledExecutionPlan({",
    "  const {\n    task_profile: taskProfile,\n    execution_plan: executionPlan,\n    runtime_estimate: runtimeEstimate,\n  } = createProfiledExecutionPlan({",
)
replace_once(
    "orquesta/scripts/setup-phase-handlers.js",
    "  return { taskIntent, taskProfile, executionPlan, modelRoute, canonicalStateRoot: path.resolve(rootPath) };",
    "  return {\n    taskIntent,\n    taskProfile,\n    executionPlan,\n    runtimeEstimate,\n    modelRoute,\n    canonicalStateRoot: path.resolve(rootPath),\n  };",
)
replace_once(
    "orquesta/scripts/setup-phase-handlers.js",
    "      model_route: existing.model_route || execution.modelRoute,",
    "      runtime_estimate: existing.runtime_estimate || execution.runtimeEstimate,\n      runtime_estimate_updated_at: existing.runtime_estimate_updated_at || now,\n      model_route: existing.model_route || execution.modelRoute,",
)
replace_once(
    "orquesta/scripts/setup-phase-handlers.test.js",
    "  assert.ok(tasks.tasks.every((task) => task.task_profile?.risk_profile));",
    "  assert.ok(tasks.tasks.every((task) => task.task_profile?.risk_profile));\n  assert.ok(tasks.tasks.every((task) => /^RE-[a-f0-9]{12}$/u.test(task.runtime_estimate?.runtime_estimate_id)));\n  assert.ok(tasks.tasks.every((task) => task.runtime_estimate?.task_intent_id === task.task_intent?.task_intent_id));\n  assert.ok(tasks.tasks.every((task) => task.runtime_estimate?.source === \"profile_inferred\"));\n  assert.ok(tasks.tasks.every((task) => task.runtime_estimate?.calibration?.mode === \"cold_start\"));\n  assert.ok(tasks.tasks.every((task) => task.runtime_estimate?.confidence <= 0.5));\n  assert.ok(tasks.tasks.every((task) => task.runtime_estimate?.runtime?.agent_active_minutes?.p50 > 0));\n  assert.ok(tasks.tasks.every((task) => task.runtime_estimate_updated_at === NOW));",
)

print("runtime estimate setup persistence patch applied")
