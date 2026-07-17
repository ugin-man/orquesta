# Orquesta V4 Phase 2 review

Phase 2 covers only 2A acquisition and Audition, and 2B Codex-native execution. It does not include a Windows, desktop, web, or other application shell.

## Deterministic result

The deterministic vertical slice passes from TaskIntent through four acquisition connectors, source-bound Audit, an authorized clean Audition, App Server lifecycle events, artifact and report hashes, acceptance, and Event Journal replay.

Expected commands:

```powershell
npm run test:v4:phase2
node scripts/v4/verify-phase2.js
node scripts/v4/verify-phase2.js --scope-base 4ee490b --scope-head HEAD
```

The verifier keeps deterministic and live evidence separate. A missing or invalid `output/v4-phase2-review/review-packet.json` is a failure, not a deterministic pass relabeled as live proof.

## Live result on 2026-07-17

The live source stage reached the current first-party OpenAI documentation and the npm registry. It selected the existing `@openai/codex-sdk` candidate, installed nothing, and passed read-only Audition preflight.

A direct SDK diagnostic turn completed and returned `ORQUESTA_PHASE2_LIVE_OK` with a real started, progress, artifact, and completed sequence. In the two final bounded attempts, the full acquisition-to-Audition path did not complete its runtime step within the fallback window. App Server did not complete in its primary window, and the SDK fallback then timed out inside the integrated path.

Therefore live Phase 2 status is currently `not_ready`. No ready review packet is written. The deterministic implementation is testable, but it must not be described as a completed end-to-end live acceptance until the integrated runtime path produces the correlated packet.

Generated failed-run journals under `output/v4-phase2-review/` are diagnostic output and are not release artifacts.

## Runtime boundaries

- Codex provides the runtime sandbox and approval boundary. Orquesta checks the requested profile but does not add another sandbox.
- Audition authorization does not authorize installation.
- App Server is primary, SDK is fallback, and repository-only cannot satisfy the live-turn check.
- Dispatch acceptance, turn start, progress, completion, artifact, report, and acceptance remain separate evidence.
- `actual_model` stays null without independent model-observation evidence.
