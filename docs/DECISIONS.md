# Decisions

Code comments cite these as `ADR NN`. The numbers are kept from the project's history, so some are missing.

## 01. The brain decides; everything else perceives or executes
Gemini and the world mesh describe what is where. Only the brain's descending and motor neurons choose actions. Gemini never emits an action.

## 02. Translate the room into fly senses; do not train
The reflexes are in the wiring (odour, sugar to feeding, looming to escape). Plasticity is off.

## 04. Gemini is slow perception, geometry is fast senses
Gemini labels objects every few seconds into anchored 3D sources. Every tick, senses are computed from each fly's pose relative to those sources.

## 08. Maximum sensory context
Every tick drives all channels at once and lets the network arbitrate.

## 10. Inject each sense at the deepest level that works
Pixels alone do not reach behaviour in this model; the fly's own feature detectors do. See `SENSES_AND_READOUTS.md`.

## 12. Honest board sections
NEURAL shows measured spike rates. BODY shows simulated vitals (energy, speed) and is never presented as a brain measurement.

## 13. The user is part of the flies' world
Your head and hands are sources: a fast approach looms, a still palm is a landing spot, a pinch is a lure. Flies also sense each other.

## 14. Commands are lures and rewards, never motor control
A voice find or a pinch makes an attractive source for one fly. The brain may refuse. Landing on it gives a 200 ms reward pulse into PAM11.

## 15. Resting light pinned to the calibration level
The network is bistable in light (grey 153: silent; grey 160: DNa02 ≈ 22 Hz). Decoder baselines are valid at 160/255, so the retina mean is pinned there.

## 16. Measured positions for world sources
A Gemini box becomes a world position through a depth test (depth frame on the glasses, World Query in the editor), never a guessed plane. Odour per antenna falls off with distance, so direction comes from the left/right difference.

## 17. Material values are tuned by hand
The fly hologram material is tuned in the Inspector. Code only clones it per fly and multiplies its values.

## 18. Fly count follows the frame budget
Every fly costs a brain on the Mac and a body, senses, eye rays and a trail on the glasses. The lens runs two flies.

## 19. Food near a hungry fly becomes its landing target (engineered)
Within `FOOD_ASSIST_CM` of a hungry fly's head, food becomes a landing target (altitude and touch-down) until the fly is sated. Real food rewards through taste (sweet to MN9), not through an injected reward.

## 21. Faster brains: packed-state CPU kernel
Measured: sharing one connectome gives 1.0x; the time goes into random access to ~8 per-neuron arrays per delivery. Packing that state into one cell gives 2.0–2.2x, bit-identical.

## 22. Flight = decoded DN commands into our controller
Every published embodied fly model drives the body from descending-neuron commands into engineered low-level controllers; none drives flight from connectome motor-neuron rates. So: turning from DNa02, take-off from DNp01, thrust from approach drive and power motor neurons, and our own oscillator for the wing beat. Honest label: DN-decoded commands into an engineered controller.

## 23. The GPU kernel is an exact port with ordered deliveries
No atomic float adds, because summation order changes spikes. See `METAL_KERNEL.md`.

## 24. Landing gate and room walls (engineered)
Within reach of a landing target the eye loom is scaled down (`LAND_LOOM_KEEP`), otherwise the approaching surface triggers the escape and a fly never lands; this model's landing DNs do not respond to loom. Walls are the world mesh itself: a move into the mesh keeps only its sliding part. A padded room box is a far backstop for holes in the mesh.

## 25. One runtime folder, pinned fly-wirehead
`$CYBERFLY_RUNTIME` holds fly-wirehead, its data, the kernel builds and logs. fly-wirehead is pinned because the engine matches its kernel bit for bit; bump it only with `test_equality.py` and `test_metal.py`.

## 26. Object channel for attractive things only; hunger gain (engineered)
Only food, scent and lures drive the object detectors; furniture saturated both sides. Food cues are multiplied by (1 + 1.5 x (1 − energy)): an engineered stand-in for internal state.

## 27. Voice find
Push to talk, one phrase. Gemini picks one of the things the scan already knows; that thing becomes a lure for one fly (ADR 14).

