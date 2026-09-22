/**
 * FlyAttention — ADR 89: SELECTING a thing in the room instead of picking it up, and showing the
 * smell that selection creates.
 *
 * Why it exists. A thing in the room has no smell of its own: `WorldSources` gives class `object`
 * sigma 0 and strength 0, and it only borrows the lure's smell while `present > 0`. ADR 70 turned
 * `present` on by HOLDING the thing in your palm — which is impossible for what a room scan
 * actually names (a plant, a curtain, a cabinet, a wall light). Pressing it with the SIK cursor (or
 * poking it) is the same act for things you cannot pick up, and it is disclosed exactly like ADR 70:
 * the smell is real, the fly still decides by itself whether to fly there.
 *
 * And the smell was invisible. It is the whole mechanism by which a fly finds anything, and nothing
 * on screen ever said so. While a thing is attended it wears a wireframe box in the colour of its
 * GLOMERULUS, and the caption under it is written for a PERSON, not for the atlas: the fly does not
 * see this object, to her it is a smell; there are only four smells in her whole world
 * (`FlyConfig.ODOUR_IDS`, ADR 65); and `labelOdour` hashes a label onto one of them, so everything
 * drawn in the same colour smells identical to her and she cannot tell those things apart. The
 * glomerulus name is the last line and the smallest — true, and not the point.
 *
 * And the reach was invisible too. The box says WHERE the thing is; concentric rings on the floor,
 * in the same odour colour, say HOW FAR its smell carries -- the Source's own `sigma` (scent ~110,
 * food ~90, a plain object 0, which still gets one small nominal ring so "this barely smells" is
 * shown, not merely absent). That is the plain answer to "why does she fly to that one, not this".
 *
 * And the caption says what she THINKS of the smell, which is the question the first version left
 * unanswered. Two signals, two halves: her own synapses for the smell that is on (`memory.eff_on`,
 * ADR 67 — drift-free, a frozen control moves it 0.000) decide whether anything has been learned at
 * all, and only then do MBON07 (appetitive) against MBON11 (aversive), each as its elevation over
 * the rest the brain published for it, name a direction. When the synapses moved but the outputs do
 * not separate, the line says so. Read ADR 89 before changing a threshold: the numbers come from
 * ADR 65's own table, where MBON11 swings +12 Hz in a control that cannot have learned anything.
 *
 * What is engineered here, plainly (ADR 101, 21.09 Pavlo: pointing is an INSPECTOR, not a trigger):
 *   - a press makes the thing the attended one and draws its box, rings and caption. It does NOT
 *     touch the thing's smell: every scanned thing smells by itself (ADR 93), and what the caption
 *     shows is that smell as it is. `present` (ADR 70's hand path) is never written here any more;
 *   - only ONE thing is attended at a time — attending a new one releases the old;
 *   - nothing else touches the brain. No steering, no landing gate, no reward.
 *
 * Contract with FlySwarm: three call sites — construction, one tick, and one telemetry term. Sources
 * are not hooked at add/remove: the hit targets are re-synced from `WorldSources.items` at SYNC_S,
 * which covers the scanner, treats, the bench and the multiplayer ghosts through one path.
 *
 * Draws while a thing is ATTENDED: 3 (the box, one batch per plane) + 1 (the reach rings, one
 * batch) + 1 (the caption, one MSDF mesh). While merely HOVERED: the box only. 0 otherwise. Hit
 * targets are colliders only — no visual, no draw.
 */
import { FlyConfig } from "./FlyConfig"
import { Source, WorldSources } from "./WorldSources"
import { NeonBatch, NeonQuadSet, QuadSink } from "./UIBatch"
import { TextBatch } from "./TextBatch"
import { Anim } from "./FlyMotion"
import { makeQuadMesh } from "./FlyFx"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"

const TAG = "FlyAttention"
const log = new NativeLogger(TAG)
const UP = new vec3(0, 1, 0)

// ---------------------------------------------------------------------------------------------
// Constants. They live here, not in FlyConfig: that file is the tuning sheet a developer pastes a local
// relay key into before a device build, so it stays untouched.
// ---------------------------------------------------------------------------------------------

/** ONE colour per glomerulus, in `FlyConfig.ODOUR_IDS` order (va2, dm4, dm2, dm1). Four hues far
 *  apart, every one of them at full brightness in at least one channel — the glasses are an
 *  additive display and a dark box is not a dim box, it is no box. Two things that hash to the same
 *  glomerulus get the same colour on purpose: that IS what the fly smells. */
const ODOUR_COLOR: vec4[] = [ // ADR 105: sixteen, in FlyConfig.ODOUR_IDS order; every hue has a channel at 1.0, red stays BAD's
  new vec4(0.45, 1.0, 0.35, 1), // VA2  lime
  new vec4(1.0, 0.95, 0.25, 1), // VM7d yellow
  new vec4(1.0, 0.4, 0.85, 1), // DM2  pink
  new vec4(0.2, 1.0, 0.8, 1), // DC2  teal
  new vec4(0.35, 0.8, 1.0, 1), // DM1  blue
  new vec4(1.0, 0.7, 0.2, 1), // DM4  amber
  new vec4(1.0, 0.5, 0.12, 1), // DM3  orange
  new vec4(0.65, 0.4, 1.0, 1), // DM5  violet
  new vec4(1.0, 1.0, 1.0, 1), // DL1  white
  new vec4(0.8, 1.0, 0.2, 1), // VM2  chartreuse
  new vec4(0.55, 1.0, 0.7, 1), // DL5  mint
  new vec4(0.4, 0.45, 1.0, 1), // VM1  indigo
  new vec4(0.3, 1.0, 1.0, 1), // DC1  cyan
  new vec4(0.8, 0.35, 1.0, 1), // VL2a purple
  new vec4(1.0, 0.3, 1.0, 1), // VA6  magenta
  new vec4(1.0, 0.72, 0.5, 1), // VA7l peach
]
/** ...and the plain word for each of them, because the caption has to be able to SAY the colour
 *  ("everything amber smells the same"). The word is what a person sees, not the hex. */
