# AGENTS.md: CyberFly for coding agents

You are in a repo that puts a hologram fruit fly on Snap Spectacles (2024), driven by the full MaleCNS fly connectome running on a web page (WebGPU). This file tells an agent what the pieces are, what it can do from a fresh clone, what only a human can do, and which rules must not be broken.

Human docs: `README.md`. Deep dives: `docs/ARCHITECTURE.md`, `docs/SENSES_AND_READOUTS.md`, `docs/TROUBLESHOOTING.md`, `docs/METAL_KERNEL.md`, `web/DEPLOY.md`. The engineering record: `docs/knowledge/INDEX.md` → `DECISIONS.md` → `RUNBOOK.md` → `COMPONENTS.md` (read INDEX first in every session; keep all four updated in place while working: a decision → an ADR with the call and why; a gotcha → a RUNBOOK row; a settled contract → COMPONENTS; never leave two contradicting facts).

## What an agent can do from a fresh clone

```sh
# the page, locally (no cloud project needed): a LAN relay on :8795, the page on :8796
uv run --with websockets python web/relay.py --port 8795 &
web/serve.sh page
uv run --with websockets python web/lens_sim.py --pin 4242 --relay ws://localhost:8795   # a lens without glasses
# then open http://localhost:8796/app.html?pin=4242   (the brain file must sit in web/, see README)

# a deployable site with YOUR Supabase / Snap Cloud project
web/release.sh --sb <ref> --key <anon> --host snapcloud.dev     # writes web/site/
uv run --with websockets python web/check_supabase.py <ref> <anon>   # the schema and policies, PASS lines

# the Mac brain server (optional; the editor bench)
scripts/setup_mac.sh            # fly-wirehead + 1.1 GB MaleCNS data into $CYBERFLY_RUNTIME (~/cyberfly_runtime)
scripts/verify_brain.sh         # must print PASS
BG=1 scripts/run_server.sh
```

Syntax checks that need no toolchain: `node --check` on `web/*.js` and `web/gfx/*.js`, `python3 -m py_compile` on every `.py`. The WASM in `web/dist/` is prebuilt and committed; rebuilding it (`web/build_wasm.sh`) needs Emscripten and is only needed after a change to `core/`.

## What only a human can do (tell them, do not fake it)

Lens Studio is a GUI app; an agent cannot click through it (Lens Studio 5.23 has an MCP server that lets an agent compile, run scenarios and capture the preview; 5.15 has a smaller one). Hand the human this list:

1. Install **Lens Studio 5.15.4** for `Spectacles-5.15/` (the build for Spectacles 2024) or **5.23** for `Spectacles-5.23/` (the LEAF tests), from https://ar.snap.com/download. Open each project only with its own version; never move packages between them.
2. Remote Service Gateway token for Gemini: Asset Library → Spectacles → install **Remote Service Gateway Token Generator**; main menu **Windows → Remote Service Gateway Token** → **Generate Token**; paste the **Google Token** into the **Google Token** field of the `RemoteServiceGatewayCredentials` scene object. Without it the lens runs, but the room is not labelled.
3. The relay key: `python3 web/lens_key.py --cfg Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts` after one `web/release.sh` (it pastes the anon key of the built site); `--clear` before any commit.
4. Editor: switch the preview to its 3D mode, press SOLO, then DONE SCANNING on the board (or `debugScenario` = `auto_solo`), open the page with the PIN (or run `web/pagebrain.py`).
5. Glasses: **Send to Spectacles**, accept the camera permission prompt (or enable Extended Permissions while developing), scan the room, read the PIN, open the page on a laptop.

## Hard rules

