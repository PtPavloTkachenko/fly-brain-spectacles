# Troubleshooting

The full "Gotchas" table, sorted by symptom, is [knowledge/RUNBOOK.md](knowledge/RUNBOOK.md). These are the ones a person setting the project up meets first.

## The page and the PIN

| Symptom | Cause | Fix |
|---|---|---|
| No fly at all, in the preview or on the glasses, and the board says BRAIN OFFLINE | ADR 78: the fly exists only while a brain steps it, and since ADR 87 the lens has no brain of its own. The only brains are a page joined by PIN, or the Mac server over the (off by default) socket | open the page, type the PIN; in the editor, `web/pagebrain.py` gives the preview a brain |
| The page says `NO GLASSES FOUND FOR PIN nnnn` while the glasses show that PIN | the lens's `FlyConfig.ts` has no anon key, so it never joined its relay room | `python3 web/lens_key.py --cfg Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts` (the key comes from a built `web/site/config.js`), recompile, send again; `--clear` before a commit |
| No `PIN` on the board, and the Lens Studio log has no `WEB_RELAY_*` line | the PIN is drawn only after the start card and the room scan; or the relay socket never opened | finish the scan; read `WEB_RELAY_OPEN pin=` / `WEB_RELAY_REFUSED` in the log |
| The page shows `RELAY UNREACHABLE` / `THE LINK SERVER REFUSED PIN nnnn` / `NO GLASSES FOUND FOR PIN nnnn` / `GLASSES LOST` | the header names the fault: relay URL, the anon key, the PIN, or the lens went away | read the fault line; `web/DEPLOY.md` "Common problems" matches those words |
| The deployed page still asks for a relay URL on the PIN card | `config.js` in the upload has an empty `ref` (the site was built without a project) | `web/release.sh --sb <ref> --key <anon>` and upload again |
| The page says "no WebGPU" and the brain is slow (~850 ms a step) | no WebGPU: an old browser, or the page is not served over HTTPS (localhost counts as secure) | Chrome/Edge 113+ or Safari 26+, over `https://` |
| 404 on `brain_c0.flyb.z` | the brain file is not next to `index.html` | download it from the repository's brain release and put it in the same folder |
| The brain never starts after an FTP upload (`404`/`CompileError` on `dist/flybrain.wasm`) | `.wasm` served without `application/wasm`, or `.flyb.z` re-encoded by the host | upload the hidden `.htaccess` that `release.sh` writes; nginx rules in `web/DEPLOY.md` |
| The page looks like the previous build after a deploy | browsers cache `app.js` and the modules for days | `release.sh` stamps every script URL with the build; upload the whole `web/site/` |
| A dev page with `?sb=<ref>` cannot resolve `wss://<ref>.supabase.co` | the host default is `snapcloud.dev` for a Snap Cloud project | add `&host=` / build with `--host supabase.co` for a supabase.com project |
| The page's neuron cloud shows only optic and sensory regions and every rate is flat | the WebGPU backend never received the synapses (an edge upload path issue) | run `web/test.html?steps=40&chunks=3` headless; `gpu_check` must be clean |
| The fly vanished with a blink and the header says BRAIN: DROPPED | the page went quiet (closed tab, laptop asleep, relay hiccup) for more than `PAGE_TIMEOUT_S` | reopen the page with the same PIN; the fly blinks back in (ADR 107) |

## The glasses

| Symptom | Cause | Fix |
|---|---|---|
| Camera frames black, Gemini finds nothing on the glasses | camera access is blocked when a lens also uses open internet, unless the wearer accepts the permission prompt | accept the prompt, or enable Extended Permissions for the lens in the Spectacles app while developing |
| Gemini calls fail | no Remote Service Gateway token in the scene (the repo ships them empty) | generate your own in Lens Studio and paste the Google Token on `RemoteServiceGatewayCredentials` |
| A shader works in the editor and draws nothing on the glasses | the device cross-compiler rejects an input named `color` (and GLSL built-in names) | never name shader inputs `color`, `texture`, `sample`, `mix`…; grep the Lens Studio log for `CrossCompiler error` after every send |
| Dark text invisible on the glasses | the display is additive: dark means transparent | bright text on a dim plate |
| The lens cannot reach the Mac server (socket path) | `BRAIN_SOCKET_ENABLED` off, Experimental APIs off, guest Wi-Fi client isolation, the firewall prompt, or mDNS blocked | same subnet (a hotspot works), accept the prompt; if `flybrain.local` does not resolve set `WS_URL` to `ws://<mac-ip>:8790` |
| The fly ignores the weather; `clim=none` in the telemetry | no internet, the location prompt refused, or Open-Meteo unreachable; `WEATHER_FAIL <why>` is logged once | it still fetches for `WEATHER_LAT/LON`; otherwise the climate stays neutral |
| No `THREAT_LESSON` although you rushed a hand at the fly | the loom stayed under `THREAT_LESSON_LOOM` (a slow hand, or one that started close), or the 4 s refractory | a fast approach from further away; read `THREAT_LESSON` / `REWARD_US` in the log |
| A fed fly learns nothing from landing on food | by design (ADR 103): the reward is scaled by hunger, 0.2 at full energy | wait until it is hungry (a session starves it: `TRAIN_STARVE`) |
| Grooming never fires while the fly sits dusty | fixed in ADR 100/106 (DNg12 read against rest, range 5 Hz); an old brain file or core still has the old scale | rebuild the page's WASM (`web/build_wasm.sh`) and re-export the brain file |