const ODOUR_WORD = ["lime", "yellow", "pink", "teal", "blue", "amber", "orange", "violet", "white", "chartreuse", "mint", "indigo", "cyan", "purple", "magenta", "peach"]
/** ...and what that smell IS, in a nose's words (21.09 Pavlo: "з опису не зрозуміло який запах"):
 *  the odorant each glomerulus is tuned to -- VA2 2,3-butanedione (buttery, fermenting), DM4
 *  methyl acetate (a sweet solvent), DM2 ethyl hexanoate (ripe fruit), DM1 ethyl acetate (sharp,
 *  fruity). The hash decides which one a thing gets (ADR 65); the caption tells the truth about it. */
export const ODOUR_SMELL = ["buttery, fermenting", "pear drops", "ripe fruit", "mushroom", "sharp fruit", "a sweet solvent", "banana", "winey fruit", "wintergreen", "pineapple candy", "cut green leaves", "sharp ammonia", "citrus peel", "honey", "rose", "barnyard"]
/** `bad` has no glomerulus (WorldSources sets odourId -1 for it): it drives the aversive channel.
 *  Its own colour, so it can never be read as one of the four. */
const BAD_COLOR = new vec4(1.0, 0.35, 0.35, 1)
const BAD_WORD = "red"
/** A thing with no smell at all (a plain object Gemini gave `smell` 0): the box is drawn in this
 *  colour and the rings say "this barely smells" — attending does not make it smell (ADR 101). */
const IDLE_COLOR = new vec4(0.7, 0.9, 1.0, 1)
const NAME_COLOR = new vec4(1, 1, 1, 1)
/** the explaining line. FlyPalette's TXT value (0.86, 0.95, 1.0) — copied, not imported, because
 *  that file says in writing that the five cards are its only readers, and this is not a card. */
const SAY_COLOR = new vec4(0.86, 0.95, 1.0, 1)
/** the small print under it. FlyPalette's DIM value, the one it says survives the additive display. */
const NOTE_COLOR = new vec4(0.416, 0.565, 0.616, 1)
/** Spelled numbers read as speech; digits read as data. The caption is speech. */
const COUNT_WORD = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen"]

// --- what she THINKS of the smell (ADR 89, second pass) -----------------------------------------
// The caption said what the smell IS and never what it MEANS to her. TWO signals answer that, and
// they answer different halves of it — read the ADR before changing a number here.
const VAL_HIDDEN = -2 // the brain reports nothing we may read: no line at all
const VAL_AVOID = -1
const VAL_NONE = 0 // nothing has been learned about this smell yet
const VAL_KNOWN = 1 // her synapses for it moved, but the outputs do not say which way
const VAL_LIKE = 2
/** HALF ONE — has she learned anything about THIS smell? `memory.eff_on` (ADR 67) is the efficacy
 *  of only the plastic synapses whose presynaptic Kenyon cell fired this step, i.e. the memory OF
 *  THE SMELL THAT IS ON — which, while a thing is attended, is the smell that thing is making.
 *  Measured: synapses no cue drives sit at 1.00083, a paired cue's own at 0.98705 (−1.3 %), an
 *  unpaired one at 1.02132 (+2.1 %), and the FROZEN control moves exactly 0.000. So 0.5 % is six
 *  times the untouched floor and a third of the smallest real effect: under it, "she has no opinion
 *  about this yet" is a measurement, not a guess — and no amount of MBON drift can override it. */
const VAL_EFF_MIN = 0.005
const VAL_EFF_N = 40 // ...over at least this many synapses, or the mean is one Kenyon cell's accident
/** HALF TWO — which way? How far above its OWN published rest each output must be before it is
 *  allowed to name a direction. NOT one number for both: 4 cells at 1.5 Hz and 2 cells at 18 Hz are
 *  different instruments, so one Hz figure would be a different statement for each.
 *  MBON07 = 5 Hz: a live page session sits ~2.5 Hz over the rest it published at warm-up
 *  (`mbon07=4.05` against ~1.5 Hz), the frozen control moved ±1 Hz, and ONE spike of a 4-cell
 *  readout is 1.4 Hz after the brain's own 150 ms smoothing.
 *  MBON11 = 25 Hz: this one is 2 cells and it DRIFTS — 26-40 Hz across a session against the same
 *  ~18 Hz rest, and the frozen control, which cannot have learned anything, swung +12.4 Hz. Any
 *  threshold under that reports drift as an opinion, which is the one thing this line may never do
 *  (ADR 65's table; RUNBOOK "An MBON11 difference between CS+ and CS- looks like a result"). */
const VAL_HZ: { [k: string]: number } = { MBON07: 5, MBON11: 25 }
const VAL_LEAD = 0.5 // ...and the winner must lead the other by this much, in those same units
const VAL_HOLD = 0.6 // a shown direction holds until its score falls below this (no flicker)
const VAL_DWELL_S = 1.0 // and a change must persist this long before the caption is rebuilt

/** bright, additive-safe, and each says its meaning before it is read: FlyPalette's LIVE mint, OFF
 *  orange-red and WAIT gold, by value (see SAY_COLOR for why they are copied and not imported). */
const LIKE_COLOR = new vec4(0.45, 1.0, 0.7, 1)
const AVOID_COLOR = new vec4(1.0, 0.45, 0.3, 1)
const KNOWN_COLOR = new vec4(1.0, 0.812, 0.353, 1)

/** What the brain says about the fly whose caption this is. `BrainLink` satisfies it as it stands. */
export interface RestRates {
  /** how far above its own published rest a readout is, in Hz (0 when there is no rest for it) */
  above(name: string, hz: number): number
  /** the rest itself — an ABSENT key means "no rest known", which is NOT "the rest is zero" */
  baseline: { [k: string]: number }
}

const BOX_PAD = 1.25 // the box is this much bigger than the thing's sizeCm: it surrounds it
/** 21.09 Pavlo: "баундінг бокс не треба показувати, просто радіус дії і опис". The box geometry
 *  still exists (the caption hangs off its near face, the rings sit just outside it), it is
 *  simply not drawn: the floor rings say where the thing is and how far its smell carries. */
