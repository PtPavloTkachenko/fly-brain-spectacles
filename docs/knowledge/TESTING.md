# CyberFly — LEAF tests (Lens Studio 5.23 preview, the 5.23 project)

Nine LEAF scenarios (the list is at the end) drive the WHOLE flow in the Lens Studio preview on the real keys the board builds at
runtime (SIK `Interactable`s named `<Key>Hit`): the start card, the room scan, the board and the guide,
the web brain joined by PIN (page_sim.py stands in for the page), a FOOD training session driven by the
page with its Gemini/local verdict, the board's grip and the guide card.
They read the lens's own state through the `FlySwarm` instance (private fields via `any`: a test may
look inside) and log `LEAF_STEP <name>` (a screenshot point) and `LEAF_NOTE k=v` (a measured number)
next to the lens's own markers, so the LS log stays the ground truth.

## Files
| where | what |
|---|---|
| `Spectacles-5.23/Assets/Scripts/Leaf/CyberFlyTestKit.ts` | shared helpers: `swarm()`, `board()`, `waitFor`, `key(name, underAncestor)`, `CyberFlyLeafInteractor.tap()` (resolves to the lens time of `onTriggerStart`), `pressSolo()`, `ensureBoard()`, `aimErrorDeg()`, the `bugs` list |
| `…/Leaf/StartToBoardScenario.ts` | `start_to_board` |
| `…/Leaf/WebBrainHandoverScenario.ts` | `web_brain_handover` |
| `…/Leaf/TrainFoodSessionScenario.ts` | `train_food_session` |
| `…/Leaf/GripAndGuideScenario.ts` | `grip_and_guide` |
| `…/Leaf/LeafIndex.ts` | the registry (`@scenariosIndex`), on the root scene object **`LeafIndex`** |
| `Spectacles-5.23/Packages/Leaf.lspkg` | LEAF (packed); the LEAF panel plugin adds the root object **`LEAF Plugin Bridge`** to `Scene.scene` the first time it opens |
| runner (not shipped) | anything that can call the LS MCP tools: set the token, run by id, screenshot every `LEAF_STEP`, start/stop `page_sim.py`, grade from the LS log (the steps are below) |

