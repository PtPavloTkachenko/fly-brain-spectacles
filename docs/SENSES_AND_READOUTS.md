# Senses and readouts

How the room gets into the fly brain, and how the brain gets back into the body. All cell type names are MaleCNS v1.0 annotations. Effects are mean firing-rate changes from 20 mV probes in `brain/atlas.py` (`brain/results/atlas.npz`), 1,426 sensory and visual-projection probes against 1,339 cells; the mapping itself is `brain_server/channels.py`, and the brain file carries a snapshot of it.

## Inject at the level that works

Pixels fed to photoreceptors alone do not reach behaviour in this model: an expanding disk on R1–R8 leaves the giant fibre silent, while the same event injected at the fly's own looming detectors (LPLC2/LC4) drives it to 280 Hz. So the lens computes what the fly's optic lobe would compute (looming, object direction, optic flow) and drives those cell types directly (ADR 10). The eyes themselves are still real: the ommatidia feed the lamina and medulla as ON/OFF contrast (ADR 54), and a loom fires LPLC2 22:1 toward the right side through the connectome's own wiring.

A channel value v is a current of 20 mV × v into every cell of its types. Sensory cells fire above about 7 mV (v ≈ 0.35) and saturate by about 0.5, so graded cues start at `SENSE_FLOOR` 0.45 (ADR 31). A packet that stops arriving goes neutral after 3 s of fly time (ADR 104).

## Senses

| Channel | Cells | Source on the glasses | Effect in the brain |
|---|---|---|---|
| `eye` | 1,767 ommatidial columns → L1, L2, L5 (OFF/ON), Mi1, Tm1, Tm2, Tm9 | two cameras on the fly's head (±35°, 100° each); per column Weber contrast against its own running mean, one signed byte (ADR 54) | the optic lobe computes the rest: LC4/LPLC2/LC11/T4/T5 rates on the board |
| `light` | R1–R6, R8 | the mean brightness, pinned to the calibration level 160/255 (ADR 15) | the network is bistable in light; the pin keeps the decoder baselines valid |
| `motion` L/R | LLPC1 | progressive optic flow per eye from the head camera (rays + own yaw rate as fallback) | steering DNa02 +128/+144 Hz, the strongest steering input |
| `loom` L/R | LC4, LPLC2 | your hands and head, or anything moving AT the fly; turned down within 70 cm of a landing target (ADR 24) | escape suite (DNp01/02/04/11) +110–121 Hz on that side |
| `loom_wall` L/R | LPLC1 | eye-ray time to contact with walls and other flies | DNp03 same side +186 Hz: turn away, no escape |
| `object` L/R | LC12, LPC1, LC10a/d | food, scent and lures on that side, other flies | orient DNp66 +48–62 Hz, steer +20–34 |
| `odor` | ORN DM1/DM2/DM4/VA2 | food and scent sources, per antenna, by distance; up to 2.5× stronger while hungry (ADR 26) | weak approach |
| `odor_<glomerulus>` ×16 | ORN DM1, DM2, DM4, VA2, DM3, DL5, DC1, VM2, VA6, DC2, DL1, VL2a, VM1, DM5, VM7d, VA7l | every scanned thing has ONE smell identity, hashed from its label (ADR 65/93/105); the wearer's head and hands share one (ADR 102) | the mushroom body's odour code; two things on the same glomerulus genuinely smell the same to the fly |
| `odor_bad` | ORN V, DA2 | repellents (Gemini class `bad`) | aversion |
| `sweet` | LB3c, claw taste pegs, TPMN1/2 | landing on food or a lure | feeding MN9, proboscis contact +70 Hz |
| `bitter` | LgAG1, LB1c, LB2* | touching a repellent | stop DNpe007 +121 Hz |
| `touch` | notum SNta02/09 | a hand very close | backward walk MDN +18–24 Hz |
| `bristle` | BM bristle neurons | dust load from contact and wind | grooming DNg12 |
| `wind` L/R | JO-C/E | the fly's own airspeed, gusts from a moving hand, a fan / AC / open window Gemini tagged (ADR 96) | stop DNpe007 +53 Hz (airspeed brake), steer ±14–22 |
| `sound` | JO-A/B | clap and bang onsets from the microphone (ADR 29, computed on the glasses; no audio leaves them). Off by default: `EAR_ENABLED` false, nothing reads the mic | stop +24, steer −12…−22: a flinch, rarely a full stop |
| `hot` / `cold` / `dry` / `moist` | TRN_VP2, TRN_VP3, HRN_VP4, HRN_VP5 (assumed identities) | Open-Meteo for the room's climate, warmer and drier indoors (ADR 95), plus Gemini's per-thing warm/cold/humid fields as local gaussians (ADR 96) | wired; not probed |
| `ocelli`, `haltere` | OCG cells; haltere afferents | the fly's own attitude and rotation magnitude | reach the ocellar ganglion and the neck pool, but not behaviour: the righting reflex stays engineered (ADR 70/73) |
| `hunger` | DNge051, DNge023, DNge173 (appetitive DNs) | simulated energy (ADR 26/42) | approach and feeding drive |
| `reward` / `punish` | PAM11 (15 cells), PPL101 (2 cells) | landing on food or a lure → reward × hunger (0.2 fed … 1.0 hungry); a hand rushing at the fly, touching it, or heat/cold → punish (ADR 102/103); a conditioning session's pairings (ADR 62) | dopamine: moves the 7,835 KC→MBON synapses while they fire |