const BOX_SHOWN = false
const BOX_MIN_CM = 10 // ...and never smaller than this, or a 4 cm thing draws a speck
const EDGE_FRAC = 0.035 // edge thickness as a fraction of the box
const EDGE_MIN_CM = 0.45
const ON_INTENSITY = 1.7 // attended
const HOVER_INTENSITY = 0.5 // the cursor is on it, nothing pressed yet
const POP_S = 0.32 // the "it worked" entrance
const DROP_S = 0.18

// --- the smell's REACH, drawn as concentric rings on the floor plane (ADR 89, third pass) -------
// The box says WHERE a thing is; the rings say HOW FAR its smell carries -- the plain answer to
// "why does she fly to that one and not this". The reach is the Source's OWN `sigma` (a gaussian
// width, cm): scent ~110, food ~90, bad 60, a plain `object` 0. A 0-sigma thing still gets ONE
// small nominal ring, because "this barely smells" is the lesson, not a missing drawing. These
// constants live here (like the box's), not in FlyConfig, which stays untouched (see above).
const RING_MULT = [0.5, 1.0, 1.5] // ring radii as multiples of sigma: inner, the sigma edge, faint outer
const RING_INTEN = [1.1, 0.8, 0.45] // brightest inside, faint at the outer edge -- additive display (21.09: lifted, 'ледве видно радіуси')
const RING_DOTS = 40 // soft discs per ring; a dotted ring never fills and never washes out the room
const RING_HOVER_SCALE = 0.45 // ring brightness while the cursor only hovers (the box used to do this job)
const RING_NOMINAL_CM = 18 // the single ring a 0-sigma object gets: just outside its box
const RING_MIN_CM = 8 // below this a ring would sit inside the box -- do not draw it
const RING_DOT_FRAC = 0.075 // a dot's size as a fraction of its ring radius... (21.09: 0.045 was barely visible)
const RING_DOT_MIN = 2.4 // ...clamped so a small ring still shows dots...
const RING_DOT_MAX = 9.0 // ...and a big ring's dots do not blob into a disc
/** unit-circle table for the RING_DOTS dot angles, built once (rebuilds are rare, but trig-free). */
const RING_ANG: { c: number; s: number }[] = (() => {
  const out: { c: number; s: number }[] = []
  for (let i = 0; i < RING_DOTS; i++) {
    const a = (i / RING_DOTS) * Math.PI * 2
    out.push({ c: Math.cos(a), s: Math.sin(a) })
  }
  return out
})()

const HIT_PAD = 1.25 // the collider around a thing...
const HIT_MIN_CM = 12 // ...with a floor, so a 4 cm thing is still hittable at arm's length.
//                       Engineered and disclosed: the box drawn is the thing's real size, the
//                       COLLIDER may be bigger than what is drawn.
const SYNC_S = 0.2 // re-sync the hit targets against WorldSources.items at 5 Hz

/** Labels of sources that already carry their OWN SIK interactable and are meant to be PICKED UP:
 *  a treat has an `InteractableManipulation` (ADR 60) and ADR 70's palm path handles its smell. A
 *  second, bigger collider on top of it would swallow the grab, and selecting is only needed for
 *  what cannot be picked up. One label, checked by name because that is how FlySwarm names them. */
const MANIPULATED = ["treat"]

const CAP_GAP_CM = 6 // caption anchor below the box's near-bottom edge (21.09: 4 sat on the frame)
const CAP_NAME_CM = 3.0 // cap heights, world cm at CAP_REF_CM
const CAP_HEAD_CM = 2.1 // what the fly experiences — the headline
const CAP_SAY_CM = 1.45 // the two lines that explain it
const CAP_VAL_CM = 1.7 // what she thinks of it: second only to the headline
const CAP_NOTE_CM = 1.0 // the glomerulus name: true, and deliberately small
const CAP_REF_CM = 180 // the distance the cap heights above are authored for
const CAP_SCALE_MIN = 0.7
const CAP_SCALE_MAX = 2.8
/** No line may be wider than this (caption-local cm, i.e. before the distance scale). Every line
 *  authored below was MEASURED against the real font advances and lands at 32-39 cm; the only line
 *  that can exceed it is a thing's own name, which Gemini writes. `fitCap` shrinks anything longer
 *  rather than letting it run off the side, the way ADR 71 does on the cards. */
const CAP_MAX_CM = 42
const CAP_MIN_CAP = 0.9 // ...but never below this, or the shrink becomes unreadable

const AXIS_VEC = [new vec3(1, 0, 0), new vec3(0, 1, 0), new vec3(0, 0, 1)]
const AXIS_NAME = ["X", "Y", "Z"]

/** The twelve edges of a box: `[dir, sx, sy, sz]`, where the two components that are not `dir` are
 *  +-1 (which corner of the cross-section this edge runs along) and the `dir` one is 0. */
const EDGES: number[][] = (() => {
  const out: number[][] = []
  for (let a = 0; a < 3; a++) {
    const o0 = (a + 1) % 3
    const o1 = (a + 2) % 3
    for (const p of [-1, 1]) {
      for (const q of [-1, 1]) {
        const e = [a, 0, 0, 0]
        e[1 + o0] = p
        e[1 + o1] = q
        out.push(e)
      }
    }
  }
  return out
})()

/** One quad batch = one PLANE. A quad can only be a rectangle in its batch's (right, up) plane, so
 *  three batches cover all three directions — and every edge is drawn TWICE, once in each of the
 *  two planes that contain it, making a `+` cross-section. One plane alone would vanish whenever
 *  the wearer looks along it edge-on. */
const PLANES = [[0, 1], [2, 1], [0, 2]] // XY, ZY, XZ

interface Plane {
  sink: QuadSink
  aR: number
  aU: number
  q: number[] // quad handle per EDGES index, -1 = this plane does not carry that edge
}

interface Target {
  id: string
  src: Source
  so: SceneObject
  size: number
  seen: boolean
}

