# Troubleshooting

## Brain server

| Symptom | Cause | Fix |
|---|---|---|
| Server dies at start with a `c++` or Metal build error | kernels compile on first run; no Xcode command line tools, or macOS < 15 for Metal | `xcode-select --install`; on macOS 14 or Intel use `METAL=0 scripts/run_server.sh` |
| `run_server.sh`: port 8790 is busy | a server is already running (a second one would also claim `flybrain.local`) | `pkill -f brain_server/server.py`, then start again |
| `xcrun metal`: missing Metal Toolchain | the offline shader compiler is not installed | not needed: `brain.metal` is compiled at run time |
| Metal state differs from CPU only in tiny `g` values | Apple GPUs flush float denormals to zero | expected and harmless; `test_metal.py` compares modulo denormals |
| Multi-fly GPU batch diverges | two batches in flight at once | fixed (one batch + mutex); after any engine change run `engine/metal/test_metal.py --ms 1500` |
| Brain is several times slower than real time | CPU kernel under load | use `--engine batch --kernel metal` (the `run_server.sh` default); fewer flies is the next lever |
| `bad json` / merged frames in the server log | the editor preview can append bytes after a frame or merge two frames | `protocol.decode_many` handles both |
| Want to test the engine while a live server runs | a second server announces the same mDNS service | use `engine/test_contract.py` (pipes, no network) |

## Connection

| Symptom | Cause | Fix |
|---|---|---|
| Lens cannot reach the Mac | guest Wi-Fi client isolation, firewall prompt, blocked mDNS | same subnet (a hotspot works), accept the firewall prompt; if `flybrain.local` does not resolve set `WS_URL` to `ws://<mac-ip>:8790` |
| Brains get two worlds at once, jumpy escapes | two preview panels (or the editor and the glasses) drive the same brains | keep one lens connected: close extra previews, pause the editor during device tests |

## Lens

| Symptom | Cause | Fix |
|---|---|---|
| Camera frames black, Gemini finds nothing on the glasses | camera access is blocked when a lens also uses open internet | enable Extended Permissions for the lens |
| Gemini calls fail | no token in the repo | paste your own Remote Service Gateway token on `RemoteServiceGatewayCredentials` |
| Shader works in the editor, draws nothing on the glasses | the device cross-compiler rejects an input named `color` (and GLSL built-in names) | never name shader inputs `color`, `texture`, `sample`, `mix`...; grep the Lens Studio log for `CrossCompiler error` after every send |
| Dark text invisible on the glasses | the display is additive: dark means transparent | bright text on a dim plate |
| Fly eyes report 0/12 hits right after start | the world mesh builds as you look around | do the room scan first |
| Editor preview: no world mesh, flies ignore walls | the preview is not in 3D mode | click the 3D mode icon in the preview toolbar |
| Editor: SCANNING ROOM never ends | the scan ends on the button | press DONE SCANNING on the board (clickable with the mouse) |
| Gemini labels land in the wrong place | colour and depth frames paired too far apart in time | the scanner discards the first depth frame after a start and refuses pairs older than `SCAN_PAIR_MAX_MS` |
| Materials white or unbound after a fresh clone | shader `.meta` files missing | they are tracked; keep `.mat.meta` and `.ss_graph.meta` next to their files |
| `TS2304` right after a batch of edits, then green | files compile as they are saved | trust the next compile |
| Package warnings about a newer Lens Studio at load | some packages were built with a later editor | benign in this project; open and save only with 5.15.4 |
| STRESS / STOP bars full from the start | PPL101 and DNpe007 are tonically active | bars fill from each row's resting level; read the Hz value for the absolute rate |

## Performance on the glasses

- Turn telemetry on (`DEBUG_TELEMETRY_S` 2) and read the `LENS` lines in the server log: fps, worst frame and per-subsystem cost ranked by mean.
- The lens is CPU-bound; the GPU has headroom. Reduce script work first (fewer flies, `VISION_HZ`, `SCAN_EVERY_S`).
- Recording video costs encoder time and heat. Set `DEBUG_TELEMETRY_S` 0 before recording.