## Lens Studio

| Symptom | Cause | Fix |
|---|---|---|
| Editor preview: no world mesh, flies ignore walls, the scan term of the telemetry row says `cal=hits0` | the preview is not in 3D mode | click the 3D mode icon in the preview toolbar (after the project loaded) |
| Editor: SCANNING ROOM never ends | the scan ends on the button | press DONE SCANNING on the board (clickable with the mouse) |
| The start card's SOLO / COLOCATED key does not take the simulated pinch | UI Kit buttons ignore the preview's synthetic pinch in this project | set `FlySwarm.debugScenario` = `auto_solo` (editor only: SOLO at 2 s, DONE at 12 s); revert to `none` |
| `debugScenario` set in the `.ts` file does nothing | it is a serialized script input: the value in `Scene.scene` wins | set it in the Inspector (or `scene-graphql setProperty` in 5.23) |
| Materials white or unbound after a fresh clone | shader `.meta` files missing | they are tracked; keep `.mat.meta`, `.ss_graph.meta` and `.graphShader.meta` next to their files |
| `TS2304` / `TS2339` right after a batch of edits, then green | files compile as they are saved | trust the next compile |
| Lens Studio compiles a STALE copy of a script | LS mirrors `Assets/` into `Cache/TypeScript/Src/` and missed a change | touch the file again, or restart Lens Studio |
| A `NeonBatch` throws `Can't set vertex, index = N` | the batch sizes its mesh at the first `flush()`; a quad added later has no vertices | add every quad before the first flush; lazily created keys get their own batch |
| Package warnings about a newer Lens Studio at load | a package built with a later editor | open `Spectacles-5.15/` only with 5.15.4 and `Spectacles-5.23/` only with 5.23; never move packages between them |
| Every telemetry window comes back empty | every TypeScript save (including `lens_key.py`) recompiles and resets the preview | measure in one clean run |
| The STRESS / STOP bars are full from the start | PPL101 and DNpe007 are tonically active | the bars fill from each row's resting level (ADR 38); read the Hz value for the absolute rate |
| LS 5.23 preview: the fly is blind (`'from' texture should be loaded` on every eye sample) | a preview-only readback limitation; the device is unaffected | eye numbers (`read=`) are a device measurement |
| LS 5.23: a LEAF scenario longer than ~55 s never reports over MCP | the MCP call's own timeout is shorter than the scenario | read `PASSED:` / `FAILED:` from the Lens Studio log |

## The Mac brain server

| Symptom | Cause | Fix |
|---|---|---|
| Server dies at start with a `c++` or Metal build error | the kernels compile on first run into `$CYBERFLY_RUNTIME/engine_build/`; no Xcode command line tools, or macOS < 15 for Metal | `xcode-select --install`; on macOS 14 or Intel `METAL=0 scripts/run_server.sh` |
| `run_server.sh`: port 8790 is busy | a server is already running (a second one would also claim `flybrain.local`) | `pkill -f brain_server/server.py`, then start again |
| `xcrun metal`: missing Metal Toolchain | the offline shader compiler is not installed | not needed: `brain.metal` is compiled at run time |
| Metal state differs from the CPU only in tiny `g` values | Apple GPUs flush float denormals to zero | expected and harmless; `test_metal.py` compares modulo denormals |
| The brain is several times slower than real time | the CPU kernel under load | `--engine batch --kernel metal` (the `run_server.sh` default); fewer flies is the next lever |
| Brains get two worlds at once, jumpy escapes | two preview panels (or the editor and the glasses) drive the same brains | keep one lens connected |
| `server.py --engine native` ignores `memory` / `learning` | an old `libflybrain_host.dylib` | rebuild it: `clang++ -O3 -std=c++17 -shared -fPIC -I core/include -I core/src -I/opt/homebrew/include core/src/flybrain.cpp core/src/gpu/vkbrain.cpp -lz -o core/build/libflybrain_host.dylib` |
| After any change to the GPU engine, Xcode or macOS | the kernels must still be exact | `engine/metal/test_metal.py --ms 1500 --chaos`, `core/tools/compare.py --post '{"gpu":1}'` |

## Learning and memory

| Symptom | Cause | Fix |
|---|---|---|
| The TEACH key is dim and will not open the picker | by design (ADR 68): teaching only runs while a page is the brain | open the page with the PIN |
| A session finishes with `eff 1.0000 chg 0` | plasticity was never live: the rows say `learn=off` and the card says CONTROL RUN | `NATIVE_LEARNING` on, a brain file with plastic edges, a page that answers `learning` |
| `TRAIN_TRIAL` prints `mbon07=-` | the brain file predates the MBON readouts | use the current brain file from the release |
| A session learns but the CS− control moves with the CS+ | measured (ADR 65/67): the two cues fire ~95 % the same Kenyon cells; the cue-specific effect is in `memory.eff_on`, not in the global mean | read `eff_on` per cue; TEST / CHOICE / TRANSFER sessions |
| The memory looks smaller every time you TEST it | the after-probe is itself an unpaired presentation: repeated testing is extinction | test once |
| `MEMORY_TOO_BIG` / nothing stored | the glasses' persistent store is 102,400 bytes in total | the compact blob (10 bytes per moved synapse) fits a normal session; nothing to do |
