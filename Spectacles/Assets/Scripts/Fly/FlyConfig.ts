/**
 * FlyConfig — every tunable of the fly lens in one place (units: cm, s, rad).
 * Named + dated so the tuning ladder is the documentation (foundation playbook §2).
 */
export const FlyConfig = {
  // --- brain link (docs/ARCHITECTURE.md) -------------------------
  WS_URL: "ws://flybrain.local:8790", // mDNS name the brain server publishes
  PING_INTERVAL_S: 2.0,
  PONG_TIMEOUT_S: 6.0,
  SENSE_HZ: 12, // senses per fly per second (12.09: 4 -> 8 -> 12; measured cost in the lens is ~1 ms, the eye rays stay at EYE_HZ)
  EYE_HZ: 4, // ...but the eye rays against the world mesh stay at this rate (they are the expensive part and walls don't move); the cached view is reused between them

  // --- swarm ------------------------------------------------------------------------------
  FLY_COUNT: 2, // 12.09 the user: two for the POC (was 3 — every per-fly cost scales with this: a brain on the server, a body, senses, eye rays, a trail)
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
  DEBUG_TELEMETRY_S: 0, // 12.09 the user, recording on device: all logging off (was 2.0). This also skips
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
  // 12.09 the user: "they crawl along the wall oddly, maybe the legs need a bigger amplitude".
  // The rate now follows speed and the stride stays big, instead of the other way round.
  GAIT_MIN: 0.35, // slowest step rate, as a share of GAIT_HZ
  LEG_STRIDE: 0.55, // rad of coxa swing at full stride (was a flat 0.25 scaled down by speed)
  LEG_LIFT: 0.45, // rad the femur lifts on the swing half (was 0.2)
  LEG_STRIDE_MIN: 0.45, // a fly that walks at all keeps at least this share of the stride
  // 12.09 audit: the flight pose used to snap on the landing frame, and a standing fly never moved
  POSE_BLEND_S: 0.18, // wings fold / unfold and legs take weight over this long
  GROOM_HZ: 5.0, // sweep rate of a grooming leg
  GROOM_SWEEP: 0.95, // rad of coxa swing in a sweep (12.09 the user, twice: "still never seen them wipe" — 0.35 -> 0.6 -> 0.95)
  // 12.09: the bout timer is gone — DNg12 says when (ADR). What is left is the mechanics.
  GROOM_ON: 0.25, // DNg12 drive above this = the legs go up
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
    object: { sigma: 0, strength: 0 }, // phone, keys, AirPods: seen only
    fly: { sigma: 0, strength: 0 }, // another fly: seen (object detectors) + looming, no smell
  } as { [cls: string]: { sigma: number; strength: number } },
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
  // the user's head is a BODY around the camera, not a point at the eyes (12.09 the user: "they only
  // react when I get really close"): a bigger sphere looms from further away, centred behind the eyes
  HEAD_SIZE_CM: 45,
  HEAD_BEHIND_CM: 10,
  HAND_STILL_CM_S: 15, // an open palm slower than this is a landing surface (11.09)
  HAND_LAND_ASSIST_CM: 45, // ...for a fly whose head is this close
  HAND_PUFF_CM: 45, // a moving hand pushes air onto flies this close (JO wind, by side)
  HAND_PUFF_SPEED_CM_S: 120, // hand speed that gives a full gust
  WIND_GAIN: 0.9, // audit 11.09: live wind 0.11 was below the JO firing floor (0.35); 1.0 -> stop 0.58 = airspeed braking (was 0.25); // airflow on JO-C/E at cruise speed (0..1; 1.0 = 20 mV); atlas: JO-C/E -> DNpe007 stop (+54 Hz) = airspeed brake (0.4 made flies hover)

  // --- hologram look (FlyHolo shader; 11.09 the user: "neon rimlight like holograms") --------
  // One neon pair per fly: head colour (= its tab colour on the status board) -> abdomen
  // accent, shifted iridescently by view angle in FlyHolo v2. Fly 0 stays green.
  FLY_COLORS: [
    // 12.09 the user: "keep the green and the pink fly". The flies take the first FLY_COUNT entries,
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
  BOARD_HEADLOCK_IN_EDITOR: true, // 11.09 the user: debug the board head-locked in the editor
  BOARD_DIST_CM: 124, // editor head-lock: doubled with BOARD_SCALE so the preview frames the whole board;
  BOARD_RIGHT_CM: 0, // 11.09: 16 then 7 then 3 — the v2 device is wide, centre it
  BOARD_DOWN_CM: 5,
  BOARD_SCALE: 0.85, // 12.09 the user: "a bit smaller" (was 1.0); 11.09 device test "2x bigger" (was 0.5); whole device (50x46 cm layout -> 25x23 cm; 11.09 "make the whole panel bigger", was 0.34 on 64x36)
  BOARD_ABOVE_PALM_CM: 38, // device: board rides the right palm while it faces the user (centre; bottom edge ~15 cm above, was 14 at scale 0.5)
  BOARD_PALM_PUSH_CM: 30, // 50x46 cm fits the glasses' view only ~70 cm from the eyes; // and this far beyond the hand (away from the eyes) so the other hand can point at it (11.09)
  BOARD_FOLLOW_RATE: 8,
  BOARD_W_CM: 26,
  BOARD_H_CM: 34,
  BOARD_PLATE: 0.34, // 12.09 the user: "more transparent" (0.35 -> 0.2), then "make the backing coloured" — the tint has to read as glass, so intensity comes back up with a real colour behind it
  BOARD_TEXT_SIZE: 48, // glyph atlas resolution (11.09 design pass: 24 rendered torn/pixelated glyphs)
  BOARD_TEXT_SCALE: 1.15, // 11.09 the user: board text bigger (was 1.0); // x BOARD_TEXT_SIZE = same on-screen size as 24 x 2.0, twice the resolution
  BOARD_MONO_DY: 0.35, // cm: Share Tech Mono sits lower than Chakra Petch; lift it (x BOARD_TEXT_SCALE) (11.09 device screenshot)
  BOARD_TEXT_CAP: 0.7, // 12.09: cap height as a fraction of the line height, for batched MSDF text
  BOARD_LINE_CM: 1.55, // rendered line height of board text per unit text scale (tune so the label/value blocks sit on the bars)
  BOARD_BLOCK_TOP_CM: 0.9, // label/value blocks start this far above the first row's centre
  GLOW_DISC_CM: 40, // halved with the fly (11.09 device test) // halo billboard behind every fly (11.09: 44 -> 56 -> 80, "bigger")
  GLOW_DISC_SELECTED_CM: 50, // halved with the fly; // the active fly's halo, bigger and brighter
  GLOW_HALO_IDLE: 0.85, // 11.09: "stronger default glow on every fly" (was 0.45)
  GLOW_HALO_SELECTED: 1.8, // + 0.35 pulse (was 1.4)
  GLOW_DROP_CM: 2.5, // halved with the fly; // the soft glow plane sits this far UNDER the fly (11.09: 14 -> "raise to the body")
  BOARD_DATA_HZ: 15, // 12.09 the user: the panel's numbers/bars/strings tick at 15 Hz, not per frame
  BAR_EASE_RATE: 4, // 1/s: board bars + their auto-range ease to each brain update (~2 Hz) instead of jumping
  BAR_PEAK_TAU_S: 20, // auto-range scale forgets an old peak over ~20 s
  // 12.09 the user: "stress and stop sit at a super high level right from the start". They do — PPL101
  // rests at 87 Hz with no input at all (atlas control) and DNpe007 idles ~110 Hz in the live loop —
  // so a bar drawn from zero is full before anything happens. Each row now fills from its OWN resting
  // level; the Hz text stays the raw measurement (ADR 38).
  BAR_REST_RELATIVE: true,
  // 12.09 the user, pointing at the column of "5.9 Hz / 14.5 Hz / ...": "let's drop these numbers —
  // minus a huge pile of texts to update". Each was its own Component.Text and every write re-lays
  // the text out, on the thread we are short of. The bars stay, and they already fill from each
  // row's own resting level (ADR 38) — what is lost is the absolute rate in figures.
  BOARD_ROW_VALUES: false,
  BAR_REST_UP_TAU_S: 45, // a level that stays high slowly becomes the new normal...
  BAR_REST_DOWN_TAU_S: 4, // ...and a drop is taken as the new normal this fast
  // 12.09 the user: "optimise the trails a bit, the CPU keeps recalculating the MeshBuilder — let's
  // compress them on quality". Each sample rewrites every point of that fly's ribbon and calls
  // updateMesh(), so the cost is points x samples-per-second. Both halved-ish while the trail
  // keeps its LENGTH: 72 x 0.2 s = 14.4 s, exactly what 120 x 0.12 s gave. Work drops to ~36 %
  // (60 % of the points, 60 % as often). The trade is a coarser ribbon — fewer, longer segments.
  TRAIL_POINTS: 72, // 11.09 the user: long trails behind EVERY fly (device test "2x longer": 180 pts cost fx 30-48 ms)
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
  BOARD_FRAME_RIGHT_CM: 30,
  BOARD_FRAME_DOWN_CM: 5,
  BOARD_FRAME_W_CM: 46, // frame around the 50x46 board (x BOARD_SCALE 0.85 = 42.5x39): + a small margin
  BOARD_FRAME_H_CM: 45,
  BOARD_FRAME_EDGE_CM: 3, // the move frame shows when the cursor is this far inside the frame edge...
  BOARD_FRAME_BORDER_CM: 9, // ...or up to this far outside it (the frame's 7 cm border + slack)
  BOARD_FRAME_LINGER_S: 0.5, // stays this long after the cursor leaves the border (no flicker)
  BOARD_FRAME_LIFT_CM: 1.5, // board content sits this far in front of the frame (our UI over the frame's plate)
  // treats (11.09): long LEFT pinch spawns one, release drops it in 3D space
  // easter egg (11.09 the user): two flies mating in a room corner — decoration, no brains
  // 12.09: off for the POC pass. Two FULL skinned fly rigs, posed at 15 Hz and drawn every frame,
  // for a decoration in the corner — and since they were moved in front of the user they are also
  // always in view. Safe to flip: spawnMeme() returns at the top and tickMeme() early-outs on an
  // empty list, so nothing else has to change.
  MEME_ENABLED: false,
  MEME_LIFT_CM: 1,
  MEME_BOB_HZ: 3,
  MEME_BOB_CM: 0.9,
  // landing on any surface (11.09 the user: "they can land on walls, on anything") — OFF until verified
  SURFACE_LANDING: true, // ON for the 11.09 test (was false until verified); watch `surf=` in telemetry
  SURFACE_LAND_CM: 22, // a surface within this of the head (eye rays) can be landed on
  SURFACE_STOP: 0.4, // the brain wants to stop (DNpe007) ...
  SURFACE_IDLE_FWD: 0.12, // ... or has no forward drive ...
  SURFACE_WANT_S: 0.8, // ... for this long -> settle on the nearest surface
  WALK_CM_S: 20, // walking speed at full forward drive (12.09 the user "they only sit": 6 cm/s = 0.1 body length/s, invisible; a real fly walks 1-2 body lengths/s)
  SURFACE_WALK_DEAD: 0.2, // forward below this = standing
  SURFACE_TAKEOFF_FWD: 0.75, // sustained forward drive above this ...
  SURFACE_TAKEOFF_S: 1.5, // ... for this long = take off
  SURFACE_MAX_S: 40, // longest stay before taking off again
  SURFACE_MAX_FORAGE_S: 6, // ...or this, when the fly is hungry AND smells food: it goes looking (ADR 35)
  FORAGE_ODOR: 0.15, // odour level that counts as 'there is food somewhere'
  SURFACE_JUMP_CM: 8, // push-off along the normal at take-off, now eased in (12.09 the user: the instant 8 cm pop read as a teleport)
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
  // 12.09 the user: "the apple's material should be holographic, take it like the flies" — FlyHolo with
  // its own pair (red rim, amber body) so a treat reads as food, not as a fourth fly
  TREAT_RIM: new vec4(1.0, 0.25, 0.3, 1.0),
  TREAT_BODY: new vec4(1.0, 0.72, 0.2, 1.0),
  TREAT_MAX: 5,
  WALL_MARGIN_CM: 8, // a fly stops this far in front of a world-mesh surface it would fly into (solid walls, 11.09)
  WALL_TURN_RATE: 4, // 1/s: a fly touching a wall turns its heading along it (or away, head-on) (11.09)
  // 12.09: one fly per frame does its world-mesh raycasts, round-robin. ADR 39 named this the
  // biggest remaining engine saving and we had not taken it. Measured why it is worth taking: the
  // trace has the GPU busy 95 ms across a 699 s span while the main thread runs 45,992 ms of work
  // in a 42,579 ms span — 108 %, saturated — and the user reads 15-20 % GPU on the device. The eye
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
  CLOUD_RADIUS_CM: 9, // half-length of the long axis on the board's holo stage (board-local cm; 7 on the old 17 cm pad)
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
  // 12.09 the user: "the brain just burns non-stop, you can't see the neurons working". Measured: at a
  // 50 ms step 10.7 % of the 16,000 spike (1709 dots) — the DATA is fine, the drawing was not. Every
  // dot glowed at 0.6 and 16,000 of them add up into one slab, while a spiking dot was only ~2x a
  // sleeping one. The silhouette now comes from the shell meshes; the dots carry the activity.
  CLOUD_BASE_GLOW: 0.15, // resting dot floor (was 0.6: the slab)
  CLOUD_FLASH: 2.6, // a spiking dot is this much brighter -> ~17x contrast instead of ~2x
  CLOUD_DECAY: 0.45, // spike level per brain step after it fires (0.5 was a ~200 ms smear)
  CLOUD_SHELL_GLOW: 0.35, // brain/VNC outline rim = FlyHolo glow x this (11.09 "silhouette should read")
  CLOUD_SHELL_BODY: 0.5, // outline body fill = FlyHolo bodyGlow x this
  // 12.09 the user: "show what the brain sees" — FlyVision's 16x8 retina, the exact array sent to the
  // brain, in the corner under the holo stage. Not the camera image: that coarseness is the point.
  RETINA_PANEL: true,
  RETINA_CELLS: [16, 8],
  RETINA_X: -13.75, // 12.09 the user "centre it": the same x as the holo stage above it
  RETINA_Y: -18.4, // ...and a little higher
  RETINA_W_CM: 2.8, // width of ONE eye (8x8 cells); 12.09 the user: smaller again
  RETINA_GAP_CM: 0.8, // ...with this much between the two eyes
  RETINA_GAIN: 1.7,
  // display only: FlyVision pins the mean to 160 so the brain sees contrast, not exposure — and the
  // room is painted from a rough world-mesh bake, so the raw view is flat. The panel stretches it.
  RETINA_CONTRAST: 3.2,
  MINI_FLY_CM: 7.5, // 12.09 the user: a bit smaller, so the brain rises and the eye panel fits below // mini hologram of the selected fly on the board (board-local cm; 10 overlapped the brain caption side-on)
  LENGTH_CM: 17.5, // giant fly length (fly_model LENGTH_M 0.35; device test 11.09 "2x smaller", was 35)
  MODEL_LENGTH_CM: 35, // the fly GLB's built length (fly_model LENGTH_M 0.35): containers scale LENGTH_CM / this
  LANDED_LIFT_CM: 1.5, // thorax above the surface when landed (scaled with the fly: 3 at 35 cm)
  CLOUD_SPIN: 0.35, // sway phase speed, rad/s (the mini fly turntable uses it too)
  CLOUD_SWAY: 0.45, // brain sways +-0.45 rad about vertical around the frontal view
  CLOUD_FACE_DEG: 180, // 12.09 the user: "turn the brain 180 deg towards us in the panel" — spin about the vertical after the upright flip

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
  // fly-eye cameras (FlyVision, 11.09 the user: cameras on their heads into render targets)
  VISION_ENABLED: true, // (11.09 A/B: not the cause of the 140 ms hitches — worst frame identical without it)
  VISION_HZ: 3, // 12.09 device recording: each tick is a whole extra camera pass per fly (was 6, 11.09: was 10)
  VISION_FOV_RAD: 1.75, // vertical; 32x16 at aspect 2 -> ~134 deg horizontal
  VISION_TEX_CELL_CM: 40, // blocks of 20 cm on the world mesh: trackable by a 32 px eye
  VISION_TEX_INTENSITY: 8,
  VISION_FLOW_EASE: 6, // 1/s smoothing of the measured flow
  // room colours baked onto a world-mesh copy for the eye cameras (WorldColorBake, 11.09 the user)
  BAKE_GEOM_S: 3, // re-read the growing world mesh's vertex positions this often
  BAKE_VOXEL_CM: 8, // colour memory cell; 256x256 hash texture = 64x32x32 voxels (5.1 x 2.6 x 2.6 m, then wraps)
  BAKE_ROWS: 48, // sparse full-width row readback per scan frame
  BAKE_POS_SCALE: 100, // extracted world-mesh vertices are in metres -> cm
  BAKE_CAL_LOCK_CM: 80, // vertex-frame calibration locks when the best flip's median hit error is below this (and half the next)
  BAKE_AFTER_SCAN: false, // 12.09 the user: nothing re-reads the world mesh once the scan is done (it was
  // a 95 ms spike every BAKE_GEOM_LATE_S, growing with the room). true = keep the room box growing
  BAKE_GEOM_LATE_S: 30, // ...at this interval, when BAKE_AFTER_SCAN is on (12.09: every 10 s showed up as a 52 ms frame spike)
  BAKE_MAX_VERTS: 20000, // colour at most this many vertices per frame (strided)
  BAKE_FLIP_Y: true, // readback rows bottom-up (flip if colours land upside down)
  BAKE_GAIN: 1.0,
  BAKE_TEXTURE: 0.25, // +- block pattern for optic flow on flat colours

  // --- world scan: Gemini = slow perception, geometry = fast senses (ADR 04/16) ------------
  SCAN_ENABLED: true,
  GEMINI_MODEL: "gemini-2.5-flash", // the Depth sample used 2.5-pro: better boxes, ~3x slower
  // 11.09 the user: "at the start I scan the world mesh a little, then scanning is non-stop"
  INTRO_SCAN_S: 8, // room-scan phase: flies appear after it, in front of wherever the user looks
  SCAN_INTRO_EVERY_S: 1, // back-to-back Gemini passes during the intro
  WORLD_MESH_AFTER_INTRO: false, // keep the scanned mesh visible after the intro (debug)
  // 12.09: keep RECONSTRUCTING the room after DONE SCANNING. Off — the room does not change while
  // you watch flies, and we were rebuilding it for the whole session. The mesh already built stays
  // queryable, so the eye rays keep hitting. If `hits=` in the telemetry drops to 0 after the scan,
  // this is why: flip it back to true.
  MESH_TRACK_AFTER_SCAN: false,
  // 12.09 the user: "at startup you can switch off any world-mesh visualisation". Off = the room mesh
  // is never made visible during the intro and gets no grid material, so the biggest mesh in the
  // scene — one that GROWS the whole time you look around — is not drawn at all. The scan still
  // happens: tracking builds the mesh, Gemini still finds objects, the colour bake still runs, and
  // the fly eyes still get the mesh afterwards (hideWorldMesh moves it to the vision layer, which
  // now happens immediately since there is no grid left to dissolve).
  SCAN_GRID_SHOW: false,
  SCAN_GRID_CELL_CM: 12, // neon grid on the world mesh during the scan (11.09: light, then dissolves)
  SCAN_GRID_INTENSITY: 0.45, // 11.09: 0.8 covered the board — 'light' visualisation
  SCAN_GRID_DISSOLVE_S: 0.35, // 12.09 the user: "simplify the scan-end animation, it is heavy" — the neon
  // grid is drawn over the WHOLE world mesh while it burns away, so 1.6 s was 1.6 s of that draw.
  // 0 = no dissolve at all: the grid goes the moment DONE SCANNING is pressed
  SCAN_FIRST_S: 1,
  EDITOR_SCAN_EVERY_S: 1e6, // 12.09: the preview wedged five times, always with Gemini scanning on (it ran 8 h straight while the bench kept Gemini off). Off in the editor while we prove that; the glasses keep SCAN_EVERY_S.
  // 12.09 the user: "let's do depth every 10 seconds and scan less often, less camera use". Depth is
  // now better than every 10 s — the session only runs during a capture window (see below) — and
  // the Gemini pass went 5 -> 10 s. The COLOUR camera cannot be closed: CameraTextureProvider
  // exposes only onNewFrame in 5.15, with no stop, so that stream stays open whatever we do; our
  // handler already returns immediately when no capture is armed.
  // 12.09 the user: "after the room scan turn depth test and the camera off completely — we've scanned
  // everything, that's enough for a POC". Off = the scanner's interval goes to 1e6 at DONE
  // SCANNING, so no pass ever arms again; and because depth and the colour callback are both tied
  // to arming (SCAN_DEPTH_GATED), they simply never start. The room map stays: the same 1e5 test
  // that stops scanning also stops findings expiring. The colour STREAM still cannot be closed in
  // 5.15 — no API — but from here nothing reads it.
  SCAN_AFTER_INTRO: false,
  SCAN_DEPTH_GATED: true, // start the depth session only while a capture is armed, then stop it.
  // If `depthScans` in the telemetry falls to 0, the session needs longer than SCAN_DEPTH_WAIT_S
  // to produce its first frame — turn this off and depth goes back to running continuously.
  SCAN_EVERY_S: 10, // 12.09 the user, recording on the device: back-to-back Gemini passes (0.5) grab a camera
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
  // 12.09 the user: "they only need lookAt at the start". Not quite — a label must still turn when you
  // walk around it — but it needs nothing while the head is still. Re-aim only once the camera has
  // moved this far or turned at all since the last aim (the 8 Hz tick still gates the check).
  SCAN_LABEL_AIM_CM: 2,
  SCAN_LABEL_SCALE: 2.5, // floating label above each found object (~4 cm caps)
  SCAN_LABEL_LIFT_CM: 5, // label origin above the anchor so the arrow tip sits on it (tune by eye)
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
  NARRATE_ENABLED: true,
  NARRATE_FIRST_S: 3,
  NARRATE_EVERY_S: 20, // 12.09 the user: "let it not spam words so often" (was 8)
  NARRATE_TYPE_CPS: 45, // typing reveal, characters per second
  NARRATE_LINE_CHARS: 30, // the Gemini section has bigger text: fewer characters per line so nothing runs past the plate
  BOARD_GEMINI_H_CM: 9, // its own plate on the board (12.09 the user: a whole section for Gemini)
  BOARD_GEMINI_TEXT: 0.78, // ...and bigger text inside it (rows use 0.56)
  BOARD_GEMINI_PLATE: 0.18, // plate intensity behind the section

  // 12.09: the spoken inner voice (Gemini Live -> FlyVoice, ADR 28) is gone, and its nine knobs with
  // it — model, per-fly prebuilt voices, volume, distance falloff, timeouts. the user turned it off and
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

  // --- sound from the brain (FlySound, 11.09) --------------------------------------------
  // 12.09 the user, on the constant 150-160 % CPU: "turn spatial audio off, just do distance-based
  // volume". Off. The loudness was ALREADY ours — `FlySound.distanceGain` — so spatial audio only
  // added the positional (left/right, front/back) effect on top, for every voice, every frame; and
  // the AudioListenerComponent on the camera exists only to feed it, so it is no longer created.
  // 12.09 the user: "drop the buzzing too, it is surplus right now". Off = FlySound is never built, so
  // there are no AudioComponents, no looping play(-1) and no volume writes at all — silencing it
  // with a zero volume would still keep the loops running. Takes the courtship song with it: both
  // voices live in the same component.
  SOUND_ENABLED: false,
  SOUND_SPATIAL: false,
  SOUND_BUZZ_VOL: 0.28, // 12.09 the user: half the loudest buzz (was 0.55)
  SOUND_SPEED_MIN: 0.5, // buzz volume at a hover (x1 at cruise speed) (11.09 "sounds from speed")
  SOUND_SONG_VOL: 0.8,
  SOUND_SONG_FULL_HZ: 30, // pIP10 rate ABOVE its resting floor that plays the song at full volume
  SOUND_SONG_MARGIN_HZ: 6, // ignore small wobble above the floor (pIP10 idles at ~13 Hz)
  SOUND_WING_FLOOR_HZ: 5, // wing MN auto-range never below this
  SOUND_EASE_RATE: 6,
  SOUND_HZ: 15, // 12.09 the user: volume updates at this rate, not once per frame
  SOUND_NEAR_CM: 60, // full loudness within this of the user's head (11.09: 'fade the buzz by distance')
  SOUND_FAR_CM: 400, // silent beyond this

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
  ENERGY_START: [0.45, 0.95], // 12.09 the user: each fly starts with its OWN energy, so they don't all get hungry together
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
  AUTO_DEBUG: false, // 12.09 the user is watching the preview: the bench teleports all three flies at every scenario start, which reads as a glitch. Flip back to true to run the playlist.
  AUTO_INTRO_S: 10, // editor: the room scan runs this long, then the flies appear
  BENCH_SCAN_EVERY_S: 1e6, // bench: no Gemini scans after the intro (voice + narration are off on the bench too)
  SCN_CLAMPS_PER_FLY: 3, // bench: more box clamps per fly than this in one run = the box is in the way
  SCN_STUCK_CM_S: 3, // a flying fly slower than this counts as stuck (hovering in place)
  SCN_STUCK_MAX: 0.35, // ...FAIL when that is more than this share of the flight time

  // --- debug overlay ----------------------------------------------------------------------
  MARKER_MESH_DIAMETER_CM: 12, // native diameter of the sphere preset mesh (11.09: 2 made a 6 cm lure look ~30 cm)
}
