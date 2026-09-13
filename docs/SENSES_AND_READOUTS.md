# Senses and readouts

How the room gets into the fly brain, and how the brain gets back into the body. All cell type names are MaleCNS v1.0 annotations. Effects are mean firing-rate changes from 20 mV probes in `brain/atlas.py` (`brain/results/atlas.npz`).

## Inject at the level that works

Pixels fed to photoreceptors alone do not reach behaviour in this model: an expanding disk on R1–R8 leaves the giant fibre silent, while the same event injected at the fly's own looming detectors (LPLC2/LC4) drives it to 280 Hz. So the lens computes what the fly's eye and optic lobe would compute (looming, object direction, optic flow) and drives those cell types directly. The retina still receives the fly's real view for completeness.

A channel value v is a current of 20 mV x v into every cell of its types. Sensory cells fire above about 7 mV (v ≈ 0.35) and saturate by about 0.5, so graded cues start at `SENSE_FLOOR` 0.45.

## Senses

| Channel | Cells | Source on the glasses | Effect in the brain |
|---|---|---|---|
| `retina` / `light` | 3,335 R1–R6 + 811 R8 | each fly's 32x16 head camera, folded into a 16x8 RGB retina, mean pinned to 160/255 | context; the network is bistable in light, so the mean is pinned to the calibration level |
| `motion` L/R | LLPC1 | optic flow per eye from the head camera (rays as fallback) | steering DNa02 +128/+144 Hz, the strongest steering input |
| `loom` L/R | LC4, LPLC2 | your hands and head, or anything moving AT the fly | escape suite (DNp01/02/04/11) +110–121 Hz on that side |
| `loom_wall` L/R | LPLC1 | eye-ray time to contact with walls and other flies | DNp03 same side +186 Hz: turn away, no escape |
| `object` L/R | LC12, LPC1, LC10a/d | Gemini food, scent and lures on that side, other flies | orient DNp66 +48–62 Hz, steer +20–34 |
| `odor` / `odor_bad` | ORN DM1/DM2/DM4/VA2 · V/DA2 | Gemini food and scent sources, per-antenna Gaussian by distance | weak approach / aversion |
| `sweet` | LB3c, claw taste pegs, TPMN1/2 | landing on food | feeding MN9, proboscis contact +70 Hz |
| `bitter` | LgAG1, LB1c, LB2* | touching a repellent | stop DNpe007 +121 Hz |
| `touch` | notum SNta02/09 | a hand very close | backward walk MDN +18–24 Hz |
| `wind` | JO-C/E | the fly's own airspeed, gusts from a moving hand | stop DNpe007 +53 Hz (airspeed brake) |
| `bristle` | BM bristle neurons | dust load from contact and wind | grooming DNg12 |
| hunger | appetitive DNs (DNge051/023/173) | simulated energy | see "Engineered" below |

Weak or inert in this model, measured: sound on JO-A/B, odour steering on the attractive ORNs, raw pixels for direction.

## Readouts

| Body | Neurons | Decoding |
|---|---|---|
| Turn | DNa02 L/R, DNp66 L/R | `steer` = DNa02 R−L turn + DNp66 orient, deadzoned |
| Turn away from surfaces | DNp03 L/R | `avoid` = (DNp03_L − DNp03_R) / 120 Hz, added to steer |
| Escape / take-off | DNp01 (giant fibre), DNp02, DNp04, DNp11 by side | `escape_L/R` |
| Stop / brake | DNpe007 | `stop` |
| Walk backwards | MDN | `back`, walking only |
| Feed | MN9, proboscis pool `pm` | `feed`, proboscis extension, abdomen pumping |
| Appetite | DNge051, DNge023, DNge173 | `appetite` |
| Thrust | DNp66 fixation, DLM/DVM power motor neurons, DNg02 | resting drive + approach + slow power gain |
| Wing stroke | 67 wing motor neurons (`wm`), steering MNs per side | stroke amplitude, per-side tilt |
| Saccades | DNa15, DNb01 (VES041 suppresses) | when and which way |
| Head | neck motor neurons `nm` + `orient` | head yaw |
| Antennae | antennal motor neurons `am` | antennal sweep |
| Grooming | DNg12 | when a grooming bout starts and ends |
| Legs | `fl` / `ml` / `hl` pools | how hard each leg pushes |
| Reward / stress (board) | PAM11, PPL101 | display |

## Engineered, not from the brain

The connectome has no physics, no walking rhythm generator and no gut. These parts are ours and each has a numbered entry in [DECISIONS.md](DECISIONS.md):

- the tripod walking rhythm (the leg pools do not alternate in this model, measured);
- wing beat rate (visual 22 Hz) and the saccade shape;
- flight altitude band, landing approach and touch-down, solid walls and bodies;
- hunger as a current into the appetitive DNs, and a hunger gain on food cues;
- the landing gate that scales down loom near a landing target;
- the arena leash and the comfort bubble around your head;
- the reward pulse when a fly lands on a lure.

The brain still chooses when to turn, escape, stop, feed and groom.
