# Perf attribution sweep — 21.09 (LS 5.23.2 editor, page brain, CLAD specs-lens-perf-attribution)

## Representative state (the exerciser)
- Brain: a headless page joined to the editor lens's PIN (`web/pagebrain.py 8796 …`; log line `WEB_BRAIN_ON page=web`).
- Journey: LEAF `start_to_board` (SOLO → scan → DONE → boot card → board), then 20 s settle. The fly is shown (`FLY_SHOWN`), the board rows tick, the room scan has run (`SCAN_RESULT`).
- Existing markers: `DEBUG_STATE_ENTER/READY`, `FLY_SHOWN`, `BOARD_FRAME`, `SOUND_START`, the 2 s `dbg` row with `perf <subsystem>=ms` (script-side attribution, mean over the window) and `fps … worst …ms`.

## Stages (name sorts in order). One capture per stage: 12 s, one Preview panel.
| stage | how | expected owner |
|---|---|---|
| `00_no_project` | `setEnabled(FlySwarm root, false)` via scene-graphql; RunAndCollectLogs refresh; no LEAF | Preview/editor + SIK + World Mesh baseline |
| `01_full` | everything as shipped, brain on, board open | the whole lens |
| `02_no_scan` | FlyConfig `SCAN_ENABLED: false` | Gemini scan + world labels + world query |
| `03_no_vision` | `VISION_ENABLED: false`, `MOTION_ENABLED: false` | the fly eyes' camera passes + optic flow |
| `04_no_sound` | `SOUND_ENABLED: false` | buzz/song |
| `05_no_narrate` | `NARRATE_ENABLED: false` | Gemini inner voice |
| `06_board_slow` | `BOARD_DATA_HZ: 5`, `MINI_MIRROR_HZ: 15` | board text/bars + mini fly |
| `07_no_scene_feed` | `WEB_SCENE_HZ: 0` (if 0 disables; else 1) | the room/scene feed to the page |
Each FlyConfig stage: edit → RecompileTypeScriptTool → wait for `WEB_BRAIN_ON` (pagebrain re-joins the PIN by itself, ~15–40 s) → run_leaf_scenario start_to_board (the MCP call may time out; `PASSED: start_to_board` in the LS log is the verdict) → 20 s settle → capture → after the capture read the last two `dbg` rows (`perf …`, `fps …`) from the LS log. Restore every flag to shipped values at the end (FlyConfig is NOT to be committed with flags flipped; and it holds a pasted key — never print it).

## Capture
`ExecuteEditorCode` with the specs-capture-perf-trace "Start scheduled capture" snippet: `outputDir` = this folder, `filenamePrefix` = stage name, `durationMs` = 12000, `previewCount` = 1. Verify the `.pftrace` is non-zero.

## Analysis
```
# analyze_perfetto_attribution.py ships with the ls-clad plugin (skill specs-lens-perf-attribution);
# trace_processor_shell is Perfetto's (https://perfetto.dev)
python3 <path-to>/analyze_perfetto_attribution.py \
  perf/traces_2026-09-21 --trace-processor <path-to>/trace_processor_shell --project-label "CyberFly 5.23" --base 00_no_project --target-fps 30 --warmup-s 2
```
Outputs land next to the traces: CSVs, donut chart, `optimization_candidates.md`, `metrics_compact.json`.