- **Never commit a secret.** `Scene.scene` ships with `openAIToken`, `googleToken`, `snapToken` set to `""` in both projects: before any commit run `git diff Spectacles-5.15/Assets/Scene.scene Spectacles-5.23/Assets/Scene.scene` and make sure those lines are still empty. `FlyConfig.ts` ships with `WEB_RELAY_KEY` and `MEMORY_BACKEND_KEY` empty: `python3 web/lens_key.py --clear` before a commit. Never commit `.env`, `.pem`, `.mcp.json` (Lens Studio writes one into the project folder) or keys of any kind. The Supabase service-role key belongs nowhere in this repo.
- **The brain decides.** Fly behaviour must come from the connectome readouts. Any engineered input or override (a gate, a gain, a controller, a smell) gets a numbered entry in `docs/knowledge/DECISIONS.md`; code comments cite it as `ADR NN`. Never hide a scripted behaviour. No brain, no fly.
- **Keep the brain kernels exact.** After touching `core/`, `brain_server/engine/` or bumping fly-wirehead: `core/tools/compare.py` (C++ vs Python), `compare.py --post '{"gpu":1}'` (the Vulkan kernel), `web/test.html` headless (the WebGPU kernel's `gpu_check`), `brain_server/engine/metal/test_metal.py --ms 1500 --chaos`, `engine/test_equality.py`. All must report identical / EXACT. The fly-wirehead commit is pinned in `scripts/setup_mac.sh` (`FLYWIREHEAD_REF`).
- **The brain file is a snapshot of `channels.py`.** After a change to the SENSES / READOUTS tables re-export it (`core/brain_export/export.py`, the recipe in the RUNBOOK) and rebuild the page's WASM if `flybrain.cpp` changed. Never overwrite a brain file a live process reads.
- **Two projects, one feature state** (assets may lag: the 5.15 scene has one treat model where 5.23 has five). Changes land in `Spectacles-5.23/` first and are ported to `Spectacles-5.15/` by copying the `.ts` files (keep the 5.15 `.meta` ids; 5.15 needs `Text.worldSpaceRect` where 5.23 has `layoutRect`, and 5.23-only properties through `as any`). Never copy `Scene.scene`, `.esproj`, packages or `.graphShader` files across.
- **Lens Studio versions.** Never let 5.22+ save the 5.15 project, and never import 5.22-era packages into it (they fail to load).
- **Every user-visible word is for someone with zero context**: WHAT / WHY / WHAT DO I DO; atlas names as small print.

## Lens gotchas (Spectacles display and compiler)

- The display is **additive**: dark colours are invisible. Bright text on dim plates.
- Shader inputs must never be named `color` or a GLSL built-in (`texture`, `sample`, `mix`…), and must not contain `Input` or start with `float`: the device cross-compiler rejects them and the shader silently draws nothing on the glasses while working in the editor. Sources are in `shaders_src/`; GLSL must be ASCII only. After every Send to Spectacles, grep the Lens Studio log for `CrossCompiler error`.
- Keep shader `.mat.meta` / `.ss_graph.meta` / `.graphShader.meta` files in git with the scene: materials reference the ids inside them.
- Material clones take the `.mat` defaults: set blend mode, depth write and two-sided explicitly on every clone.
- Logging goes through SIK `NativeLogger` with a module tag, never `print()`.
- Performance by attribution: the `perf` probe (`FlySwarm.timed`, board sections) lands in the telemetry row every 2 s (`LENS_PERF` in the page's console, `PERF_ROW` in the Lens Studio log). Diff-cache Text writes; no per-frame allocations or per-vertex `vec3` in hot loops; stagger per-fly work across frames. Set `DEBUG_TELEMETRY_S` to 0 for recordings.
- Every TypeScript save resets the preview: measure in one clean run.
- Sync Kit and SIK subscriptions bind in `OnStartEvent`, not `onAwake`.

## Map of the repo

| Path | What |
|---|---|
| `Spectacles-5.15/Assets/Scripts/Fly/` | the lens; `FlyConfig.ts` holds every tunable, `FlySwarm.ts` is the single update loop, `WebBrainLink.ts` the relay client |
| `Spectacles-5.23/` | the same lens for Lens Studio 5.23, plus `Assets/Scripts/Leaf/` (LEAF scenarios, `docs/knowledge/TESTING.md`) |
| `web/` | `app.js` (page), `brain_worker.js` + `brain_gpu.js` + `dist/` (the brain), `gfx/` (drawing), `release.sh`, `DEPLOY.md`, `relay.py`, `lens_sim.py`, `page_sim.py`, `pagebrain.py`, `lens_key.py`, `check_supabase.py`, `make_assets.py` |
| `core/` | `src/flybrain.cpp` (the core), `src/gpu/` (Vulkan + WGSL kernels), `brain_export/export.py` (the brain file), `tools/` (exactness, memory and session checks), `brain_prune/` (a pruning study, rejected), `DETERMINISM.md` |
| `brain_server/` | `server.py` (`--flies --engine process|batch|native --kernel orig|fast|par2|par3|metal --cloud --port`), `worker.py`, `channels.py` (senses → cell types, readouts), `engine/` (exact fast kernels; `metal/` the GPU kernel), `fake_lens.py` |
| `brain/` | offline probes that built the decoder (`atlas.py`) and the point-cloud sample |
| `perf/` | `sweep.py` (the differential sweep through the 5.23 MCP), `perf_rows.py`, the 21.09 results |
| `fly_model/`, `tools/`, `audio/`, `shaders_src/` | offline asset pipelines (see `tools/README.md`) |
| `scripts/` | `setup_mac.sh`, `run_server.sh`, `verify_brain.sh` |

## Wire protocol in one paragraph

Relay: a Phoenix-protocol subset (join / broadcast / heartbeat) on Supabase Realtime, topic `realtime:fly-<pin>`, or `web/relay.py` on a LAN. Lens → page (`lens` events): `hello`, `senses{fly, ch, eye}`, `select`, `pulse{kind}`, `reset`, `learning{on}`, `memory{op}`, `scene{...}`, `dbg`. Page → lens (`brain` events): `hello`, `ready{baseline}`, `brain{act, neural, hz, regions, memory, cloud?}`, `memory` replies, `cmd{train|train_stop|reset|memory_set}`. Sense channel values are 0..1 (or `{L, R}`), 1.0 = 20 mV into those cell types. The Mac socket carries the same JSON with a `t` field over `ws://flybrain.local:8790`. Full list: `docs/ARCHITECTURE.md`, `brain_server/protocol.py`, `docs/knowledge/COMPONENTS.md`.
