# Orquesta Desktop Long-run Observation

Measured on 2026-07-18T20:08:36.667Z using a selected project in the packaged Windows x64 application. This run is not pure idle evidence: the user reported left-button map movement at about 22 minutes, followed by repeated cursor movement, map movement, and tree clicks at about 26.5 minutes.

| Elapsed minutes | Total working set | Process count |
| ---: | ---: | ---: |
| 5 | 391.63 MiB | 6 |
| 10 | 385.55 MiB | 6 |
| 15 | 385.43 MiB | 6 |
| 20 | 385.46 MiB | 6 |
| 25 | 404.55 MiB | 6 |
| 30 | 434.73 MiB | 6 |

- The working set was effectively flat from 10 through 20 minutes: 385.55 MiB to 385.46 MiB.
- Growth from 5 to 30 minutes: 43.11 MiB (limit 75 MiB) — PASS.
- Because the final two samples include interaction, this file does not claim a 30-minute idle leak result.
- The post-interaction increase is classified separately in `desktop-interaction-retention.md`: native-style repeated interaction plateaued with bounded JS heap and no DOM or listener growth.

Each sample in the JSON evidence includes the complete descendant process tree.
