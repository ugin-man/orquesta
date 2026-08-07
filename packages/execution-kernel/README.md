# @orquesta/execution-kernel

Feature-flagged execution kernel for Orquesta V4 Fast.

This package is connected to Orquesta Desktop only through opt-in Phase C and
shadow paths. The default product route remains unchanged. It provides
deterministic scheduling primitives for:

- dependency-aware eligibility
- bounded concurrency
- duplicate-dispatch prevention
- explicit runtime event transitions
- retry and cancellation
- injected Codex dispatch adapters
- a two-task-limited Codex App Server proof bridge

Enablement is represented by `ORQUESTA_EXECUTION_KERNEL_V2=1`. Orquesta
Desktop Core reads that flag for a deliberately limited two-task Phase C path;
the normal product path remains unchanged while the flag is absent. Broader
product integration belongs to the later shadow-run stage.

`ORQUESTA_EXECUTION_KERNEL_SHADOW_V2=1` keeps the existing Desktop runtime send
as the sole authoritative Codex dispatch. The kernel only calculates its
decision, mirrors the observed real thread and turn identifiers, and records
differences under `.orquesta/state/execution-kernel-shadow-v2.json`. It never
starts an additional Codex turn.

The live bridge creates only real Codex App Server threads and records the
returned thread and turn IDs in kernel state. Run its deliberately gated proof
with:

```powershell
$env:ORQUESTA_EXECUTION_KERNEL_V2='1'
$env:ORQUESTA_EXECUTION_KERNEL_LIVE_PROOF='1'
npm --workspace @orquesta/execution-kernel run proof:app-server
```

The proof is read-only, starts exactly two tiny tasks, and writes its evidence
under `output/execution-kernel/`.

Stage E cutover is deliberately separate from the Desktop composer shadow.
`evaluateExecutionKernelCutover` requires live `orquesta_task_dispatch`
observations covering dependency, capacity, duplicate, recovery, retry, and
unknown-task cases. It also requires quality-matched Plain/kernel measurements.
Desktop-only observations or missing token/time evidence return
`insufficient_evidence`; they never authorize cutover.

Evaluate a prepared evidence file with:

```powershell
npm --workspace @orquesta/execution-kernel run evaluate:cutover -- `
  --input C:\path\to\evidence.json
```

Add `--require-pass` in CI when insufficient evidence should fail the command.
Task text and task-name keywords are not inputs to the evaluator.

The design is informed by the language-neutral
[OpenAI Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md).
See `NOTICE` for attribution.
