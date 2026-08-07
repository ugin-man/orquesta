# Desktop Asset Provenance

This record covers assets shipped or displayed by Orquesta Desktop.

| Asset | Origin | Release status |
| --- | --- | --- |
| `public/brand/orquesta-startup.png` | Supplied by the Orquesta project owner for this product | Approved for publication by the owner on 2026-08-07; warm-canvas render visually verified |
| `public/setup/pipe-organ-background.png` | Generated specifically for the Orquesta setup experience during project development | Project-controlled output; kept |
| `public/setup/setup-gear-*.png` | Generated specifically for the Orquesta setup experience during project development | Project-controlled output; kept |
| `assets/orquesta.png`, `assets/orquesta.ico`, `public/favicon.ico` | Generated from project-owned vector-like shapes by `scripts/generate-app-icon.mjs` | Reproducible project asset; kept |
| Desktop screenshots under `docs/` and `tests/` | Captures of Orquesta itself using repository fixtures | Kept as product and regression evidence |

The local approval image formerly stored at `public/reference/orquesta-desktop-home-approved.png` is not part of the public candidate. The old paper-grain raster is also excluded; the current interface uses a procedural CSS texture instead.
