# @orquesta/execution-kernel

Feature-flagged deterministic execution kernel for Orquesta V5.

This package is connected to Orquesta Desktop through one explicit opt-in
execution path. The default product route remains unchanged. It provides
deterministic scheduling primitives for:

- dependency-aware eligibility
- bounded concurrency
- duplicate-dispatch prevention
- explicit runtime event transitions
- retry and cancellation
- injected Codex dispatch adapters
- a two-task-limited Codex App Server proof bridge

Enablement is represented by `ORQUESTA_EXECUTION_KERNEL_V2=1`. Orquesta
Desktop Core reads that flag for the current bounded kernel path; the normal
product path remains unchanged while the flag is absent. The retired shadow
writer is not part of the V5 product.

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
