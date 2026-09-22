# CyberFly

A hologram fruit fly in your real room, on Snap Spectacles (2024), driven by a complete simulated fly brain that runs on a web page.

<p>
  <a href="https://pavlo-stijn.dev/blog/assets/videos/cyberfly-demo.mp4"><img src="docs/media/cyberfly-on-spectacles.jpg" alt="Watch the demo: a hologram fly next to a coffee cup, seen through Spectacles" width="49%" /></a>
  <img src="docs/media/cyberfly-board.jpg" alt="The board with the selected fly's live brain point cloud" width="49%" />
</p>

▶ **[The public page: pavlo-stijn.dev/fly](https://pavlo-stijn.dev/fly/)** (watch the brain think, no glasses needed) · [30 s demo recorded on Spectacles](https://pavlo-stijn.dev/blog/assets/videos/cyberfly-demo.mp4) · [Blog post](https://pavlo-stijn.dev/blog/posts/a-real-fly-brain-on-spectacles.html)

## What it is

The fly's brain is the **MaleCNS v1.0 connectome**: 166,700 neurons and 25.6 million synapses of a real male fruit fly, mapped by scientists, run as the leaky integrate-and-fire model of [Shiu et al., Nature 2024](https://www.nature.com/articles/s41586-024-07763-9) (through [fly-wirehead](https://github.com/mattyhempstead/fly-wirehead)). Every neuron of the fly's central nervous system is in there — brain and nerve cord; nothing is scripted.

That brain runs **on a web page**, in your browser, on your graphics card: a C++ core compiled to WebAssembly steps the model, and a WebGPU compute kernel does the heavy part. On an M1 Max laptop one 50 ms slice of fly life takes about 100 ms of wall time (79–143 ms measured); the CPU fallback about 850 ms.

The glasses are the fly's **senses and body**. They scan the room, ask Gemini what is in it, run two compound-eye cameras on the fly's head, feel your hands, read the weather; they send all of that to the page as currents into the same sensory neurons a real fly has. Back come the firing rates of the descending and motor neurons, and the wings, legs, head and proboscis follow them.

The two meet through a **4-digit PIN**: the lens shows it on its board, you type it into the page, and the page becomes that fly's brain over a realtime relay (Snap Cloud, which is Supabase).

```
 Spectacles (2024)                                     laptop / desktop / strong phone
 ┌────────────────────────────────────┐   Snap Cloud   ┌────────────────────────────────────┐
 │ room scan: world mesh + depth +    │   Realtime     │ the web page                       │
 │   camera → Gemini names the things │ room fly-<PIN> │   WASM core + WebGPU kernel        │
 │ fly eyes: 1,767 ommatidia → ON/OFF │                │   166,700 neurons, 25.6 M synapses │
 │ hands, head, weather, hunger       │ ─ senses 12/s ▶│   50 ms of fly time per step       │
 │                                    │                │                                    │
 │ body: wings, legs, head, proboscis │◀─ brain 10/s ─ │   descending + motor neuron rates  │
 │ board: PIN, rows, brain hologram   │ act, hz, cloud │   every neuron drawn as it fires   │
 └────────────────────────────────────┘                └────────────────────────────────────┘
```

**Why a page.** The glasses are too small to think this fast. Because the brain runs on a laptop or desktop GPU (or a strong phone), WebGPU brings PC-class compute to the glasses: the glasses render and sense, the heavy brain lives where the compute is. That is what makes a 166,700-neuron brain per fly possible on a headset, and it extends what the device can do far beyond its own chip.

**Several people, several flies.** The start card offers **COLOCATED** (Spectacles Sync Kit) next to SOLO. Several people in the same room, each with their own glasses and their own page brain, see each other's flies: every headset owns one fly and one brain, and only the bodies cross the network (a ~120-byte packet per person, 8 times a second). So several machines together put many flies in one scene, each with its own brain. Status: verified between two editor previews; a two-headset session with a shared map is the next test (ADR 53).

**It learns by itself.** The dopamine learning rule of Huang, Luo et al. 2024, as extended by fly-wirehead (the paper models punishment; the reward side and the bound on how far a synapse may move are fly-wirehead's), runs on the fly's 7,835 mushroom-body synapses. Landing on food pays a reward scaled by hunger; a hand rushing at the fly is a punishment; every scanned thing has a smell (one of sixteen the lens can name; the released brain file tells four apart, see below). The memory fades over about three hours and is kept on the glasses between sessions, so the fly you meet tomorrow is the one that lived in your room today.

## Keys and tokens: none ship in this repo

Every credential field in this repository is empty on purpose. You generate your own; nothing here ever needs to be committed.

| What | Where it lives | How to get yours | Rule |
|---|---|---|---|
| **Remote Service Gateway token** (Gemini: the room inventory and the fly's inner voice) | the `RemoteServiceGatewayCredentials` object in `Assets/Scene.scene` of the project you open (Inspector: Google / OpenAI / Snap token fields) | Lens Studio → **Windows → Remote Service Gateway Token → Generate Token** (needs a Snap developer account; the token generator comes from Asset Library → Spectacles → *Remote Service Gateway Token Generator*). Paste the **Google token**; the other two fields can stay empty. | per developer; never commit `Scene.scene` with a token in it |
| **Relay project ref + anon key** (the PIN room between lens and page, and the fly's saved memory) | lens: `WEB_RELAY_URL` / `MEMORY_BACKEND_URL` (the ref) and `WEB_RELAY_KEY` / `MEMORY_BACKEND_KEY` (the key) in `Assets/Scripts/Fly/FlyConfig.ts`; page: `web/site/config.js` written by `release.sh` | **Using the public page:** keep the ref as shipped and take the anon key from `https://pavlo-stijn.dev/fly/config.js`. **Running your own page:** create a Snap Cloud / Supabase project, run the schema (`web/check_supabase.py --create`), put your ref into `FlyConfig.ts`, build with `web/release.sh --sb <ref> --key <anon>`. Either way paste the key into the lens with `web/lens_key.py --key <anon> --cfg <project>/Assets/Scripts/Fly/FlyConfig.ts` before a device build and `--clear` it before committing. | the anon key is public by design (RLS-guarded), the **service-role key never goes anywhere** (`release.sh` refuses it) |
| Weather (Open-Meteo) | `FlyConfig.ts` `WEATHER_*` | no key needed | change the default city to yours |

## Repository layout

| Path | What |
|---|---|
| `Spectacles-5.15/` | Lens Studio **5.15.4** project: the build for Spectacles (2024). TypeScript in `Assets/Scripts/Fly/` |
| `Spectacles-5.23/` | Lens Studio **5.23** project: the same lens, newer packages, plus the LEAF test scenarios (`Assets/Scripts/Leaf/`) |
| `web/` | The page: landing (`index.html`), dashboard (`app.html`), brain worker, WebGPU kernel, relay tools, `release.sh` |
| `core/` | The shared brain core in C++: the CPU kernel, the GPU kernels (Vulkan for the Mac, WGSL for the page), the brain-file exporter (`brain_export/`), exactness tools |
| `brain_server/` | The Mac brain server (WebSocket + mDNS), the Metal GPU kernel; the offline alternative for the editor |
| `brain/` | Offline probes that map senses to neurons (`atlas.py`), the exported point clouds |
| `fly_model/`, `tools/`, `audio/`, `shaders_src/` | The fly model pipeline (flybody → GLB), anatomy meshes, motion clips, font atlases, fly sounds, GLSL sources of the lens shaders |
| `perf/` | The perf instrument (`PERF_ROW`, `perf_rows.py`), the differential sweep and its results |
| `docs/` | Architecture, senses and readouts, troubleshooting, the Metal kernel, and `docs/knowledge/`: the project's full engineering record (decisions as ADRs, runbook, contracts) |
| `AGENTS.md`, `CLAUDE.md` | Instructions for coding agents |

Both lens projects carry the **same feature state** (the 5.23 project is where changes land first; they are ported to 5.15 by copying scripts, never by moving packages). One asset difference: the 5.23 scene wires the five treat models of ADR 60, the 5.15 scene draws one apple (`treatPrefabs` is empty there; copy the GLBs and fill it to match). Open each with exactly its own Lens Studio version.

## How to run it

### With the public page (nothing to deploy)

1. Open `Spectacles-5.15/Spectacles.esproj` in **Lens Studio 5.15.4** (or `Spectacles-5.23/` in 5.23).
2. Gemini needs a **Remote Service Gateway token** from your own Snap developer account: Asset Library → Spectacles → *Remote Service Gateway Token Generator*; **Windows → Remote Service Gateway Token → Generate Token**; paste the **Google Token** into the `RemoteServiceGatewayCredentials` object in the scene. The repo ships these fields empty. Without it the lens runs, but nothing in the room gets a name.
3. The lens must be able to join its relay room. `FlyConfig.ts` already names the public page's relay project (`WEB_RELAY_URL`, a Snap Cloud project ref). The matching **anon key** is not in git, but it is public by design (it ships inside the page): read it from `https://pavlo-stijn.dev/fly/config.js` (the `anon` field) and paste it into the lens with `python3 web/lens_key.py --key <anon> --cfg Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts` before a device build (`--clear` before you commit). It only lets a client join relay rooms and read/write the fly-memory table under row-level security; it is not an admin key.
4. **Send to Spectacles.** Choose SOLO or COLOCATED, look around while the room scans, press DONE SCANNING. The board shows **PIN NNNN**.
5. On a laptop open the page, type the PIN. The page becomes the brain; the fly appears on the glasses within seconds. No brain, no fly: the lens never moves a fly without a brain stepping it.

On the glasses the lens uses the camera and depth together with the internet (the microphone is wired in the scene but nothing reads it: `EAR_ENABLED` and `ASK_ENABLED` are off): accept the permission prompt on the device, or enable Extended Permissions for the lens in the Spectacles app while developing.

### Deploy your own page

The page is a static folder plus one Supabase project (Snap Cloud is Supabase under `snapcloud.dev`). `web/DEPLOY.md` is the step-by-step; in short:

```sh
# the schema (two small tables with RLS policies), once
supabase db query "$(python3 web/check_supabase.py --create)"
# the site, with YOUR project ref and anon key baked into config.js
web/release.sh --sb <ref> --key <anon> --host snapcloud.dev     # or --host supabase.co
# the brain files (not in git): brain_c0.flyb.z, skel_l0.bin and brain.version from the brain-v2 release of this repo, into web/
```

Upload `web/site/` to any HTTPS host. `web/config.js` in the repo has an empty `ref` and `anon` on purpose; `release.sh` writes the real ones into `web/site/config.js`. Point the lens at the same project (`WEB_RELAY_URL`, `MEMORY_BACKEND_URL` in `FlyConfig.ts`, key via `lens_key.py`). Never use the service-role key anywhere; `release.sh` refuses it.

The brain file is on the repository's GitHub release **`brain-v2`**, not in git: `brain_c0.flyb.z` (77 MB, the sixteen-odour export of ADR 105, the one `web/brain.version` names), `skel_l0.bin` (34 MB, every neuron's arbor for the page's brain view; the page works without it, just without the branches) and `brain.version`. `release.sh --brain` copies them into `web/site/` when they sit next to `web/`; otherwise download them from the release into `web/` first. The synapse table `web/assets/edges.bin` (16 MB) is in git.

### Demo mode, and testing without glasses

- **`app.html?demo=1`**: a made-up room with a few named things and the real brain deciding what to do about them. The page says DEMO the whole time.
- `web/serve.sh` serves the page locally and runs `web/relay.py`, a one-network relay that needs no cloud project.
- `uv run --with websockets python web/lens_sim.py --pin 4242 --relay <wss-url> --key <anon>`: a lens without glasses (senses + room) so a page can be built and judged.
- `web/pagebrain.py`: gives the Lens Studio editor preview a brain from the command line.

### The Mac brain server (offline alternative for the editor)

`brain_server/` runs one brain per fly on the Mac, on a Metal GPU kernel that is bit-exact with the CPU kernel (see [docs/METAL_KERNEL.md](docs/METAL_KERNEL.md)). It was the original brain and is still the editor bench: `scripts/setup_mac.sh` (downloads the 1.1 GB of MaleCNS data into `$CYBERFLY_RUNTIME`, default `~/cyberfly_runtime`), then `scripts/run_server.sh`, `scripts/verify_brain.sh` prints PASS. The lens reaches it over a plain `ws://` socket, which needs `BRAIN_SOCKET_ENABLED: true` in `FlyConfig.ts` and *Experimental APIs* on in Project Settings (a lens with that flag cannot be published; the shipped configuration has it off, ADR 84). Requirements: Apple Silicon, macOS 15+ for Metal (`METAL=0` for the CPU kernel), Xcode command line tools, `uv`.

## What is real and what is engineered

The brain decides. The lens only senses and executes. Where a body needs something the connectome does not have, we engineered it and wrote it down as a numbered decision (`docs/knowledge/DECISIONS.md`, cited in code as `ADR NN`). Nothing is faked silently. The engineered parts, all of them:

- **Senses computed by the lens, injected where a real fly's own detectors sit** (ADR 10): looming, object direction and optic flow are computed from geometry and driven into LC4/LPLC2, LC12/LPC1, LLPC1, because pixels alone do not reach behaviour in this model. The eyes are real: 1,767 ommatidia sampled by two cameras on the fly's head, ON/OFF contrast into the lamina and medulla (ADR 54).
- **Engineered inputs, disclosed:** every scanned thing smells, a plain object identity-only (ADR 93); the room's climate comes from the real forecast, warmer indoors, plus Gemini's per-thing warm/cold/humid/windy fields (ADR 95/96); the wearer smells, and a scare near the wearer is a punishment (ADR 102); landing on food pays a dopamine reward scaled by hunger, and discomfort is a small punishment (ADR 103); hunger is a simulated energy injected into the appetitive descending neurons (ADR 26/42); a clap detector turns the microphone into the fly's `sound` channel (ADR 29); a sense packet that stops arriving goes neutral after 3 s of fly time (ADR 104).
- **Engineered body, disclosed:** flight controller, altitude band, landing approach and touch-down, solid walls and a leash (ADR 22/24/35); the tripod walking rhythm (the leg pools do not alternate in this model, ADR 42); the visual wing-beat rate and saccade shape (ADR 41); the buzz's audibility envelope (ADR 91); how the grooming readout is scaled (ADR 100/106).
- **Display, never a measurement:** the INNER VOICE is Gemini reading the measured brain state and speaking as the fly; it never feeds back into the brain (ADR 20/36). BODY rows on the board are simulated vitals and say so (ADR 12).
- **What the brain still owns:** when to turn, escape, stop, back up, feed, groom, sing, extend the proboscis, and whether it wants a thing at all. `act.forward` defaults to 0: no brain, no fly (ADR 78), and a dropped brain blinks the fly out rather than hiding it (ADR 107).

The full list, with the measurement behind each call, is in [docs/knowledge/DECISIONS.md](docs/knowledge/DECISIONS.md); the short version in [docs/DECISIONS.md](docs/DECISIONS.md).

## Performance notes

- **The page.** WebGPU: about 100 ms of wall time per 50 ms brain step on an M1 Max (79–143 ms measured, ADR 55/61), the CPU fallback about 850 ms. The dashboard draws all 166,700 neurons and a million synapses at a locked 60 fps at 1600x1000 while the brain steps (ADR 61). BOOST BRAIN pauses the previews so the GPU only thinks.
- **The glasses.** The lens sends a telemetry row every 2 s; the page prints it in the browser console as `LENS_PERF fps … worst … | perf …` and shows it in the footer as *glasses frame*. `perf/perf_rows.py` summarises a saved log. The editor instrument is the same row in the Lens Studio log (`PERF_ROW`).
- **The perf pass (21.09, `perf/`).** A differential sweep in the LS 5.23 preview with a page brain: the preview frame is render-bound on the Mac (~50 ms), the lens's scripts are ~3.6 ms of it (board 0.9, eye rays 0.3, bodies 0.2); no config switch moves the editor frame beyond noise. On the glasses the script side is what differs (a much slower CPU), so the ranked script costs are the candidate list, and a knob is changed only after a device row says so (`perf/PERF_2026-09-21.md`).
- **The Mac server.** Wall time per 50 ms of brain time, per fly, M1 Max: Metal 41 ms (1 fly), 73 ms (3), 123 ms (5); CPU packed kernel 238 / 151 / 185 ms. Details in [docs/METAL_KERNEL.md](docs/METAL_KERNEL.md).

## How it works, in more detail

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the loop, the relay protocol, the lens modules, the page.
- [docs/SENSES_AND_READOUTS.md](docs/SENSES_AND_READOUTS.md): which room signal enters which neurons, and which neurons move which body part.
- [docs/METAL_KERNEL.md](docs/METAL_KERNEL.md): the Mac server's GPU kernel and how it stays bit-exact.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): symptoms, causes and fixes.
- [docs/TEACHING.md](docs/TEACHING.md): the conditioning sessions, in plain words.
- [docs/knowledge/INDEX.md](docs/knowledge/INDEX.md): the engineering record (decisions, runbook, component contracts, tests, backlog, handoff).
- [web/DEPLOY.md](web/DEPLOY.md): deploying the page and the Supabase project.

## Credits

CyberFly stands on open science and open code:

- **MaleCNS v1.0 connectome**: HHMI Janelia FlyEM with Google Research and the University of Cambridge / MRC LMB, CC BY 4.0. [male-cns.janelia.org](https://male-cns.janelia.org/)
- **LIF brain model**: Shiu et al., *A Drosophila computational brain model reveals sensorimotor processing*, Nature 2024. [Code](https://github.com/philshiu/Drosophila_brain_model)
- **Learning rule**: Huang, Luo et al., *Dopamine-mediated interactions between short- and long-term memory dynamics*, Nature 2024. [10.1038/s41586-024-07819-w](https://doi.org/10.1038/s41586-024-07819-w)
- **fly-wirehead** by Matty Hempstead (no licence file of its own; its neural core is **stonkfly** / DOOMFLY, MIT): the model and runtime the Mac server runs on and the C++ core re-implements statement for statement. [fly-wirehead](https://github.com/mattyhempstead/fly-wirehead), [stonkfly](https://github.com/nftechie/stonkfly)
- **flybody** (DeepMind and HHMI Janelia, Apache-2.0): the fly body model. [TuragaLab/flybody](https://github.com/TuragaLab/flybody)
- **Snap Spectacles** packages and samples: Spectacles Interaction Kit, UI Kit, Sync Kit, Remote Service Gateway, LEAF, the Depth Cache sample's colour/depth pairing.
- **three.js** (MIT) for the page's room and brain; **Open-Meteo** for the weather; **Supabase** / **Snap Cloud** for the relay.

Full attribution and licences: [THIRD_PARTY.md](THIRD_PARTY.md).

## License

CyberFly's own code is MIT, see [LICENSE](LICENSE). Data, models and packages from others keep their own licences, listed in [THIRD_PARTY.md](THIRD_PARTY.md).
