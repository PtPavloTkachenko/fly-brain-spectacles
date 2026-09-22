/**
 * FlyBoard v3 — the neon "FLY BRAIN LINK" device (ADR 12/13, 11.09 feedback):
 *   left  = HOLO STAGE: a mini hologram of the selected fly that mirrors its live pose in
 *           place (wings, legs, proboscis, head) + that fly's brain (16,000 neurons, live);
 *   right = tabs (SIK), NEURAL live spike rates (Hz, auto-ranged — measured), ACTION, the BODY
 *           section (simulated; never shown as a brain measurement) and Gemini's INNER VOICE;
 *   all wrapped in a neon frame with corner brackets, header, dividers and captions.
 * Perf (11.09 "are draw calls a disaster?" — 125 in the main view): every neon quad of the board
 * is ONE NeonBatch mesh (1 draw instead of ~48); each NEURAL row has its own label + value Text
 * at the bar's y (two multi-line blocks drifted off the bars on device, 11.09); tabs / rows / the scan button keep invisible SIK hit objects (no draw).
 * Anchoring: head-locked in the editor (debug), rides the right palm on device.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { InteractableManipulation } from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import { BrainCloud } from "./BrainCloud"
import { BrainMsg } from "./BrainLink"
import { TextBatch } from "./TextBatch"
// 5.23 UI Kit: the kit's own buttons for the few real buttons (plate + hover/press feedback);
// rows and tabs stay invisible hit boxes on the batched board (a kit button each would be a draw call each)
import { FlyConfig } from "./FlyConfig"
import { FlyEyePanel } from "./FlyEyePanel"
import { FlyGuide, GuideState } from "./FlyGuide"
import { FlySidePanel } from "./FlySidePanel"
import { FlyStart } from "./FlyStart"
import { FlyScan } from "./FlyScan"
import { BrainLinkView, FlyBoot, brainNumbers, brainStep, brainWhere, brainWhy, gpuCheckRunning } from "./FlyBoot"
import { Anim, Ease } from "./FlyMotion"
import { BONES, FlyBody } from "./FlyBody"
import { NeonBatch, NeonQuadSet, QuadSink, addFrame } from "./UIBatch"
import { CARD_RENDER_ORDER } from "./UICard"
// the board's colours, shared with the start / scan / boot / guide cards (FlyPalette). The
// palette's dark editor-only ink is deliberately not imported: nothing on the board ever drew
// with it, and dark ink is invisible on the glasses anyway.
import { BODY, FRAME, GEM, LIVE, OFF, PLATE, TRACK, TXT, TXT2, WAIT, WHITE } from "./FlyPalette"

const log = new NativeLogger("FlyBoard")

// 11.09 Pavlo: "more vertical, bigger, compact right side" — was 64x36 landscape
const W = 50 // board-local cm (whole device, before BOARD_SCALE)
const H = 46
// Design tokens (11.09 design pass): cyan = structure, two text tiers, the selected fly's colour
// = the only accent, amber = BODY (simulated, never the brain's colours). Chakra Petch for words,
// Share Tech Mono for numbers (tabular digits: values don't jitter as they change).
// The colours themselves live in FlyPalette, one set for all five cards -- with the reason each
// value is what it is, including the plate: a LIT tinted glass, one flat fill (12.09 Pavlo: "I'd
// fill it with a solid colour, less noise"), never the website's dark plate, which additive glass
// does not draw at all.
const BTN_IDLE = 0.55 // button body intensity at rest / hovered (15.09 Pavlo: "too bright")
const BTN_HOVER = 0.8
const BTN_ON = 0.72 // a toggle that is on
const BTN_LINE = 0.5 // its outline
const BTN_REFUSE = 0.3 // 16.09: a key that is refusing (ADR 68's TEACH without a page) rests here
// text scales (x BOARD_TEXT_SCALE, board-local): one step per tier, nothing below T_SMALL
const T_TITLE = 1.05
const T_ACTION = 0.8
const T_LABEL = 0.56
const T_CAPTION = 0.46
// 16.09 typography pass: 0.42 rendered as mush (cap 0.52 cm; the start-card capture read
// "MalwCNS v1.0 connuctumu"), and it sat 9 % from T_CAPTION, which is not a step. Five tiers now.
const T_SMALL = 0.46
const T_KEY = 0.66 // every key label (15.09 typography pass: one size for all keys)
// 12.09 Pavlo: no neuron counts in the caption ("16,000 of 166,700" read as a limitation of the
// brain; the brain is whole, the hologram shows a sample of it)
// 21.09 copy pass (audience rule): a newcomer sees dots — say what a dot is
const CLOUD_CAPTION = "HER BRAIN  //  EACH DOT A NEURON"
// hoisted formatters: passing them as arrow functions made a fresh closure per row per frame
const UPV = new vec3(0, 1, 0)
// 15.09 perf pass: hoisted out of the per-frame follow block, which rebuilt both every frame.
const FRAME_LIFT = new vec3(0, 0, FlyConfig.BOARD_FRAME_LIFT_CM)
const SCRATCH_SCALE = new vec3(1, 1, 1) // reused: setLocalScale/setWorldScale copy the value
const FMT_HZ = (x: number) => x.toFixed(1) + " Hz"
const FMT_PCT = (x: number) => Math.round(x * 100) + "%"
const FMT_CMS = (x: number) => Math.round(x) + " cm/s"

// NEURAL rows (11.09 "every bar should move"): whole-region population rates always fluctuate
// (`msg.regions`); command cells (`msg.hz`) are silent at rest by biology and flare on events.
// Every row auto-ranges to its own recent peak.
// 21.09 copy pass (ADR 98, audience rule): `label` is the plain meaning and is the headline; `atlas`
// is the cell's name, drawn after it in the small tier — true for anyone who knows the atlas, never
// the thing a newcomer has to read first. A tap on the row opens the side panel (FlyGuide.ROW_BLURBS).
const NEURAL = [
  { key: "optic", label: "VISION", atlas: "", floor: 2 },
  { key: "central", label: "CENTRAL BRAIN", atlas: "", floor: 2 },
  { key: "mushroom", label: "MEMORY", atlas: "", floor: 2 },
  { key: "sensory", label: "SENSES", atlas: "", floor: 2 },
  { key: "descending", label: "BRAIN TO BODY", atlas: "", floor: 2 },
  { key: "vnc", label: "NERVE CORD", atlas: "VNC", floor: 2 },
  { key: "DNa02_L", label: "STEER LEFT", atlas: "DNa02", floor: 30 },
  { key: "DNa02_R", label: "STEER RIGHT", atlas: "DNa02", floor: 30 },
  { key: "escape", label: "ESCAPE", atlas: "DNp01+", floor: 30 },
  { key: "stop", label: "STOP", atlas: "DNpe007", floor: 30 },
  { key: "feed", label: "FEED", atlas: "MN9", floor: 30 },
  { key: "stress", label: "STRESS", atlas: "PPL101", floor: 60 }, // 21.09 Pavlo: "давай стресс повернемо" -- the word he wants; the blurb says it is the punishment dopamine
]
// scale -> cap height in board cm, the same factor `still` applies (to measure a label before drawing)
const CAP_K = FlyConfig.BOARD_TEXT_SCALE * FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_TEXT_CAP
const SIDE_GAP = 2.2 // the seam between the board's right edge and the side panel (the guide keeps the same on the left)
// left holo stage (board-local cm): mini fly on top, brain below
const STAGE_X = -13.75
const STAGE_W = 20
// 12.09 Pavlo: "shrink the 3D fly a little, that lets the brain go up and the eyes fit underneath"
const STAGE_FLY_Y = 13.6 // 15.09 Pavlo: a smaller fly, the brain higher, more room for the eyes
const STAGE_FLY_H = 8.2
const STAGE_BRAIN_Y = -2.0
const STAGE_BRAIN_H = 19
const DIV_X = -2.5
// right column (compact): label | bar | value, all inside the frame
const RX = -1
const BAR_X0 = 9.5
const BAR_W = 10.5
const BAR_H = 0.75
const ROW_H = 1.8 // 12.09: 2.0 left the Gemini section only 2.6 cm and its text ran over the bottom frame
const ROW0_Y = H / 2 - 9.9
const VAL_X = W / 2 - 1.2 // values right-aligned to one clean edge
const TAB_Y = H / 2 - 5.2
const SCAN_BTN_Y = H / 2 + 5 // DONE SCANNING floats above the board's top frame
const GRIP_Y = -H / 2 - 2.8 // the move grip, under the bottom frame
// the two keys above the board share the width: ASK on the left, LEARNING on the right, a gap between
const ASK_X = -6
const ASK_W = 24
const GRIP_W = 22 // 15.09 Pavlo: "hard to hit": a wide bar and a hit box taller than it
// how to teach the fly, under the LEARNING key (ADR 14/48)
// 16.09 copy pass: these are the smallest type in the lens, unplated, ABOVE the board's top frame --
// i.e. read against the real room. 76 and 85 characters were unreadable there; the meaning is kept.
const LEARN_HINT_OFF = "point at a thing; getting there rewires her memory"
const SIDE_HOVER_OPEN_S = 0.35 // a hover this long on a NEURAL row opens its side panel (21.09)
const LEARN_HINT_ON = "each rewarded landing rewires it; fades in ~3 h"

interface Row {
  track: number // quad handles in the board batch
  fill: number
  hl: number // hover backdrop behind the label
  y: number
  max: number // eased scale
  peak: number // scale target (recent peak)
  rest: number // this row's own resting level: the bar fills from here, not from zero (ADR 38)
  floor: number
  shown: number // eased value
  value: Text | null // the row's own value text (at the bar's y)
  str: string
}

export class FlyBoard {
  root: SceneObject
  onTab: (fly: number) => void = () => {}
  onScanDone: () => void = () => {}
  onAsk: () => void = () => {} // ASK button: voice find (FlyCommands, ADR 27)
  private content: SceneObject
  private ui: QuadSink
  private rows: { [k: string]: Row } = {}
  private tabs: number[] = []
  private tabNums: Text[] = []
  private brackets: number[] = []
  private edges: number[] = [] // the four frame lines: they light when the grip is hovered / held
  private grip = -1
  private gripHeld = false
  private gripHover = false
  private fonts: { ui: Font | null; mono: Font | null }
  private header: Text
  private status: Text
  private action: Text
  private footer: Text
  webPin = "" // ADR 55: shown in the header and the footer, the page joins the brain room with it
  private linkWasOn = false // ADR 107: a link that was up and is not any more = DROPPED, not "not connected"
  private dropped = false
  private pinHeader: Text
  private pinShown = ""
  // ADR 58: the cards before the dashboard, and the soft flow between them
  private start: FlyStart | null = null
  private scan: FlyScan | null = null
  private boot: FlyBoot | null = null // ADR 84: the third card — what the brain is doing
  private revealed = false // the scan is over
  private dashOn = false // ...and the dashboard itself is up (the boot card may still stand between)
  onStart: (multi: boolean) => void = () => {}
  /** ADR 84: set once by FlySwarm. The boot card and the brain line only READ these. */
  brainLink: BrainLinkView | null = null

  showStart() {
    if (this.start) this.start.show()
  }

  /** the scan card pops in under the start card's tail (or at once when there was no start choice) */
  showScan() {
    if (!this.scan || this.scan.visible || this.revealed) return
    const delay = this.start && this.start.visible ? 0.16 : 0
    if (this.start && this.start.visible) this.start.hide()
    this.scan.show(delay)
  }

  /** per frame during the scan: the card's typewriter, sweep and counter */
  setScan(dt: number, seconds: number, found: number, surfaces: boolean) {
    // 16.09: the start card ticks off the same clock. It is the one that has to stay alive while
    // Sync Kit takes its ~5 s to answer (polish playbook §3), and it has no update of its own.
    if (this.start) this.start.tick(dt)
    if (this.scan) this.scan.tick(dt, seconds, found, surfaces)
    if (this.boot) this.boot.scan(seconds, found, surfaces) // ADR 84: the same numbers, one card later
  }

  /**
   * DONE SCANNING. ADR 84: the dashboard is NOT what comes next unless a brain is already stepping —
   * with no brain every NEURAL / BODY row would read 0.0 and the fly is withheld anyway (ADR 78), so
   * the boot card takes the slot and says what the brain is doing. The dashboard opens under ITS tail.
   */
  reveal() {
    if (this.revealed) return
    this.revealed = true
    if (this.start && this.start.visible) this.start.hide()
    const delay = this.scan && this.scan.visible ? 0.16 : 0
    if (this.scan && this.scan.visible) this.scan.hide()
    if (this.boot) {
      this.boot.scanDone()
      if (!this.boot.done) {
        this.boot.show(delay)
        return
      }
    }
    this.openDash(delay)
  }

  /** the dashboard itself, under whichever card was last (one entrance, one owner) */
  private openDash(delay: number) {
    if (this.dashOn) return
    this.dashOn = true
    this.content.enabled = true
    Anim.popIn("board.content", this.content.getTransform(), 0.45, 1.2, delay)
    if (this.guide) this.guide.show(true, delay + 0.15)
  }
  private guide: FlyGuide | null = null
  private guideHint: Text | null = null
  private brainPlate = -1 // the strip's plate + accent: hidden when the strip has nothing to say (a page is the brain)
  private brainAccent = -1
  private brainStripOn = true
  private guideAutoHidden = false

  /** FlySwarm reports the session's phase every frame; the card diff-caches every write (ADR 57) */
  setGuide(s: GuideState, secondsSinceIntro: number) {
    if (!this.guide) return
    s.learning = this.learnOn || this.learnWanted
    this.guide.set(s)
    // the card leaves by itself once the fly has been around for a while (GOT IT does it sooner; "?" brings it back)
    if (!this.guideAutoHidden && secondsSinceIntro > FlyConfig.GUIDE_AUTO_HIDE_S) {
      this.guideAutoHidden = true
      this.guide.show(false)
    }
  }
  private cloud: BrainCloud | null = null
  private cloudErr = ""
  private mini: SceneObject | null = null
  private miniRoot: SceneObject | null = null
  private miniBones: { [n: string]: Transform } = {}
  private miniMats: Material[] = []
  private miniSpin = 0
  private miniT = 0
  private shownFly = -1
  private hovered = -1
  private hoverRow: string | null = null // 11.09: hovered NEURAL row -> that branch lights up in the cloud
  private shownHover: string | null = null
  private brainCaption: Text
  // ADR 84: the brain line, in the strip the retired fly tabs left free
  private brainWhereT: Text | null = null
  private brainStepT: Text | null = null
  private brainWhyT: Text | null = null
  private brainNumsShown = ""
  private banner: string | null = null // overrides the header status (intro room scan)
  private thought: Text
  private thoughtFull = ""
  private thoughtShown = 0
  private askPulse = 0
  private oneFly = false
  // ASK (voice find) sits in the DONE SCANNING slot once the scan is over — never both at once
  private askKey: { so: SceneObject; kit: boolean; quads: number[]; on: (v: boolean) => void; hover: (cb: (on: boolean) => void) => void; idle: (k: number) => void; live: (k: number) => void; flash: () => void } | null = null
  private askHit: SceneObject | null = null
  private askLabel: Text | null = null
  private askText = "ASK A FLY  >"
  private askLive = false
  private askShown = false
  private learnKey: { so: SceneObject; kit: boolean; quads: number[]; on: (v: boolean) => void; hover: (cb: (on: boolean) => void) => void; idle: (k: number) => void; live: (k: number) => void; flash: () => void } | null = null
  private learnHit: SceneObject | null = null // LEARN toggle (native brain only: dopamine plasticity)
  private learnLabel: Text | null = null
  private learnHint: Text | null = null
  private learnBtnOn: ((v: boolean) => void) | null = null
  private learnOn = false
  private learnShown = false
  onLearn: (on: boolean) => void = () => {}
  onTrainMode: (m: string) => void = () => {} // a key on the guide's session picker (ADR 66)
  onLessonChoice: (key: string) => void = () => {} // a choice key in the guide's lesson (ADR 71)
  framed = false // world-space inside a ContainerFrame (set by FlySwarm): the frame owns the transform
  private shown = 0
  private pos: vec3 | null = null
  private rot: quat | null = null

  get contentRoot(): SceneObject {
    return this.content
  }

  setBanner(s: string | null) {
    if (s === this.banner) return
    this.banner = s
    // ADR 73: a phase change is worth one beat, so the line is noticed instead of just being there
    if (s && this.status) Anim.pulse("board.banner", this.status.getTransform(), 1.10)
  }

  /** MaleCNS brain + VNC outline meshes around the live cloud (FlySwarm `brainShells` input). */
  addBrainShells(prefabs: ObjectPrefab[], holo: Material | null) {
    if (this.cloud) this.cloud.addShells(prefabs, holo)
  }

  cloudStatus(): string {
    return this.cloud ? "ok " + this.cloud.status() : this.cloudErr || "none"
  }

  // 12.09: batched MSDF text (TextBatch) is being wired in to replace ~40 Component.Text draws.
  // The probe first: `requireAsset` cannot see assets the scene does not reference (BrainCloud hit
  // "Cannot find asset" on prefabs), so this logs what resolved before anything depends on it.
  private textMat: Material | null = null
  private uiFace: any = null
  private monoFace: any = null
  private probeText() {
    this.textMat = TextBatch.material()
    this.uiFace = TextBatch.face("ui")
    this.monoFace = TextBatch.face("mono")
    log.i("TEXTBATCH_PROBE mat=" + (this.textMat ? "ok" : "MISSING") +
      " ui=" + (this.uiFace ? "ok cap=" + this.uiFace.capEm.toFixed(3) : "MISSING") +
      " mono=" + (this.monoFace ? "ok cap=" + this.monoFace.capEm.toFixed(3) : "MISSING"))
  }

  private quad: RenderMesh
  private neon: Material
  private batchMat: Material | null

  constructor(parent: SceneObject, quad: RenderMesh, neon: Material, batchMat: Material | null, miniPrefab: ObjectPrefab | null, holo: Material | null, brain: Material | null, fonts: { ui: Font | null; mono: Font | null }) {
    this.quad = quad
    this.neon = neon
    this.batchMat = batchMat
    this.fonts = fonts
    this.probeText()
    this.root = global.scene.createSceneObject("FlyBoard")
    this.root.setParent(parent)
    this.content = global.scene.createSceneObject("Content")
    this.content.setParent(this.root)
    const c = this.content
    this.ui = batchMat ? new NeonBatch(c, batchMat, "BoardNeon") : new NeonQuadSet(c, quad, neon, "BoardNeon")
    const ui = this.ui
    // every label that never changes goes into ONE batched MSDF mesh instead of its own Component.Text
    // (12.09: the board was 67 text draw calls of the ~90 in view). Colour rides in the vertices.
    if (this.textMat && this.uiFace) this.txt = new TextBatch(c, "BoardTextStatic", this.uiFace, this.textMat, CARD_RENDER_ORDER)
    // ADR 97 (21.09 Pavlo: "хай муха просвічується"): every board visual draws BEFORE the fly and
    // writes no depth, so a fly behind the board is ADDED through it instead of being cut out. The
    // 12.09 depth-only occluder that hid her is gone.
    ui.setRenderOrder(CARD_RENDER_ORDER)

    // ---- device body: faint plate, neon frame, corner brackets, header rule, divider ----
    ui.add(0, 0, -0.6, W, H, PLATE, FlyConfig.BOARD_PLATE, 2) // 12.09: one solid tint, still see-through; 15.09: flat corner to corner
    const fr = addFrame(ui, 0, 0, W, H, FRAME, FlyConfig.FLY_COLORS[0])
    this.edges = fr.edges
    this.brackets = fr.brackets
    // the grip: a bar under the bottom edge, ours instead of the UI Kit Frame's grey plate (15.09
    // Pavlo). Hover lights it and the edges; a pinch on it drags the whole board (makeGrip).
    this.grip = ui.add(0, GRIP_Y, 0, GRIP_W, 1.0, FlyConfig.FLY_COLORS[0], 0.45)
    ui.add(0, H / 2 - 3.2, 0, W - 2, 0.16, FRAME, 0.6, 2)
    ui.add(DIV_X, -1.8, 0, 0.16, H - 7, FRAME, 0.5, 2)

    // ---- header ----
    this.still("FLY BRAIN LINK", -W / 2 + 1.5, H / 2 - 2.35, T_CAPTION, TXT2)
    this.header = this.text(c, "FLY 1", -W / 2 + 11, H / 2 - 2.35, T_TITLE, FlyConfig.FLY_COLORS[0])
    this.status = this.text(c, "BRAIN ...", W / 2 - 1.5, H / 2 - 2.35, T_CAPTION, WAIT, { align: "R" })
    // 15.09 Pavlo: "put the PIN somewhere at the top so it is visible": the header, between the title
    // and the brain status, in the fly's colour; "PAGE ON" once a page is the brain (footer keeps it too)
    this.pinHeader = this.text(c, "", W / 2 - 13.5, H / 2 - 2.35, T_LABEL, FlyConfig.FLY_COLORS[0], { align: "R", mono: true })

    // ---- left: holo stage, stacked vertically (11.09: "fly and brain can go vertical") ----
    this.still("THIS FLY  //  HER BODY, LIVE", -W / 2 + 1.5, H / 2 - 5.1, T_CAPTION, TXT2)
    this.brainCaption = this.text(c, CLOUD_CAPTION, -W / 2 + 1.5, STAGE_BRAIN_Y + STAGE_BRAIN_H / 2 - 0.5, T_CAPTION, TXT2)
    // ONE eyes section (15.09 Pavlo): with the compound eye on, the hex mosaic IS the eye panel
    // and the old 16x8 view and its caption retire — two captions for one thing read as a bug.
    if (!(FlyConfig.RETINA_EYES && FlyConfig.EYE_PANEL)) this.makeRetina(quad)
    // the compound eye + the optic lobe it drives (ADR 54). Its own file; it only borrows the
    // board's quad batch and static-text helper, so nothing else on the board moves.
    this.eyePanel = new FlyEyePanel(c, quad, this.ui, (t, x, y, sc, col, al) => this.still(t, x, y, sc, col, al), FlyConfig.FLY_COLORS[0], TXT2)
    ui.add(STAGE_X, STAGE_FLY_Y, -0.3, STAGE_W, STAGE_FLY_H, FRAME, 0.25, 1)
    ui.add(STAGE_X, STAGE_BRAIN_Y, -0.3, STAGE_W, STAGE_BRAIN_H, FRAME, 0.25, 1)
    if (miniPrefab && holo) this.buildMini(miniPrefab, holo)
    if (brain) {
      try {
        this.cloud = new BrainCloud(c, brain, new vec3(STAGE_X, STAGE_BRAIN_Y, 1.5), FlyConfig.CLOUD_RADIUS_CM)
      } catch (e) {
        const stack = e && (e as any).stack ? String((e as any).stack).replace(/\s+/g, " ").substring(0, 220) : ""
        this.cloudErr = "BUILD FAILED @" + BrainCloud.stage + ": " + e + " | " + stack
      }
    }
    this.footer = this.text(c, "", -W / 2 + 1.5, -H / 2 + 1.1, T_SMALL, TXT2, { mono: true })
    // the onboarding card to the left (ADR 57): the board's helpers, its own plate; "?" in the header reopens it
    const mkText = (p: SceneObject, s: string, x: number, y: number, sc: number, col: vec4, opt?: any) => this.text(p, s, x, y, sc, col, opt)
    const mkButton = (p: SceneObject, n: string, x: number, y: number, w: number, h: number, cb: () => void, sink?: QuadSink) => this.kitButton(p, n, x, y, w, h, cb, sink)
    // one MSDF mesh per card for everything that never changes (15.09 Pavlo: "fewer draw calls")
    const mkBatch = (p: SceneObject, n: string) => (this.textMat && this.uiFace ? new TextBatch(p, n, this.uiFace, this.textMat, 0) : null)
    this.guide = new FlyGuide(c, W, H, quad, neon, batchMat, mkText, mkButton, mkBatch, FlyConfig.FLY_COLORS[0])
    this.guideHint = this.text(c, "HELP  ?", W / 2 - 1.5, H / 2 - 5.1, T_TITLE, TXT2, { align: "R" }) // 21.09: a bare "?" read as "what is that mark"
    // 16.09: the hint used to light on dismiss and stay lit forever, including while the card was
    // open, and it wrote textFill straight past the diff-cache. It is a state now: lit = there is
    // something to open, dim = it is already open.
    this.hit(c, "GuideHit", W / 2 - 4.0, H / 2 - 5.1, 7.0, 2.4, (it: Interactable) => it.onTriggerStart.add(() => {
      this.guide!.show(!this.guide!.visible)
      this.fill(this.guideHint!, this.guide!.visible ? TXT2 : TXT)
    }))
    this.guide.onDismiss = () => { if (this.guideHint) this.fill(this.guideHint, TXT) }
    // ADR 98: the side panel, a drawer off the board's RIGHT edge (the guide is on the left). Built
    // here so its quads and text are in place before the first tap; closed = disabled = 0 draws.
    this.side = new FlySidePanel(c, W / 2 + SIDE_GAP, H, quad, neon, batchMat, mkText, mkBatch, FlyConfig.FLY_COLORS[0])
    this.side.onClose = () => this.syncSide()
    // "tap outside closes it": one invisible box the size of the plate, BEHIND every other hit box
    // (rows, tabs, "?", keys sit at z 0.05 and win the ray), so a tap on the board that is not a
    // row lands here. The grip hangs under the bottom edge and is not covered.
    const outside = this.hit(c, "BoardHit", 0, 0, W, H, (it: Interactable) => it.onTriggerStart.add(() => this.closeSide()))
    outside.getTransform().setLocalPosition(new vec3(0, 0, -0.5))
    this.guide.onMode = (m: string) => this.onTrainMode(m) // the session picker (ADR 66)
    this.guide.onLessonChoice = (k: string) => this.onLessonChoice(k) // the lesson's choices (ADR 71)
    // the two cards that come BEFORE the fly's dashboard (ADR 58): the start choice, then the scan.
    // Siblings of the content on the board's root: the content stays hidden until DONE SCANNING.
    this.start = new FlyStart(this.root, quad, neon, batchMat, mkText, mkButton, mkBatch, FlyConfig.FLY_COLORS[0])
    this.start.onMultiplayer = () => { if (this.boot) this.boot.session(true); this.onStart(true) }
    this.start.onSolo = () => { if (this.boot) this.boot.session(false); this.onStart(false) }
    this.scan = new FlyScan(this.root, quad, neon, batchMat, mkText, mkButton, mkBatch, FlyConfig.FLY_COLORS[0])
    this.scan.onDone = () => this.onScanDone()
    // ADR 84: the boot card — the third screen of the same flow, built here so its quads exist before
    // its batch's first flush, like every other card.
    this.boot = new FlyBoot(this.root, quad, neon, batchMat, mkText, mkButton, mkBatch, FlyConfig.FLY_COLORS[0])
    this.content.enabled = false
    this.guide.hideNow()

    // ---- right: tabs (number inside), neural, action, body ----
    // tabs share the column width, whatever the fly count (3 since 11.09)
    // 16.09: with FLY_COUNT 1 this was ONE 24.2 cm-wide tab selecting the only fly there is, and a
    // `1` that can never change -- a control that cannot do anything. The header names the fly.
    this.oneFly = FlyConfig.FLY_COUNT <= 1
    const pitch = (VAL_X - RX) / FlyConfig.FLY_COUNT
    for (let i = 0; i < FlyConfig.FLY_COUNT; i++) {
      const x = RX + pitch * (i + 0.5)
      const tab = ui.add(x, TAB_Y, 0, pitch - 0.6, 1.9, FlyConfig.FLY_COLORS[i], 0.35)
      this.tabs.push(tab)
      const num = this.text(c, "" + (i + 1), x, TAB_Y - 0.3, T_LABEL, TXT, { align: "C", mono: true })
      this.tabNums.push(num)
      if (this.oneFly) {
        ui.set(tab, { visible: false })
        num.getSceneObject().enabled = false
        continue
      }
      this.hit(c, "TabHit" + i, x, TAB_Y, pitch - 0.6, 1.9, (it: Interactable) => {
        it.onTriggerStart.add(() => { this.closeSide(); this.onTab(i) })
        it.onHoverEnter.add(() => (this.hovered = i))
        it.onHoverExit.add(() => {
          if (this.hovered === i) this.hovered = -1
        })
      })
    }
    // ---- the brain line (ADR 84) ----------------------------------------------------------------
    // 16.09 retired the fly tabs when there is only one fly, which frees this strip. It is where the
    // header's old "BRAIN native x1 25%" goes, in words a wearer can act on: WHERE the brain runs,
    // HOW FAST it thinks (one step = 50 ms of fly time), and — when the load policy is holding it
    // back, or the two kernels are being compared — WHY. The raw numbers move under "?" (FlyGuide).
    if (this.oneFly) {
      const bx = (RX + VAL_X) / 2
      this.brainPlate = ui.add(bx, TAB_Y, -0.1, VAL_X - RX, 3.6, PLATE, 0.30, 2)
      this.brainAccent = ui.add(RX + 0.3, TAB_Y, 0, 0.6, 3.6, FlyConfig.FLY_COLORS[0], 1.2, 2) // the accent tab, as on every key
      this.brainWhereT = this.text(c, "", RX + 1.2, TAB_Y + 0.8, T_LABEL, WHITE)
      this.brainStepT = this.text(c, "", VAL_X, TAB_Y + 0.8, T_SMALL, TXT, { align: "R", mono: true })
      this.brainWhyT = this.text(c, "", RX + 1.2, TAB_Y - 0.85, T_SMALL, TXT2)
    }
    // 16.09: BOARD_ROW_VALUES is false -- there are no Hz numbers on these rows any more, so the
    // caption must not promise a unit it never prints.
    // 21.09 copy pass: what the rows are (her brain, live) and what to do with them (tap one)
    this.still("BRAIN ACTIVITY  //  LIVE  ·  POINT AT A ROW", RX, H / 2 - 7.9, T_CAPTION, TXT2)
    let y = ROW0_Y
    for (const r of NEURAL) {
      // one label + one value Text per row at the bar's own y (11.09 device: the two multi-line
      // blocks drifted off the bars — the two fonts have different line heights)
      this.still(r.label, RX, y - 0.3, T_LABEL, TXT)
      if (r.atlas) {
        // the cell's name after the plain label, one tier smaller, baselines aligned; measured with
        // the font's own advances so it lands where the label ends and never under the bar
        const lw = this.txt ? this.txt.drawnWidthOf(r.label, T_LABEL * CAP_K) : r.label.length * 0.62
        const ax = RX + lw + 0.5
        const aw = this.txt ? this.txt.drawnWidthOf(r.atlas, T_SMALL * CAP_K) : r.atlas.length * 0.5
        if (ax + aw > BAR_X0 - 0.4) log.w("ROW_LABEL_OVERFLOW " + r.label + " " + r.atlas + " ends at " + (ax + aw).toFixed(1) + " cm, bar at " + BAR_X0)
        this.still(r.atlas, ax, y - 0.3 - ((T_LABEL - T_SMALL) * CAP_K) / 2, T_SMALL, TXT2)
      }
      const val = FlyConfig.BOARD_ROW_VALUES
        ? this.text(c, "0", VAL_X, y - 0.3, T_LABEL, TXT, { align: "R", mono: true })
        : null // no Text created at all: `row()` takes null and the update already guards on it
      this.rows[r.key] = this.row(y, r.floor, val)
      const key = r.key
      this.hit(c, "RowHit_" + key, (RX + W / 2) / 2, y, W / 2 - RX, ROW_H * 0.95, (it: Interactable) => {
        it.onHoverEnter.add(() => (this.hoverRow = key))
        it.onHoverExit.add(() => {
          if (this.hoverRow === key) this.hoverRow = null
        })
        it.onTriggerStart.add(() => this.toggleSide(key)) // ADR 98: the description, on demand
      })
      y -= ROW_H
    }

    this.action = this.text(c, "ACTION  HOVER", RX, y - 0.6, T_ACTION, FlyConfig.FLY_COLORS[0])
    y -= 2.2
    this.still("BODY  //  DRIVEN BY THE COMMANDS ABOVE", RX, y, T_CAPTION, BODY) // 21.09 Pavlo: "our simulation, not the brain" read as a riddle; same honesty, plain
    y -= 1.5
    this.still("ENERGY", RX, y - 0.3, T_LABEL, TXT)
    this.rows["energy"] = this.row(y, 1, this.text(c, "0", VAL_X, y - 0.3, T_LABEL, TXT, { align: "R", mono: true }))
    y -= ROW_H
    this.still("SPEED", RX, y - 0.3, T_LABEL, TXT)
    this.rows["speed"] = this.row(y, 1, this.text(c, "0", VAL_X, y - 0.3, T_LABEL, TXT, { align: "R", mono: true }))
    // Gemini's reading of this fly, in its own voice — its OWN section: a dim plate, a caption bar
    // and bigger text (12.09 Pavlo: "put the Gemini comments in their own section, a whole bar,
    // and make them easier to see"). Labelled as interpretation, never a measurement.
    y -= 2.2
    const gemW = W / 2 - RX - 0.4
    const gemTop = y + 0.9
    const gemBot = -H / 2 + 2.4 // stay clear of the footer line (12.09 / 15.09: the last line ran over it)
    const gemH = gemTop - gemBot
    const gemX = RX + gemW / 2
    ui.add(gemX, (gemTop + gemBot) / 2, -0.05, gemW, gemH, GEM, FlyConfig.BOARD_GEMINI_PLATE)
    ui.add(gemX, gemTop, 0, gemW, 0.12, GEM, 1.4) // the bar that opens the section
    // 12.09 Pavlo: "rephrase this and drop the equalisers". With VOICE_ENABLED off the fly never
    // speaks, so "inner voice" promised something that no longer happens and the five bars beside
    // it were a level meter for silence. The line is a thought now, and it follows the board's
    // own pattern (EYES // WHAT THE BRAIN SEES).
    this.still("AI  //  WHAT SHE MIGHT BE THINKING", RX, y, T_CAPTION, GEM)
    const thoughtY = y - 1.5
    this.thought = this.text(c, "", RX, thoughtY, FlyConfig.BOARD_GEMINI_TEXT, TXT, { top: true })
    // how many lines actually fit above the bottom frame: the wrap clips to this, so a long line
    // can never run off the board again (12.09 Pavlo: "make this text stop sticking out")
    this.thoughtLines = Math.max(1, Math.floor((thoughtY - gemBot) / (FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_GEMINI_TEXT * 1.15))) // 1.15: the font's real line height

    // ASK (voice find, ADR 27) and TEACH THE FLY (ADR 66): built HERE, hidden, so their quads go into
    // BoardNeon. Built lazily -- which is what showAskButton/showLearnButton used to do -- they land
    // after the batch's first flush and cannot join it, which cost one draw call each (COMPONENTS
    // lists AskNeon and LearnNeon as their own visuals). 16.09: -2 draw calls, +12 quads in the mesh.
    // It also retires the 15.09 LEAF bug where the TEACH hint could never name the PIN: the key and
    // its hint exist before the first setTrainAvailable(), so the gate applies on the first frame.
    this.askKey = this.kitButton(c, "Ask", ASK_X, SCAN_BTN_Y, ASK_W, 5, () => this.onAsk(), ui)
    this.askHit = this.askKey.so
    this.askLabel = this.text(c, this.askText, ASK_X, SCAN_BTN_Y - 0.4, T_KEY, WHITE, { align: "C" })
    this.askLabel.getTransform().setLocalPosition(new vec3(ASK_X, SCAN_BTN_Y - 0.4, 1.5))
    const lx = W / 2 - 8
    this.learnKey = this.kitButton(c, "Learn", lx, SCAN_BTN_Y, 15, 5, () => this.teach(!(this.learnOn || this.learnWanted)), ui)
    this.learnHit = this.learnKey.so
    this.learnBtnOn = this.learnKey.on
    this.learnLabel = this.text(c, "HOW IT LEARNS  >", lx, SCAN_BTN_Y - 0.3, T_KEY, WHITE, { align: "C" })
    this.learnLabel.getTransform().setLocalPosition(new vec3(lx, SCAN_BTN_Y - 0.3, 1.5))
    this.learnHint = this.text(c, LEARN_HINT_OFF, W / 2 - 0.5, SCAN_BTN_Y - 3.5, T_SMALL, TXT2, { align: "R" })
    for (const k of [this.askKey, this.learnKey]) {
      k.so.enabled = false
      for (const q of k.quads) ui.set(q, { visible: false })
    }
    this.askLabel.getSceneObject().enabled = false
    this.learnLabel.getSceneObject().enabled = false
    this.learnHint.getSceneObject().enabled = false
    ui.flush()
    if (this.txt) this.txt.flush() // the statics never change: this mesh is built once and left alone
  }

  // ---- ADR 98: the side panel (tap a row) ----------------------------------------------------
  private side: FlySidePanel | null = null
  // 21.09 Pavlo: "коли наводжу на параметри -- описуються в боковому меню": a hover that STAYS on a
  // row opens its panel too; the dwell keeps a cursor crossing the rows from flipping it. A tap
  // still pins/closes it, and a row closed by a tap does not re-open until the cursor leaves it.
  private hoverDwell = 0
  private hoverDwellRow: string | null = null
  private hoverMuteRow: string | null = null

  /** a row was tapped: open its description, close it on the second tap, swap it on another row */
  private toggleSide(key: string) {
    if (!this.side) return
    const r = this.rows[key]
    if (!r) return
    if (this.side.row === key) { this.side.close(); this.hoverMuteRow = key }
    else this.side.open(key, r.y)
    this.syncSide()
  }

  /** for FlySwarm.behindBoard: the cards a label must not draw over (ADR 101 follow-up) */
  get guideVisible(): boolean { return !!(this.guide && this.guide.visible) }
  get sideOpen(): boolean { return !!(this.side && this.side.row !== null) }

  private closeSide() {
    if (this.side && this.side.row !== null) this.side.close()
  }

  /** the tapped row stays lit and its neurons stay isolated in the cloud while the panel is up: the
   *  hover block reads `sideRow` on its next data tick, this only marks it stale */
  private syncSide() {
    this.sideRow = this.side ? this.side.row : null
  }
  private sideRow: string | null = null

  /** ADR 58: DONE SCANNING lives on the scan card, which is always built, so nothing here can run.
   *  Kept because FlySwarm calls it while the intro is up. */
  showScanButton(on: boolean) {
  }

  /** ASK (voice find, ADR 27): same slot + look as DONE SCANNING — white text on a dim plate. */
  showAskButton(on: boolean) {
    // 21.09 Pavlo: "remove ASK A FLY too". One gate, so the key, its label and the mic behind it
    // all go together and nothing half-appears (ADR 89).
    if (!FlyConfig.ASK_ENABLED) on = false
    if (this.askShown === on) return
    this.askShown = on
    if (this.askHit) this.askHit.enabled = on
    if (this.askLabel) this.askLabel.getSceneObject().enabled = on
    if (this.askKey) for (const q of this.askKey.quads) this.ui.set(q, { visible: on })
    if (!on && this.askKey) this.askKey.live(0)
    this.ui.flush()
  }

  /** LEARN toggle: only the C++ core (a web page by PIN, or server.py --engine native) can learn. */
  showLearnButton(on: boolean) {
    // 21.09: this key was TEACH THE FLY. With the fly teaching itself (ADR 89) it had nothing left
    // to switch, so it became a way to the guide -- and then there were TWO ways to the same card,
    // this and the "?" in the header. Pavlo, seeing it: "I thought we cleaned this up". The "?" is
    // the one that stays; a board with one entrance to its legend is the point.
    if (!FlyConfig.LESSON_ENABLED) on = false
    if (this.learnShown === on) return
    this.learnShown = on
    if (this.learnHit) this.learnHit.enabled = on
    if (this.learnLabel) this.learnLabel.getSceneObject().enabled = on
    if (this.learnHint) this.learnHint.getSceneObject().enabled = on
    if (this.learnKey) for (const q of this.learnKey.quads) this.ui.set(q, { visible: on })
    this.ui.flush()
  }

  /** TEACH THE FLY pressed (or the editor's auto beat): learning is asked of the brain AND the guide
   *  opens at once with the teaching instruction (15.09 Pavlo), not a brain step later when the ack
   *  comes. `learnWanted` holds the guide in teaching mode until the brain says it is learning. */
  teach(on: boolean) {
    if (!this.learnReady && on) {
      // ADR 68: no page, no session. The hint under the key already carries the reason, but a static
      // line is not an answer to a press (polish playbook §4: refusals are visible and NAMED) -- so
      // the reason is the thing that moves. The key's own press flash has already fired.
      if (this.learnHint) Anim.pulse("board.learnhint", this.learnHint.getTransform(), 1.12)
      return
    }
    this.learnWanted = on
    this.onLearn(on)
    if (this.learnBtnOn) this.learnBtnOn(on || this.learnOn)
    if (on && this.guide) {
      this.guideAutoHidden = true // it stays until GOT IT
      this.guide.show(true)
    }
  }
  private learnWanted = false
  private learnReady = true
  private learnWhy = ""

  /**
   * ADR 68: teaching only runs while a web page is the brain. The key stays visible — it is how a
   * person learns the feature exists — but it is dim and says what is missing. FlySwarm calls this
   * every frame from `FlyTrainer.available()`; both writes are diff-cached.
   */
  setTrainAvailable(ready: boolean, why: string) {
    if (ready === this.learnReady && why === this.learnWhy) return
    this.learnReady = ready
    this.learnWhy = why
    // 16.09: a key that cannot act must not rest at the same level as one that can -- the label was
    // the only difference, so a refusing key looked armed.
    if (this.learnKey) this.learnKey.idle(ready ? BTN_IDLE : BTN_REFUSE)
    if (this.learnLabel) this.fill(this.learnLabel, ready ? (this.learnOn ? LIVE : WHITE) : TXT2)
    if (this.learnBtnOn) this.learnBtnOn(ready && (this.learnOn || this.learnWanted))
    if (this.learnHint) {
      const h = ready ? (this.learnOn ? LEARN_HINT_ON : LEARN_HINT_OFF) : why
      if (this.learnHint.text !== h) this.learnHint.text = h
    }
  }

  /** The brain reports whether it is learning right now (BrainMsg.memory). */
  setLearnState(on: boolean) {
    if (on === this.learnOn && this.learnLabel && this.learnLabel.text !== "") return
    this.learnOn = on
    if (on) this.learnWanted = false // acked
    if (this.learnLabel) {
      // 21.09 Pavlo: "that button is really just a legend button now". Learning is no longer a mode
      // a person switches on -- the fly does it all the time (ADR 89) -- so the key stopped being a
      // switch and became the way to the card that explains what you are looking at. The label no
      // longer promises a toggle.
      const s = on ? "HOW IT LEARNS  //  OPEN" : "HOW IT LEARNS  >"
      if (this.learnLabel.text !== s) this.learnLabel.text = s
      this.fill(this.learnLabel, !this.learnReady ? TXT2 : on ? LIVE : WHITE)
    }
    if (this.learnBtnOn) this.learnBtnOn(on || this.learnWanted)
    if (this.learnHint) {
      const h = !this.learnReady ? this.learnWhy : on ? LEARN_HINT_ON : LEARN_HINT_OFF
      if (this.learnHint.text !== h) this.learnHint.text = h
    }
  }

  /** ASK label (LISTENING… / THINKING… / FINDING X); live = the plate pulses. */
  setAskLabel(s: string, live: boolean) {
    this.askText = s
    this.askLive = live
    if (this.askLabel && this.askLabel.text !== s) this.askLabel.text = s
    // 16.09: this wrote an orphan quad that was permanently invisible, so ASK changed its words to
    // LISTENING... and nothing moved (polish playbook law 2). The key itself breathes now.
    if (!live && this.askKey) this.askKey.live(0)
  }


  // ---- what the brain sees: FlyVision's 16x8 RGB retina, the same array the brain is sent ----
  private retinaData: number[] | null = null
  private retinaBlank = false

  /** The selected fly's retina (16x8x3 bytes, row-major, top row first), or null when vision is off. */
  private eyePanel: FlyEyePanel | null = null

  /** The selected fly's ommatidial contrast map and its brain rates (ADR 54). */
  setEye(map: Uint8Array | null, hz: any, img: Uint8Array | null = null) {
    if (this.eyePanel) this.eyePanel.setData(map, hz, img)
  }

  setRetina(r: number[] | null) {
    this.retinaData = r
  }

  /** 12.09 Pavlo: "a bit smaller, and split it into two eyes". The retina IS two eyes already —
   *  FlyVision measures flow per half — so the left 8 columns are the left eye and the right 8 the
   *  right one. Two textures (not two UV windows) keep the shader untouched: adding an input would
   *  mean rebuilding the graph while Lens Studio has it open. */
  private makeRetina(quad: RenderMesh | null) {
    if (!quad || !FlyConfig.RETINA_PANEL) return
    try {
      const mat = requireAsset("../../Fly/Shaders/RetinaView.mat") as Material
      const half = FlyConfig.RETINA_CELLS[0] / 2
      const h = FlyConfig.RETINA_CELLS[1]
      const eyeCm = FlyConfig.RETINA_W_CM
      const gap = FlyConfig.RETINA_GAP_CM
      for (let side = 0; side < 2; side++) {
        const tex = ProceduralTextureProvider.createWithFormat(half, h, TextureFormat.RGBA8Unorm)
        const prov = tex.control as ProceduralTextureProvider
        const pix = new Uint8Array(half * h * 4)
        prov.setPixels(0, 0, half, h, pix)

        const so = global.scene.createSceneObject(side === 0 ? "RetinaLeft" : "RetinaRight")
        so.setParent(this.content)
        const t = so.getTransform()
        const x = FlyConfig.RETINA_X + (side === 0 ? -(eyeCm + gap) / 2 : (eyeCm + gap) / 2)
        t.setLocalPosition(new vec3(x, FlyConfig.RETINA_Y, 0.3))
        t.setLocalScale(new vec3(eyeCm, (eyeCm * h) / half, 1))
        const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
        rmv.mesh = quad
        const m = mat.clone()
        const p: any = m.mainPass
        p.eye = tex
        p.tint = FlyConfig.FLY_COLORS[0]
        p.gain = FlyConfig.RETINA_GAIN
        p.cells = half
        p.blendMode = BlendMode.Add // additive display: the dark parts of the view simply stay dark
        p.depthWrite = false
        p.depthTest = true
        p.twoSided = true
        try {
          ;(p as any).samplers.eye.filtering = FilteringMode.Nearest // one texel per ommatidial block
        } catch (e) {
          /* the .mat default stands */
        }
        rmv.mainMaterial = m
        rmv.setRenderOrder(CARD_RENDER_ORDER) // ADR 97
        this.eyes.push({ so: so, tex: prov, pix: pix, mat: m })
      }
      // 12.09 Pavlo: "leave the text where it was, only centre the planes" — the caption keeps the
      // board's left margin like every other one; only the two quads sit under the brain.
      this.still("EYES  //  WHAT THE BRAIN SEES", -W / 2 + 1.5,
        FlyConfig.RETINA_Y + (eyeCm * h) / (2 * half) + 1.0, T_SMALL, TXT2)
    } catch (e) {
      log.w("RetinaPanel unavailable: " + e)
    }
  }
  private eyes: { so: SceneObject; tex: ProceduralTextureProvider; pix: Uint8Array; mat: Material }[] = []

  /** Push the latest retina into the panel's texture (called on the board's data tick). */
  private uploadRetina(color: vec4) {
    if (this.eyes.length !== 2) return
    const r = this.retinaData
    const w = FlyConfig.RETINA_CELLS[0]
    const half = w / 2
    const h = FlyConfig.RETINA_CELLS[1]
    for (let side = 0; side < 2; side++) {
      const e = this.eyes[side]
      // 15.09 Pavlo: no "no signal" checker — an eye with no frame yet is simply not drawn
      if (!r) {
        if (e.so.enabled) e.so.enabled = false
        continue
      }
      if (e.so.enabled !== true) e.so.enabled = true
      if (e.mat.mainPass.tint !== color) e.mat.mainPass.tint = color
      const px = e.pix
      {
        // the retina is one 16x8 row-major array: columns 0..7 are the left eye, 8..15 the right.
        // 12.09 Pavlo: "it looks washed out" — and it is, on purpose: FlyVision pins the MEAN
        // brightness to 160/255 so the brain sees contrast, not exposure. That flatness is right for
        // the brain and wrong for a viewer, so the PANEL stretches the contrast around that mean.
        // The array itself (what the brain gets) is untouched.
        const k = FlyConfig.RETINA_CONTRAST
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < half; x++) {
            const src = 3 * (y * w + x + side * half)
            const dst = 4 * (y * half + x)
            px[dst] = Math.max(0, Math.min(255, 160 + (r[src] - 160) * k))
            px[dst + 1] = Math.max(0, Math.min(255, 160 + (r[src + 1] - 160) * k))
            px[dst + 2] = Math.max(0, Math.min(255, 160 + (r[src + 2] - 160) * k))
            px[dst + 3] = 255
          }
        }
      }
      e.tex.setPixels(0, 0, half, h, px)
    }
    this.retinaBlank = !r
  }


  /** Typing reveal of the latest thought (nothing pops in). While the fly speaks, the line grows
   *  with Gemini's own transcript (ADR 36), so an extension of what is already shown keeps typing
   *  from where it was instead of restarting. */
  setThought(s: string) {
    if (s === this.thoughtFull) return
    if (!(s.substring(0, this.thoughtFull.length) === this.thoughtFull && this.thoughtFull)) this.thoughtShown = 0
    this.thoughtFull = s
  }

  private thoughtLines = 3
  private thoughtStr = "" // diff-cache for the typing reveal (16.09)

  private wrap(s: string): string {
    const lines: string[] = []
    let cur = ""
    for (const w of s.split(" ")) {
      if (cur && (cur + " " + w).length > FlyConfig.NARRATE_LINE_CHARS) {
        lines.push(cur)
        cur = w
      } else cur = cur ? cur + " " + w : w
    }
    if (cur) lines.push(cur)
    // a long line keeps its END visible (the newest words) rather than being cut off mid-thought
    return lines.slice(Math.max(0, lines.length - this.thoughtLines)).join("\n")
  }

  // ------------------------------------------------------------------------------ builders

  private buildMini(prefab: ObjectPrefab, holo: Material) {
    this.miniRoot = global.scene.createSceneObject("MiniFly")
    this.miniRoot.setParent(this.content)
    const t = this.miniRoot.getTransform()
    t.setLocalPosition(new vec3(STAGE_X, STAGE_FLY_Y - 2.6, 2.0)) // under the stage caption, wings clear of it
    t.setLocalScale(vec3.one().uniformScale(FlyConfig.MINI_FLY_CM / FlyConfig.LENGTH_CM))
    this.mini = prefab.instantiate(this.miniRoot)
    const visit = (so: SceneObject) => {
      if (BONES.indexOf(so.name) >= 0) this.miniBones[so.name] = so.getTransform()
      for (const rmv of so.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]) {
        const m = holo.clone()
        rmv.mainMaterial = m
        this.miniMats.push(m)
      }
      for (let i = 0; i < so.getChildrenCount(); i++) visit(so.getChild(i))
    }
    visit(this.mini)
  }

  /** A UI Kit button (SnapOS2 theme, Rectangle): the kit's plate + hover/press feedback, our label
   *  on top. Sized in board-local cm like everything else. Falls back to the invisible hit box (with
   *  our own neon plate) when the kit cannot be created, so a kit change never loses the button. */
  /** 15.09 Pavlo: "the buttons in the right colour". A button in the board's own language: the plate
   *  tint with a neon frame (one small quad batch), an Interactable hit box, and the four states of
   *  the polish playbook: hover lifts the plate, press flashes it white and squeezes it, release
   *  fires. `kit` stays false so the callers' legacy plates never show. */
  private kitButton(parent: SceneObject, name: string, x: number, y: number, w: number, h: number, onPress: () => void, sink?: QuadSink): { so: SceneObject; kit: boolean; quads: number[]; on: (v: boolean) => void; hover: (cb: (on: boolean) => void) => void; idle: (k: number) => void; live: (k: number) => void; flash: () => void } {
    // 15.09 Pavlo: "prettier", then "too bright, and fewer details / draw calls". A calm lit key in
    // the card's language: a solid body a shade deeper than the card, a thin outline, the fly's
    // colour as a tab on the left edge. Six quads. When the card
    // hands over its own batch the quads join it (no draw call of their own) and are placed in card
    // space; only the hit box is a scene object.
    const so = global.scene.createSceneObject(name)
    so.setParent(parent)
    so.getTransform().setLocalPosition(new vec3(x, y, 0.6))
    const own = !sink
    const ui: QuadSink = sink || (this.batchMat ? new NeonBatch(so, this.batchMat, name + "Neon") : new NeonQuadSet(so, this.quad, this.neon, name + "Neon"))
    const ox = own ? 0 : x
    const oy = own ? 0 : y
    const accent = FlyConfig.FLY_COLORS[0]
    const q: number[] = []
    // 15.09 Pavlo: "still a bit crooked and cheap": no gloss band, no stub. A solid body, one thin
    // crisp outline, and the fly's colour as a tab flush with the left edge, corner to corner.
    const plate = ui.add(ox, oy, -0.2, w, h, PLATE, BTN_IDLE, 2)
    q.push(plate)
    const ol: number[] = []
    ol.push(ui.add(ox, oy + h / 2, 0, w, 0.14, FRAME, BTN_LINE))
    ol.push(ui.add(ox, oy - h / 2, 0, w, 0.14, FRAME, BTN_LINE))
    ol.push(ui.add(ox - w / 2, oy, 0, 0.14, h, FRAME, BTN_LINE))
    ol.push(ui.add(ox + w / 2, oy, 0, 0.14, h, FRAME, BTN_LINE))
    for (const i of ol) q.push(i)
    const tab = ui.add(ox - w / 2 + 0.3, oy, 0.1, 0.6, h, accent, 1.2, 2) // the accent tab: the fly's colour
    q.push(tab)
    if (own) ui.flush()
    let hover = false
    let hoverOut: (on: boolean) => void = () => {}
    let selected = false // a toggle that is ON: the key stays lit (the 4th state, polish playbook §4)
    // 16.09: `base` is the key's own resting level (a secondary key, or one that is refusing, rests
    // lower than a live one) and `liveK` is an extra term the owner drives while the key is busy.
    let base = BTN_IDLE
    let liveK = 0
    const idle = () => (selected ? BTN_ON : base) + liveK
    const setPlate = (k: number, col: vec4) => {
      ui.set(plate, { intensity: k, color: col })
      ui.set(tab, { intensity: hover || selected ? 2.0 : 1.2 })
      for (const i of ol) ui.set(i, { intensity: hover || selected ? 0.95 : BTN_LINE })
      ui.flush()
    }
    // the flash reads as the cause (polish playbook §3/§4); a duplicate hit replays it too. 16.09:
    // the colour crossfades on the same bell that drives the intensity -- it used to flip WHITE->PLATE
    // at t = 0.5, a hard cut in the middle of the one beat that is meant to read as soft.
    const doFlash = () => Anim.run(name + ".flash", 0.25, (t) => {
      const b = Ease.bell(t)
      setPlate(idle() + 0.9 * b, new vec4(PLATE.x + (WHITE.x - PLATE.x) * b, PLATE.y + (WHITE.y - PLATE.y) * b, PLATE.z + (WHITE.z - PLATE.z) * b, 1))
    }, { done: () => setPlate(hover ? BTN_HOVER : idle(), PLATE) })
    this.hit(so, name + "Hit", 0, 0, w, h, (it: Interactable) => {
      it.onHoverEnter.add(() => { hover = true; setPlate(BTN_HOVER, PLATE); hoverOut(true) })
      it.onHoverExit.add(() => { hover = false; setPlate(idle(), PLATE); hoverOut(false) })
      it.onTriggerStart.add(() => {
        doFlash()
        onPress()
      })
    })
    // ADR 68: a card may want to follow the hover itself (the session picker shows one line about
    // the key under the cursor). Additive: nobody who ignores it behaves differently.
    const hoverCbs: ((on: boolean) => void)[] = []
    hoverOut = (on: boolean) => { for (const cb of hoverCbs) cb(on) }
    return { so: so, kit: false, quads: q,
      on: (v: boolean) => { if (v !== selected) { selected = v; setPlate(hover ? BTN_HOVER : idle(), PLATE) } },
      hover: (cb: (on: boolean) => void) => hoverCbs.push(cb),
      idle: (k: number) => { if (k !== base) { base = k; if (!hover) setPlate(idle(), PLATE) } },
      live: (k: number) => { if (k !== liveK) { liveK = k; if (!hover) setPlate(idle(), PLATE) } },
      flash: doFlash }
  }

  /** The board's move grip (15.09 Pavlo: the UI Kit Frame lit a grey plate over the board when
   *  grabbed; ours is the bar under the bottom edge). SIK's InteractableManipulation on the grip's
   *  hit box moves `frameObj`, the world anchor the board hangs from; hover and hold light the bar
   *  and the four frame lines. Translation only: FlySwarm turns the board to face the user. */
  makeGrip(frameObj: SceneObject) {
    const so = this.hit(this.content, "GripHit", 0, GRIP_Y, GRIP_W + 6, 5.5, (it: Interactable) => {
      it.onHoverEnter.add(() => { this.gripHover = true; this.gripLight() })
      it.onHoverExit.add(() => { this.gripHover = false; this.gripLight() })
    })
    const m = so.createComponent(InteractableManipulation.getTypeName()) as InteractableManipulation
    // the root is read from the serialized input in ITS onAwake, which for a runtime-created
    // component runs after this line: write the input too, or the root falls back to the grip's
    // own (invisible) hit box and "moving does nothing" (15.09 device)
    ;(m as any).manipulateRootSceneObject = frameObj
    m.setManipulateRoot(frameObj.getTransform())
    // bind our Interactable now, not only in its own OnStart (a runtime-created component's start
    // may come a frame late, and a pinch before it would move nothing)
    const it = so.getComponent(Interactable.getTypeName()) as Interactable
    if (it) m.setNewInteractable(it)
    m.setCanRotate(false)
    m.setCanScale(false)
    m.onManipulationStart.add(() => { this.gripHeld = true; this.gripLight() })
    m.onManipulationEnd.add(() => { this.gripHeld = false; this.gripLight() })
  }

  private gripLight() {
    const k = this.gripHeld ? 2 : this.gripHover ? 1 : 0
    this.ui.set(this.grip, { intensity: [0.45, 1.3, 1.9][k] })
    for (const e of this.edges) this.ui.set(e, { intensity: [0.9, 1.4, 1.9][k] })
    this.ui.flush()
  }

  /** the board is being carried (FlySwarm turns it to face the user meanwhile) */
  get carried(): boolean {
    return this.gripHeld
  }

  /** Invisible SIK hit box (collider + Interactable, no visual = no draw call). */
  private hit(parent: SceneObject, name: string, x: number, y: number, w: number, h: number, wire: (it: Interactable) => void): SceneObject {
    const so = global.scene.createSceneObject(name)
    so.setParent(parent)
    const t = so.getTransform()
    t.setLocalPosition(new vec3(x, y, 0.05))
    t.setLocalScale(new vec3(Math.max(0.001, w), Math.max(0.001, h), 1))
    const col = so.createComponent("Physics.ColliderComponent") as ColliderComponent
    const box = Shape.createBoxShape()
    box.size = new vec3(1, 1, 1)
    col.shape = box
    const it = so.createComponent(Interactable.getTypeName()) as Interactable
    it.targetingMode = 3
    wire(it)
    return so
  }

  private txt: TextBatch | null = null

  /** A label that never changes: it joins the batched text mesh, so it costs no draw call of its
   *  own. Falls back to a Component.Text when the atlas assets are missing. */
  private still(s: string, x: number, y: number, scale: number, color: vec4, align: "L" | "R" | "C" = "L") {
    if (!this.txt) {
      this.text(this.content, s, x, y, scale, color, { align: align })
      return
    }
    this.txt.add(s, x, y, 0.2, scale * FlyConfig.BOARD_TEXT_SCALE * FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_TEXT_CAP, color, align)
  }

  private text(parent: SceneObject, s: string, x: number, y: number, scale: number, color: vec4, opt: { align?: "L" | "R" | "C"; mono?: boolean; top?: boolean } = {}): Text {
    // Share Tech Mono renders lower in its line than Chakra Petch: lift it so digits sit on the
    // same centre as labels, bars and tab plates (11.09 device screenshot: values ~0.6 cm low)
    if (opt.mono && !opt.top) y += FlyConfig.BOARD_MONO_DY * FlyConfig.BOARD_TEXT_SCALE
    const so = global.scene.createSceneObject("T_" + s.substring(0, 8))
    so.setParent(parent)
    const t = so.createComponent("Component.Text") as Text
    const font = opt.mono ? this.fonts.mono : this.fonts.ui
    if (font) t.font = font
    t.text = s
    t.size = FlyConfig.BOARD_TEXT_SIZE
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    // World text aligns inside its layout rect, which is centred on the object by default — so
    // left-aligned labels slid over the bars (11.09). Anchor the rect edge at the object instead.
    const top = opt.top ? -40 : -10
    const bottom = opt.top ? 0 : 10
    if (opt.align === "R") {
      t.horizontalAlignment = HorizontalAlignment.Right
      t.layoutRect = Rect.create(-200, 0, top, bottom)
    } else if (opt.align === "C") {
      t.horizontalAlignment = HorizontalAlignment.Center
      t.layoutRect = Rect.create(-100, 100, top, bottom)
    } else {
      t.horizontalAlignment = HorizontalAlignment.Left
      t.layoutRect = Rect.create(0, 200, top, bottom)
    }
    // multi-line blocks grow DOWN from the object (centred text would climb upward)
    if (opt.top) t.verticalAlignment = VerticalAlignment.Top
    t.textFill.color = color
    t.setRenderOrder(CARD_RENDER_ORDER) // ADR 97: with the plates, before the fly
    const tr = so.getTransform()
    tr.setLocalPosition(new vec3(x, y, 0.2))
    tr.setLocalScale(vec3.one().uniformScale(scale * FlyConfig.BOARD_TEXT_SCALE))
    return t
  }

  private row(y: number, floor: number, value: Text | null): Row {
    const track = this.ui.add(BAR_X0 + BAR_W / 2, y, 0, BAR_W, BAR_H, TRACK, 0.22)
    const fill = this.ui.add(BAR_X0, y, 0.1, 0, BAR_H, FlyConfig.FLY_COLORS[0], 1)
    // 16.09: the backdrop used to cover the LABEL only while the hit strip covers the whole row, so
    // hovering the bar or the value lit something nowhere near the cursor. Same rect as the strip.
    const hl = this.ui.add((RX + W / 2) / 2, y, -0.2, W / 2 - RX, ROW_H * 0.85, FlyConfig.FLY_COLORS[0], 0.3)
    this.ui.set(hl, { visible: false })
    return { track: track, fill: fill, hl: hl, y: y, max: floor, peak: floor, rest: 0, floor: floor, shown: 0, value: value, str: "0" }
  }

  /** Brain data lands every ~0.2-0.5 s: value AND auto-range scale both ease toward their targets
   *  at one rate (11.09 Pavlo "no jumps, nothing twitches"). Scale = recent peak, never below floor. */
  private setBar(key: string, target: number, color: vec4, fmt: (v: number) => string, dt: number, fixedMax = 0) {
    const r = this.rows[key]
    if (!r) return
    const k = 1 - Math.exp(-dt * FlyConfig.BAR_EASE_RATE)
    r.shown += (target - r.shown) * k
    r.peak = fixedMax > 0 ? fixedMax : Math.max(r.floor, r.peak * Math.exp(-dt / FlyConfig.BAR_PEAK_TAU_S), target * 1.1)
    r.max += (r.peak - r.max) * k
    // ...and the bar fills from this row's own resting level, so a tonically loud cell (PPL101 87 Hz
    // with no input at all, DNpe007 ~110 live) starts EMPTY and only moves when something happens
    if (FlyConfig.BAR_REST_RELATIVE && fixedMax <= 0) {
      const tau = target < r.rest ? FlyConfig.BAR_REST_DOWN_TAU_S : FlyConfig.BAR_REST_UP_TAU_S
      r.rest += (target - r.rest) * (1 - Math.exp(-dt / tau))
    } else r.rest = 0
    const span = Math.max(r.max - r.rest, r.floor * 0.5)
    const w = Math.max(0, Math.min(1, (r.shown - r.rest) / span)) * BAR_W
    this.ui.set(r.fill, { x: BAR_X0 + w / 2, w: w, color: color })
    // 12.09 audit: formatting ran every frame for 14 rows and the string was used 6 times a second
    if (r.value && this.textDue) {
      r.str = fmt(r.shown)
      if (r.value.text !== r.str) r.value.text = r.str
    }
  }

  // -------------------------------------------------------------------------------- update

  // 11.09 perf (board up to 126 ms): every Text write re-lays the text out, so colours are written
  // only when they change and the value digits at ~6 Hz (the bars themselves still ease per frame)
  private fills = new Map<Text, vec4>()
  private textT = 0
  private textDue = true
  private dataT = 0 // board data clock (BOARD_DATA_HZ), separate from the per-frame transform
  private shownScale = -1 // last scale written; the reveal easing settles, so the write stops
  // perf probe: worst ms per board section in the telemetry window (read + reset by FlySwarm)
  perf: { [k: string]: number } = {}
  private mark(k: string, t0: number): number {
    if (FlyConfig.DEBUG_TELEMETRY_S <= 0) return 0 // perf sections are only read by the telemetry row
    const t = getRealTimeNanos() / 1e6 // ns clock, float ms: every board section is well under 1 ms (15.09 perf pass)
    if (!(this.perf[k] >= t - t0)) this.perf[k] = t - t0
    return t
  }
  /** 16.09: `update` returns before any transform is written until the dashboard is revealed, so the
   *  root stayed at scale 1 while the start and scan cards were up and snapped to BOARD_SCALE (0.85)
   *  at DONE SCANNING — the whole UI changed size across the one transition it is meant to flow
   *  through. Written once, here, the three screens are one object at one size. */
  private parkScale() {
    this.shownScale = FlyConfig.BOARD_SCALE
    SCRATCH_SCALE.x = FlyConfig.BOARD_SCALE
    SCRATCH_SCALE.y = FlyConfig.BOARD_SCALE
    SCRATCH_SCALE.z = FlyConfig.BOARD_SCALE
    const t = this.root.getTransform()
    t.setLocalScale(SCRATCH_SCALE)
    if (this.framed) t.setLocalPosition(FRAME_LIFT)
  }

  private fill(t: Text, c: vec4) {
    if (this.fills.get(t) === c) return
    this.fills.set(t, c)
    t.textFill.color = c
  }

  update(dt: number, cam: Transform, palm: vec3 | null, selected: number, body: FlyBody, msg: BrainMsg | null, linkOk: boolean) {
    const camPos = cam.getWorldPosition()
    let t0 = getRealTimeNanos() / 1e6
    this.textT += dt
    this.textDue = this.textT >= 1 / 6
    if (this.textDue) this.textT = 0
    // ADR 84: the boot card's stage clocks start with the LENS, not with DONE SCANNING — a page
    // may already be joining while the scan runs — so it is ticked before anything else here and before the
    // "is the board on screen" gate below. Once the dashboard is open it is never ticked again.
    if (this.boot && !this.dashOn) {
      this.boot.tick(dt, this.brainLink, msg, linkOk, this.boot.visible)
      if (this.revealed && this.boot.done) {
        this.boot.hide()
        this.openDash(0.16)
      }
    }
    let target: vec3 | null = null
    if (this.framed) {
      // world-space board in a SIK ContainerFrame (11.09 "move it through 3D space with the UI kit,
      // off the hand"): the frame owns position + rotation, the board only fades in
    } else if (palm) {
      // above the palm and pushed beyond it (horizontal eyes->hand direction): big enough to read,
      // clear of the holding hand for the other hand's cursor (11.09)
      const away = palm.sub(camPos)
      const flat = new vec3(away.x, 0, away.z)
      const push = flat.length > 1 ? flat.normalize().uniformScale(FlyConfig.BOARD_PALM_PUSH_CM) : vec3.zero()
      target = palm.add(new vec3(0, FlyConfig.BOARD_ABOVE_PALM_CM, 0)).add(push)
    }
    else if (global.deviceInfoSystem.isEditor() && FlyConfig.BOARD_HEADLOCK_IN_EDITOR) {
      // follow pitch too (11.09: looking down pushed the level board's top out of the frame)
      const look = cam.back.normalize()
      const right = look.cross(new vec3(0, 1, 0)).normalize()
      const down = right.cross(look).normalize().uniformScale(-FlyConfig.BOARD_DOWN_CM)
      target = camPos.add(look.uniformScale(FlyConfig.BOARD_DIST_CM)).add(right.uniformScale(FlyConfig.BOARD_RIGHT_CM)).add(down)
    }
    // ...and it only draws while the user is actually looking at it: the board is ~90 draw calls, and
    // on device during a video recording that was the difference between 8 fps and a usable frame rate
    let inView = true
    if (this.framed) {
      const to = this.root.getTransform().getWorldPosition().sub(camPos)
      inView = to.length < 20 || to.normalize().dot(cam.back.normalize()) > FlyConfig.BOARD_VIEW_COS
    }
    this.shown += ((target || (this.framed && inView) ? 1 : 0) - this.shown) * (1 - Math.exp(-dt * 8))
    // the dashboard exists only after the scan (ADR 58) AND once a brain steps it (ADR 84)
    const on = this.dashOn && this.shown > 0.02
    if (this.content.enabled !== on) this.content.enabled = on
    if (this.cloud) this.cloud.setVisible(on) // cloud mesh lives at scene root
    if (!on && this.shownScale < 0) this.parkScale()
    if (!on) {
      if (this.side) this.side.hideNow() // the board went away: the drawer goes with it, no motion
      this.sideRow = null
      return
    }
    if (this.side) this.side.tick(dt) // the auto-hide clock only
    if (target) {
      const rot = quat.lookAt(camPos.sub(target).normalize(), new vec3(0, 1, 0))
      const a = 1 - Math.exp(-dt * FlyConfig.BOARD_FOLLOW_RATE)
      this.pos = this.pos ? vec3.lerp(this.pos, target, a) : target
      this.rot = this.rot ? quat.slerp(this.rot, rot, a) : rot
    }
    const t = this.root.getTransform()
    // 16.09 (law 1, no hard cuts): `shown` gates content.enabled at 0.02, and the old curve was still
    // at 0.6 x BOARD_SCALE there — looking away shrank the board to 60 % and then it VANISHED. The
    // last quarter of `shown` now collapses it to nothing, so the disable lands at scale ~0.
    const s = FlyConfig.BOARD_SCALE * (0.6 + 0.4 * this.shown) * Math.min(1, this.shown / 0.25)
    // 15.09 perf pass: `shown` eases asymptotically and reaches 1.0 exactly in float, so an exact
    // compare stops the scale write once the reveal has settled — the same trick ADR 45 used on the
    // bones, and for the same reason (the driver is deterministic, so a settled value reproduces the
    // identical number). The frame lift is a constant and was rebuilt as a fresh vec3 every frame.
    if (this.framed) {
      if (s !== this.shownScale) {
        this.shownScale = s
        SCRATCH_SCALE.x = s
        SCRATCH_SCALE.y = s
        SCRATCH_SCALE.z = s
        t.setLocalScale(SCRATCH_SCALE)
        t.setLocalPosition(FRAME_LIFT) // in front of the frame's plane
      }
    }
    else {
      if (this.pos) t.setWorldPosition(this.pos)
      if (this.rot) t.setWorldRotation(this.rot)
      if (s !== this.shownScale) {
        this.shownScale = s
        SCRATCH_SCALE.x = s
        SCRATCH_SCALE.y = s
        SCRATCH_SCALE.z = s
        t.setWorldScale(SCRATCH_SCALE)
      }
    }
    t0 = this.mark("follow", t0)

    const color = FlyConfig.FLY_COLORS[selected % FlyConfig.FLY_COLORS.length]
    const accent = FlyConfig.FLY_ACCENTS[selected % FlyConfig.FLY_ACCENTS.length]
    // 12.09 Pavlo: "update the panel's data at 15 fps, not 60". The board's POSITION and the brain
    // cloud stay per frame (they follow the head, and any lag there reads as judder); everything that
    // is a number, a bar or a string runs on this clock, with the accumulated dt so the easing rates
    // are unchanged.
    this.dataT += dt
    const dataDue = this.dataT >= 1 / FlyConfig.BOARD_DATA_HZ
    const ddt = this.dataT
    if (dataDue) this.dataT = 0
    if (dataDue) {
    if (selected !== this.shownFly) {
      this.shownFly = selected
      for (const b of this.brackets) this.ui.set(b, { color: color })
      for (const m of this.miniMats) {
        m.mainPass.rimColor = color
        m.mainPass.bodyColor = accent
      }
    }
    // 16.09: "FLY 1  ZIGGY" at T_TITLE runs to x +6 and the PIN's left edge is at +5.3. With
    // one fly the index says nothing anyway — the name IS the header.
    const nm = FlyConfig.FLY_NAMES[selected % FlyConfig.FLY_NAMES.length]
    const head = this.oneFly ? nm : "FLY " + (selected + 1) + "  " + nm
    if (this.header.text !== head) this.header.text = head
    this.fill(this.header, color)
    if (!this.oneFly) this.tabs.forEach((tab, i) => {
      this.ui.set(tab, { intensity: i === selected ? 0.8 : i === this.hovered ? 0.55 : 0.3 })
      this.fill(this.tabNums[i], i === selected ? WHITE : TXT)
    })
    this.fill(this.action, color)
    if (this.thoughtShown < this.thoughtFull.length) {
      this.thoughtShown = Math.min(this.thoughtFull.length, this.thoughtShown + dt * FlyConfig.NARRATE_TYPE_CPS)
      // 16.09: the one Text on the board with no diff-guard. `Math.floor()` is unchanged on most data
      // ticks, so the identical string was re-assigned — and a Text assignment re-lays out every
      // glyph unconditionally (playbook §8). Write only on the ticks that actually advanced.
      const line = this.wrap(this.thoughtFull.substring(0, Math.floor(this.thoughtShown)))
      if (line !== this.thoughtStr) {
        this.thoughtStr = line
        this.thought.text = line
      }
    } else if (!this.thoughtFull && this.thoughtStr) {
      this.thoughtStr = ""
      this.thought.text = ""
    }
    // NATIVE = the C++ core (a web page by PIN, or server.py --engine native for the preview)
    // 21.09 Pavlo: "and it is obvious it is a web page". The header used to read PAGE ON next to a
    // status of BRAIN ON A PAGE next to two more copies below -- four ways to say one thing. On a
    // page the header shows nothing; the status line is the single place that says where the brain is.
    // 21.09 Pavlo: "веб PIN має показуватись десь постійно" -- it stays in the header while a page is
    // the brain too (a friend joins with it, a dropped page comes back with it)
    // ADR 107: the last message outlives a dropped link, so "on a page" needs the link too, and the
    // header of a dropped brain is the call to action (the PIN stays: that is what the person needs)
    if (linkOk) { this.linkWasOn = true; this.dropped = false } else if (this.linkWasOn) this.dropped = true
    const pinNow = !this.webPin ? "" : linkOk && msg && msg.engine === "web" ? "PIN " + this.webPin : "OPEN THE WEB PAGE  ·  PIN " + this.webPin
    if (pinNow !== this.pinShown) { this.pinShown = pinNow; this.pinHeader.text = pinNow }
    // 15.09 Pavlo: "PAGE ON but BRAIN OFFLINE": the page is the brain whether or not the Mac socket is up
    const webOn = linkOk && !!msg && msg.engine === "web"
    // ADR 84, Pavlo: "Brain native x1 25% — split it and explain what that 25 % is". `x1` was kernel
    // threads and `25%` the share of time a native core was allowed; neither means anything to a wearer, and
    // both are now under "?". The header says only whether there IS a brain; the strip below says
    // where it runs, how fast it thinks, and why it is being held back.
    const bootFail = !!(this.boot && this.boot.failure)
    // 21.09 Pavlo: "не розумію що в цій шапці має бути" -- one line, plain: where her brain is
    let st = webOn ? "BRAIN: ON YOUR WEB PAGE" : bootFail ? "BRAIN: NONE  ·  open the web page" : !linkOk ? (this.dropped ? "BRAIN: DROPPED  ·  reopen the page" : "BRAIN: NOT CONNECTED") : msg ? "BRAIN: ON THE MAC" : "BRAIN: WAKING UP"
    let stc = webOn || (linkOk && msg && !bootFail) ? LIVE : bootFail || !linkOk ? OFF : WAIT
    // dopamine learning is only a thing on the native core: the toggle appears with it
    this.showLearnButton(!!(msg && msg.memory))
    if (msg && msg.memory) this.setLearnState(!!msg.memory.learning)
    if (this.banner) {
      st = this.banner
      // ADR 73: a session banner is the fly's own accent, so training reads as an event, not a status
      stc = this.banner.indexOf("TRAINING") === 0 || this.banner.indexOf("DONE") === 0
        ? FlyConfig.FLY_COLORS[0] : WAIT
    }
    if (this.status.text !== st) this.status.text = st
    this.fill(this.status, stc)
    // ASK is doing something: the key itself says so. Quantised, so most ticks mark nothing dirty.
    if (this.askKey && this.askShown && this.askLive) {
      this.askPulse += ddt
      this.askKey.live(Math.round((0.1 + 0.1 * Math.sin(this.askPulse * 6)) * 50) / 50)
    }

    this.uploadRetina(color) // what the brain sees, at the board's own 15 Hz
      if (this.eyePanel) this.eyePanel.update(ddt, color) // the eye mosaic + optic-lobe bars (ADR 54)
    t0 = this.mark("top", t0)
    // mini hologram: mirror the selected fly's bone pose in place, slow turntable
    if (this.miniRoot) {
      // the 9 cm mini rig copied 26 bone rotations every frame; 15 Hz is indistinguishable at that
      // size, while the turntable keeps spinning per frame so it stays smooth (12.09 audit)
      // 21.09 Pavlo, third pass: "the panel fly must be 1:1 with the flying one; it skips frames". It
      // did: at a 60 Hz knob the accumulator reached 1/60 only on every OTHER frame (dt jitters around
      // 16.6 ms and the reset-to-zero dropped the remainder), so half the poses were never copied.
      // 0 = copy every frame, the same pose the real fly has this frame; a positive knob throttles
      // with a carry (no drift) for the day the 26 copies matter, which the perf probe says they do not.
      const hz = FlyConfig.MINI_MIRROR_HZ
      this.miniT += dt
      const every = hz <= 0 || this.miniT >= 1 / hz
      if (every) {
        this.miniT = hz <= 0 ? 0 : this.miniT - 1 / hz
        for (const name in this.miniBones) {
          const q = body.boneRotation(name)
          if (q) this.miniBones[name].setLocalRotation(q)
        }
      }
      this.miniSpin += dt * FlyConfig.CLOUD_SPIN
      this.miniRoot.getTransform().setLocalRotation(quat.angleAxis(this.miniSpin + 0.6, UPV))
    }
    // ADR 98: the row whose side panel is open keeps the highlight while nothing else is hovered
    if (this.side && this.side.row !== this.sideRow) this.sideRow = this.side.row // auto-hide, or a tap on the plate
    if (this.hoverRow !== this.hoverDwellRow) { this.hoverDwellRow = this.hoverRow; this.hoverDwell = 0; if (this.hoverRow !== this.hoverMuteRow) this.hoverMuteRow = null }
    if (this.hoverRow && this.side && this.hoverRow !== this.hoverMuteRow) {
      this.hoverDwell += dt
      if (this.hoverDwell >= SIDE_HOVER_OPEN_S && this.side.row !== this.hoverRow) {
        const r = this.rows[this.hoverRow]
        if (r) { this.side.open(this.hoverRow, r.y); this.syncSide() }
      }
    }
    const want = this.hoverRow || this.sideRow
    if (want !== this.shownHover) {
      const was = this.shownHover ? this.rows[this.shownHover] : null
      if (was) {
        this.ui.set(was.track, { intensity: 0.22 })
        this.ui.set(was.hl, { visible: false })
      }
      const now = want ? this.rows[want] : null
      if (now) {
        this.ui.set(now.track, { intensity: 0.8 })
        this.ui.set(now.hl, { visible: true, color: color }) // hovered row lights up in the fly's colour
      }
      this.shownHover = want
      const row = NEURAL.filter((r) => r.key === want)[0]
      this.brainCaption.text = row ? "HIGHLIGHT  // " + row.label : CLOUD_CAPTION
      if (this.cloud) this.cloud.setHighlight(want)
    }
    }
    t0 = this.mark("mini", t0)
    if (this.cloud) this.cloud.update(dt, msg, color, cam)
    t0 = this.mark("cloud", t0)
    if (!dataDue) {
      this.ui.flush() // nothing marked dirty on a skipped tick: this returns immediately
      return
    }

    const hz = msg ? msg.hz : null
    const reg: any = msg ? (msg as any).regions : null
    // 21.09: a rate on its own says nothing, and twelve rows each auto-ranging on their own peak
    // made every bar the same length whatever the fly was doing -- a busy panel carrying no
    // information. PPL101 idles at 71 Hz in this model and we drew that under the word STRESS.
    // The brain publishes its OWN resting rate for every named readout at start, so a row now shows
    // how far ABOVE ITS REST the cell is. A cell doing nothing goes quiet by itself, and whatever is
    // genuinely happening is the only thing lit -- which is the highlighting, earned from the data
    // rather than painted on.
    const base = this.brainLink && (this.brainLink as any).baseline ? (this.brainLink as any).baseline : {}
    const g = (k: string) => {
      const v = hz && typeof hz[k] === "number" ? (hz[k] as number) : 0
      const rest = base[k]
      return rest === undefined ? v : Math.max(0, v - rest)
    }
    const rg = (k: string) => (reg && typeof reg[k] === "number" ? (reg[k] as number) : 0)
    const vals: { [k: string]: number } = {
      optic: rg("optic"), central: rg("central"), mushroom: rg("mushroom"), sensory: rg("sensory"),
      descending: rg("descending"), vnc: rg("vnc"),
      DNa02_L: g("DNa02_L"), DNa02_R: g("DNa02_R"),
      escape: (g("esc_L") + g("esc_R")) / 2,
      stop: g("stop"), feed: g("feed"), stress: g("stress"),
    }
    for (const r of NEURAL) this.setBar(r.key, vals[r.key], color, FMT_HZ, ddt)
    this.setBar("energy", body.energy, BODY, FMT_PCT, ddt, 1)
    this.setBar("speed", Math.abs(body.speed), BODY, FMT_CMS, ddt, FlyConfig.ESCAPE_CM_S)
    // 12.09 audit: these strings were built every frame and written six times a second
    if (this.textDue) {
      const act = "ACTION  " + body.actionLabel()
      if (this.action.text !== act) this.action.text = act
      // 16.09 copy pass: the PIN was printed here, in the header AND in the guide's live line. The
      // header is the one Pavlo asked for, so this copy goes.
      const mem = msg && msg.memory ? "  |  memory " + (msg.memory.learning ? "learning " : "") + (msg.memory.mean_efficacy * 100).toFixed(1) + "%" : ""
      const foot = msg
        ? "fly time " + (msg.sim_ms / 1000).toFixed(1) + " s  |  " + msg.wall_ms + " ms/step  |  MaleCNS v1.0 brain" + mem
        : "no brain data"
      if (this.footer.text !== foot) this.footer.text = foot
      // ADR 84: the brain line in words, and the raw policy numbers under "?" -- both at 6 Hz, both
      // diff-cached, because a Text assignment re-lays out every glyph unconditionally.
      if (this.brainWhereT && this.brainStepT && this.brainWhyT) {
        const where = brainWhere(this.brainLink, msg)
        const step = brainStep(msg)
        const why = brainWhy(this.brainLink, msg)
        if (this.brainWhereT.text !== where) this.brainWhereT.text = where
        if (this.brainStepT.text !== step) this.brainStepT.text = step
        // 21.09 Pavlo: on a page the strip said nothing but still drew its plate -- an empty blue bar
        const stripOn = where !== "" || why !== ""
        if (stripOn !== this.brainStripOn && this.brainPlate >= 0) {
          this.brainStripOn = stripOn
          this.ui.set(this.brainPlate, { visible: stripOn })
          this.ui.set(this.brainAccent, { visible: stripOn })
        }
        if (this.brainWhyT.text !== why) {
          this.brainWhyT.text = why
          // the two states worth a beat: the stutter has a cause, and being held back has a reason
          if (why.indexOf("COMPARING") === 0 || why.indexOf("HELD BACK") === 0) Anim.pulse("board.brainwhy", this.brainWhyT.getTransform(), 1.10)
        }
        this.fill(this.brainWhyT, gpuCheckRunning(this.brainLink) ? WAIT : why.indexOf("HELD BACK") === 0 ? WAIT : TXT2)
      }
      if (this.guide) {
        const nums = brainNumbers(this.brainLink)
        if (nums !== this.brainNumsShown) {
          this.brainNumsShown = nums
          this.guide.setBrainNumbers(nums)
        }
      }
    }
    t0 = this.mark("bars", t0)
    this.ui.flush()
    this.mark("flush", t0)
  }
}
