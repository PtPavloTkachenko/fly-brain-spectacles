/**
 * FlyConfig — every tunable of the fly lens in one place (units: cm, s, rad).
 * Named + dated so the tuning ladder is the documentation (foundation playbook §2).
 */
export const FlyConfig = {
  // --- brain link (docs/knowledge/COMPONENTS.md "Brain server") -------------------------
  // 17.09 Pavlo: "we do not really need the native path in the editor". The Mac brain server was a
  // DEVELOPMENT brain reached over plain `ws://` on the LAN, and that plain socket is the one thing
  // still forcing EXPERIMENTAL_API on the project - which is also what blocks publishing the lens.
  // Off by default since the relay moved to Snap Cloud (`wss://`, ADR 75/76): on the glasses and
  // in the editor the brain is a page by PIN. Set it true
  // (and turn Experimental APIs back on) only to drive the lens from `scripts/run_server.sh` again.
  BRAIN_SOCKET_ENABLED: false,
  WS_URL: "ws://flybrain.local:8790", // mDNS name the brain server publishes
  // The brain is the C++ core in core/ (ADR 47/55/87): on a web page as WASM + WebGPU, or on the Mac
  // behind server.py --engine native. Its brain file (core/brain_export/out/*.flyb.z, ~75 MB compressed)
  // is too big for a lens or a repository: the page downloads it once from a GitHub release.
  // BRAIN_NATIVE true = the brain link is WebBrainLink (a page by PIN over the relay); false = the plain
  // Mac WebSocket link only.
  BRAIN_NATIVE: true,
  NATIVE_STEP_MS: 50,
  // ADR 52/82: the core has a CPU kernel and an exact GPU kernel (Vulkan on the Mac, WebGPU on the
  // page). Once a fresh brain is warm the lens asks it for a CPU-vs-GPU self-check (`gpu_check`:
  // identical cells / active list / queues / spikes on THIS machine, NATIVE_GPU_CHECK_CHUNKS chunks).
  // Web brain (ADR 55): the page (WASM core + WebGPU kernel) joins the room `fly-<pin>` on the relay
  // and becomes the brain; a Mac core on the socket rests at WEB_NATIVE_REST_DUTY meanwhile. The relay is
  // Supabase Realtime (`wss://<ref>.snapcloud.dev/realtime/v1/websocket` on Snap Cloud, `<ref>.supabase.co`
  // for a supabase.com project; WEB_RELAY_KEY = that project's anon key, pasted locally, never committed)
  // or web/relay.py on the LAN (`ws://<mac-ip>:8795`, no key): the same protocol.
  WEB_BRAIN: true,
  WEB_RELAY_URL: "wss://zggswrzfsxuixvkaunnv.snapcloud.dev/realtime/v1/websocket", // the author's demo project on Snap Cloud (web/release.sh pins the same ref); replace it with your own project for a fork. LAN: "ws://flybrain.local:8795" with an empty key
  WEB_RELAY_KEY: "", // PASTE the anon key of that project here before a device build (it is `anon` in web/site/config.js); keep it out of commits
  WEB_NATIVE_REST_DUTY: 0.15,
  WEB_NATIVE_PAUSE: true, // a Mac core on the socket (server.py --engine native) stops stepping entirely while a page is the brain ({"pause"}); no effect without the socket
  // Scene feed (ADR 61): while a page is the brain, the lens also streams what only the lens knows
  // — the user's head, every fly's pose + FlyBody.packNet, Gemini's inventory and a coarse point set
  // of the scanned world mesh — so the page can rebuild the room. Nothing is computed for it: the
  // inventory and the mesh are diff-cached behind version counters and sent only when they change.
  WEB_SCENE_FEED: true,
  WEB_SCENE_HZ: 4,
  WEB_SCENE_MESH_PTS: 1500, // point fallback, only until the mesh has triangles (int16 cm, base64)
  START_MULTI_WATCHDOG_S: 10, // MULTIPLAYER: the scan card comes on the session or after this many seconds, whichever is first
  WEB_SCENE_CAL_WAIT_S: 12, // the surface waits this long for the bake's axis calibration (cal=…!) before going out unverified
  WEB_SCENE_MESH_S: 4, // never more often than this, even while the room is still growing
  // The room goes to the page as a real SURFACE (ADR 61 follow-up): the frozen world mesh,
  // decimated to WEB_SCENE_TRIS triangles, its vertices merged on a WEB_SCENE_VOXEL_CM grid so
  // uint16 indices suffice, split into WEB_SCENE_CHUNK-byte pieces so one broadcast never
  // approaches a relay's message limit. Sent once per change and never again after the scan.
  WEB_SCENE_TRIS: 10000,
  WEB_SCENE_VOXEL_CM: 2.5,
  WEB_SCENE_CHUNK: 40000,
  // the ommatidial IMAGE for the page's eye panel (ADR 54's third map): EYE_N x RGB, base64, only
  // when it changed and at its own slower clock — it is the biggest thing the feed sends per second
  WEB_SCENE_EYE_HZ: 2,
  // onboarding card (ADR 57): step 2 (meet the fly) yields to step 3 (the PIN) after GUIDE_STEP2_S; the
  // card hides itself GUIDE_AUTO_HIDE_S after the intro unless GOT IT did it first; "?" reopens it
  GUIDE_STEP2_S: 20,
  GUIDE_AUTO_HIDE_S: 90,
  NATIVE_GPU_CHECK_CHUNKS: 3,
  // 21.09 Pavlo: "keep training, but in the background -- the fly always lives and teaches itself".
  // Measured that day, with no session at all: 4,119 of the 7,835 plastic synapses moved in ten
  // minutes and mean efficacy fell 1.0000 -> 0.9599. It was already happening, but ONLY because a
  // session left plasticity switched on behind itself (FlyTrainer.stop). Learning by accident is
  // not learning by design: it is on now because the fly is meant to learn from its own life.
  NATIVE_LEARNING: true, // dopamine plasticity (KC->MBON07/11, rule.py): the fly learns from reward/punish; memory fades ~3 h (rule[2] in the brain file, 21.09)

  // --- the memory that survives the lens being closed (ADR 62, FlyMemory.ts) ------------------
  MEMORY_ENABLED: true, // keep the plastic state in the device's persistent storage and give it back at start
  MEMORY_SAVE_CHANGES: 200, // take a copy once this many more synapses have moved...
  MEMORY_SAVE_MIN_S: 20, // ...but never more often than this (a `get` costs the brain one step's pause)
  MEMORY_PULL_S: 20, // while a web page is the brain (ADR 55) it may vanish: pull a fresh copy this often
  MEMORY_MAX_FRACTION: 0.8, // refuse to store a blob bigger than this share of the store (device: 100 KB total)
  MEMORY_USER_POLL_S: 2, // how often to ask Sync Kit for the user id until it exists (then never again)
  MEMORY_RESET_SHOW_S: 2, // the board says FORGOTTEN for this long after a reset
  // Optional backend mirror, so a fly follows its OWNER to other glasses (the row is keyed by the
  // Sync Kit user id). OFF by default and not needed: the device store is the primary copy.
  // Table + policies: web/DEPLOY.md. NEVER commit a key.
  MEMORY_BACKEND: false,
  MEMORY_BACKEND_URL: "https://zggswrzfsxuixvkaunnv.snapcloud.dev", // the same Snap Cloud project as WEB_RELAY_URL
  MEMORY_BACKEND_KEY: "", // the anon key (public by design, but still not committed)
  SCAN_CAMERA_SMALLER_PX: 756, // device camera request size
  PING_INTERVAL_S: 2.0,
  PONG_TIMEOUT_S: 6.0,
  SENSE_HZ: 12, // senses per fly per second (12.09: 4 -> 8 -> 12; measured cost in the lens is ~1 ms, the eye rays stay at EYE_HZ)
  EYE_HZ: 4, // ...but the eye rays against the world mesh stay at this rate (they are the expensive part and walls don't move); the cached view is reused between them

  // --- swarm ------------------------------------------------------------------------------
  FLY_COUNT: 1, // one fly, one brain per wearer (ADR 53; every per-fly cost scales with this)
  // FlyNet (ADR 53): other people's flies in the room. Each device owns one fly and one brain; the
  // network carries the body only (~120 bytes, NET_RATE_HZ per user). Ghosts ease toward the received
  // transform at NET_GHOST_LERP (1/s) and snap when further than NET_SNAP_CM (a late packet).
  NET_SYNC: true,
  NET_RATE_HZ: 8,
  NET_ROOM_MSGS_PER_S: 56, // Sync Kit budget 350 messages / 5 s per session, with margin: the rate per user = this / users
  NET_GHOST_LERP: 10,
  NET_SNAP_CM: 120,
  NET_MAX_GHOSTS: 8,
  // short, easy to say: voice find matches them in the spoken phrase (swap freely)
  FLY_NAMES: ["NOVA", "PIP", "ZIGGY", "DOT", "BLITZ"],
  SPAWN_DIST_CM: 120, // in front of the user at start
  SPAWN_SPREAD_CM: 45,

  // --- body (engineered locomotion; the brain only supplies the decisions) ----------------
  TURN_RATE: 1.5, // rad/s at steer = ±1 (11.09: was 2.4 — read as twitchy)
  // saccades (ADR 22 numbers: ~50 ms, ~90 deg, 2.7-3.5 per second in a real fly)
  SACC_S: 0.06, // one flick lasts this long
  SACC_DEG: 75, // ...and turns this far at |sacc| = 1
  SACC_TRIGGER: 0.3, // |sacc| above this starts one
  SACC_CRUISE_TURN: 0.5, // the smooth steering between flicks runs at this share of TURN_RATE
  COMFORT_CM: 80, // flies drift out of this bubble around the user's head (engineered, disclosed; was 60)
  COMFORT_BELOW_CM: 40, // ...and sink at least this far below eye level while inside it
  // 12.09: ON again while we profile — the perf probe (and the new vision read/flow split) only
  // reaches the server log through this. Set back to 0 before recording on device.
  DEBUG_DRAW_COUNT: false, // countDraws() walks the whole scene graph: 2.4 ms, diagnostics only
  DEBUG_TELEMETRY_S: 2, // 14.09 bring-up: telemetry ON (LENS rows in the server log are the preview's test readout); back to 0 for recording. This also skips
  // the scene-graph draw-count walk (6 ms per row). Set back to 2 when a run needs diagnosing.
  CRUISE_CM_S: 40,
  ESCAPE_CM_S: 120, // 11.09: 170 read as a glitchy teleport
  ESCAPE_CLIMB_CM: 25, // an escape climbs this much ONCE above where it started (11.09: it climbed forever into the ceiling)
  ESCAPE_S: 1.1,
  BACK_CM_S: 15,
  ACT_SMOOTH_RATE: 8.0, // 1/s easing of decoded actions (12.09: 4 added ~250 ms of lag on top of the brain's own)
  ALT_RATE: 1.4, // 1/s altitude easing
  CRUISE_ALT_CM: [-80, -35], // band relative to the user's start head height (11.09: was -55..-10 = in your face)
  ARENA_RADIUS_CM: 180, // soft leash around the spawn centre — controller override, disclosed (was 260: flies drifted 5 m off)
  HEAD_OFFSET_CM: 6, // head ahead of the thorax pivot (scaled with the fly: 12 at 35 cm)
  LAND_CM: 12, // head within this of a landing target -> touch down (11.09: 12 -> 18 for the 17.5 cm fly; bench: 18 = a visible jump that neighbours read as a rush)
  LAND_SETTLED_CM: 3, // closer than this to the touch-down anchor = settled (the edge check may run)
  LAND_SETTLE_RATE: 6, // 1/s: the touch-down eases onto the spot (~0.4 s) instead of snapping
  LAND_TAKEOFF_S: 1.4, // stay after the lure is released
  BANK: 0.35, // roll into turns

  // --- bone animation (signs verified against LS preview; flip if a wing opens inward) ----
  WING_HZ: 22, // visual stroke rate (a real fly beats ~200 Hz — shown as a blur rate)
  WING_FLAP: 0.6, // Z stroke amplitude, same sign on both wings (Blender pose check 11.09)
  WING_BRAIN_MIN: 0.35, // 12.09: stroke amplitude = WING_FLAP x (this + (1-this) x the brain's wing MN drive)
  WING_STEER_MIX: 0.35, // ...and the steering MNs tilt it by up to this much per side
  HEAD_YAW: 0.5, // rad at orient = +-1: the head follows the brain's gaze command
  WING_FOLD_X: 1.15, // landed: X +1.2 folds both wings back over the abdomen (pose check #2)
  WING_FOLD_Z: 0.3, // ...lifted a little so they sit on top instead of hanging down
  LEG_TUCK: -0.5, // femur X in flight (was +0.9: legs stuck straight down in an X)
  LEG_DANGLE: 0.25, // femur X when hovering slowly (legs hang; 11.09 'legs never move in flight')
  LEG_REACH: 0.7, // femur X just before touch-down (landing response)
  LEG_REACH_COXA: 0.25, // coxa swing forward while reaching (sign: flip if legs swing back)
  LAND_APPROACH_CM: 40, // legs start reaching when the landing target is this close
  SPEED_EASE_RATE: 2.5, // 1/s: flight speed eases to the brain's command (was instant)
  PITCH_FWD: 0.22, // rad nose-down at cruise speed
  PITCH_HOVER: 0.08, // rad nose-up in a slow hover
  GAIT_HZ: 3.0, // step rate at full walking speed
  // 12.09 Pavlo: "they crawl along the wall oddly, maybe the legs need a bigger amplitude".
  // The rate now follows speed and the stride stays big, instead of the other way round.
  GAIT_MIN: 0.35, // slowest step rate, as a share of GAIT_HZ
  LEG_STRIDE: 0.55, // rad of coxa swing at full stride (was a flat 0.25 scaled down by speed)
  LEG_LIFT: 0.45, // rad the femur lifts on the swing half (was 0.2)
  LEG_STRIDE_MIN: 0.45, // a fly that walks at all keeps at least this share of the stride
  // 12.09 audit: the flight pose used to snap on the landing frame, and a standing fly never moved
  POSE_BLEND_S: 0.18, // wings fold / unfold and legs take weight over this long
  GROOM_HZ: 5.0, // sweep rate of a grooming leg
  GROOM_SWEEP: 0.95, // rad of coxa swing in a sweep (12.09 Pavlo, twice: "still never seen them wipe" — 0.35 -> 0.6 -> 0.95)
  // 12.09: the bout timer is gone — DNg12 says when (ADR). What is left is the mechanics.
  GROOM_ON: 0.15, // DNg12 drive above this = the legs go up (21.09 ADR 106: on the 5 Hz range a full load reads 0.3-0.37, so 0.25 left the pose at lvl 0.04; was 0.25)
  GROOM_HOLD_S: 0.4, // the sweep decays out this long after the command drops (no flicker)
  GROOM_WALK_MAX: 0.3, // a leg cannot step and sweep at once: only a fly this slow grooms (0.15 = almost never, the flies walk)
  LEG_BRAIN_MIX: 0.6, // stride amplitude = 1 + this x the leg motor pools' drive
  PROBOSCIS_RATE: 6.0,

  // --- senses (ADR 16: world sources with per-class action distance) ---------------------
  ANTENNA_OFFSET_CM: 5, // scaled with the fly (10 at 35 cm)
  ODOR: {
    food: { sigma: 90, strength: 1.0 },
    lure: { sigma: 80, strength: 1.2 },
    bad: { sigma: 60, strength: 1.0 },
    threat: { sigma: 0, strength: 0 },
    scent: { sigma: 110, strength: 0.8 }, // plants, bins, litter box: smelled, not eaten
    // ADR 93 (21.09 Pavlo: "everything Gemini finds should smell, to some degree"): a plain thing
    // has a smell of its OWN, scaled by Gemini's `smell` 0..1 for that thing (wood 0.6, plastic
    // 0.3, glass 0), and it goes ONLY into the thing's identity glomerulus, never the generic
    // appetitive `odor`: furniture is something she can learn about, not something she eats.
    object: { sigma: 120, strength: 0.6 }, // x smell; sigma x (0.15 + 0.85 x smell) -> 18..120 cm (21.09: spread, was 35..70)
    fly: { sigma: 0, strength: 0 }, // another fly: seen (object detectors) + looming, no smell
  } as { [cls: string]: { sigma: number; strength: number } },
  OBJECT_SMELL_DEFAULT: 0.5, // a scanned thing whose answer carries no `smell` value
  OBJECT_GAIN: 5.0, // angular size (rad) -> object channel
  FLY_LOOM_GAIN: 0.3, // another fly coming at this one -> loom x this (11.09: 1.0 made them bolt; bench: 0.15 no better than 0.3 — the stacking was the cause, see FOOD_SPOT_CM)
  FLY_SEEN_GAIN: 0.25, // audit: 0.6 made a fly 1 m away as attractive as food (was 0.6); // another fly in view -> object channel x this (11.09 flies know each other)
  SENSE_FLOOR: 0.45, // channel value where sensory cells start firing (7 mV = 0.35) + margin: graded cues start here (audit 11.09)
  MOTION_DEAD: 0.02, // net progressive flow below this = no motion input
  OBJECT_CENTRE_MAX: 0.8, // straight-ahead object cap per eye (1.5 builds DNpe007 stop)
  HUNGER_GAIN: 1.5, // food cues (object + odour) x (1 + this x (1 - energy)): empty fly = x2.5 (11.09)
  LOOM_MIN: 0.25, // rad/s angular expansion below this is not a threat
  LOOM_GAIN: 1.5,
  TOUCH_CM: 8,
  // the user's head is a BODY around the camera, not a point at the eyes (12.09 Pavlo: "they only
  // react when I get really close"): a bigger sphere looms from further away, centred behind the eyes
  HEAD_SIZE_CM: 45,
  HEAD_BEHIND_CM: 10,
  HAND_STILL_CM_S: 15, // an open palm slower than this is a landing surface (11.09)
  HAND_LAND_ASSIST_CM: 45, // ...for a fly whose head is this close
  HAND_PUFF_CM: 45, // a moving hand pushes air onto flies this close (JO wind, by side)
  HAND_PUFF_SPEED_CM_S: 120, // hand speed that gives a full gust
  WIND_GAIN: 0.9, // audit 11.09: live wind 0.11 was below the JO firing floor (0.35); 1.0 -> stop 0.58 = airspeed braking (was 0.25); // airflow on JO-C/E at cruise speed (0..1; 1.0 = 20 mV); atlas: JO-C/E -> DNpe007 stop (+54 Hz) = airspeed brake (0.4 made flies hover)

  // --- climate (ADR 95, 21.09 Pavlo: "take humidity and temperature from the weather forecast; a
  // room is simply warmer than outside"). FlyWeather fetches Open-Meteo (no key) once per
  // WEATHER_REFRESH_S for the glasses' own position, offsets it indoors, and the result is the ROOM
  // BASELINE on the brain's hot / cold / dry / moist cells (TRN_VP2 / VP3 / HRN_VP4 / VP5) for every
  // fly. Gemini's per-thing fields (ADR 96) add on top of it near the thing.
  WEATHER_ENABLED: true,
  WEATHER_LOCATION: false, // GPS off (disabled when the lens also uses internet); climate comes from Gemini (WEATHER_FROM_SCAN)
  WEATHER_FROM_SCAN: true, // Gemini estimates the room's approximate climate during the scan; no GPS, no weather API
  WEATHER_LAT: 50.45, // the default city (change it for yours, ADR 95) -- used until a real position arrives, or when WEATHER_LOCATION is off
  WEATHER_LON: 30.52,
  WEATHER_LOCATION_WAIT_S: 6, // no position after this long -> fetch for WEATHER_LAT/LON, keep listening
  WEATHER_REFRESH_S: 1800, // 30 min; a failed refresh keeps the last good reading
  WEATHER_RETRY_S: 120, // ...and tries again this soon when there is no reading at all yet
  INDOOR_WARM_C: 6, // the room = outside + this
  INDOOR_DRIER_PCT: 10, // ...and this much less relative humidity
  FLY_COMFORT_C: 25, // Drosophila prefers ~25 C: neither hot nor cold cells are driven inside the band
  FLY_COMFORT_BAND_C: 3, // +-3 C of comfort is silence
  FLY_HOT_SPAN_C: 10, // hot = 1.0 this far above the band (38 C)
  FLY_COLD_SPAN_C: 12, // cold = 1.0 this far below it (10 C)
  FLY_RH_MID: 50, // relative humidity that is neither dry nor moist
  FLY_RH_BAND: 10, // +-10 % is silence
  FLY_RH_SPAN: 35, // dry / moist = 1.0 this far outside the band (5 % / 95 %)
  WEATHER_WIND_FULL_KMH: 30, // the forecast wind that would be a full JO-C/E drive outdoors...
  WEATHER_WIND_INDOOR: 0, // ...times this indoors (0 = a closed room: the wind shows in telemetry only)
  // Gemini's per-thing physical fields (ADR 96): warm / cold / humid / wind 0..1 per scanned thing,
  // each a gaussian around it with the thing's own smell reach (at least FIELD_SIGMA_CM), scaled
  // by FIELD_GAIN, added to the weather baseline and clamped at injection.
  FIELD_SIGMA_CM: 60,
  FIELD_GAIN: 1.0,

  // --- hologram look (FlyHolo shader; 11.09 Pavlo: "neon rimlight like holograms") --------
  // One neon pair per fly: head colour (= its tab colour on the status board) -> abdomen
  // accent, shifted iridescently by view angle in FlyHolo v2. Fly 0 stays green.
  FLY_COLORS: [
    // 12.09 Pavlo: "keep the green and the pink fly". The flies take the first FLY_COUNT entries,
    // so pink moves into slot 1 and cyan drops to 2. Note this also recolours the DONE SCANNING and
    // ASK buttons, which are drawn in FLY_COLORS[1].
    new vec4(0.2, 1.0, 0.45, 1.0), // green
    new vec4(1.0, 0.3, 0.85, 1.0), // magenta
    new vec4(0.2, 0.85, 1.0, 1.0), // cyan
    new vec4(1.0, 0.72, 0.2, 1.0), // amber
    new vec4(0.62, 0.42, 1.0, 1.0), // violet
  ],
  FLY_ACCENTS: [
    new vec4(1.0, 0.95, 0.25, 1.0), // green -> lemon
    new vec4(1.0, 0.55, 0.15, 1.0), // magenta -> orange   (moved with FLY_COLORS: paired by index)
    new vec4(0.35, 0.35, 1.0, 1.0), // cyan -> electric blue
    new vec4(1.0, 0.2, 0.3, 1.0), // amber -> hot red
    new vec4(0.2, 1.0, 0.95, 1.0), // violet -> aqua
  ],
  // Multipliers on the FlyHolo MATERIAL values (so Inspector tuning of glow/bodyGlow is live):
  GLOW_IDLE: 1.0, // x material glow
  GLOW_SELECTED: 1.6, // x material glow for the selected fly
  WING_BODY_GLOW: 0.3, // wings: x material bodyGlow (almost only the rim)

  // --- status board (ADR 12/13) + selection fx ---------------------------------------------
  BOARD_HEADLOCK_IN_EDITOR: true, // 11.09 Pavlo: debug the board head-locked in the editor
  BOARD_DIST_CM: 124, // editor head-lock: doubled with BOARD_SCALE so the preview frames the whole board;
  BOARD_RIGHT_CM: 0, // 11.09: 16 then 7 then 3 — the v2 device is wide, centre it
  BOARD_DOWN_CM: 5,
  BOARD_SCALE: 0.85, // 12.09 Pavlo: "a bit smaller" (was 1.0); 11.09 device test "2x bigger" (was 0.5); whole device (50x46 cm layout -> 25x23 cm; 11.09 "make the whole panel bigger", was 0.34 on 64x36)
  BOARD_ABOVE_PALM_CM: 38, // device: board rides the right palm while it faces the user (centre; bottom edge ~15 cm above, was 14 at scale 0.5)
  BOARD_PALM_PUSH_CM: 30, // 50x46 cm fits the glasses' view only ~70 cm from the eyes; // and this far beyond the hand (away from the eyes) so the other hand can point at it (11.09)
  BOARD_FOLLOW_RATE: 8,
  BOARD_W_CM: 26,
  BOARD_H_CM: 34,
  BOARD_PLATE: 0.62, // 12.09 Pavlo: "more transparent" (0.35 -> 0.2), then "make the backing coloured"; 15.09: "more saturated, solid corner to corner" (glow mode 2, no soft edges) -> 0.62
  BOARD_TEXT_SIZE: 48, // glyph atlas resolution (11.09 design pass: 24 rendered torn/pixelated glyphs)
  BOARD_TEXT_SCALE: 1.15, // 11.09 Pavlo: board text bigger (was 1.0); // x BOARD_TEXT_SIZE = same on-screen size as 24 x 2.0, twice the resolution
  BOARD_MONO_DY: 0.35, // cm: Share Tech Mono sits lower than Chakra Petch; lift it (x BOARD_TEXT_SCALE) (11.09 device screenshot)
  BOARD_TEXT_CAP: 0.7, // 12.09: cap height as a fraction of the line height, for batched MSDF text
  BOARD_LINE_CM: 1.55, // rendered line height of board text per unit text scale (tune so the label/value blocks sit on the bars)
  BOARD_BLOCK_TOP_CM: 0.9, // label/value blocks start this far above the first row's centre
  GLOW_DISC_CM: 40, // halved with the fly (11.09 device test) // halo billboard behind every fly (11.09: 44 -> 56 -> 80, "bigger")
  GLOW_DISC_SELECTED_CM: 50, // halved with the fly; // the active fly's halo, bigger and brighter
  GLOW_HALO_IDLE: 0.85, // 11.09: "stronger default glow on every fly" (was 0.45)
  GLOW_HALO_SELECTED: 1.8, // + 0.35 pulse (was 1.4)
  GLOW_DROP_CM: 2.5, // halved with the fly; // the soft glow plane sits this far UNDER the fly (11.09: 14 -> "raise to the body")
  BOARD_DATA_HZ: 15, // 12.09 Pavlo: the panel's numbers/bars/strings tick at 15 Hz, not per frame
  // ADR 107 (21.09 Pavlo: "visualise that the brain dropped"): the hologram blinks out over this many
  // seconds when its brain link drops (bursts that get shorter), and blinks in when a brain is back
  BRAIN_LOST_BLINK_S: 1.8,
  BRAIN_BACK_BLINK_S: 0.6,
  MINI_MIRROR_HZ: 0, // 21.09 Pavlo: the mini fly on the panel copies the real fly's bones EVERY frame (0); a positive value throttles (was 60: half the frames were skipped by the accumulator)
  BAR_EASE_RATE: 4, // 1/s: board bars + their auto-range ease to each brain update (~2 Hz) instead of jumping
  BAR_PEAK_TAU_S: 20, // auto-range scale forgets an old peak over ~20 s
  // 12.09 Pavlo: "stress and stop sit at a super high level right from the start". They do — PPL101
  // rests at 87 Hz with no input at all (atlas control) and DNpe007 idles ~110 Hz in the live loop —
  // so a bar drawn from zero is full before anything happens. Each row now fills from its OWN resting
  // level; the Hz text stays the raw measurement (ADR 38).
  BAR_REST_RELATIVE: true,
  // 12.09 Pavlo, pointing at the column of "5.9 Hz / 14.5 Hz / ...": "let's drop these numbers —
  // minus a huge pile of texts to update". Each was its own Component.Text and every write re-lays
  // the text out, on the thread we are short of. The bars stay, and they already fill from each
  // row's own resting level (ADR 38) — what is lost is the absolute rate in figures.
  BOARD_ROW_VALUES: false,
  BAR_REST_UP_TAU_S: 45, // a level that stays high slowly becomes the new normal...
  BAR_REST_DOWN_TAU_S: 4, // ...and a drop is taken as the new normal this fast
  // 12.09 Pavlo: "optimise the trails a bit, the CPU keeps recalculating the MeshBuilder — let's
  // compress them on quality". Each sample rewrites every point of that fly's ribbon and calls
  // updateMesh(), so the cost is points x samples-per-second. Both halved-ish while the trail
  // keeps its LENGTH: 72 x 0.2 s = 14.4 s, exactly what 120 x 0.12 s gave. Work drops to ~36 %
  // (60 % of the points, 60 % as often). The trade is a coarser ribbon — fewer, longer segments.
  TRAIL_POINTS: 72, // 11.09 Pavlo: long trails behind EVERY fly (device test "2x longer": 180 pts cost fx 30-48 ms)
  TRAIL_SAMPLE_S: 0.2, // was 0.12; length is points x this, so the two move together
  TRAIL_HEAD_CM: 1.5, // 12.09: the trail's buffer is re-uploaded only after the head moved this far
  // (at cruise ~27 Hz, at a hover never) — "less smooth but optimised"
  TRAIL_WIDTH_CM: 1.1,
  TRAIL_INTENSITY_IDLE: 0.7,
  TRAIL_INTENSITY_SELECTED: 1.5,
  // halos + trails draw AFTER the flies (order 0, FlyHolo writes depth): the body hides what is behind
  // it, additive fx never write depth so they don't cut each other (11.09 device test: render order)
  RENDER_ORDER_FX: 1,
  LAND_LOOM_KEEP: 0.15, // eye loom kept while a landing target is within FOOD_ASSIST_CM (landing response, 11.09)
  // world-space board in a SIK ContainerFrame (11.09 device test: "move it in 3D with the UI kit, off the hand")
  BOARD_IN_FRAME: true,
  BOARD_VIEW_COS: 0.5, // 12.09 device: the board is ~90 of the ~130 draws in view (67 of them Text). It
  // fades out when its centre leaves a 120 deg cone around where the user looks — off-screen anyway

  BOARD_FRAME_DIST_CM: 100,
  INTRO_HEADLOCK_RATE: 6, // 21.09: the start + scan cards follow the head at this ease (per s) until the intro ends
  INTRO_RIGHT_CM: 0, // ...dead centre (the dashboard's own spot is BOARD_FRAME_RIGHT_CM to the right)
  INTRO_SETTLE_S: 1.2, // ...and after the intro the anchor slides to that spot over this long, then stays
  BOARD_FRAME_RIGHT_CM: 0, // dashboard stays where the intro cards were (was 30 -> flew right after the scan)
  BOARD_FRAME_DOWN_CM: 5,
  BOARD_FRAME_W_CM: 46, // frame around the 50x46 board (x BOARD_SCALE 0.85 = 42.5x39): + a small margin
  BOARD_FRAME_H_CM: 45,
  BOARD_FRAME_LIFT_CM: 1.5, // board content sits this far in front of the frame (our UI over the frame's plate)
  // treats (11.09): long LEFT pinch spawns one, release drops it in 3D space
  // easter egg (11.09 Pavlo): two flies mating in a room corner — decoration, no brains
  // 12.09: off for the POC pass. Two FULL skinned fly rigs, posed at 15 Hz and drawn every frame,
  // for a decoration in the corner — and since they were moved in front of the user they are also
  // always in view. Safe to flip: spawnMeme() returns at the top and tickMeme() early-outs on an
  // empty list, so nothing else has to change.
  MEME_ENABLED: false,
  MEME_LIFT_CM: 1,
  MEME_BOB_HZ: 3,
  MEME_BOB_CM: 0.9,
  // landing on any surface (11.09 Pavlo: "they can land on walls, on anything") — OFF until verified
  SURFACE_LANDING: true, // ON for the 11.09 test (was false until verified); watch `surf=` in telemetry
  SURFACE_LAND_CM: 22, // a surface within this of the head (eye rays) can be landed on
  SURFACE_STOP: 0.4, // the brain wants to stop (DNpe007) ...
  SURFACE_IDLE_FWD: 0.12, // ... or has no forward drive ...
  SURFACE_WANT_S: 0.8, // ... for this long -> settle on the nearest surface
  WALK_CM_S: 20, // walking speed at full forward drive (12.09 Pavlo "they only sit": 6 cm/s = 0.1 body length/s, invisible; a real fly walks 1-2 body lengths/s)
  SURFACE_WALK_DEAD: 0.2, // forward below this = standing
  SURFACE_TAKEOFF_FWD: 0.75, // sustained forward drive above this ...
  SURFACE_TAKEOFF_S: 1.5, // ... for this long = take off
  SURFACE_MAX_S: 40, // longest stay before taking off again
  SURFACE_MAX_FORAGE_S: 6, // ...or this, when the fly is hungry AND smells food: it goes looking (ADR 35)
  FORAGE_ODOR: 0.15, // odour level that counts as 'there is food somewhere'
  SURFACE_JUMP_CM: 8, // push-off along the normal at take-off, now eased in (12.09 Pavlo: the instant 8 cm pop read as a teleport)
  TAKEOFF_BUZZ_S: 0.18, // 12.09: wings unfold and buzz this long BEFORE the body leaves the surface
  TAKEOFF_EASE_RATE: 8, // 1/s: the push-off is spread over ~0.4 s
  STEP_MAX_S: 0.05, // motion integrates at most this much per frame: a 146 ms hitch used to fling an
  // escaping fly 12-17 cm in one frame, which reads as a teleport (12.09 jump probe: move:11)
  TAKEOFF_ROT_S: 0.35, // s: the body turns out of the surface frame into flight over this long
  // landing response on a head-on approach (Tammero & Dickinson 2002; ADR 35): a surface right ahead
  // that the brain does NOT turn away from (DNp03 `avoid`) is landed on (11.09 bench: 100% flight)
  LAND_ON_APPROACH: true,
  LAND_REACH_CM: 12, // the surface is this close ahead of the head
  LAND_AVOID_MAX: 0.2, // |avoid| below this = the brain is not saccading away
  LAND_FRONTAL_COS: 0.6, // approach within ~53 deg of the surface normal = expansion centred ahead
  // landing approach (van Breugel & Dickinson 2012): near a landing target speed <= MIN + RATE x distance
  // (11.09 bench: 3 hungry flies hit the one treat at 36 cm/s, loomed on each other, 12 escapes)
  LAND_DECEL_RATE: 1.0, // 1/s
  LAND_DECEL_MIN_CM_S: 5,
  // ...and the same brake near another fly (12.09 bench: a fly passing an eater at 9-14 cm and
  // 31-38 cm/s startled it off its meal; at these body sizes any close pass looms hard)
  NEIGHBOUR_SLOW_CM: 45, // a neighbour closer than this brakes the fly
  NEIGHBOUR_CLEAR_CM: 10, // ...down to LAND_DECEL_MIN + RATE x (distance - this)
  // flight bouts (ADR 35): after a bout the fly lands on the next surface in reach, unless food/lure/palm is its target
  // (11.09 bench: with honest wall avoidance flies flew 98% of the time)
  FLIGHT_BOUT: true,
  FLIGHT_BOUT_S: [8, 25], // bout length, uniform (engineered for AR legibility; real bouts are often shorter)
  PERCH_STEER: 0.6, // how strongly a tired fly steers toward the surface its eyes found (0..1)
  BOUT_SCAN_S: 0.1, // a tired fly looks for a landing surface this often (5 short rays)
  TREAT_HOLD_S: 0.6,
  TREAT_CM: 8,
  // 12.09 Pavlo: "the apple's material should be holographic, take it like the flies" — FlyHolo with
  // its own pair (red rim, amber body) so a treat reads as food, not as a fourth fly
  TREAT_RIM: new vec4(1.0, 0.25, 0.3, 1.0),
  TREAT_BODY: new vec4(1.0, 0.72, 0.2, 1.0),
  TREAT_MAX: 5,
  WALL_MARGIN_CM: 8, // a fly stops this far in front of a world-mesh surface it would fly into (solid walls, 11.09)
  WALL_TURN_RATE: 4, // 1/s: a fly touching a wall turns its heading along it (or away, head-on) (11.09)
  // 12.09: one fly per frame does its world-mesh raycasts, round-robin. ADR 39 named this the
  // biggest remaining engine saving and we had not taken it. Measured why it is worth taking: the
  // trace has the GPU busy 95 ms across a 699 s span while the main thread runs 45,992 ms of work
  // in a 42,579 ms span — 108 %, saturated — and Pavlo reads 15-20 % GPU on the device. The eye
  // rays were already throttled to EYE_HZ; these were not: solidWalls casts every frame for every
  // airborne fly (it early-outs at 0.3 cm of movement, which a cruising fly always exceeds) and the
  // landed re-cast runs every frame for every settled fly.
  // A BEHAVIOUR CHANGE, disclosed: at two flies each still gets checked ~28 times a second, but a
  // fly can now travel one more frame into a wall before the backstop pushes it out. Watch for
  // flies clipping surfaces; false restores the old per-frame casting exactly.
  WALL_RAY_STAGGER: true,
  JUMP_CM: 8, // telemetry: a step moved a fly more than this in ONE frame = a jump (12.09: 20 cm missed ones that still read as a teleport on a 17.5 cm fly)
  ROOM_PAD_CM: 30, // the scanned-room box is padded by this: a backstop for mesh holes only (solid walls do the real walls; 11.09 bench: 100 let flies roam a metre outside)
  ROOM_MARGIN_CM: 15, // flies stay this far inside the scanned room box (11.09 "they fly out of the world mesh")

  // --- brain cloud hologram (16,000 neurons above the board) -------------------------------
  CLOUD_RADIUS_CM: 7.4, // 15.09: the brain rises and the eyes take the strip below; // half-length of the long axis on the board's holo stage (board-local cm; 7 on the old 17 cm pad)
  // 12.09: draw every Nth neuron. The cloud is 16,000 additive quads (64,002 verts) packed into a
  // 9 cm stage with depthWrite off and twoSided on — so every pixel of the brain is shaded dozens of
  // times over and nothing can early-Z it away. That is pure GPU fill, which none of our probes can
  // see: they time CPU. 1 = all of them (as before), 3 = a third of the fill, same silhouette.
  // The spike texture still covers all 16,000, so the dots that ARE drawn keep their own activity.
  // MEASURED AFTERWARDS, and it says this knob is the wrong lever: in the trace the GPU track is
  // busy 95 ms across a 699 s span while the main thread runs 45,992 ms of work in a 42,579 ms
  // span — 108 %, saturated. Fill is not our problem, the CPU is. Back to 1 (all 16,000 drawn):
  // thinning would have cost ADR 37's "the hologram is a sample, the brain is whole" for nothing.
  CLOUD_DRAW_EVERY: 1,
  CLOUD_POINT_CM: 0.24, // WORLD cm per neuron dot (NeuronDots; 11.09: 0.32 stacked into a white blob over the optic lobes)
  // 12.09 Pavlo: "the brain just burns non-stop, you can't see the neurons working". Measured: at a
  // 50 ms step 10.7 % of the 16,000 spike (1709 dots) — the DATA is fine, the drawing was not. Every
  // dot glowed at 0.6 and 16,000 of them add up into one slab, while a spiking dot was only ~2x a
  // sleeping one. The silhouette now comes from the shell meshes; the dots carry the activity.
  CLOUD_BASE_GLOW: 0.15, // resting dot floor (was 0.6: the slab)
  CLOUD_FLASH: 2.6, // a spiking dot is this much brighter -> ~17x contrast instead of ~2x
  CLOUD_DECAY: 0.45, // spike level per brain step after it fires (0.5 was a ~200 ms smear)
  CLOUD_SHELL_GLOW: 0.35, // brain/VNC outline rim = FlyHolo glow x this (11.09 "silhouette should read")
  CLOUD_SHELL_BODY: 0.5, // outline body fill = FlyHolo bodyGlow x this
  // 12.09 Pavlo: "show what the brain sees" — FlyVision's 16x8 retina, the exact array sent to the
  // brain, in the corner under the holo stage. Not the camera image: that coarseness is the point.
  RETINA_PANEL: true,
  RETINA_CELLS: [16, 8],
  RETINA_X: -13.75, // 12.09 Pavlo "centre it": the same x as the holo stage above it
  RETINA_Y: -18.4, // ...and a little higher
  RETINA_W_CM: 2.8, // width of ONE eye (8x8 cells); 12.09 Pavlo: smaller again
  RETINA_GAP_CM: 0.8, // ...with this much between the two eyes
  RETINA_GAIN: 1.7,
  // display only: FlyVision pins the mean to 160 so the brain sees contrast, not exposure — and the
  // room is painted from a rough world-mesh bake, so the raw view is flat. The panel stretches it.
  RETINA_CONTRAST: 3.2,
  MINI_FLY_CM: 6.2, // 15.09 Pavlo: smaller again; // 12.09 Pavlo: a bit smaller, so the brain rises and the eye panel fits below // mini hologram of the selected fly on the board (board-local cm; 10 overlapped the brain caption side-on)
  LENGTH_CM: 17.5, // giant fly length (fly_model LENGTH_M 0.35; device test 11.09 "2x smaller", was 35)
  MODEL_LENGTH_CM: 35, // the fly GLB's built length (fly_model LENGTH_M 0.35): containers scale LENGTH_CM / this
  LANDED_LIFT_CM: 1.5, // thorax above the surface when landed (scaled with the fly: 3 at 35 cm)
  CLOUD_SPIN: 0.35, // sway phase speed, rad/s (the mini fly turntable uses it too)
  CLOUD_SWAY: 0.45, // brain sways +-0.45 rad about vertical around the frontal view
  CLOUD_FACE_DEG: 180, // 12.09 Pavlo: "turn the brain 180 deg towards us in the panel" — spin about the vertical after the upright flip

  // --- fly eyes: each fly's own rays against the world mesh (FlyEyes, 11.09) ---------------
  EYE_RANGE_CM: 150,
  EYE_TTC_S: 0.8, // a surface closer than this in time-to-contact looms on that side (11.09: 1.2 -> escape loops at walls)
  EYE_LOOM_GAIN: 0.7, // 1.0 = full 20 mV into LC4/LPLC2 at contact (11.09: 1.0 made flies escape every few seconds)
  EYE_DOT_CM: 2.5, // the selected fly's ray-hit dots
  FLY_OBSTACLES: true, // other flies feed the eye-ray obstacle loom (LPLC1 -> DNp03 steer-away), 11.09 bench
  FLY_OBSTACLE_R_CM: 8, // another fly's body radius for time-to-contact (LENGTH_CM 17.5 / 2)
  SEPARATION_PUSH_MAX_CM: 4, // ...but never shoved more than this per frame (a 46 cm shove read as an attack to the neighbour)
  FLY_SEPARATION_CM: 16, // two flies' bodies (thorax to thorax) never get closer than this (collision physics, 11.09 bench)
  MOTION_ENABLED: true, // optic flow -> LLPC1 (optomotor damping + wall following), 11.09
  MOTION_GAIN: 0.25, // (rad/s of progressive flow) -> 0..1 channel; a full-rate turn ~0.4
  // fly-eye cameras (FlyVision, 11.09 Pavlo: cameras on their heads into render targets)
  VISION_ENABLED: true, // (11.09 A/B: not the cause of the 140 ms hitches — worst frame identical without it)
  VISION_HZ: 3, // 12.09 device recording: each tick is a whole extra camera pass per fly (was 6, 11.09: was 10)
  VISION_FOV_RAD: 1.75, // vertical; 32x16 at aspect 2 -> ~134 deg horizontal
  VISION_TEX_CELL_CM: 40, // blocks of 20 cm on the world mesh: trackable by a 32 px eye
  VISION_TEX_INTENSITY: 8,
  VISION_FLOW_EASE: 6, // 1/s smoothing of the measured flow
  // room colours baked onto a world-mesh copy for the eye cameras (WorldColorBake, 11.09 Pavlo)
  BAKE_GEOM_S: 3, // re-read the growing world mesh's vertex positions this often
  BAKE_VOXEL_CM: 8, // colour memory cell; 256x256 hash texture = 64x32x32 voxels (5.1 x 2.6 x 2.6 m, then wraps)
  BAKE_ROWS: 48, // sparse full-width row readback per scan frame
  BAKE_POS_SCALE: 100, // extracted world-mesh vertices are in metres -> cm
  BAKE_CAL_LOCK_CM: 80, // vertex-frame calibration locks when the best flip's median hit error is below this (and half the next)
  BAKE_AFTER_SCAN: false, // 12.09 Pavlo: nothing re-reads the world mesh once the scan is done (it was
  // a 95 ms spike every BAKE_GEOM_LATE_S, growing with the room). true = keep the room box growing
  BAKE_GEOM_LATE_S: 30, // ...at this interval, when BAKE_AFTER_SCAN is on (12.09: every 10 s showed up as a 52 ms frame spike)
  BAKE_MAX_VERTS: 20000, // colour at most this many vertices per frame (strided)
  BAKE_FLIP_Y: true, // readback rows bottom-up (flip if colours land upside down)
  BAKE_GAIN: 1.0,
  BAKE_TEXTURE: 0.25, // +- block pattern for optic flow on flat colours

  // --- world scan: Gemini = slow perception, geometry = fast senses (ADR 04/16) ------------
  SCAN_ENABLED: true,
  GEMINI_MODEL: "gemini-2.5-flash", // the Depth sample used 2.5-pro: better boxes, ~3x slower
  // 11.09 Pavlo: "at the start I scan the world mesh a little, then scanning is non-stop"
  INTRO_SCAN_S: 8, // room-scan phase: flies appear after it, in front of wherever the user looks
  SCAN_INTRO_EVERY_S: 1, // back-to-back Gemini passes during the intro
  WORLD_MESH_AFTER_INTRO: false, // keep the scanned mesh visible after the intro (debug)
  // 12.09: keep RECONSTRUCTING the room after DONE SCANNING. Off — the room does not change while
  // you watch flies, and we were rebuilding it for the whole session. The mesh already built stays
  // queryable, so the eye rays keep hitting. If `hits=` in the telemetry drops to 0 after the scan,
  // this is why: flip it back to true.
  MESH_TRACK_AFTER_SCAN: false,
  // 12.09 Pavlo: "at startup you can switch off any world-mesh visualisation". Off = the room mesh
  // is never made visible during the intro and gets no grid material, so the biggest mesh in the
  // scene — one that GROWS the whole time you look around — is not drawn at all. The scan still
  // happens: tracking builds the mesh, Gemini still finds objects, the colour bake still runs, and
  // the fly eyes still get the mesh afterwards (hideWorldMesh moves it to the vision layer, which
  // now happens immediately since there is no grid left to dissolve).
  SCAN_GRID_SHOW: false,
  SCAN_GRID_CELL_CM: 12, // neon grid on the world mesh during the scan (11.09: light, then dissolves)
  SCAN_GRID_INTENSITY: 0.45, // 11.09: 0.8 covered the board — 'light' visualisation
  SCAN_GRID_DISSOLVE_S: 0.35, // 12.09 Pavlo: "simplify the scan-end animation, it is heavy" — the neon
  // grid is drawn over the WHOLE world mesh while it burns away, so 1.6 s was 1.6 s of that draw.
  // 0 = no dissolve at all: the grid goes the moment DONE SCANNING is pressed
  SCAN_FIRST_S: 1,
  EDITOR_SCAN_EVERY_S: 1e6, // 12.09: the preview wedged five times, always with Gemini scanning on (it ran 8 h straight while the bench kept Gemini off). Off in the editor while we prove that; the glasses keep SCAN_EVERY_S.
  // 12.09 Pavlo: "let's do depth every 10 seconds and scan less often, less camera use". Depth is
  // now better than every 10 s — the session only runs during a capture window (see below) — and
  // the Gemini pass went 5 -> 10 s. The COLOUR camera cannot be closed: CameraTextureProvider
  // exposes only onNewFrame in 5.15, with no stop, so that stream stays open whatever we do; our
  // handler already returns immediately when no capture is armed.
  // 12.09 Pavlo: "after the room scan turn depth test and the camera off completely — we've scanned
  // everything, that's enough for a POC". Off = the scanner's interval goes to 1e6 at DONE
  // SCANNING, so no pass ever arms again; and because depth and the colour callback are both tied
  // to arming (SCAN_DEPTH_GATED), they simply never start. The room map stays: the same 1e5 test
  // that stops scanning also stops findings expiring. The colour STREAM still cannot be closed in
  // 5.15 — no API — but from here nothing reads it.
  SCAN_AFTER_INTRO: false,
  SCAN_DEPTH_GATED: true, // start the depth session only while a capture is armed, then stop it.
  // If `depthScans` in the telemetry falls to 0, the session needs longer than SCAN_DEPTH_WAIT_S
  // to produce its first frame — turn this off and depth goes back to running continuously.
  SCAN_EVERY_S: 10, // 12.09 Pavlo, recording on the device: back-to-back Gemini passes (0.5) grab a camera
  // frame + depth every half second, which fights the video encoder for the camera and the SoC. The room
  // inventory does not change that fast; the intro still scans back-to-back (SCAN_INTRO_EVERY_S)
  SCAN_DEPTH_WAIT_S: 0.6, // wait this long for a depth frame to pair with the capture, else World Query
  // 12.09: gating the depth session (SCAN_DEPTH_GATED) sent `pairDt` from 33 ms to 4.0-4.8 SECONDS
  // on device — a freshly started session hands back a stale first frame, and a marker placed from
  // a four-second-old pose lands wherever the head used to be looking. So: ignore the first frame
  // after a start, and refuse a pair older than this (the capture then takes the World Query path,
  // exactly as it does when no depth arrives at all).
  SCAN_PAIR_MAX_MS: 150,
  SCAN_MAX_SOURCES: 24, // 11.09: whole-room inventory, not only food
  SCAN_MERGE_CM: 30, // same class this close = the same object seen again
  SCAN_LABEL_MERGE_CM: 80, // same label this close = the same object (placement jitter)
  SCAN_SAME_VIEW_S: 30, // an unchanged view is re-checked only this often (11.09: no 300x re-detections)
  SCAN_MOVE_CM: 30, // ...the view counts as changed after moving this far
  SCAN_TURN_DEG: 15, // ...or turning this much
  SCAN_TTL_S: 150, // forget an object Gemini hasn't re-confirmed for this long
  SCAN_RANGE_CM: 500,
  // 12.09 Pavlo: "they only need lookAt at the start". Not quite — a label must still turn when you
  // walk around it — but it needs nothing while the head is still. Re-aim only once the camera has
  // moved this far or turned at all since the last aim (the 8 Hz tick still gates the check).
  SCAN_LABEL_AIM_CM: 2,
  SCAN_LABEL_CAP_CM: 2.05, // the batched world label's cap height (matches the old Text look pixel for pixel)
  SCAN_LABEL_SCALE: 2.5, // floating label above each found object (~4 cm caps)
  SCAN_LABEL_LIFT_CM: 5, // label origin above the anchor so the arrow tip sits on it (tune by eye)
  ATTENTION_INTERACTIVE: false, // no point-to-inspect; every scan describes itself statically under its name label
  FOOD_ASSIST_CM: 70, // food within this of a fly's head = its landing target (altitude + touch-down; disclosed)
  FOOD_SATED: 0.97, // ...until its energy is back above this, then it takes off
  FOOD_SPOT_CM: 14, // each fly lands on its own spot on a ring this far from the food's centre (bench: one shared point = head in head; 7 cm = heads 12 cm apart, still a loom at arrival)
  FOOD_SPOT_PHASE: 0.5, // rad: ring rotation
  FOOD_SMELL_CM: 250, // a hungry fly drifts toward the HEIGHT of the nearest food it smells (ADR 26;
  // 12.09 bench: with a real mesh the treat lands on the actual floor, a metre below the cruise band,
  // and flies never got closer than 146 cm - they could smell it but not descend to it)
  SMELL_ALT_MIX: 0.7, // how far the cruise altitude gives way to the smelled food's height
  FOOD_HUNGRY: 0.6, // a fly looks for food (landing target) only below this; on the food it eats up to FOOD_SATED

  // --- inner voice: Gemini narrates the selected fly from its live state (FlyNarrator) -----
  // 21.09 Pavlo, clearing the experience down to the fly itself: "remove ASK A FLY too" and "cut the
  // Gemini audio". The audio was already gone (FlyNarrator: tts=off, nothing speaks); what ASK A FLY
  // still carried was the MICROPHONE path, which goes with it. Switches rather than deletions today:
  // FlyCommands is four hundred lines and this project has already lost two cards to blind edits.
  // Deleting the code belongs in its own calm pass.
  ASK_ENABLED: false, // the ASK A FLY key, its voice command and the mic that served it
  // The fly teaches itself now (ADR 89), so nothing drags a newcomer into a nine-step tutorial.
  // The seven real protocols stay in the picker for anyone who wants to run an experiment.
  LESSON_ENABLED: false,
  NARRATE_ENABLED: true,
  NARRATE_FIRST_S: 3,
  NARRATE_EVERY_S: 20, // 12.09 Pavlo: "let it not spam words so often" (was 8)
  NARRATE_TYPE_CPS: 45, // typing reveal, characters per second
  NARRATE_LINE_CHARS: 30, // the Gemini section has bigger text: fewer characters per line so nothing runs past the plate
  BOARD_GEMINI_H_CM: 9, // its own plate on the board (12.09 Pavlo: a whole section for Gemini)
  BOARD_GEMINI_TEXT: 0.78, // ...and bigger text inside it (rows use 0.56)
  BOARD_GEMINI_PLATE: 0.18, // plate intensity behind the section

  // 12.09: the spoken inner voice (Gemini Live -> FlyVoice, ADR 28) is gone, and its nine knobs with
  // it — model, per-fly prebuilt voices, volume, distance falloff, timeouts. Pavlo turned it off and
  // then deleted Fly/Audio/FlyVoiceOut.audioOutput; `requireAsset` is resolved statically by Lens
  // Studio, so the class broke the build just by naming a missing asset. It could not work without
  // its own audio output anyway. The board still shows the thought (NARRATE_ENABLED).

  // --- voice find: "Fly, find the apple" -> a lure on that thing (FlyCommands, ADR 27) -----
  FIND_TIMEOUT_S: 60, // 11.09 the find lure expires if the fly hasn't landed on it by then
  FIND_LAND_HOLD_S: 2, // 11.09 ...or this long after it landed (reward already pulsed), so it visibly sits there
  FIND_LISTEN_S: 10, // 11.09 ASK listens at most this long for one phrase
  FIND_SILENCE_MS: 1200, // 11.09 ASR: this much silence ends the phrase
  FIND_GEMINI_TIMEOUT_S: 8, // 11.09 no Gemini answer by then -> local word-overlap match
  FIND_LURE_MAX_CM: 20, // 11.09 lure size = the thing's size (object-channel angular size), capped
  FIND_BANNER_S: 6, // 11.09 heard phrase + chosen target stay on the board status line this long
  FIND_EDITOR_PHRASE: "fly, find the apple", // 11.09 ASR is device-only: ASK in the editor pretends it heard this

  // --- teaching the fly: the conditioning protocol (FlyTrainer, ADR 62) -------------------
  // Numbers marked (paper) are Huang, Luo et al. 2024 (Nature 634:1141, doi 10.1038/s41586-024-07819-w),
  // whose appendix eq. 3.2-3.5 IS the rule fly-wirehead runs (rule.py / flybrain.cpp). Numbers marked
  // (ours) are compressions or extensions and every one of them is disclosed in ADR 62.
  TRAIN_BOUTS: 6, // (paper) six training bouts per session
  TRAIN_BOUTS_EDITOR: 2, // (ours) the editor bench runs a short session
  TRAIN_US_DELAY_SIM_MS: 3000, // (paper) the fixed CS+ -> US interval, in the brain's OWN time
  TRAIN_US_DELAY_MAX_S: 6, // (ours) ...but never wait longer than this in wall time (on the glasses
  // one 50 ms brain step costs 1-2 s, so 3000 sim ms would be a minute of the user standing still)
  TRAIN_US_PULSES: 16, // (paper) sixteen US pulses per bout (the shock train)
  TRAIN_US_PERIOD_S: 0.5, // (ours) the paper's 2.0 s period compressed 4x; each `pulse` is 200 ms x 20 mV
  TRAIN_BOUT_MAX_S: 45, // (ours) a CS+ bout waits this long for the fly to arrive, then it is a MISS
  TRAIN_CS_MINUS_S: 12, // (ours) the unpaired CS- presentation (paper: the same 30 s odour, no shock)
  TRAIN_ITI_S: 10, // (ours) fresh air between presentations. Paper: 135 s, model optimum 360 s -- but
  // that optimum comes from the paper's STM->LTM gating, which this rule does not have (ADR 62)
  TRAIN_PROBE_S: 20, // (ours) the CS-only probe before and after training, per odour
  TRAIN_BIAS_SIM_MS: 5000, // (paper) the 5 s test bout: the bias is read over the first 5 s of the
  // brain's own time after CS onset, before the readout baselines creep (BASE_TAU_MS 8 s)
  TRAIN_NEAR_CM: 40, // (ours) head within this of the CS = it went there (the two-way choice)
  TRAIN_SAMPLE_S: 0.25, // (ours) how often the trainer reads the brain message
  TRAIN_STEER_DEAD: 0.05, // (ours) |steer| under this is not a turn either way
  TRAIN_LURE_CM: 16, // (ours) the CS lure's size (object-channel angular size)
  TRAIN_AUTO_CS_MINUS: true, // (ours) a second known thing becomes the unpaired CS-, as in the paper
  TRAIN_TEST_REPEATS: 3, // (paper) the test session's three CS+/CS- bouts (ADR 66: TEST and TRANSFER)
  // Teaching lives on the WEB BRAIN (ADR 68, Pavlo). On the glasses alone one 50 ms brain step
  // costs 1-2 s, so a six-bout session is an hour of standing still and the probes measure a fly
  // that has barely thought. The page runs the same brain in ~100 ms a slice instead of seconds, and it is where the
  // numbers, the history and the brain versions live. The key stays visible and says why.
  TRAIN_WEB_ONLY: true,
  TRAIN_NEEDS_PAGE_MSG: "TEACHING NEEDS THE WEB BRAIN  //  open the page, PIN ",
  TRAIN_VERDICT: true, // ask Gemini to read the evidence pack at TRAIN_DONE
  TRAIN_VERDICT_TOKENS: 700,
  TRAIN_SUMMARY_KEEP: 8, // how many session summaries ride with the fly's identity
  // The first lesson (ADR 69): the whole thing once, in eight plain steps, nothing to know first.
  TRAIN_LESSON_BOUTS: 3, // fewer than the paper's six: the point is understanding, and it must fit ~5 min
  TRAIN_LESSON_MEET_S: 8, // step 1 is a pause: look at the fly before the first instruction lands
  TRAIN_DONE_BANNER_S: 20, // the board says DONE this long after the verdict, then hides (ADR 73)
  // --- PRESENTING a thing (ADR 70, Pavlo: "when we take the cup in our hand") -----------------
  // The end result in plain words: pick up the cup and a trained fly comes and lands on it in your
  // hand within seconds; a naive fly ignores it; a DANGER-trained fly flees when you lift it.
  // ADR 101 (21.09): this is the HAND path only. Pointing at a thing (FlyAttention) is an inspector
  // and never writes `present`; the LEAF kit's presentCue stands in for the hand in headless tests.
  PRESENT_ENABLED: true,
  PRESENT_CM: 15, // a palm this close to a named thing is showing it
  PRESENT_HOLD_S: 0.5, // ...for this long, so brushing past something is not "showing" it
  PRESENT_FADE_S: 3.0, // the smell lingers this long after the hand leaves
  PRESENT_FOLLOW: true, // while held, the thing goes where the hand goes (land on it in your hand)
  TRAIN_LOOM_FROM_CM: 150, // (ours) the aversive US the user can SEE: a shape rushing the fly, from...
  TRAIN_LOOM_TO_CM: 18, // ...to here, repeating every TRAIN_LOOM_S while the PPL101 train plays.
  TRAIN_LOOM_S: 1.2, // It drives the fly's own LC4/LPLC2 loom channel; PPL101 itself is the pulse.
  TRAIN_LOOM_CM: 20, // the looming shape's size (angular size is what LC4/LPLC2 answer)

  // --- the wearer has a smell, and a scare near it is a lesson (ADR 102, 21.09 Pavlo: "якщо я
  // загроза то муха вчиться простіше мене ідентифікувати") ---------------------------------------
  // Head and hands smell of ONE glomerulus (labelOdour("human")), identity-only like a plain object
  // (no appetite in it). A real threat event by the wearer -- a hand or the head looming at the fly
  // above THREAT_LESSON_LOOM, or a hand touching it -- sends a short `punish` (PPL101) so the rule
  // depresses the KC->MBON synapses of whatever she smells then, the wearer's smell first. Mere
  // presence teaches nothing; a gentle wearer is never punished into her memory.
  HUMAN_SMELL: 0.5, // the wearer's odour strength (a wooden table is 0.36 at 30 cm, ADR 93)
  HUMAN_SMELL_HEAD_CM: 60, // sigma of the head's smell
  HUMAN_SMELL_HAND_CM: 25, // sigma of each hand's smell
  THREAT_LESSON: true,
  THREAT_LESSON_LOOM: 0.5, // the wearer's loom (0..1 after LOOM_GAIN) at or above this = a real scare
  THREAT_LESSON_PUNISH: 1.0, // the `punish` value sent (1.0 = 20 mV into the two PPL101)
  THREAT_LESSON_S: 0.5, // ...for this long (the trainer's own pulse is 200 ms; 16 of them per trial)
  THREAT_LESSON_REFRACTORY_S: 4, // one lesson per fly per this many seconds

  // --- the reward follows hunger, discomfort is aversive (ADR 103, 21.09 Pavlo: "хай вона сама
  // змінює той гриб постійно, в залежності від кондицій, як це в реальному світі") --------------
  // A fed fly barely learns that a smell means food: the `reward` (PAM11) the lens sends on landing
  // is scaled by energy -- REWARD_FED at 100 %, 1.0 at or below REWARD_FULL_BELOW, linear between.
  // Landing on real FOOD is a reward too now (it never was: `sweet` does not reach PAM11 in this
  // model, COMPONENTS), so she learns a food smell by herself, and learns it hungry.
  REWARD_ON_FOOD: true,
  REWARD_S: 0.5, // the reward channel stays on this long after the landing
  REWARD_FED: 0.2, // the reward's value at full energy
  REWARD_FULL_BELOW: 0.4, // ...and 1.0 from this energy share down (FOOD_HUNGRY 0.6 = she forages)
  // Heat or cold at the fly (hot/cold >= DISCOMFORT_AT after the local fields) pairs whatever she
  // smells with a small aversive `punish`, pulsed, like heat-shock conditioning. Above the ~0.35
  // firing floor (ADR 31) or it would be silent.
  DISCOMFORT_LEARN: true,
  DISCOMFORT_AT: 0.6,
  DISCOMFORT_PUNISH: 0.5,
  DISCOMFORT_S: 0.3,
  DISCOMFORT_EVERY_S: 6,

  // --- odour IDENTITY (ADR 65): two things in the room must not be the same smell -------------
  // The `odor` channel drives ORN_DM1+DM2+DM4+VA2 together, so every source smelled identical and
  // a cue-specific memory was impossible by construction. A source now also drives ONE glomerulus
  // of its own, on top of the generic channel. Measured on the graph (2 hops, |w| >= 1, of 4,064
  // Kenyon cells): VA2 -> 1388, DM4 -> 1295, DM2 -> 1209, DM1 -> 1410, and the pairs really differ.
  ODOUR_ID: true, // false = the old single-smell world
  ODOUR_IDS: ["odor_va2", "odor_vm7d", "odor_dm2", "odor_dc2", "odor_dm1", "odor_dm4", "odor_dm3", "odor_dm5",
              "odor_dl1", "odor_vm2", "odor_dl5", "odor_vm1", "odor_dc1", "odor_vl2a", "odor_va6", "odor_va7l"], // ADR 105: sixteen, functional farthest-first (0/1 = the most distinct pair)
  ODOUR_FAR: [1, 0, 3, 4, 15, 4, 0, 0, 4, 1, 4, 4, 4, 4, 4, 4], // least-overlapping partner (functional Jaccard, ADR 105)
  ODOUR_ID_GAIN: 0.8, // the identity component, as a fraction of this source's own odour strength

  // --- sound from the brain (FlySound, 11.09) --------------------------------------------
  // 12.09 Pavlo, on the constant 150-160 % CPU: "turn spatial audio off, just do distance-based
  // volume". Off. The loudness was ALREADY ours — `FlySound.distanceGain` — so spatial audio only
  // added the positional (left/right, front/back) effect on top, for every voice, every frame; and
  // the AudioListenerComponent on the camera exists only to feed it, so it is no longer created.
  // 12.09 Pavlo: "drop the buzzing too, it is surplus right now". Off = FlySound is never built, so
  // there are no AudioComponents, no looping play(-1) and no volume writes at all — silencing it
  // with a zero volume would still keep the loops running. Takes the courtship song with it: both
  // voices live in the same component.
  // 21.09 (ADR 91): back ON, distance-based loudness. Note the tracks: FlySwarm only builds
  // FlySound when buzzTrack/songTrack are assigned (Assets/Fly/Audio/fly_buzz.wav and fly_song.wav,
  // wired in Scene.scene); with nothing wired the log says SOUND_NO_TRACK and the dbg row "sound off".
  SOUND_ENABLED: true,
  SOUND_SPATIAL: false,
  SOUND_BUZZ_VOL: 0.5, // master: the loudest steady buzz. 12.09 Pavlo halved 0.55 -> 0.28 when it was "surplus"; 21.09 up again, it could not be heard (ADR 91)
  SOUND_ESCAPE_GAIN: 1.4, // x SOUND_BUZZ_VOL while the fly escapes (the one moment it is louder than steady flight)
  SOUND_SPEED_MIN: 0.5, // buzz volume at a hover (x1 at cruise speed) (11.09 "sounds from speed")
  SOUND_WING_MIN_GAIN: 0.35, // buzz at wing MN rate 0 (a flying fly always buzzes); x1 at this fly's own recent peak
  SOUND_SONG_VOL: 0.8,
  SOUND_SONG_FULL_HZ: 30, // pIP10 rate ABOVE its resting floor that plays the song at full volume
  SOUND_SONG_MARGIN_HZ: 6, // ignore small wobble above the floor (pIP10 idles at ~13 Hz)
  SOUND_WING_FLOOR_HZ: 30, // wing MN auto-range never below this. Measured in flight 28-48 Hz (median 39); was 5, so the first reading read as "the peak"
  SOUND_WING_PEAK_TAU_S: 20, // the auto-range peak forgets with this time constant (an escape burst dims steady flight only this long)
  SOUND_EASE_RATE: 6,
  SOUND_HZ: 15, // 12.09 Pavlo: volume updates at this rate, not once per frame
  // Distance curve — ours (FlySound.distanceGain); the engine's spatial DistanceEffect stays off.
  // Full within NEAR, then inverse distance (NEAR / d) ^ ROLLOFF, and a smoothstep fade over the
  // last FADE cm before FAR. With these values: 1 m 1.00 · 2 m 0.50 · 3 m 0.33 · 4 m 0.25 ·
  // 4.5 m 0.11 · 5 m 0. The old (FAR - d) / (FAR - NEAR) squared ramp (60/400) gave 1 m 0.78 ·
  // 2 m 0.35 · 3 m 0.09 · 4 m 0 — inaudible for most of a room (ADR 91).
  SOUND_NEAR_CM: 100, // full loudness within this of the user's head (11.09: 'fade the buzz by distance')
  SOUND_FAR_CM: 500, // silent beyond this
  SOUND_FADE_CM: 100, // the smooth fade to silence takes the last this-many cm before FAR
  SOUND_ROLLOFF: 1, // 1 = inverse distance (-6 dB per doubling); 2 = inverse square (steeper)
  SOUND_LOG_S: 5, // the SOUND row (wing Hz, speed, distance, gain, volume per fly) every this-many s while DEBUG_TELEMETRY_S > 0; 0 = off

  // --- hearing: Spectacles mic -> Johnston's organ JO-A/B `sound` (FlyEars, ADR 29) ---------
  // 12.09: off for the POC pass. The microphone was the last piece of hardware we held open all
  // session, in the same class as the Gemini voice socket we killed. Checked before flipping: this
  // gates ONLY FlyEars (the mic read behind the `sound` sense). ASK/voice-find uses AsrModule in
  // FlyCommands and opens the mic itself, so it is untouched.
  // A BRAIN INPUT, disclosed: the flies stop hearing — no clap, nothing into JO-A/B.
  EAR_ENABLED: false, // 11.09 false = no mic read, no sound channel
  EAR_SAMPLE_RATE: 16000, // 11.09 mic rate (loudness only, no spectrum needed)
  EAR_BLOCK_MS: 5, // 11.09 level = the loudest block RMS of a frame: a clap is a 5-20 ms transient
  EAR_BG_TAU_S: 2.5, // 11.09 background follows the level this slowly: music / talk lift it, one clap barely
  EAR_BG_FLOOR: 0.004, // 11.09 background never below this (a silent room must not make every tick an onset)
  EAR_MIN_LEVEL: 0.06, // 11.09 an onset is at least this loud (block RMS, full scale 1) — tune on device from dbg ears=
  EAR_ONSET_DB: 14, // 11.09 ...and this far above the background
  EAR_RANGE_DB: 18, // 11.09 dB above the onset threshold that give a full-strength pulse
  EAR_PULSE_MIN: 0.5, // 11.09 weakest onset pulse (sound 1.0 = 20 mV into JO-A/B, the atlas probe)
  EAR_PULSE_S: 0.3, // 11.09 the pulse decays linearly to 0 in this long
  EAR_REFRACTORY_S: 0.25, // 11.09 no second onset within this (a clap's tail / echo)
  EAR_WARMUP_S: 0.6, // 11.09 after a mic (re)start: the background settles, no onsets

  // --- body vitals (BODY section — simulated, never shown as neural) ---------------------
  ENERGY_START: [0.45, 0.95], // 12.09 Pavlo: each fly starts with its OWN energy, so they don't all get hungry together
  ENERGY_IDLE_DRAIN: 0.0015, // per s (11.09: was 0.004 — empty in ~75 s, now ~4 min)
  ENERGY_MOVE_DRAIN: 0.004, // per s at cruise speed (was 0.012)
  ENERGY_ESCAPE_DRAIN: 0.03,
  ENERGY_FEED_GAIN: 0.08, // per s while the feeding neuron fires
  // 12.09: the two senses that were missing. Bristle load = dust picked up by contact and wind,
  // read by the BM bristles -> DNg12 decides to groom; grooming discharges it. Hunger = a current
  // into the appetitive DNs, because the connectome has no gut (both disclosed ADRs).
  BRISTLE_LOAD: 0.22, // per s while sitting on a surface (x0.15 in the air, +50 % in wind): ~5 s to full
  BRISTLE_CLEAN: 0.8, // per s of full grooming: a bout of ~1.5 s clears it
  HUNGER_FEEL: 0.5, // the fly starts feeling empty below this share of energy
  HUNGER_DRIVE: 0.7, // current into the appetitive DNs at zero energy (1.0 = a full sense channel)

  // --- editor closed-loop bench (FlyScenarios, ADR 34) -----------------------------------
  AUTO_DEBUG: false, // 12.09 Pavlo is watching the preview: the bench teleports all three flies at every scenario start, which reads as a glitch. Flip back to true to run the playlist.
  AUTO_INTRO_S: 10, // editor: the room scan runs this long, then the flies appear
  BENCH_SCAN_EVERY_S: 1e6, // bench: no Gemini scans after the intro (voice + narration are off on the bench too)
  SCN_CLAMPS_PER_FLY: 3, // bench: more box clamps per fly than this in one run = the box is in the way
  SCN_STUCK_CM_S: 3, // a flying fly slower than this counts as stuck (hovering in place)
  SCN_STUCK_MAX: 0.35, // ...FAIL when that is more than this share of the flight time

  // --- debug overlay ----------------------------------------------------------------------
  MARKER_MESH_DIAMETER_CM: 12, // native diameter of the sphere preset mesh (11.09: 2 made a 6 cm lure look ~30 cm)
  // --- the compound eye: ommatidia -> ON/OFF -> the optic lobe (ADR 54) -----------------------
  // The old 8x16 `retina` frame is inert (measured: every LC / LPLC / T4 / T5 cell at 0.00 Hz
  // under every image). This is the real path: one camera per eye, the model's OWN 1,767
  // ommatidial columns, Weber-adapted log contrast, injected as ON/OFF into the lamina and the
  // first medulla neurons of each column. Gains live in brain_server/eye.py (MV_LAMINA/MV_MEDULLA).
  RETINA_EYES: true, // false = the engineered loom/motion channels alone, exactly as before
  RETINA_HZ: 4, // samples per eye per second; one GPU->CPU readback per frame at most.
  // 3 flies x 2 eyes x 4 Hz = 24 readbacks/s. ADR 45 measured 1.7-2.2 ms for a 512-texel
  // readback, so budget ~1 ms/frame at 56 fps; read the real number from `eye read=` in the
  // telemetry on the first post-intro run and tune this and RETINA_PX against it.
  RETINA_PX: 24, // render target per eye (24 x 24 ~ 4.2 deg/texel at the centre = one ommatidium)
  RETINA_FOV_RAD: 1.745, // 100 deg per eye; wider would starve the centre (perspective is tan)
  RETINA_EYE_YAW_DEG: 35, // optical axis of each eye from the head axis -> ~30 deg binocular overlap
  RETINA_TAU_S: 0.25, // photoreceptor adaptation / LMC high-pass; keep it near 1 / RETINA_HZ
  RETINA_FULL: 1.0, // log-luminance change that counts as full contrast (an e-fold)
  RETINA_MAX_COLUMNS: 200, // 17.09: was 400. On the glasses a hand in the fly's face drove ~400 columns
  // and the page's step went 50 -> 736 ms; the optic lobe is 104,702 of the 166,700 neurons, so every
  // driven column is paid for in spikes. Halved rather than sampling the eye less often: looming is a
  // DIFFERENCE between successive views, so a lower rate kills the hand signal outright, while the
  // deadzone keeps whichever columns changed most - the ones carrying that signal - so vision only
  // gets coarser, never strobed. // cost guard: each driven column costs the brain (see the ADR); a
  // per-eye deadzone rises until the count is under this, so only the strongest edges get through
  // What the eyes can see besides the room (ADR 54, 15.09). The tracked world mesh already reaches
  // them with its baked room colours; these add the moving things a fly must answer to.
  RETINA_SEE_HANDS: true, // sphere proxies on the tracked hand joints, on a layer only the eyes render
  RETINA_HAND_CM: 9, // proxy diameter: a hand-sized blob for the looming detectors
  RETINA_HAND_DARK: true, // a hand is normally darker than the wall -> the OFF pathway; device-tunable
  RETINA_HAND_DEBUG: false, // seeder: with no hands tracked, sweep one proxy INTO the first eye
  RETINA_DEBUG_FAR_CM: 140,
  RETINA_DEBUG_NEAR_CM: 14,
  RETINA_DEBUG_S: 2.0, // seconds per approach before it loops
  // --- the OCELLI: dorsal brightness -> the ocellar ganglion -> roll and pitch (ADR 70) ---------
  OCELLI_ENABLED: true,
  OCELLI_FOV_RAD: 2.6, // ~149 deg: each half must straddle the HORIZON, not sit on the zenith (ADR 70)
  OCELLI_TAU_S: 4.0, // SLOW adaptation on purpose: a fast one would erase the pitch (common-mode) signal
  OCELLI_BASE: 0.55, // the resting channel value; the reflex modulates around it
  OCELLI_GAIN: 0.45, // per e-fold of dorsal log luminance
  OCELLI_MAX: 1.0, // measured knee: laterality is clean to 1.0 and BREAKS at 1.5 (ADR 70)
  OCELLI_BASE_TAU_S: 60.0, // slow per-side baseline: a lopsided ceiling is not a roll (ADR 70)
  RIGHTING_FROM_BRAIN: false, // ADR 70: roll from DNp20, not from BANK. ON once the sign is verified
  RIGHTING_FULL: 1.3, // measured one-sided DNp20 response at ocelli 1.0 (ADR 70)
  RIGHTING_GAIN: 0.5, // rad of roll per unit of the DNp20 left-right difference
  RIGHTING_REST_TAU_S: 8.0, // each side's own resting rate; slower than a righting transient
  RIGHTING_DEBUG_ROLL: 0, // seeder amplitude (rad); it FLIPS sign every RIGHTING_DEBUG_S. 0 = off
  RIGHTING_DEBUG_S: 6, // force a known bank (rad) to READ the sign off the telemetry; 0 = off
  RETINA_KEEP_FRAME: true, // still send the old 16x8 `retina` frame (R1-R8 + the board panel)
  // --- the eye panel on the board ------------------------------------------------------------
  EYE_PANEL: true,
  // 15.09 Pavlo: "the eyes are small, a bit bigger" — the mosaics now take the whole strip the
  // brain stage leaves free (its box ends at y -16.5) down to just above the footer at -21.9.
  EYE_PANEL_X: -17.51, // the pair starts on the board's left margin, like the caption above it
  EYE_PANEL_Y: -15.0,
  EYE_PANEL_GAP_CM: 1.2, // between the two eyes; also the gap between the two ON/OFF pairs
  EYE_PANEL_H_CM: 4.9, // 15.09: the brain stage was raised (its box now ends at y -11.5), so the
  // strip is ~10 cm instead of 5.4 and the eyes grew with it. WIDTH is not a setting: it follows
  // from the height and the lattice (30 columns over 39 rows at the 0.866 hex row spacing), so an
  // ommatidium stays round and the eye keeps its real proportions. Here the pair is the widest
  // that still leaves the detector bars a comfortable column.
  EYE_PANEL_CAPTION_X: -23.5, // -W/2 + 1.5: every board caption keeps the left margin
  EYE_PANEL_CAPTION_Y: -12.3, // the brain stage box now ends at -11.5 (15.09 layout)
  EYE_PANEL_GAIN: 2.1, // the ON / OFF maps
  EYE_PANEL_IMAGE_GAIN: 1.5, // the ommatidial image: it carries the room's own brightness
  // IMAGE on top (EYE_PANEL_Y / _H_CM), the eye's ON and OFF pair under it
  EYE_PANEL_CX_H_CM: 2.6,
  EYE_PANEL_CX_Y: -19.15, // the small maps keep their size; the block moved up off the footer
  EYE_PANEL_CX_GAP_CM: 0.35, // between an eye's own ON and OFF
  EYE_PANEL_CX_LABEL_DY: 0.45, // caption drop under each small map
  EYE_PANEL_CX_LABEL_SCALE: 0.3,
  // the detector bars sit BESIDE the mosaics, in the column their width leaves free
  EYE_PANEL_LABEL_X: -10.7,
  EYE_PANEL_BAR_CX: -5.8, // L grows left from here, R grows right
  EYE_PANEL_BAR_W: 2.1, // half width
  EYE_PANEL_BAR_Y: -14.1, // first row; five step down, the last label must clear the footer
  EYE_PANEL_BAR_STEP: 1.3, // 15.09 Pavlo: "it's very cramped there" — the rows can breathe now
  EYE_PANEL_BAR_H: 0.65,
  EYE_PANEL_LABEL_SCALE: 0.42,
  EYE_PANEL_HZ: 10, // its own upload clock, under the board's 15 Hz data tick
}
