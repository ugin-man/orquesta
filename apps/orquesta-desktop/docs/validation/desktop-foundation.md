# Orquesta Desktop Foundation Validation

Measured on 2026-07-18T20:16:34.915Z using the packaged Windows x64 application.

- Executable: `C:\Users\kouki\OneDrive\ドキュメント\Orquesta\.worktrees\orquesta-desktop-electron\apps\orquesta-desktop\out\Orquesta-win32-x64\Orquesta.exe`
- Input isolation: native mouse input disabled before idle timing
- Cold start: 2297 ms (limit 4000 ms) — PASS
- No-project idle working set: 313.54 MiB after 60 seconds (limit 400 MiB) — PASS
- Selected-project idle working set: 391.36 MiB after 60 seconds (limit 400 MiB) — PASS
- ui_core_footprint_bytes: 306.27 MiB
- codex_runtime_footprint_bytes: 390.28 MiB
- total_footprint_bytes: 696.56 MiB
- Electron process count without a project: 5
- Electron process count with a selected project: 6
- Result: PASS

Package footprint is reported as evidence, not used as a pass/fail gate. The no-project run proves lazy project/Core startup; the selected-project run records the idle repository baseline.