export class FlyAttention {
  readonly root: SceneObject
  private boxRoot: SceneObject | null = null
  private boxScale: SceneObject | null = null // Anim.popIn writes this one's scale
  private capHolder: SceneObject | null = null
  private cap: TextBatch | null = null
  private capFace: any = null // the same Face the batch lays out with, kept so `fitCap` can measure
  private capText: Text | null = null // fallback when the MSDF atlas is missing
  private box: Plane[] = []
  private ringBatch: NeonBatch | null = null // the reach rings: one batch, all dots (ADR 89, third pass)
  private ringOn = false
  private ringKey = "" // id | rounded sigma | cls: the dots are only rewritten when this changes
  // its OWN spec (never the box's): it carries glow=1, and the box's shared spec must never see that
  private ringSpec: any = { x: 0, y: 0, z: 0, w: 1, h: 1, color: IDLE_COLOR, intensity: 1, glow: 1, visible: true }
  private targets: { [id: string]: Target } = {}
  private nTargets = 0
  private attended: Source | null = null
  private attendedId = ""
  private hovered: Source | null = null
  private hoveredId = ""
  private syncT = SYNC_S // sync on the very first tick
  private boxKey = "" // id | rounded size | mode: the quads are only rewritten when this changes
  private capKey = ""
  private boxOn = false
  // the exit runs on OUR clock, not on an Anim `done` callback: `Anim.run` lands the run it replaces,
  // so a `done` that disables the root would fire the moment the box is shown again mid-exit, and the
  // new box would be invisible for good.
  private hideT = 0
  private capY = 0
  private capYSet = NaN
  private boxHalf = 0 // the box's half-size, so the caption can hang off its NEAR face
  private capAng = 0 // which way that face points, in 32nds of a turn (quantised: a still head writes nothing)
  private capK = 0
  private valence = VAL_NONE // what is DRAWN right now
  private valWant = VAL_NONE // ...and what the brain has been saying for valT seconds
  private valT = 0
  private valWhy = false // the one-shot "why is there no opinion line" diagnostic has been printed
  // reused, never reallocated: the sinks copy out of it immediately (same pattern as FlyEyes)
  private spec: any = { x: 0, y: 0, z: 0, w: 1, h: 1, color: IDLE_COLOR, intensity: 1, visible: true }

  constructor(
    private sources: WorldSources,
    private camera: SceneObject,
    private rest: RestRates,
    batchMat: Material | null,
    neon: Material | null,
    font: Font | null,
  ) {
    this.root = global.scene.createSceneObject("FlyAttention") // scene root: world cm, identity
    this.buildBox(batchMat, neon)
    this.buildRings(batchMat)
    this.buildCaption(font)
    log.i("ATTN_READY box=" + (this.box.length > 0 ? this.box.length + " planes" : "NO MATERIAL") +
      " caption=" + (this.cap ? "batch" : this.capText ? "text" : "NONE") +
      " rings=" + (this.ringBatch ? RING_MULT.length + "x" + RING_DOTS + " dots" : "NONE"))
  }

  // ------------------------------------------------------------------ build

  private buildBox(batchMat: Material | null, neon: Material | null) {
    if (!batchMat && !neon) {
      log.w("ATTN_NO_BOX neither the NeonBatch nor the NeonQuad material was given: selecting still works, nothing is drawn")
      return
    }
    const boxRoot = global.scene.createSceneObject("AttnBox")
    boxRoot.setParent(this.root)
    const boxScale = global.scene.createSceneObject("AttnBoxScale")
    boxScale.setParent(boxRoot)
    const quad = batchMat ? null : makeQuadMesh()
    for (const pl of PLANES) {
      const aR = pl[0]
      const aU = pl[1]
      const name = "AttnEdges" + AXIS_NAME[aR] + AXIS_NAME[aU]
      const sink: QuadSink = batchMat
        ? new NeonBatch(boxScale, batchMat, name)
        : new NeonQuadSet(boxScale, quad!, neon!, name)
      const q: number[] = []
      for (let i = 0; i < EDGES.length; i++) {
        const d = EDGES[i][0]
        // glow 2 = solid corner to corner: a wireframe edge is a line, not a soft bar
        q.push(d === aR || d === aU ? sink.add(0, 0, 0, 1, 1, IDLE_COLOR, 1, 2) : -1)
      }
      sink.setBillboard(AXIS_VEC[aR], AXIS_VEC[aU]) // fixed world axes, set once — never per frame
      sink.flush()
      this.box.push({ sink: sink, aR: aR, aU: aU, q: q })
    }
    boxRoot.enabled = false
    this.boxRoot = boxRoot
    this.boxScale = boxScale
  }

  /** One batch of soft radial discs, laid out later by `setRings` on the floor plane through the
   *  attended thing. Parented under boxRoot (NOT boxScale) so it inherits the thing's world position
   *  but never the box's pop scale, and needs no rotation of its own. NeonBatch only, never the
   *  per-object fallback: 120 discs as 120 draws would blow the budget the box just paid to avoid. */
  private buildRings(batchMat: Material | null) {
    if (!this.boxRoot) return
    if (!batchMat) {
      log.w("ATTN_NO_RINGS no NeonBatch material: the reach rings are not drawn (the fallback would be one draw per dot)")
      return
    }
    const b = new NeonBatch(this.boxRoot, batchMat, "AttnRings")
    // pre-allocate every dot up front: NeonBatch takes no new quads after its first flush, so setRings
    // only moves / recolours / hides these. glow 1 = a soft radial disc, so a dot's orientation on the
    // ring never matters -- which is why axis-aligned quads with ONE shared billboard can draw a ring.
    for (let ri = 0; ri < RING_MULT.length; ri++)
      for (let i = 0; i < RING_DOTS; i++) b.add(0, 0, 0, 1, 1, IDLE_COLOR, 1, 1)
    b.setBillboard(new vec3(1, 0, 0), new vec3(0, 0, 1)) // flat in the world XZ plane: reads as reach on the floor
    b.flush()
    b.so.enabled = false
    this.ringBatch = b
  }

