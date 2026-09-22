# HANDOFF — for whoever picks this up (written 21.09.2026, evening)

You are picking up CyberFly: a Snap Spectacles lens whose hologram fruit fly is driven by a real
MaleCNS connectome brain (166,700 neurons) that runs on a web page (WebGPU). Read in this order:
`INDEX.md` → `DECISIONS.md` (ADR 89–107 are the latest) → `RUNBOOK.md` → `COMPONENTS.md`. Then this file.

## What is DONE
- Web page rebuilt for a curious visitor: `?demo=1` always runs (one fly, its body driven by the
  brain's own decisions), no TRAINING tab, plain header, phone layout, BOOST BRAIN chip (pauses every
  preview: the GPU only thinks), brain file versioned (`brain.version`), every script URL versioned
  per build (`release.sh` cache-bust), landing says computer or strong phone.
- Lens (`Spectacles-5.23/`, and the same state in `Spectacles-5.15/`): sixteen smells (re-exported
  brain file `brain_c0_od16.flyb.z`), real-forecast climate + Gemini per-thing fields, inspector
  (rings, smell + meaning caption), board (fly shows through, side panel on hover/tap, plain labels,
  PIN in the header), body animations from brain commands, buzz back, grooming fixed at the root
  (ADR 100/106), stale senses decay (104), memory τ 3 h (92), head-locked intro cards, learnable
  threat + hunger-gated reward (102/103), a dropped brain blinks the fly out + header BRAIN: DROPPED
  (107), `PERF_ROW` perf rows in the LS log.
- The 5.15 project is the build for Spectacles (2024). Before ANY device build there:
  `python3 web/lens_key.py --cfg Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts`, and `--clear`
  the same way before a commit. Without the key the glasses never join their room and the phone page
  says "NO GLASSES FOUND" (RUNBOOK).

## What to do next, in order
1. **Deploy the page.** Follow `web/DEPLOY.md` → "AGENT CHECKLIST" exactly (build, four pre-upload
   checks, upload `web/site/` whole, four live-host curls, the page check). Your own Snap Cloud or
   Supabase project goes in with `release.sh --sb <ref> --key <anon>`.
2. **Device pass** (send the lens to the glasses; read the Lens Studio log and the page's browser
   console: every 2 s the glasses' `LENS_PERF fps … worst … | perf …` row, the footer shows it as
   `glasses frame`): expect `WEB_BRAIN_ON page=web`, `LINK_BASELINE cells=93`, `FLY_SHOWN`, BODY_SIG
   rows with `groomLvl > 0.2` while landed and dusty, `THREAT_LESSON` after a fast hand at the fly,
   `REWARD_US` on a food landing, `WEATHER_OK`, `SCAN_SOURCE … smell=`. Things to eyeball on the
   glasses: sixteen ring hues on the additive display, centred head-locked intro cards, side panel
   on hover, buzz by distance, mini fly smoothness, the header "PIN NNNN · BRAIN: ON YOUR WEB PAGE".
3. **Editor validation without glasses:** `web/serve.sh page` (port 8796) +
   `uv run --with websockets python web/pagebrain.py 8796 900` (needs `web/site/config.js` from one
   `web/release.sh`) gives the editor lens a brain; then the LEAF scenarios (`TESTING.md`, LS 5.23
   only): `start_to_board`, `scan_card_hold`, `inspect_thing`, `row_hover_panel`. `run_leaf_scenario`
   over MCP often times out although the scenario passes — read `PASSED:`/`FAILED:` from the LS log.
4. **Two headsets in one room** (COLOCATED on the start card, ADR 53): verified between two editor
   previews; a real two-device session with a shared map is the next test.

## Rules that bite (do not learn them the hard way)
- **Secrets.** `FlyConfig.ts` holds a pasted anon key locally: `python3 web/lens_key.py --clear`
  before any commit that touches it, `python3 web/lens_key.py` after. The Remote Service Gateway
  tokens on the `RemoteServiceGatewayCredentials` object in `Scene.scene` are per account: generate
  your own in Lens Studio, never commit them (the repo ships them empty).
- **Motion and learning come from the brain.** Every engineered input/override is a disclosed ADR.
  Never fake behaviour. The demo body integrates the brain's decisions; keep it that way.
- **Audience rule.** Every user-visible word is for someone with zero context: WHAT / WHY / WHAT DO I
  DO; atlas names small print.
- **Knowledge OS while working:** decision → ADR (next number after 107); gotcha → RUNBOOK; contract
  → COMPONENTS; backlog items `[x]` with a DONE note keeping the original quote. Tighten, don't grow.
- **Every TypeScript save resets the preview** — measure telemetry in one clean run.
- **Lens Studio:** 5.23 opens `Spectacles-5.23/`, 5.15.4 opens `Spectacles-5.15/`; never the other way
  round, and never move packages between them. LS writes its MCP config into the project folder;
  never commit it. Compile with `RecompileTypeScriptTool`, runtime with `RunAndCollectLogsTool`.
- **Web:** `web/config.js` in the repo has an empty ref and key on purpose; `release.sh` bakes the
  real ones into `web/site/config.js`.
