# Perf sweep, editor (LS 5.23.2 preview on the Mac, page brain) — 2026-09-21 21:40

Instrument: `PERF_ROW` (script ms/frame per subsystem, mean over a 45 s window at the board with the fly shown; worst frame kept) + preview fps. Δ = stage − `01_full`; a negative Δ frame is what the switched-off system cost. These are EDITOR numbers (the Mac renders the preview); the glasses' numbers come from `LENS_PERF` rows on the page.

| stage | flags | rows | fps | frame ms | Δ frame | worst med / max ms | scripts ms | Δ scripts | top subsystems (mean ms) |
|---|---|---|---|---|---|---|---|---|---|
| 01_full |  | 23 | 19.8 | 50.5 | — | 137 / 174 | 3.64 | — | ours 1.95, board 0.86, eye 0.31, bodies 0.17 |
| 02_no_scan | SCAN_ENABLED=false | 22 | 19.4 | 51.5 | +1.0 | 138.5 / 507 | 3.65 | +0.01 | ours 1.97, board 0.83, eye 0.31, bodies 0.20 |
| 03_no_vision ⚠ invalid | VISION_ENABLED=false MOTION_ENABLED=false | 23 | 20.1 | 49.8 | -0.7 | 128 / 173 | 2.02 | -1.62 | ours 1.11, board 0.45, bodies 0.19, fx 0.07 |
| 04_eyes_slow | EYE_HZ=1 RETINA_HZ=1 EYE_PANEL_HZ=2 | 23 | 20.1 | 49.7 | -0.8 | 160 / 178 | 2.89 | -0.75 | ours 1.56, board 0.57, bodies 0.28, vision 0.13 |
| 05_no_sound | SOUND_ENABLED=false | 23 | 19.7 | 50.8 | +0.3 | 130 / 185 | 3.36 | -0.28 | ours 1.81, board 0.72, eye 0.30, bodies 0.18 |
| 06_no_gemini_weather | NARRATE_ENABLED=false WEATHER_ENABLED=false | 23 | 19.1 | 52.4 | +1.9 | 140 / 368 | 3.94 | +0.30 | ours 2.12, board 0.80, eye 0.42, bodies 0.20 |
| 07_board_slow ⚠ invalid | BOARD_DATA_HZ=5 MINI_MIRROR_HZ=15 | 22 | 5.6 | 177.4 | +126.9 | 286.0 / 742 | 25.36 | +21.72 | ours 14.10, bake 4.29, webscene 3.65, scan 2.85 |