  private buildCaption(font: Font | null) {
    if (!this.boxRoot) return
    const holder = global.scene.createSceneObject("AttnCaption")
    holder.setParent(this.boxRoot)
    this.capHolder = holder
    const mat = TextBatch.material()
    const face = TextBatch.face("ui")
    if (mat && face) {
      this.cap = new TextBatch(holder, "AttnCaptionText", face, mat, 0)
      this.capFace = face
      return
    }
    // the board's own fallback: one Component.Text instead of the batched MSDF mesh
    if (!font) {
      log.w("ATTN_NO_CAPTION no BoardText material / font metadata and no font asset")
      return
    }
    const so = global.scene.createSceneObject("AttnCaptionText")
    so.setParent(holder)
    const t = so.createComponent("Component.Text") as Text
    t.font = font
    t.text = ""
    t.size = FlyConfig.BOARD_TEXT_SIZE
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.horizontalAlignment = HorizontalAlignment.Center
    t.verticalAlignment = VerticalAlignment.Top
    t.layoutRect = Rect.create(-100, 100, -40, 0)
    t.textFill.color = NAME_COLOR
    so.getTransform().setLocalScale(vec3.one().uniformScale(CAP_NAME_CM * 0.5))
    this.capText = t
  }

  // ------------------------------------------------------------------ the smell

  /** Which of the four glomeruli this thing drives, and the colour that says so. */
  private odourOf(s: Source): { name: string; color: vec4 } {
    if (s.cls === "bad") return { name: "BAD", color: BAD_COLOR }
    const i = s.odourId
    if (i < 0 || i >= FlyConfig.ODOUR_IDS.length) return { name: "", color: IDLE_COLOR }
    const id: string = FlyConfig.ODOUR_IDS[i]
    return { name: id.replace("odor_", "").toUpperCase(), color: ODOUR_COLOR[i % ODOUR_COLOR.length] }
  }

  /** A thing the wearer may select: everything the fly can sense that is not the wearer, another
   *  fly, or the one lure slot (those have their own owners and their own entry paths). */
  private eligible(s: Source): boolean {
    if (!s.active || s.cls === "threat" || s.cls === "lure" || s.cls === "fly") return false
    return MANIPULATED.indexOf(s.label) < 0
  }

  private press(id: string) {
    const t = this.targets[id]
    if (!t) return
    if (this.attended === t.src) this.release("pressed again")
    else this.attend(t.src, id)
  }

  /** This thing is now the attended one: the inspector opens on it. Its smell is whatever it already
   *  is (ADR 93) — attending changes nothing the fly senses (ADR 101). */
  private attend(s: Source, id: string) {
    if (this.attended) this.release("replaced by " + s.label)
    this.attended = s
    this.attendedId = id
    // a fresh thing starts with no verdict and has to earn one: never inherit the last thing's
    this.valence = VAL_NONE
    this.valWant = VAL_NONE
    this.valT = 0
    const o = this.odourOf(s)
    log.i("ATTEND thing='" + s.label + "' cls=" + s.cls + " odour=" + (o.name || "-") +
      " size=" + s.sizeCm.toFixed(0) + "cm")
    if (this.boxScale) Anim.popIn("attn.box", this.boxScale.getTransform(), POP_S, 1.22)
  }

  /** Released: the inspector closes. Nothing about the thing changes for the fly. */
  private release(why: string) {
    const s = this.attended
    if (!s) return
    this.attended = null
    this.attendedId = ""
    log.i("ATTEND_OFF thing='" + s.label + "' (" + why + ")")
  }

  /** The cursor left the scene / the thing is gone: drop it. */
  private forget(s: Source) {
    if (this.attended === s) {
      this.attended = null
      this.attendedId = ""
    }
    if (this.hovered === s) {
      this.hovered = null
      this.hoveredId = ""
    }
  }

  // ------------------------------------------------------------------ hit targets

  private make(s: Source): Target {
    const so = global.scene.createSceneObject("AttnHit_" + s.id)
    so.setParent(this.root)
    const size = Math.max(HIT_MIN_CM, s.sizeCm * HIT_PAD)
    const t = so.getTransform()
    t.setWorldPosition(s.pos)
    t.setLocalScale(new vec3(size, size, size))
    const col = so.createComponent("Physics.ColliderComponent") as ColliderComponent
    const box = Shape.createBoxShape()
    box.size = new vec3(1, 1, 1)
    col.shape = box
    const it = so.createComponent(Interactable.getTypeName()) as Interactable
    it.targetingMode = 3
    const id = s.id
    // bind now, not in the component's own start: a runtime-created Interactable starts a frame
    // late and a press before that would do nothing (FlyBoard.makeGrip hit the same thing)
    it.onTriggerStart.add(() => this.press(id))
    it.onHoverEnter.add(() => {
      const t = this.targets[id]
      if (!t) return
      this.hovered = t.src
      this.hoveredId = id
    })
    it.onHoverExit.add(() => {
      if (this.hoveredId !== id) return
      this.hovered = null
      this.hoveredId = ""
    })
    const target: Target = { id: id, src: s, so: so, size: size, seen: true }
    this.targets[id] = target
    this.nTargets++
    return target
  }

  private drop(id: string) {
    const t = this.targets[id]
    if (!t) return
    this.forget(t.src)
    t.so.destroy()
    delete this.targets[id]
    this.nTargets--
  }

  /** Re-sync against the live source list: the scanner, the treats, the bench and the ghosts all
   *  add and remove sources through `WorldSources` without telling anyone, so this is the one path. */
  private sync() {
    for (const id in this.targets) this.targets[id].seen = false
    for (const s of this.sources.items) {
      if (!this.eligible(s)) continue
      let t = this.targets[s.id]
      if (!t) t = this.make(s)
      t.seen = true
      t.src = s
      const want = Math.max(HIT_MIN_CM, s.sizeCm * HIT_PAD)
      if (Math.abs(want - t.size) > 0.5) {
        t.size = want
        t.so.getTransform().setLocalScale(new vec3(want, want, want))
      }
      t.so.getTransform().setWorldPosition(s.pos)
    }
    for (const id in this.targets) {
      if (!this.targets[id].seen) this.drop(id)
    }
  }