Weak or inert in this model, measured: raw pixels for direction, odour steering on the attractive ORNs alone, sound as more than a flinch.

## Readouts

| Body | Neurons | Decoding |
|---|---|---|
| Turn | DNa02 L/R, DNp66 L/R | `steer` = DNa02 R−L turn + DNp66 orient, deadzoned; saccades from DNa15, DNb01 (VES041 suppresses) |
| Turn away from surfaces | DNp03 L/R | added to steer |
| Escape / take-off | DNp01 (giant fibre), DNp02, DNp04, DNp11 by side | `escape_L/R` |
| Stop / brake | DNpe007 | `stop` |
| Walk backwards | MDN | `back`; the gait phase reverses (ADR 90) |
| Feed | MN9, proboscis pool `pm` | `feed`, proboscis extension, abdomen pumping |
| Appetite | DNge051, DNge023, DNge173 | `appetite` → forward drive (engineered from approach − stop, disclosed) |
| Wing stroke | 67 wing motor neurons (`wm`), steering MNs per side | stroke amplitude and per-side tilt; the buzz's loudness (ADR 91) |
| Halteres | the same drive, antiphase | ADR 90 |
| Song | pIP10 | one wing out and fluttering above its resting rate, while landed (ADR 90) |
| Head, antennae | neck motor neurons `nm` + `orient`; antennal MNs `am` | head yaw, antennal sweep |
| Grooming | DNg12 against its resting rate (not a habituating one), full bristles ≈ 0.7 (ADR 100/106) | when a bout starts and ends |
| Legs | `fl` / `ml` / `hl` pools | how hard each leg pushes; the tripod rhythm is ours |
| Memory (board, page) | MBON07, MBON11, APL, `memory.eff_on` (the efficacy of the plastic synapses whose Kenyon cells fired this step, ADR 67) | whether the fly has learned a smell, and in which direction |
| Reward / stress (board) | PAM11, PPL101 | display |

Region rows on the board (`regions`): optic, central, mushroom-body Kenyon cells, sensory, descending, VNC population rates, each auto-ranged to its recent peak; command cells are silent at rest by biology, so their bars fill from each row's own resting level (ADR 38).

## Engineered, not from the brain

The connectome has no physics, no walking rhythm generator and no gut. These parts are ours and each has a numbered entry in [knowledge/DECISIONS.md](knowledge/DECISIONS.md):

- the tripod walking rhythm (the leg pools do not alternate in this model, measured, ADR 42);
- the flight controller, wing beat rate (visual, 22 Hz) and the saccade shape (ADR 22/41);
- the altitude band, landing approach and touch-down, solid walls, the leash and the comfort bubble around your head (ADR 24/32/35);
- hunger as a current into the appetitive DNs, and the hunger gain on food cues (ADR 26/42);
- the landing gate that scales down loom near a landing target (ADR 24);
- every disclosed input above: smells on things and on the wearer, the climate, the clap detector, the reward and punishment events (ADR 29/93/95/96/102/103);
- the buzz's audibility envelope (ADR 91), the grooming readout's scale (ADR 106), the stale-packet rule (ADR 104).

The brain still chooses when to turn, escape, stop, feed, groom and sing, and what a smell is worth.
