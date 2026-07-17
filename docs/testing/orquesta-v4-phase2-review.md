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

A direct SDK diagnostic turn first proved the fallback independently. Earlier integrated attempts then exposed three integration defects: the dedicated Audition root was intentionally outside Git without the matching SDK option, SDK completion was emitted before its event stream closed, and the thread ID observed after dispatch was not retained in the journal input. Each defect received a focused RED test before correction.

After those corrections, the complete live acquisition-to-Audition path passed. App Server reported unavailable and the bounded TypeScript SDK fallback completed a real turn. The resulting runtime timeline contains dispatch accepted, thread started, turn started, artifact produced, progress observed, and turn completed. Audition cleanup is clean, no candidate was installed, the journal contains seven correlated evidence records, replay is equivalent, and every live review check is true.

Live Phase 2 status is `ready_for_user_review`. The packet is `output/v4-phase2-review/review-packet.json` with SHA-256 identity `fa4514204150842478ed0d1a8c47b9c6829042fe39fc35bab45b0bbc3a20fe53`. `actual_model` remains null because the SDK supplied no independent model-observation evidence.

Generated failed-run journals under `output/v4-phase2-review/` are diagnostic output and are not release artifacts.

## Runtime boundaries

- Codex provides the runtime sandbox and approval boundary. Orquesta checks the requested profile but does not add another sandbox.
- Audition authorization does not authorize installation.
- App Server is primary, SDK is fallback, and repository-only cannot satisfy the live-turn check.
- Dispatch acceptance, turn start, progress, completion, artifact, report, and acceptance remain separate evidence.
- `actual_model` stays null without independent model-observation evidence.
