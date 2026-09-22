# Architecture

```
 Spectacles (Lens Studio 5.15.4 / 5.23, TypeScript)         a browser with WebGPU (laptop, desktop, strong phone)
 ┌──────────────────────────────────────────────┐          ┌──────────────────────────────────────────────┐
 │ WorldScanner   camera + depth -> Gemini      │  Snap    │ web/app.js        state, relay, one rAF loop │
 │ WorldSources   food / scent / bad / threat.. │  Cloud   │ brain_worker.js   a Web Worker stepping      │
 │ FlyRetina      1,767 ommatidia -> ON/OFF     │ Realtime │   dist/flybrain.wasm  (core/, C++ -> WASM)   │
 │ FlyEyes        12 world-mesh rays / fly      │  room    │   dist/brain.wgsl     (the WebGPU kernel)    │
 │ FlySenses      -> sense channels             │ fly-PIN  │ gfx/brain.js      all 166,700 neurons, edges │
 │ FlyWeather     Open-Meteo -> climate         │ ───────> │ gfx/room.js       the scanned room, the flies│
 │ FlyBody        wings, legs, head, flight     │  senses  │ gfx/eyes.js       what the eyes see           │
 │ FlyBoard       PIN, rows, hologram, cards    │ <─────── │ gfx/teach.js      sessions and memory         │
 │ WebBrainLink   the relay client              │  brain   └──────────────────────────────────────────────┘
 │ FlyNet         other people's flies (SyncKit)│
 └──────────────────────────────────────────────┘          Mac (optional): brain_server/ over ws://, Metal kernel
```

## The loop

1. The lens computes every fly's senses at `SENSE_HZ` from the room: what its two compound eyes see, what its rays hit, what Gemini found and where, where your hands and head are, the weather, its hunger.
2. It broadcasts `senses` into the relay room. The brain injects each channel as a current into the matching sensory neurons (1.0 = 20 mV) and the eye bytes as ON/OFF contrast into the lamina and medulla.
3. The brain steps 50 ms of simulated time (the WebGPU kernel, or the CPU fallback).
4. It reads the descending and motor neurons and decodes them into commands (`act`), rates (`hz`), region populations (`regions`), the memory's state and, for the hologram, a spike bitset over a fixed 16,000-neuron sample (`cloud`).
5. The lens smooths the commands into the body: steering, thrust, escape, stop, back, feeding, grooming, wing stroke, proboscis, head yaw. The body animates every frame in between; the fly exists only while a brain steps it (ADR 78).

A brain step takes about 100 ms of wall time on a laptop GPU, so the brain runs at roughly half real time and the fly reacts within a few hundred milliseconds.

## Where a brain can run

| Brain | Path | When |
|---|---|---|
| **A web page** (the shipped path, ADR 55/87) | `core/` compiled to WASM (`web/build_wasm.sh`) + `brain.wgsl` on WebGPU, in a Web Worker; joined by PIN through the relay | always: the glasses, the editor, the demo |
| **The Mac brain server** (the original, ADR 05/23) | `brain_server/server.py`, one brain per fly on the Metal kernel or the CPU kernel, plain `ws://flybrain.local:8790` | the editor bench; needs `BRAIN_SOCKET_ENABLED` and Experimental APIs (ADR 84) |
| The same C++ core on the Mac | `server.py --engine native` on `core/` (`libflybrain_host.dylib`), `web/page_sim.py` | to drive the preview with exactly the page's code |

An earlier build carried the brain in the lens itself; it was replaced by the page and deleted (ADR 86/87). The core is not a device path any more; the page and the Mac compile from it.

## The relay (`WebBrainLink.ts`, `web/app.js`, `web/relay.py`)

A subset of the Phoenix protocol (join / broadcast / heartbeat), so ONE client talks to Supabase Realtime (`wss://<ref>.<host>/realtime/v1/websocket?apikey=<anon>`, topic `realtime:fly-<pin>`) or to `web/relay.py` on a LAN (`ws://<mac>:8795`, no key). Snap Cloud is Supabase under `snapcloud.dev`; the anon key is public by design and guarded by the RLS policies in `web/DEPLOY.md`.