## The scenarios
| id | drives | asserts (LEAF `expect`, in the lens) | needs |
|---|---|---|---|
| `start_to_board` | `StartSoloHit` → `ScanDoneHit` on the real cards | start card up, Sync Kit menu's children all disabled; card gone < 0.4 s after SOLO; scan card + typewriter (WALK… or KEEP GOING, prefix and growing); board `Content` and `FlyGuide` enabled after DONE (measured `done_to_board_s`); `introT <= 0`; the runner checks no `E`/`TypeError` line in `[Preview 2]` | a fresh lens (the LEAF panel restarts it before every run) |
| `web_brain_handover` | nothing to press: a page joins `realtime:fly-<pin>` | `WEB_BRAIN_ON` within 15 s of the `s3_need_page` marker; `engine=web`; board status contains `WEB`; `SCENE_FEED on` (`feed.sent>=1`) and `SURFACE` (`feed.surfHead`); page step < 300 ms in `link.latest[0].wall_ms` AND in the board footer; after `s3_stop_page` the lens drops the web brain with the page quiet 6–8 s (`PAGE_TIMEOUT_S` 6 + 2), status leaves `WEB` — and since ADR 87 nothing in the lens takes over: with no Mac socket the fly is withheld (ADR 78) | `page_sim.py --pin <pin> --gpu` started by the runner on `s3_need_page`, killed on `s3_stop_page` |
| `train_food_session` | a page order `cmd train mode=food cs=<thing> bouts=1` | ≥ 2 known room things (logged as `LEAF_THINGS [[label, cm]…]`, nearest first — the runner names the cue from it); `WEB_BRAIN_ON`; `TRAIN_START` with `mode=food`; `TRAIN_CS` (label set); one `LEAF_STEP s4_rowN` per `TRAIN_TRIAL`; `phase=done` within 215 s; at least one `cs+` row with `us>=16`; `TRAIN_VERDICT` (`tr.verdict.via` — `gemini` through the lens's gateway or `local (...)`); `state.result` non-empty and changed; the guide's rebuild key carries it | `page_sim.py … --cmd train --mode food --cs "<label>" --bouts 1 --cmd-after 8` started by the runner on `LEAF_THINGS` |
| `grip_and_guide` | `GripHit` hover + drag, `GuideHit`, `GuideOkHit` | hover fires `onHoverEnter`; short drag pulls until the anchor (`boardFrameObj`) moved 10–60 cm; its aim error to the camera after < 5° and smaller than before (`faceUserWhileCarried`); the board still in view; `?` toggles `guide.visible`, GOT IT hides it and `FlyGuide` slips out | — |

`WebBrainHandoverScenario.ts` matches the board status on `PAGE` (the brain line reads `BRAIN: ON YOUR WEB PAGE` since ADR 84/85); `WEB_BRAIN_ON` / `engine=web` are the log-side equivalents.

## How to run
1. LS 5.23 with `Spectacles-5.23/Spectacles.esproj` open, the MCP server up, both preview panels rendering. Open the LEAF panel (`open_leaf_panel`); `list_leaf_scenarios` must show the nine ids (the `LeafIndex` object registers them).
2. The fixed PIN: `scene-graphql` → `mutation { setProperty(id:"6eb3751b-1395-4f1c-ad29-069108382b99", propertyPath:"debugScenario", valueType: STRING, value:"pin=1234") { success } }` (the FlySwarm ScriptComponent). The value is read at the next lens start; the LEAF run restarts the lens itself.
3. `run_leaf_scenario {"scenarioId":"start_to_board","onDevice":false}` — one at a time; the tool returns `{"status":"succeeded"|"failed"}` when the scenario finishes; the reason of a failure is the `E [DefaultLeafScenarioManager] FAILED: <id> - …` line in the LS log (`~/Library/Preferences/Snap/Lens Studio/logs/LensStudioLog-<date>.txt`, `[Preview 2]`).
4. Screenshots: `CapturePanelScreenshotTool {"pluginId":"Snap.Plugin.Gui.PreviewPanel"}` on each `LEAF_STEP` line (the runner tails the log). Do NOT pass `previewName`: the tool's label registry goes stale when panels are recreated and answers "No unassigned preview panels available"; the unlabelled call captures the default panel — check `panelTitle` in its result.
5. The web page without a browser, from the runtime dir (the ADR 67 pair gives `effOn`/`mbon07` in the rows):
   `cd ~/cyberfly_runtime/fly-wirehead && uv run --with websockets python "<repo>/web/page_sim.py" --pin 1234 --gpu --name "leaf page" --lib "<repo>/core/build/libflybrain_kcinh.dylib" --flyb "<repo>/core/brain_export/out/brain_c0_apl.flyb.z" [--cmd train --mode food --cs "<label>" --bouts 1 --cmd-after 8]`
   Start it when the scenario logs `s3_need_page` / `LEAF_THINGS`, stop it (its own process group, never by name) on `s3_stop_page`. The relay `web/relay.py` must be up on 8795 (no Mac brain server is needed: `page_sim.py` is the brain).
6. Afterwards: `debugScenario` back to `none` (the same mutation) and save the project (`ExecuteEditorCode`: `pluginSystem.findInterface(Editor.Model.IModel).project.save()`).

Every script save in the project — anyone's — recompiles and restarts every preview, which aborts a running scenario (`Tool execution failed: Widget is not initialized`, then `BOARD_FRAME` + `START_CARD` again in the log). The runner reports such runs as INTERRUPTED with the file that was saved; re-run them.

## Debug tokens (`FlySwarm.debugScenario`, `+`-joined; serialized in `Scene.scene`, the scene value wins over the TypeScript default)
| token | effect |
|---|---|
| `none` | nothing (leave it so) |
| `pin=NNNN` | the web PIN is NNNN instead of a random one — applied at the top of `FlySwarm.start()` (`WebBrainLink.setPin`), before the board caches it for its footer; the relay room is `realtime:fly-NNNN` |
| `auto_solo` | editor bench: SOLO at 2 s, DONE SCANNING at 12 s, TEACH at 18 s (calls `chooseStart`/`endIntro`/`board.teach` directly, not the keys) |
| `train`, `train_danger|forget|test|choice|transfer|reset` | seeds `sugar cube` + `blue mug` as known things; with `auto_solo` the bench picks the mode at 20 s and names the cue at 23 s |
| `treats` | one treat per model in front of the fly |
| `lure_front`, `food_left`, `food_right`, `threat_approach` | one seeded source |
| `skip_intro` | exact match only (`===`), not a `+` token: no scan, the board at once |

## What the suite cannot do (and why)
- **A real hand or the Preview's `PreviewInteractTool`**: LEAF's `DefaultLeafInteractor` targets the `Interactable` directly (it overrides the SIK interactor's `currentInteractable`), so the scaled box colliders of the `hit()` objects never matter; `PreviewInteractTool` raycasts and misses them.
- **`TRAIN_UNAVAILABLE` from the key itself**: `FlyBoard.teach()` refuses a press before the trainer (`if (!this.learnReady && on) return`, no log); the marker comes from the trainer's entry points, so a scenario calls `FlyTrainer.setOn(true, fly)` after the key.
- **The TEACH gate has no scenario since 20.09** — a gap, not a lost capability. `TeachGatedNativeScenario.ts` went with ADR 87; the gate itself is untouched (`TRAIN_WEB_ONLY` + `host.pageOn()`), only its log line changed: `TRAIN_UNAVAILABLE reason=no_page pin=NNNN`. A rewrite asserts on that string.
- **The page's own `MEMORY_SAVE`**: `page_sim.py` ignores `{t:"memory"}`; the save that appears comes from the Mac socket / native core answering the same `get` (they get every message too). The real page (`web/app.js`) answers.
- **Two lenses in one room**: the token lives in the shared scene, so any preview restarted while it is set joins `fly-1234` too. Only Preview 2 restarted during the runs of 15.09 (Preview 1 had no lens restart since 09:31).
- **A Bitmoji IK reach test** (`createIKInteractor`): not written; the board is head-locked/framed in the editor and the reach geometry belongs to the glasses.

## Lens bugs the suite found (15.09) — found by the tests, fixed in the lens afterwards
1. **The start card's SOLO / MULTIPLAYER keys do nothing but hide the card.** `FlySwarm.start()` sets `this.board.onStart = (multi) => this.chooseStart(multi)` inside `if (this.board)` at line 274, and the board is only built at line 292, so the callback is never wired; Sync Kit never gets `onSinglePlayerPress()`, no session, no scan card. The bench never saw it: `auto_solo` calls `chooseStart(false)` directly. Fixed: `FlySwarm.start()` now wires `onStart` right after `new FlyBoard(...)`. `pressSolo()` still records `BUG …` and falls back to `FlySwarm.chooseStart(false)` if it ever regresses.
2. **The TEACH key's hint never names the PIN.** `setTrainAvailable(false, why)` runs from the first frame, before the hint Text exists (it is built with the brain's first `memory` field), then returns early forever (`ready === this.learnReady && why === this.learnWhy`); `setLearnState()` returns early too (`on === this.learnOn && learnLabel.text !== ""`). `learnWhy` holds "TEACHING NEEDS THE WEB BRAIN // open the page, PIN 1234", the card shows "turns learning on: ASK it to find a thing…" and the label is not dimmed. Fix: after building the key in `showLearnButton`, write the hint/fill from the cached `learnReady`/`learnWhy` (or reset the cache so `setTrainAvailable` re-applies).

## Last run (15.09, LS 5.23.2, Preview 2, `pin=1234`, page_sim on the ADR 67 pair)
| id | result | measured |
|---|---|---|
| `start_to_board` | FAIL — lens bug 1 only (every other assertion held) | Sync Kit menu children enabled 0/1; SOLO → card hidden **0.27 s** (bound 0.4); scan card 4.97 s after SOLO (4 s of it the wait that proves the bug); typewriter `K` → `KEEP GOIN` (phase 1); DONE → board **0.27 s**, guide 0.27 s; `introT` 0; no `E`/`TypeError` line |
| `teach_gated_native` | FAIL — lens bug 2 only | `available=false`, `learnReady=false`, `learnWhy='TEACHING NEEDS THE WEB BRAIN // open the page, PIN 1234'`, hint Text = the generic learning line (the bug); the press opened neither picker nor guide, `phase` stayed `off`; `TRAIN_UNAVAILABLE reason=native pin=1234` from `setOn` |
| `web_brain_handover` | PASS | `WEB_BRAIN_ON page=leaf page` **0.67 s** after the marker (page joined in 0.6 s); status `BRAIN WEB`; `SCENE_FEED on` 47–48 KB, `SURFACE tris=11506 verts=6090 parts=4`; step **208 ms** (Mac socket) → **114 ms** (page GPU, board footer `step 114 ms … web pin 1234`); page killed → `WEB_BRAIN_OFF` with the page quiet **6.05 s** (7.67 s after the marker incl. the runner); status `BRAIN NATIVE x2`, `engine=native` (the in-lens brain of 15.09, gone since ADR 87) |
| `train_food_session` | PASS (220 s) | things nearest first `record player 178 cm, framed art 189, black speaker 227`; `cmd train mode=food cs='record player' bouts=1` → `TRAIN_START` (log prints the editor default `bouts=2`, state 1) → `TRAIN_CS cs+='record player' (odor_dm4) cs-='framed art' (odor_va2)`; 6 `TRAIN_TRIAL` rows, session **195.9 s**; the paired bout `lat=33.8s d0=113 dmin=0 us=16`; `TRAIN_DONE why=done … PLASTICITY WAS OFF - CONTROL RUN`; `TRAIN_PACK {frozen:true, effOn cue 0.94401 / control 0.89131}`; `TRAIN_VERDICT learned=no conf=0.90 via=gemini` 3.5 s later; the guide's result line changed; 12 `MEMORY_SAVE` lines |
| `grip_and_guide` | PASS | `?` toggled the guide true → false → true, GOT IT closed it and `FlyGuide` slipped out; grip hover fired; simulated hand drag **0.0 cm** (no manipulation), synthetic-ray drag **136.5 cm** in one 120 ms pull; aim error to the camera **44.4° → 6.2°** (`faceUserWhileCarried`) |

Two things in that run that are not test bugs and not yet explained (for the brain/page owners):
- **The training rows changed brains mid-session.** Rows 1–2 carried `learn=on chg=3862/3906 eff≈0.97`; from the paired bout on every row read `learn=off chg=0 eff=1.0000` (then `chg=3931` again in probe1) while the Mac core kept saving `changed=4100+`. Nothing in the log resets a brain (`TRAIN_*`, `MEMORY_*`, `WEB_BRAIN_*` only). Either the page core's memory was wiped and its `learning` flag dropped, or `link.latest[0].memory` is read from different sources at different times. Until it is understood, a FOOD session over `page_sim.py` is a control run (`frozen:true`) and Gemini says so.
- **A drag through LEAF is a jump, not a pull.** SIK's far-field `InteractableManipulation` fed by LEAF's synthetic ray moves the root about a metre on the first frame; the simulated hand does not move it at all. A 15 cm calibrated drag needs a real hand (device) or a manipulation-side test hook.

## LEAF scenarios (21.09)
`probe_key`, `start_to_board`, `web_brain_handover`, `train_food_session`, `grip_and_guide`, plus three from 21.09: `scan_card_hold` (the head-locked scan card: anchor 100 cm in front, aimed at the eyes; leaves the card up), `inspect_thing` (tap a scanned thing: rings on, no box, caption names the smell and the meaning; leaves it attended), `row_hover_panel` (a dwelling hover opens a NEURAL row's side panel and swaps on another row; leaves it open); and `brain_lost` (the page drops: the fly blinks out and the header reads BRAIN: DROPPED, ADR 107). Nine in `LeafIndex.ts`. Run them from the LEAF panel or `run_leaf_scenario`; the last three end in a state made for a screenshot (`PreviewPanelTool screenshot`).