## 28. Spoken voice (removed)
A spoken inner voice was built and removed for performance. The narrator is text only.

## 29. Hearing via a clap detector (off)
The microphone path to JO-A/B exists but is off: in simulation JO-A/B gives no behavioural response.

## 30. Thrust from approach drive
An attractive object raises DNp66 on both sides but lowers the power motor neurons, so thrust = resting drive + approach + a slow power gain. MDN is a walking command and does not affect flight. Baselines habituate over 8 s of brain time; near food only the attraction readouts freeze.

## 31. Senses above the firing floor
Graded cues start at 0.45 (cells fire above ~0.35). Motion drives only the net-progressive side. Sweet goes to LB3c, claw taste pegs and TPMN1/2.

## 32. Landing on any surface (engineered trigger)
The brain wants to stop or has lost forward drive, and an eye ray hits a surface nearby: the fly settles on it. On a surface the body's up is the surface normal, the brain's forward drive walks and its steer turns.

## 33. Walls loom into LPLC1, threats into LC4/LPLC2
Wall loom into the escape detectors jammed flies in corners. LPLC1 drives DNp03 on the same side (turn away) with little escape. Only things moving AT the fly loom into the escape channel; static objects never loom. Other flies are obstacles through the same path, and flies behind a wall are invisible.

## 34. Editor closed-loop bench
`FlyScenarios` runs a playlist of situations in the editor (hungry in air, food on a surface, threat, wall ahead, lure) and logs a verdict per run. It seeds situations; behaviour stays the brain's. Editor only.

## 35. Landing response on a head-on approach (engineered)
Expansion centred ahead means land, off to one side means saccade away (Tammero and Dickinson 2002). Flight bouts of 8–25 s make flies commit to a surface for AR legibility. Flies decelerate before touch-down (van Breugel and Dickinson 2012), land on their own spot around food, and ease onto it. Hunger uses hysteresis (hungry below 0.6, eat to 0.97).

## 36. The narrator only interprets
INNER VOICE is Gemini reading the measured state with a guide to what each neuron means. It never invents numbers and never feeds back into the brain.

## 37. The hologram is a sample; the brain is whole
All 166,700 neurons are simulated every step; the board draws a fixed 16,000-neuron sample (bitset size, 16-bit mesh indices and the activity texture set the number).

## 38. Bars fill from each row's own rest
Some cells are tonically loud (PPL101 rests at 87 Hz). Bars show change from each row's resting level; the number shows the raw rate. Command cells are drawn larger so single neurons are visible.

## 39. One clock, no per-frame garbage
One `UpdateEvent` ticks everything. Hot loops avoid allocations, the board draws only while looked at, and Gemini scans slowly after the room is known.

## 40. Board text is one batched MSDF mesh
Each `Component.Text` is its own mesh and draw call; batching the board's labels into one mesh took text from 67 draws to a few.

## 41. As many bones as possible on the brain
Wing stroke amplitude from the wing motor neurons, head yaw from `orient`, abdomen pumping from MN9, MDN backward steps, legs reaching for perches.

## 42. Motor pools; hunger injected; the gait stays ours
Grooming on DNg12 with a bristle sense, head on neck motor neurons, antennae, proboscis, abdomen and each leg on its own pool. The walking rhythm is engineered: the tripods correlate +0.42 in this model, so the CPG is not there. Hunger enters as a current into the appetitive DNs because the connectome has no gut (deliberately circular for the `appetite` readout, disclosed).

## 43. The neuron cloud needed contrast
About 11 % of sampled neurons spike per step. A low resting glow and a strong spike flash make activity visible.

## 44–46. Performance by measurement
A device Perfetto trace showed the cost was our TypeScript on a saturated main thread, not the GPU (busy 95 ms across 699 s). We ranked by mean cost, removed repeated identical bone writes, ran each eye camera only on the frame before its sample, stopped world-mesh reconstruction after the scan, and staggered world-mesh raycasts round-robin across flies (`WALL_RAY_STAGGER`, a disclosed one-frame change to wall checks). Result: ~4.5 ms of script per frame, 55–60 fps.