  // ------------------------------------------------------------------ the box

  private setEdges(size: number, color: vec4, inten: number) {
    const L = Math.max(BOX_MIN_CM, size) * BOX_PAD
    const h = L / 2
    const t = Math.max(EDGE_MIN_CM, L * EDGE_FRAC)
    const spec = this.spec
    for (const b of this.box) {
      for (let i = 0; i < EDGES.length; i++) {
        const qi = b.q[i]
        if (qi < 0) continue
        const e = EDGES[i]
        spec.x = e[1] * h
        spec.y = e[2] * h
        spec.z = e[3] * h
        spec.w = e[0] === b.aR ? L : t
        spec.h = e[0] === b.aU ? L : t
        spec.color = color
        spec.intensity = inten
        spec.visible = BOX_SHOWN
        b.sink.set(qi, spec)
      }
      b.sink.flush()
    }
    this.capY = -(h + CAP_GAP_CM)
    this.boxHalf = h
  }

  /** Lay the dots of each ring on the floor plane at radii scaled from `sigma`, in the odour colour
   *  so the rings, the box and the caption all agree. A 0-sigma object gets one nominal ring and the
   *  other two hide. Called only when the attended thing or its sigma changes -- never per frame. */
  private setRings(sigma: number, color: vec4, scale: number = 1) {
    const b = this.ringBatch
    if (!b) return
    const spec = this.ringSpec // its OWN spec: carries glow=1, which the box's shared spec must never see
    spec.y = 0 // the thing's own height: boxRoot sits at show.pos, so y=0 is the horizontal plane through it
    spec.color = color
    spec.glow = 1
    let qi = 0
    for (let ri = 0; ri < RING_MULT.length; ri++) {
      const r = sigma > 0 ? sigma * RING_MULT[ri] : ri === 1 ? RING_NOMINAL_CM : 0
      const on = r >= RING_MIN_CM
      const dot = Math.max(RING_DOT_MIN, Math.min(RING_DOT_MAX, r * RING_DOT_FRAC))
      spec.w = dot
      spec.h = dot
      spec.intensity = on ? RING_INTEN[ri] * scale : 0
      spec.visible = on
      for (let i = 0; i < RING_DOTS; i++) {
        spec.x = r * RING_ANG[i].c
        spec.z = r * RING_ANG[i].s
        b.set(qi, spec)
        qi++
      }
    }
  }

  /** One small caption line for the rings: how far this smell carries, or that it barely does. */
  private reachText(s: Source): string {
    return s.sigma > 0 ? "smell reaches ~" + Math.round(s.sigma) + " cm" : "barely a smell -- she must be right on it"
  }

  /**
   * The caption, written for the person and not for the atlas. Three things have to land, in this
   * order, and none of them is a name from a paper:
   *   1. the fly never sees this object — to her it is a SMELL (the headline);
   *   2. there are only four smells in her entire world;
   *   3. everything drawn in this colour smells identical to her, so she cannot tell them apart.
   * The glomerulus (DM4) stays, last and small: it is true, and it is worth something to anyone who
   * knows the atlas, but it is not what this moment is about.
   */
  private capLines(s: Source): { text: string; cap: number; color: vec4; gap: number }[] {
    const bad = s.cls === "bad"
    const o = this.odourOf(s)
    const word = bad ? BAD_WORD : ODOUR_WORD[s.odourId] || "this colour"
    const n = FlyConfig.ODOUR_IDS.length
    const count = COUNT_WORD[n] || "" + n
    // 21.09 Pavlo: the caption used to be SEVEN lines -- name, "a smell not a shape", "only four
    // smells", "everything green smells the same", a verdict, a reach note, and the glomerulus. For a
    // normal person that reads as torn scraps, not a thought. Cut to the one coherent idea: WHAT it
    // is to the fly, and -- only when she actually has one -- what she makes of it. The rest is not
    // gone, it is taught where it belongs: the box COLOUR already says "same colour, same smell", the
    // floor rings already show the reach, and the four-smells fact lives in the "?" legend, said once.
    const v = bad ? "" : this.valText()
    // ADR 96: what else the thing IS to her, in plain words -- Gemini's warm / cold / humid / wind
    // fields, and only the ones that are really there (> 0.3). One line, or none. This is the
    // "why does she drift to the lamp and away from the fan" line; the atlas names stay out of it.
    const P = 0.3
    const bits: string[] = []
    if (s.warm > P) bits.push(s.warm > 0.7 ? "warm to be near" : "a little warm")
    if (s.cold > P) bits.push(s.cold > 0.7 ? "cold" : "a little cold")
    if (s.humid > P) bits.push(s.humid > 0.7 ? "humid" : "a little humid")
    if (s.wind > P) bits.push(s.wind > 0.7 ? "windy" : "a draught")
    const phys = bits.join(", ") // ASCII only: the caption atlas has no middle dot
    // 21.09 Pavlo, second pass: "з опису не зрозуміло який запах чи що це значить". So the smell line
    // names the SMELL (the odorant this glomerulus answers to, in the ring's colour), and the meaning
    // line is always there -- "new to her" is the answer, not noise, when she has no opinion yet.
    const family = bad ? "" : ODOUR_SMELL[s.odourId] || "something"
    // 21.09 Pavlo, third pass: "to her: the smell of rose / she remembers it, still making up her
    // mind" was not understood. Say WHO and WHAT in plain words: the fly cannot see the thing, she
    // smells it, and here is the smell; then, in the same plain register, what she has learned.
    const smellLine = bad ? "a smell she is born to avoid" : "the fly can't see it, she smells: " + family
    return [
      { text: s.label.toUpperCase(), cap: CAP_NAME_CM, color: NAME_COLOR, gap: 0 },
      { text: smellLine, cap: CAP_HEAD_CM, color: o.color, gap: 1.1 },
      { text: phys, cap: CAP_SAY_CM, color: SAY_COLOR, gap: 0.9 },
      { text: v, cap: CAP_VAL_CM, color: this.valColor(), gap: 1.0 },
    ].filter((l) => l.text.length > 0)
  }

