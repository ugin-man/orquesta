# OpenAI Build Week Submission Notes

## What existed before the submission period

Orquesta already existed as a Codex skill and browser-based local dashboard. It had persistent specialist roles, file-backed `.orquesta` state, delegation evidence, user questions, failure intake, and early V4 capability-resolution work.

Its main purpose was already long-horizon work: specialists generate questions while developing, and the user's answers are curated into durable vision and decisions. That gives a project a way to accumulate human metacognition and tacit knowledge over one, two, or three months instead of depending on one chat window remembering everything.

The earlier system was useful, but it was difficult for a user to understand at a glance. Its browser dashboard exposed too much information at once, the Windows product did not yet exist as the main experience, and several setup and organization decisions still required manual coordination.

## What changed during Build Week

Work after the submission period began on July 13, 2026 meaningfully extended Orquesta into a Windows desktop product and completed the V4 submission scope.

The new work includes:

- A packaged Windows desktop shell built with Electron, React, TypeScript, and Vite.
- A local organization map that keeps idle and working specialists visible and supports pan, zoom, selection, and team-aware layout.
- A focused Home screen, user-task queue, task/error/conversation history, settings, and project switching.
- A one-screen project intake followed by a resumable six-phase setup engine and animated setup presentation.
- A Home tutorial that introduces the interface without taking the user to a separate manual.
- Luca, a persistent read-only project explainer that answers questions from bounded saved project records.
- Temporary read-only External Comparison and Adversarial Audit agents that can be started and stopped by the user.
- An adaptive organization decision engine for reusing or adding specialists, splitting work, assigning leadership, and proposing new production lines; a new line requires user approval.
- Codex adapters that pass the orchestrator-selected model at specialist dispatch, with bounded escalation and separate recommended, requested, applied, and observed model evidence.
- A packaged Codex runtime using pinned App Server and SDK packages, integrity checks, approval relay, and truthful fallback behavior.
- Separate evidence for dispatch, turn start, progress, artifacts, reports, and acceptance.

The dated Git history is the primary change record. The main Build Week integration ends at commit `17de0d6` and includes the six-phase setup merge `0736d8a`.

## Why Codex and GPT-5.6 mattered

Codex was both the development environment and the runtime workforce for Orquesta.

During development, GPT-5.6 Codex threads were divided into persistent roles for architecture, implementation, review, user support, and orchestration. The user repeatedly reviewed the real desktop application and corrected decisions that passed automated checks but failed human usability judgment. Those corrections directly changed the Home information architecture, organization map, record views, setup flow, and review cost policy.

The same principle applies to model cost. Earlier Codex workflows could accidentally multiply an expensive high-reasoning model across every helper. Orquesta's policy recommends a route from task signals, then lets the orchestrator accept or override it when dispatching a specialist. During Build Week, the runtime path was extended so that selected model can be passed to Codex App Server while recommended, requested, applied, and observed evidence remain separate. This supports cheaper models for bounded work and escalation for difficult work without claiming an optimization that was never actually applied.

Inside the product, Orquesta starts the packaged Codex App Server only when work is requested. It uses the user's normal Codex session and does not require a separate OpenAI API key. A TypeScript SDK adapter provides a bounded fallback. Repository-only mode may prepare a handoff, but it cannot claim that a live Codex turn ran.

## How to test

### Recommended path

1. Download the Windows x64 installer from the latest GitHub release.
2. Install and open Orquesta.
3. Choose an existing local project or create a new project folder.
4. Complete the one-screen intake.
5. Start setup and watch the six persisted phases complete.
6. On Home, inspect the organization map, User Tasks, Records, and Settings.
7. Send a harmless message to the orchestrator through the Composer.

The installer is not code-signed, so Windows may show an unknown-publisher warning.

### Run from source

Requirements:

- Windows x64
- Node.js 22.12.0 or newer
- An installed and signed-in Codex Desktop environment

```powershell
git clone https://github.com/ugin-man/orquesta.git
cd orquesta
npm install
npm install --prefix apps/orquesta-desktop
npm run start:desktop --prefix apps/orquesta-desktop
```

## Verification evidence

The repository keeps different proof classes separate:

- [V4 Phase 1 review](docs/testing/orquesta-v4-phase1-review.md)
- [V4 Phase 2 review](docs/testing/orquesta-v4-phase2-review.md)
- [Desktop validation guide](apps/orquesta-desktop/VALIDATION.md)
- [Packaged Codex runtime evidence](apps/orquesta-desktop/docs/validation/packaged-runtime.md)
- [V4 Desktop integration evidence](apps/orquesta-desktop/docs/validation/v4-desktop-integration.md)

The final merge was checked with 51 focused unit tests, two Electron end-to-end tests, and a successful Desktop production build. During submission preparation, the current Phase 2 acquisition, audit, Audition, Codex adapter, evidence, and deterministic-slice suite also passed 135 of 135 tests. The Electron checks covered all six setup phases, transition to Home, persisted completion after restart, and setup-screen viewport containment.

## Current limits

- Windows x64 only.
- Unsigned preview installer.
- No macOS or Linux package.
- V4 Phase 3 Experience Ledger and Intent Graph remain future work.
- Real benchmark superiority over other multi-agent frameworks has not been measured, so this submission does not claim it.
- `actual_model` is not populated without independent runtime observation.

## License

Orquesta is released under the MIT License. Third-party dependencies retain their own licenses.
