# Decisions, the short version

The full record is [knowledge/DECISIONS.md](knowledge/DECISIONS.md): 100+ numbered ADRs with the measurement behind each call. Code comments cite them as `ADR NN`. The numbers are kept from the project's history, so some are missing or superseded. This page is the map.

## The rules everything else follows

- **01. The brain decides; everything else perceives or executes.** Gemini and the world mesh describe what is where. Only the brain's descending and motor neurons choose actions. Gemini never emits an action.
- **02 / 48 / 62. Translate the room into fly senses; the reflexes are in the wiring.** Plasticity is the paper's own dopamine rule on the mushroom body, not a trained policy.
- **10. Inject each sense at the deepest level that works.** Pixels alone do not reach behaviour in this model; the fly's own feature detectors do. The eyes are still real (54).
- **12 / 36. Honest board.** NEURAL shows measured spike rates; BODY shows simulated vitals and says so; the INNER VOICE is an interpretation, never a measurement.
- **22 / 24 / 26 / 78. Motion comes from the brain.** Every engineered override is a disclosed ADR; `act.forward` defaults to 0; no brain, no fly.
- **17. Material values are tuned by hand.** Code only clones the hologram material per fly and multiplies its values.

## Where the brain runs

- **05 / 23. The Mac brain server, on a bit-exact Metal kernel** (the original; now the editor bench).
- **47. The whole brain as one portable C++ core** (`core/`), verified identical to the Python reference; the page and the Mac compile from it.
- **52 / 82. The same exact brain on the GPU** (Vulkan, then WebGPU): exact because the arithmetic cannot differ (integer weights, correctly rounded `+ - *`), not because the orders match.
- **55. The brain on a web page**: WASM core + WebGPU kernel, joined by a 4-digit PIN through a relay. Every visitor brings their own GPU.
- **61. The web twin**: the page shows the REAL brain, all 166,700 neurons and a million synapses, and the lens sends it the room.
- **75 / 76. One Supabase project in three places** (the page's `config.js`, the lens's relay and memory URLs); the project lives on Snap Cloud; a LAN relay is a dev tool.
- **84 / 86 / 87. The LAN socket is off, the in-lens brain is paused, then deleted.** The page is the only brain; the lens is publishable; the core stays because the page and the Mac compile from it.
- **107. A dropped brain is shown, not hidden**: the fly blinks out, the header says DROPPED and keeps the PIN.

## Senses

- **15.** Resting light pinned to the calibration level (the network is bistable in light).
- **16 / 19.** Gemini boxes become world positions through a depth test, never a guessed plane; odour per antenna falls off with distance.
- **29.** Hearing: the microphone → an engineered clap detector → the auditory JO cells; the brain decides. Off by default (`EAR_ENABLED` false), so the shipped lens never reads the microphone.
- **33 / 35.** Walls loom into LPLC1 (turn away), threats into LC4/LPLC2 (escape); a head-on approach triggers the landing response.
- **54.** The fly really sees: 1,767 ommatidia → ON/OFF → the connectome's own optic lobe.
- **65 / 93 / 105.** Every scanned thing has one of sixteen smell identities, hashed from its label; a plain object smells identity-only.
- **95 / 96.** The room's climate from the real forecast, warmer indoors; Gemini reads each thing's warm/cold/humid/windy fields.
- **102 / 103.** The wearer smells; a scare near the wearer is a punishment; landing on food pays a reward scaled by hunger; discomfort is aversive.
- **104.** A sense packet goes stale after 3 s of fly time.

## Body

- **41 / 42 / 90.** As many bones as possible on the brain's own motor pools: wings, halteres, head, antennae, proboscis, abdomen, legs, the song wing, the backward gait, the groom pose. The tripod rhythm stays ours, measured.
- **60.** Five treats, drawn at random, wearing their own textures.
- **91.** The buzz's loudness is the wing motor neurons' rate; the distance envelope is ours.
- **100 / 106.** DNg12 is read against its resting rate; full bristles ≈ 0.7. Grooming can fire.

## Learning and memory

- **62 / 66 / 68 / 71.** The conditioning sessions are the paper's own protocol run in the room; seven session types; the page can drive them. A nine-step first lesson and the on-glasses TEACH key were built and are off by default (`LESSON_ENABLED` false): sessions are started from the page's TRAINING tab (`app.html?tab=training`).
- **63 / 92.** The plastic state is a blob the lens owns, keyed by the user, kept on the glasses between sessions; it fades over three hours.
- **65 / 67.** The memory is cue-specific (the instrument was wrong); sparsening the Kenyon-cell code was built, measured, and not shipped because it makes learning weaker.
- **89 / 101.** Pointing at a thing is an inspector that shows its smell and what the fly thinks of it, never a trigger.

## Multiplayer, interface, performance

- **53.** Other people's flies: one brain per device, bodies over Sync Kit (COLOCATED).
- **57 / 58 / 59 / 85.** One flow: start card → scan card → boot card → the dashboard; the board's own skin; no data until there is data.
- **97 / 98 / 99.** The board never hides the fly; tap a row to get its story; plain meaning as the headline, the atlas as the small print.
- **39 / 40 / 45 / 46 / 69 / 80.** Performance by attribution: one clock, batched text, rank by the mean, the lens is draw- and RAM-bound, the perf probe on a nanosecond clock, the room scanned only after the choice.
