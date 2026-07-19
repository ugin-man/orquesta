# Orquesta Desktop Interaction Retention

Measured on 2026-07-19T03:44:40.947Z with the packaged Windows x64 app and the 35-agent fixture. Six identical batches exercised map pan, wheel zoom, native agent-detail open/close, Fit, and zoom controls. CDP garbage collection was used only for diagnosis, not to change product behavior.

| Sample | Total working set | Renderer | GPU | JS heap used | DOM counter | Live DOM | Event listeners |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline after 30s + GC | 348.34 MiB | 96.49 MiB | 111.62 MiB | 4.07 MiB | 1111 | 744 | 209 |
| batch 1 immediate | 404.73 MiB | 146.32 MiB | 117.21 MiB | 8.30 MiB | 1488 | 744 | 7551 |
| batch 1 after GC | 375.66 MiB | 117.96 MiB | 116.50 MiB | 4.64 MiB | 1111 | 744 | 209 |
| batch 2 immediate | 406.74 MiB | 146.86 MiB | 118.52 MiB | 5.73 MiB | 1483 | 744 | 7434 |
| batch 2 after GC | 383.80 MiB | 124.79 MiB | 117.66 MiB | 4.70 MiB | 1111 | 744 | 209 |
| batch 3 immediate | 409.41 MiB | 149.87 MiB | 118.81 MiB | 6.23 MiB | 1488 | 744 | 7551 |
| batch 3 after GC | 388.13 MiB | 129.43 MiB | 117.97 MiB | 4.79 MiB | 1111 | 744 | 209 |
| batch 4 immediate | 409.64 MiB | 149.64 MiB | 119.20 MiB | 7.36 MiB | 1483 | 744 | 7434 |
| batch 4 after GC | 390.46 MiB | 131.19 MiB | 118.48 MiB | 4.81 MiB | 1111 | 744 | 209 |
| batch 5 immediate | 411.51 MiB | 150.63 MiB | 119.74 MiB | 7.62 MiB | 1481 | 744 | 7511 |
| batch 5 after GC | 392.25 MiB | 132.41 MiB | 118.69 MiB | 4.83 MiB | 1111 | 744 | 209 |
| batch 6 immediate | 411.82 MiB | 150.55 MiB | 119.91 MiB | 7.52 MiB | 1476 | 744 | 7316 |
| batch 6 after GC | 393.66 MiB | 133.60 MiB | 118.70 MiB | 4.83 MiB | 1111 | 744 | 209 |
| recovery 1m | 386.38 MiB | 129.36 MiB | 117.74 MiB | 4.84 MiB | 1111 | 744 | 209 |
| recovery 1m after GC | 386.38 MiB | 129.36 MiB | 117.74 MiB | 4.83 MiB | 1111 | 744 | 209 |

- Final retained total working set: 38.04 MiB
- Working-set growth after the first warmed interaction batch: 10.73 MiB
- Final retained Renderer working set: 32.87 MiB
- Final retained GPU working set: 6.12 MiB
- Final retained JS heap after forced collection: 0.75 MiB
- Final DOM-counter delta: 0
- Final live-DOM delta: 0
- Final event-listener delta: 0
- Stable process count: PASS
- Total retained working set <= 75 MiB: PASS
- Growth after the first warmed batch <= 30 MiB: PASS
- Post-GC JS heap growth <= 8 MiB: PASS
- DOM-counter growth <= 10: PASS
- Live-DOM growth = 0: PASS
- Event-listener growth <= 20: PASS

The process working set is reported separately from reachable JavaScript heap. A first-use working-set increase that plateaus across repeated batches while post-GC heap, DOM nodes, and listeners stay bounded is retained Chromium/V8 capacity or graphics caching, not an accumulating product leak.