- **Lens → page** (`lens` broadcasts): `hello{role, proto}`, `senses{fly, ch, eye}`, `select{fly}`, `pulse{fly, kind: reward|punish}`, `reset{fly}`, `learning{fly, on}`, `memory{fly, op: get|set|clear|echo, data?}`, `scene{head, flies, things?, mesh?, surface?, train?, mem?, narration?}` (ADR 61: what only the lens knows, at `WEB_SCENE_HZ`, big parts only when they change), `dbg{...}` (telemetry every 2 s).
- **Page → lens** (`brain` broadcasts): `hello` (the page is the brain), `ready{fly, baseline, channels}`, `brain{fly, sim_ms, wall_ms, act, neural, hz, regions, memory, cloud?, engine: "web"}`, `memory{...}` replies, `cmd{cmd: train|train_stop|reset|memory_set, ...}` (ADR 68: the page can drive a conditioning session).
- A page that goes quiet for `PAGE_TIMEOUT_S` is a dropped brain: the fly blinks out and the header says DROPPED (ADR 107).

`ch` channels (0..1, or `{L, R}` for sided ones): `light`, `loom`, `loom_wall`, `object`, `motion`, `odor`, `odor_<glomerulus>` ×16, `odor_bad`, `wind`, `touch`, `bristle`, `ocelli`, `haltere`, `sound`, `sweet`, `bitter`, `hot`, `cold`, `dry`, `moist`, `hunger`, `reward`, `punish`; `eye` = 1,767 signed bytes of ommatidial contrast. See `brain_server/channels.py` and [SENSES_AND_READOUTS.md](SENSES_AND_READOUTS.md).

## The brain core (`core/`)

`flybrain.cpp` re-implements fly-wirehead's per-fly loop statement for statement in C++17 (senses → currents, the LIF kernel at 0.1 ms, habituating baselines, the decoder, the cloud bits, the dopamine rule). Verified identical to the Python reference (33/33 steps, frozen and learning). Backends: a CPU kernel (serial or partitioned over threads, bit-identical), a Vulkan compute kernel (`gpu/brain.comp`, `vkbrain.cpp`, the Mac's GPU path through MoltenVK), and a WebGPU kernel (`gpu/brain.wgsl`, `webbrain.cpp`, driven from JS by `web/brain_gpu.js`). The GPU kernels are exact because the arithmetic cannot differ, not because the orders match: `evolve` uses only correctly rounded `+ - *`, and synaptic weights are stored as the integer contact counts they are, so a tick's deliveries add with atomics (ADR 82; `core/DETERMINISM.md`). `{"gpu_check": k}` runs k chunks on both and compares cells, active list, queues and spikes: the proof for every new browser or GPU.

The brain file (`FLYB`, `core/brain_export/export.py`) is the connectome plus the sense and readout groups as a snapshot of `channels.py`: ~205 MB, 75 MB zlib-compressed, hosted on a GitHub release of this repository and downloaded once by the page.

## The page (`web/`)

ES modules, three.js vendored, no build step. `index.html` is the landing, `app.html` the dashboard. The brain steps in a Web Worker (`brain_worker.js`); the page relays, draws and never touches the spikes. All 166,700 neurons are drawn at their measured anatomical position (140,638 at their own soma; the inferred ones dimmer), lit by the last-spike time the worker hands over after every step (20,838 bytes, a transferable); the six strongest outgoing synapses of every neuron (982,224 edges) carry pulses; the room is the lens's own triangle mesh with the flies, the things and the wearer's head. HDR rendering with auto-exposure, because 166,700 additive points saturate an 8-bit target. `?demo=1` is a lens made of JavaScript inside the page. `web/DESIGN.md` holds the design tokens, `web/DEPLOY.md` the deployment and the Supabase schema.

## Lens modules (`Assets/Scripts/Fly/`)

