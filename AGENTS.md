# AGENTS.md: CyberFly for coding agents

You are in a repo that puts hologram fruit flies on Snap Spectacles (2024), each driven by the full MaleCNS fly connectome running on a Mac. This file tells an agent how to deploy it from a fresh clone, what only a human can do, and which rules must not be broken.

Human docs: `README.md`. Deep dives: `docs/ARCHITECTURE.md`, `docs/METAL_KERNEL.md`, `docs/SENSES_AND_READOUTS.md`, `docs/DECISIONS.md`, `docs/TROUBLESHOOTING.md`.

## Deploy from a fresh clone (agent can do all of this)

Run from the repo root, in order. Each step is idempotent.

```sh
# 0. prerequisites (macOS only). If missing, ask the human to install them:
xcode-select -p && command -v uv && command -v git

# 1. brain runtime: pinned fly-wirehead + ~1.1 GB MaleCNS data (SHA-256 verified), a few minutes
scripts/setup_mac.sh

# 2. verify the brain end to end without glasses: starts a 1-fly server, drives it, checks reactions, stops it
scripts/verify_brain.sh            # must print PASS (METAL=0 to force the CPU kernel)

# 3. start the brains for the lens (background; log path is printed)
BG=1 scripts/run_server.sh         # 2 flies, Metal when available, else CPU automatically
```

Done criteria for the agent: `verify_brain.sh` prints `PASS`, and after step 3 the log shows `ready baseline` once per fly. Stop the server with `pkill -f brain_server/server.py`.

Runtime location: `$CYBERFLY_RUNTIME` (default `~/cyberfly_runtime`). Nothing large is in git; there is no Git LFS.

Kernel choice: Apple Silicon + macOS 15+ uses `--kernel metal` (~45 ms per 50 ms brain step per fly). Otherwise `run_server.sh` falls back to `--kernel fast` on the CPU (~190 ms per fly): use `--flies 1` there.

## What only the human can do (tell them, do not fake it)

Lens Studio is a GUI app; an agent cannot click through it. Hand the human this list:

1. Install **Lens Studio 5.15.4** (https://ar.snap.com/download) and open `Spectacles/Spectacles.esproj` with it.
2. Remote Service Gateway token for Gemini: Asset Library → Spectacles → install **Remote Service Gateway Token Generator**; main menu **Windows → Remote Service Gateway Token** → **Generate Token**; copy the **Google Token** into the **Google Token** field of the `RemoteServiceGatewayCredentials` scene object. Without it the lens runs, but the room is not labelled.
3. Editor: switch the preview to its 3D mode, press **DONE SCANNING** on the board.
4. Glasses: enable **Extended Permissions** for the lens on the device, **Send to Spectacles**, same Wi-Fi as the Mac (no client isolation).

If the lens cannot reach the Mac: `dscacheutil -q host -a name flybrain.local`. If it does not resolve, set `WS_URL` in `Spectacles/Assets/Scripts/Fly/FlyConfig.ts` to `ws://<mac-ip>:8790` (the server logs its IP).

## Hard rules

- **Never commit a token.** `Spectacles/Assets/Scene.scene` ships with `openAIToken`, `googleToken`, `snapToken` set to `""`. Before any commit run `git diff Spectacles/Assets/Scene.scene` and make sure those three lines are still empty. Never commit `.env` or keys of any kind.
- **Lens Studio 5.15.4 only.** Do not open or save the project with another version and do not add packages built for another version; they fail to load in 5.15.4.
- **One brain server per network.** It claims the mDNS name `flybrain.local`. Check port 8790 before starting another (`lsof -nP -iTCP:8790 -sTCP:LISTEN`).
- **The brain decides.** Fly behaviour must come from the connectome readouts. Any engineered override (a gate, a gain, a controller) gets a numbered entry in `docs/DECISIONS.md`; code comments cite it as `ADR NN`. Never hide a scripted behaviour.
- **Keep the brain kernels exact.** After touching `brain_server/engine/` or bumping fly-wirehead, run:
  ```sh
  cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead"
  uv run python <repo>/brain_server/engine/test_equality.py
  uv run python <repo>/brain_server/engine/metal/test_metal.py --ms 1500 --chaos
  uv run python <repo>/brain_server/engine/test_contract.py --kernel metal
  ```
  All must report identical/EXACT. The fly-wirehead commit is pinned in `scripts/setup_mac.sh` (`FLYWIREHEAD_REF`) for this reason.

## Lens gotchas (Spectacles display and compiler)

- The display is **additive**: dark colours are invisible. Bright text on dim plates.
- Shader inputs must never be named `color` or a GLSL built-in (`texture`, `sample`, `mix`...), and must not contain `Input` or start with `float`: the device cross-compiler rejects them and the shader silently draws nothing on the glasses while working in the editor. Sources are in `shaders_src/`; GLSL must be ASCII only.
- Keep shader `.mat.meta` / `.ss_graph.meta` files in git with the scene: materials reference the ids inside them.
- Material clones take the `.mat` defaults: set blend mode, depth write and two-sided explicitly on every clone.
- Logging goes through SIK `NativeLogger` with a module tag, never `print()`.
- Performance on the glasses is CPU-bound: avoid per-frame allocations and per-vertex `vec3` in hot loops, stagger per-fly work across frames. Turn on telemetry with `DEBUG_TELEMETRY_S` > 0 in `FlyConfig.ts` and read the server's `LENS` log lines before optimising. Set it back to 0 for recordings.

## Map of the repo

| Path | What |
|---|---|
| `brain_server/server.py` | WebSocket brain server (`--flies --engine process|batch --kernel orig|fast|par2|par3|metal --cloud --port`) |
| `brain_server/worker.py`, `channels.py` | per-fly loop; senses to neurons |
| `brain_server/engine/` | exact fast kernels; `metal/` is the GPU kernel |
| `brain_server/fake_lens.py` | lens stand-in for tests |
| `brain/` | offline probes that built the decoder (`atlas.py`) and the point-cloud sample |
| `Spectacles/Assets/Scripts/Fly/` | lens TypeScript; `FlyConfig.ts` holds every tunable, `FlySwarm.ts` is the single update loop |
| `shaders_src/` | GLSL sources of the lens shaders |
| `fly_model/`, `tools/` | offline asset pipelines (see `tools/README.md`) |
| `scripts/` | `setup_mac.sh`, `run_server.sh`, `verify_brain.sh` |

## Wire protocol in one paragraph

JSON text frames with a `t` field over `ws://flybrain.local:8790`. Lens → Mac: `hello`, `senses{fly, ch}`, `select{fly}`, `pulse{fly, kind}`, `reset{fly}`, `ping`, `dbg`. Mac → lens: `welcome`, `ready{fly, baseline}`, `brain{fly, act, neural, hz, regions, cloud?}`, `pong`, `dead`. Sense channel values are 0..1 (or `{L, R}`), 1.0 = 20 mV into those sensory cells. Full list: `docs/ARCHITECTURE.md`.