  private valText(): string {
    const v = this.valence
    if (v === VAL_LIKE) return "she likes this smell: good things happened here"
    if (v === VAL_AVOID) return "she avoids this smell: bad things happened here"
    if (v === VAL_KNOWN) return "she knows this smell, no opinion about it yet"
    if (v === VAL_NONE) return "a new smell to her: nothing learned about it yet"
    return "her brain is not connected yet: connect it on the web page" // VAL_HIDDEN: no brain steps her (page not joined): say so, plainly
  }

  private valColor(): vec4 {
    const v = this.valence
    if (v === VAL_LIKE) return LIKE_COLOR
    if (v === VAL_AVOID) return AVOID_COLOR
    if (v === VAL_KNOWN) return KNOWN_COLOR
    return SAY_COLOR // "no opinion yet" is information, not a verdict: it reads like the lines above
  }

  /**
   * What she currently thinks of the smell that is on — in two halves, because one signal cannot
   * answer both and pretending otherwise is how a panel starts lying.
   *
   * HALF ONE, has she learned anything about it: her own synapses, `memory.eff_on` (ADR 67). This
   * is the drift-free half — a frozen control moves it exactly 0.000 — so it, and not the output
   * rates, decides whether "no opinion yet" may be said.
   *
   * HALF TWO, which way: MBON07 (the PAM/appetitive compartment) against MBON11 (the PPL101
   * aversive one), each as its ELEVATION over the rest the brain published for it, each divided by
   * its own measured non-learning excursion so the two are comparable. Below those, no direction is
   * named. A direction, once shown, holds until its score falls under VAL_HOLD.
   *
   * Anything we cannot read is hidden, never guessed: no MBON readouts AND no `eff_on` = no line.
   */
  private valTick(dt: number, msg: any) {
    const hz = msg && msg.hz ? msg.hz : null
    const mem = msg && msg.memory ? msg.memory : null
    // the two outputs, but only if the brain reports them AND published a rest to compare against
    let g = 0
    let b = 0
    let rates = false
    if (hz && typeof hz.MBON07 === "number" && typeof hz.MBON11 === "number" &&
        this.rest.baseline["MBON07"] !== undefined && this.rest.baseline["MBON11"] !== undefined) {
      rates = true
      g = this.rest.above("MBON07", hz.MBON07) / VAL_HZ["MBON07"]
      b = this.rest.above("MBON11", hz.MBON11) / VAL_HZ["MBON11"]
    }
    // ...and the synapses of the smell that is on
    let learned = false
    let known = false
    if (mem && typeof mem.eff_on === "number" && (mem.n_on || 0) >= VAL_EFF_N) {
      known = true
      learned = Math.abs(mem.eff_on - 1) >= VAL_EFF_MIN
    }
    let want: number
    if (!rates && !known) {
      want = VAL_HIDDEN
      // withholding is a decision: say once WHY, or the missing line reads as a bug (FLY_WITHHELD)
      if (!this.valWhy) {
        this.valWhy = true
        log.w("ATTN_NO_VERDICT no opinion line: MBON07/11" + (hz && typeof hz.MBON07 === "number" ? " reported but no published rest (the page's `ready` baseline is not stored)" : " not in this brain file") +
          ", and no memory.eff_on either")
      }
    }
    else if (known && !learned) want = VAL_NONE // measured: nothing about this smell has moved
    else {
      // a direction needs its own output clearly up AND clearly ahead of the other one
      const cur = this.valence
      const holdL = cur === VAL_LIKE && g >= VAL_HOLD && g - b >= VAL_HOLD
      const holdA = cur === VAL_AVOID && b >= VAL_HOLD && b - g >= VAL_HOLD
      if (holdL || (g >= 1 && g - b >= VAL_LEAD)) want = VAL_LIKE
      else if (holdA || (b >= 1 && b - g >= VAL_LEAD)) want = VAL_AVOID
      else want = learned ? VAL_KNOWN : VAL_NONE
    }
    // one shown change per VAL_DWELL_S at most: the caption mesh is rebuilt on this value
    if (want !== this.valWant) {
      this.valWant = want
      this.valT = 0
    } else this.valT += dt
    if (want !== this.valence && this.valT >= VAL_DWELL_S) this.valence = want
  }

  /** ADR 71's rule, for a caption with no plate under it: shrink a line until it fits CAP_MAX_CM,
   *  and say so once if even the floor is too wide. Nothing ever runs off the side silently. */
  private capWarned: { [k: string]: boolean } = {}
  private fitCap(text: string, cap: number): number {
    const face = this.capFace
    if (!this.cap || !face) return cap
    // `TextBatch.widthOf` returns EM-width x capCm, but the mesh scales glyphs by capCm / capEm —
    // so the real drawn width is that value divided by the cap height in EM.
    const em = face.capEm > 0.05 ? face.capEm : 0.7
    let c = cap
    while (c > CAP_MIN_CAP && this.cap.widthOf(text, c) / em > CAP_MAX_CM) c = Math.round((c - 0.05) * 100) / 100
    if (this.cap.widthOf(text, c) / em > CAP_MAX_CM && !this.capWarned[text]) {
      this.capWarned[text] = true
      log.w("ATTN_WIDE caption line does not fit " + CAP_MAX_CM + " cm even at cap " + c + ": " + text)
    }
    return c
  }

  private setCaption(s: Source | null) {
    // the verdict is part of the key: it changes as she learns, and the mesh is rebuilt then and
    // only then (valTick already limits that to one change per VAL_DWELL_S)
    const key = s ? s.id + "|" + s.label + "|" + s.odourId + "|" + s.cls + "|" + this.valence + "|" + s.warm + "|" + s.cold + "|" + s.humid + "|" + s.wind : "" // the fields are on the caption too (agent A, 21.09)
    if (key === this.capKey) return
    this.capKey = key
    const lines = s ? this.capLines(s) : []
    if (this.cap) {
      this.cap.begin()
      let y = 0
      let prevHalf = 0
      for (const l of lines) {
        const c = this.fitCap(l.text, l.cap)
        if (prevHalf > 0) y -= prevHalf + l.gap + c * 0.5
        prevHalf = c * 0.5
        this.cap.add(l.text, 0, y, 0.2, c, l.color, "C")
      }
      this.cap.flush()
      return
    }
    if (this.capText) {
      this.capText.text = lines.map((l) => l.text).join("\n")
      if (s) this.capText.textFill.color = this.odourOf(s).color
    }
  }

