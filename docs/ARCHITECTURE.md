# Architecture

```
 Spectacles (Lens Studio 5.15.4, TypeScript)                 Mac (Python + Metal)
 ┌──────────────────────────────────────────┐   WebSocket   ┌──────────────────────────────┐
 │ WorldScanner   camera + depth -> Gemini  │   JSON, LAN   │ server.py                    │
 │ WorldSources   food / scent / threat ... │ ────────────> │  one MaleCNS brain per fly   │
 │ FlyEyes        12 world-mesh rays / fly  │    senses     │  channels.py: senses -> mV   │
 │ FlyVision      32x16 eye camera / fly    │               │  engine/: fast | metal       │
 │ FlySenses      -> sense channels         │ <──────────── │  decoder: DN rates -> act    │
 │ FlyBody        wings, legs, head, flight │  act, hz,     │  cloud: 16k-neuron spike bits│
 │ FlyBoard       live brain point cloud    │  cloud        └──────────────────────────────┘
 └──────────────────────────────────────────┘
```

## The loop

1. The lens computes every fly's senses at `SENSE_HZ` from the room: what its eyes see, what its rays hit, what Gemini found and where, where your hands and head are.
2. It sends `senses` to the Mac. The server injects each channel as a current into the matching sensory neurons (1.0 = 20 mV).
3. The brain steps 50 ms of simulated time.
4. The server reads descending and motor neurons and decodes them into commands (`act`), rates (`hz`) and, for the selected fly, a spike bitset for the point cloud.
5. The lens smooths the commands into the body: steering, thrust, escape, stop, feeding, grooming, wing stroke, head yaw.

A brain step takes about 70–80 ms of wall time with two flies on the Metal kernel, so the brain runs at roughly 0.6–0.7x real time. The body animates every frame in between.

## Lens modules (`Spectacles/Assets/Scripts/Fly/`)

| Module | Role |
|---|---|
| `FlySwarm` | The one `UpdateEvent`. Spawns flies, owns all subsystems, ticks them. |
| `FlyConfig` | Every tunable, named and commented. |
| `BrainLink` | WebSocket client to `ws://flybrain.local:8790`, reconnect with backoff, ping. |
| `WorldScanner` | Camera frame + paired depth frame, Gemini room inventory (labels + boxes), boxes to world positions. |
| `WorldSources` | Everything a fly can sense, as world-space sources with a class (food, scent, bad, threat, object, lure). |
| `FlyEyes` | 12 rays per fly against the world mesh: walls, landing surfaces, time to contact. |
| `FlyVision` | A tiny camera on each fly's head: a 16x8 retina and optic flow per eye. |
| `WorldColorBake` | Copies the world mesh and bakes the room's colours so the fly eyes see a coloured room. |
| `FlyBody` | Procedural body driven by decoded commands: flight, landing, walking, bones. |
| `FlyBoard`, `BrainCloud`, `TextBatch`, `UIBatch` | The board: tabs, neural rows, the 16,000-neuron hologram, batched text and quads. |
| `FlyFx` | Trails and halos. |
| `FlyNarrator` | INNER VOICE: Gemini reads the selected fly's measured state. Display only. |
| `FlyCommands` | Voice find (ASR + Gemini picks a known object, which becomes a lure). |
| `FlyScenarios` | Editor-only closed-loop test bench (scenario playlist with pass/fail verdicts). |

## Wire protocol (`brain_server/protocol.py`)

JSON text frames with a type field `t`.

- Lens to Mac: `hello{role, proto}`, `senses{fly, ch}`, `select{fly}`, `pulse{fly, kind: reward|punish}`, `reset{fly}`, `ping{ts}`, `dbg{...}` (telemetry).
- Mac to lens: `welcome{proto, flies, cloud}`, `ready{fly, baseline, channels}`, `brain{fly, sim_ms, wall_ms, act, neural, hz, regions, cloud?}`, `pong`, `dead{fly}`.
- `ch` channels (0..1, or `{L, R}` for sided ones): `light`, `loom`, `loom_wall`, `object`, `motion`, `odor`, `odor_bad`, `wind`, `touch`, `bristle` · `sound`, `sweet`, `bitter`, `hot`, `cold`, `dry`, `moist`, `retina`. See `brain_server/channels.py`.
- `cloud`: base64 bitset over the fixed neuron sample (`--cloud`, 16,000 live) in `brain/results/cloud_subset.npz`, only for the selected fly.

## Brain server (`brain_server/`)

- `server.py`: WebSocket server, mDNS (`mdns.py`), one brain per fly.
- `worker.py`: the per-fly loop: senses to stimulation, brain step, decode, habituating baselines.
- `channels.py`: which MaleCNS cell types each sense drives.
- `engine/`: `--engine process` (one process per fly, package kernel), `--engine batch` (all flies in one process, shared connectome) with `--kernel orig|fast|par2|par3|metal`. See [METAL_KERNEL.md](METAL_KERNEL.md).
- `fake_lens.py`: drives the server without glasses and prints the decoded responses.

The server's own default is `--engine process --kernel fast --flies 5`; `scripts/run_server.sh` starts the recommended configuration (`--engine batch --kernel metal --flies 2 --cloud 16000`).

## Telemetry

With `DEBUG_TELEMETRY_S` > 0 in `FlyConfig`, the lens sends a `dbg` frame every few seconds and the server logs one `LENS` line: fps, worst frame, per-subsystem script cost, eye-ray hits, scan state, per-fly state and the brain step time. Set it to 0 for recordings.

## Offline brain tools (`brain/`)

Run inside the runtime (`cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run python <repo>/brain/<script>.py`):

- `instincts.py`: go/no-go probes (taste, looming, odour, vision).
- `dn_scan.py`, `discover.py`: which descending neurons respond to which input.
- `atlas.py`: every sensory cell type x side against every descending neuron (`results/atlas.npz`), the source of the decoder.
- `probe.py`: probe harness for motor pools.
- `export_pointcloud.py`, `export_cloud.py`: the neuron positions and the 16k sample the hologram draws (`BrainCloudData.ts` is generated; restart the server after re-exporting).