| Module | Role |
|---|---|
| `FlySwarm` | The one `UpdateEvent`. Spawns flies, owns every subsystem, ticks them, the perf probe (`timed`), the debug scenarios |
| `FlyConfig` | Every tunable, named and commented |
| `BrainLink`, `WebBrainLink` | The Mac socket client; the relay client with the PIN, the page handshake, the scene feed hook |
| `FlySceneFeed` | What only the lens knows, to the page: head, poses, inventory, the room surface, training state |
| `WorldScanner`, `WorldCameraId` | Camera frame + paired depth frame, Gemini room inventory (labels, boxes, smell and climate fields), boxes to world positions |
| `WorldSources`, `FlySenses` | Everything a fly can sense, as world-space sources with a class; the sense channels per fly |
| `FlyRetina`, `FlyVision`, `FlyEyes`, `FlyEyePanel` | The compound eyes (two cameras, 1,767 columns, ON/OFF), a small head camera for optic flow, 12 rays against the world mesh, the board's eye panel |
| `WorldColorBake` | Paints the room's colours onto the world mesh so the fly's eyes see a coloured room |
| `FlyWeather` | Open-Meteo → hot/cold/dry/moist/wind, warmer indoors |
| `FlyAttention` | Point at a thing: rings, its smell and what the fly thinks of it (an inspector, never a trigger, ADR 101) |
| `FlyBody`, `FlyFx`, `FlySound` | The body on the decoded commands (flight, landing, walking, 43 bones); trails and halos; the buzz and the song |
| `FlyMemory`, `FlyTrainer`, `FlyVerdict` | The plastic state as a blob the lens owns; the conditioning sessions; Gemini's reading of the evidence |
| `FlyBoard`, `FlyStart`, `FlyScan`, `FlyBoot`, `FlyGuide`, `FlySidePanel`, `BrainCloud`, `TextBatch`, `UIBatch`, `UICard` | The board: start card (SOLO / COLOCATED), scan card, boot card, tabs, NEURAL rows, the 16,000-neuron hologram, side panels, batched text and quads |
| `FlyNarrator` | INNER VOICE: Gemini reads the measured state and writes one line as the fly. Text on the board only, display only |
| `FlyCommands`, `FlyEars` | Off by default (`ASK_ENABLED`, `EAR_ENABLED` false: the microphone is never read). Voice find (ASR + Gemini picks a known thing, which becomes a lure); clap detector → `sound` |
| `FlyNet` | Other people's flies over Sync Kit: one RealtimeStore, ghosts that run the same body animation |
| `FlyScenarios` | Editor-only closed-loop bench and state seeding (the `debugScenario` input; each module logs `DEBUG_STATE_ENTER` / `DEBUG_STATE_READY`) |

The 5.23 project adds `Assets/Scripts/Leaf/`: LEAF scenarios that drive the start card, the scan, the board, a page handover and a training session in the Lens Studio preview (`docs/knowledge/TESTING.md`).

## Multiplayer (ADR 53)

Sync Kit; the start card's COLOCATED key. Every device owns one fly and one brain (its own page); `FlyNet` writes one packet per person per tick into a RealtimeStore (`FlyBody.packNet`: pose, state, wing drive, energy, 16 eased action values). Every other device runs that fly as a ghost: the same prefab, the next hologram colour, the same `animate()` on the received values, no brain and no motion code. Ghosts are sources, so your fly sees them. Late joiners read every slice; a leave event removes a ghost.

## Telemetry

Every 2 s the lens sends a `dbg` row: fps, worst frame, per-subsystem script cost ranked by mean, eye-ray hits, scan and climate state, per-fly state, the learning state and the brain step time. The page prints it to the browser console as `LENS_PERF …` and shows *glasses frame* in the footer; the Mac server logs it as `LENS …`; in the editor the same row lands in the Lens Studio log as `PERF_ROW`. `DEBUG_TELEMETRY_S` 0 turns it off for recordings.

## Offline brain tools (`brain/`, `core/tools/`)

Run inside the runtime (`cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/brain/<script>.py`): `atlas.py` (every sensory cell type × side against every descending neuron, the source of the decoder), `instincts.py`, `dn_scan.py`, `export_pointcloud.py` / `export_cloud.py` (the positions and the 16,000-neuron sample the hologram draws). `core/tools/compare.py` proves the C++ core against Python; `memtest.py` the memory blob; `train_check.py` a whole conditioning session; `core/brain_export/export.py` writes the brain file.