  // ------------------------------------------------------------------ tick

  /** Called from FlySwarm once a frame after the intro. Reads the sources; writes none of them. */
  tick(dt: number, msg: any) {
    this.syncT += dt
    if (this.syncT >= SYNC_S) {
      this.syncT = 0
      this.sync()
    }
    // the thing may have been removed between syncs (the scanner drops what it stops seeing)
    if (this.attended && !this.targets[this.attendedId]) this.forget(this.attended)
    if (this.hovered && !this.targets[this.hoveredId]) {
      this.hovered = null
      this.hoveredId = ""
    }

    // ADR 101: attending writes nothing to the source. The verdict reads `memory.eff_on`, which is the
    // memory of whatever smell is driving Kenyon cells NOW — the attended thing's only while the fly
    // is inside its reach (the rings). Out of reach it is the memory of what she smells instead.
    if (this.attended) this.valTick(dt, msg)

    const show = this.attended || this.hovered
    if (!this.boxRoot || !this.boxScale) return
    if (!show) {
      if (this.boxOn) {
        this.boxOn = false
        this.boxKey = ""
        this.hideT = DROP_S
        this.setCaption(null)
        Anim.slipOut("attn.box", this.boxScale.getTransform(), DROP_S)
        if (this.ringBatch && this.ringOn) {
          this.ringOn = false
          this.ringBatch.so.enabled = false
        }
      }
      if (this.hideT > 0) {
        this.hideT -= dt
        if (this.hideT <= 0) this.boxRoot.enabled = false
      }
      return
    }

    const on = show === this.attended
    if (!this.boxOn) {
      this.boxOn = true
      this.hideT = 0
      this.boxRoot.enabled = true
      if (!on) {
        Anim.stop("attn.box") // drop a running exit without landing it on top of the new box
        this.boxScale.getTransform().setLocalScale(vec3.one()) // a hover never pops
      }
    }
    this.boxRoot.getTransform().setWorldPosition(show.pos)

    // the quads are rewritten only when the thing, its size or the state really changes
    const o = this.odourOf(show)
    const key = show.id + "|" + Math.round(show.sizeCm) + "|" + (on ? 1 : 0) + "|" + show.odourId + "|" + show.cls
    if (key !== this.boxKey) {
      this.boxKey = key
      this.setEdges(show.sizeCm, o.color, on ? ON_INTENSITY : HOVER_INTENSITY)
    }

    // the reach rings, like the caption, belong to the ATTENDED thing only (a hover is a preview).
    // Rebuilt only when the attended thing or its sigma changes; boxRoot's per-frame world position
    // carries the rings along, so nothing here runs every frame.
    if (this.ringBatch) {
      // 21.09 Pavlo: the box is not drawn any more, so the rings are the pointer's feedback too --
      // dim while the cursor merely hovers, full once the thing is attended
      if (!this.ringOn) {
        this.ringOn = true
        this.ringBatch.so.enabled = true
        this.ringKey = ""
      }
      const rk = show.id + "|" + Math.round(show.sigma) + "|" + show.cls + "|" + (on ? 1 : 0)
      if (rk !== this.ringKey) {
        this.ringKey = rk
        this.setRings(show.sigma, o.color, on ? 1 : RING_HOVER_SCALE)
        this.ringBatch.flush()
      }
    }

    // the caption belongs to the attended thing only: a hover is a preview, not an answer
    this.setCaption(on ? show : null)
    if (!this.capHolder) return
    const holder = this.capHolder.getTransform()
    const cam = this.camera.getTransform().getWorldPosition()
    const toCam = cam.sub(show.pos)
    // The box has DEPTH and the caption is flat. Hung under the box's CENTRE it landed on the
    // near-bottom edge on screen (21.09 Pavlo: "overlaps the frame"), because the edge nearest the
    // eye projects below the centre. So it hangs off the NEAR face: pushed toward the camera by the
    // half-size, along the floor, then CAP_GAP_CM under the bottom edge.
    const hl = Math.sqrt(toCam.x * toCam.x + toCam.z * toCam.z)
    const ang = hl > 1 ? Math.round(Math.atan2(toCam.z, toCam.x) * 16 / Math.PI) : this.capAng
    if (this.capY !== this.capYSet || ang !== this.capAng) {
      this.capYSet = this.capY
      this.capAng = ang
      const a = ang * Math.PI / 16
      holder.setLocalPosition(new vec3(Math.cos(a) * this.boxHalf, this.capY, Math.sin(a) * this.boxHalf))
    }
    holder.setWorldRotation(quat.lookAt(toCam.normalize(), UP))
    // ...and it keeps the same apparent size across the room. Quantised, so most frames write nothing.
    const k = Math.round(Math.max(CAP_SCALE_MIN, Math.min(CAP_SCALE_MAX, cam.distance(show.pos) / CAP_REF_CM)) * 20) / 20
    if (k !== this.capK) {
      this.capK = k
      holder.setLocalScale(new vec3(k, k, k))
    }
  }

  /** One short term for the `dbg` row: what is attended and how many things can be pressed. */
  status(): string {
    const s = this.attended
    if (!s) return "none/" + this.nTargets
    const v = this.valence
    const val = v === VAL_LIKE ? "likes" : v === VAL_AVOID ? "avoids" : v === VAL_KNOWN ? "knows" : v === VAL_NONE ? "naive" : "hidden"
    return s.label.replace(/\s+/g, "_") + ":" + (this.odourOf(s).name || "-") + ":" + val + "/" + this.nTargets
  }

  /** The attended thing, for anything that wants to name it (telemetry, the page feed). */
  get thing(): Source | null {
    return this.attended
  }
}
