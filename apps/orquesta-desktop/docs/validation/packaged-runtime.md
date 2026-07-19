# Packaged Codex Runtime Validation

Validated on 2026-07-19 with the packaged Windows x64 application produced by `npm run make:win`.

## Result

- Result: PASS
- Runtime override environment: absent
- Runtime integrity: verified
- SDK: `@openai/codex-sdk` 0.144.5
- Codex package: `@openai/codex` 0.144.5
- Windows runtime: `@openai/codex` 0.144.5-win32-x64
- Target: `x86_64-pc-windows-msvc`
- App Server platform: Windows

The package verifier found exactly these three directories under `resources/codex-runtime/node_modules/@openai`: `codex-sdk`, `codex`, and `codex-win32-x64`. It verified the three package metadata files plus one regular `codex.exe` against the generated SHA-256 manifest. No extra `@openai` package directory was present.

## Real runtime cycle

`npm run test:packaged-runtime` launched `out/Orquesta-win32-x64/Orquesta.exe` with a temporary user-data directory and temporary Orquesta project. It did not set `ORQUESTA_E2E_CODEX_SCRIPT`, `ORQUESTA_CODEX_PATH`, `CODEX_PATH`, or a renderer override.

The packaged UI completed this sequence through the bundled App Server:

- initialized the App Server and reported `Codex Desktop/0.144.5`
- created a project thread
- sent one harmless text instruction
- received `turn_started`
- received an agent message and `turn_completed`
- read the same user and agent messages back through `thread/read`
- shut the desktop application down

The observed `codex.exe` path was inside the packaged `resources/codex-runtime` tree. After application shutdown, none of the captured Orquesta, Core, Codex, or runtime descendant process IDs remained. The temporary project and user-data directory were deleted.

The harmless turn used the user's normal Codex session and did not request an additional login or approval. No hidden credential, global approval-policy change, or automatic approval response was used.

## Compatibility correction found by the real test

The first real run exposed a protocol-compatibility bug: Codex 0.144.5 emits the informational notification `remoteControl/status/changed`, which was not present in the adapter's pinned normalized event set. The adapter had treated every unknown notification as fatal and closed the JSONL transport.

The corrected boundary ignores and records unknown server notifications, while still validating known notifications and failing closed on invalid responses or unknown server requests that require a reply. A focused adapter regression test proves a later thread request still succeeds after the informational notification.

Machine-readable process, runtime, event, and history evidence is in `packaged-runtime.json`.
