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
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { BrainCloud } from "./BrainCloud"
import { BrainMsg } from "./BrainLink"
import { TextBatch } from "./TextBatch"
import { FlyConfig } from "./FlyConfig"
import { BONES, FlyBody } from "./FlyBody"
import { NeonBatch, NeonQuadSet, QuadSink } from "./UIBatch"

// 11.09 the user: "more vertical, bigger, compact right side" — was 64x36 landscape
const W = 50 // board-local cm (whole device, before BOARD_SCALE)
const H = 46
const FRAME = new vec4(0.25, 0.9, 1.0, 1)
// Design tokens (11.09 design pass): cyan = structure, two text tiers, the selected fly's colour
// = the only accent, amber = BODY (simulated, never the brain's colours). Chakra Petch for words,
// Share Tech Mono for numbers (tabular digits: values don't jitter as they change).
const TXT = new vec4(0.86, 0.95, 1.0, 1) // primary: labels, values, tab numbers
const TXT2 = new vec4(0.45, 0.74, 0.86, 1) // secondary: captions, footer
const GEMC = new vec4(0.62, 0.42, 1.0, 1) // Gemini's own colour: its section is an interpretation, not a measurement
const BODYC = new vec4(1.0, 0.72, 0.3, 1)
const INK = new vec4(0.02, 0.06, 0.08, 1) // dark ink: editor-only look — INVISIBLE on the additive glasses display
// the device body reads as TINTED GLASS, not a colourless sheet (12.09 the user) — one FLAT fill, no
// gradient: "I'd fill it with a solid colour, less noise"
const PLATE = new vec4(0.14, 0.34, 0.58, 1)
const WHITE = new vec4(1, 1, 1, 1) // text on lit plates (selected tab number, DONE SCANNING)
const LIVE = new vec4(0.45, 1.0, 0.7, 1)
const WAIT = new vec4(1.0, 0.8, 0.35, 1)
const OFF = new vec4(1.0, 0.38, 0.38, 1)
const TRACK = new vec4(0.3, 0.55, 0.65, 1)
// text scales (x BOARD_TEXT_SCALE, board-local): one step per tier, nothing below T_SMALL
const T_TITLE = 1.05
const T_ACTION = 0.8
const T_LABEL = 0.56
const T_CAPTION = 0.46
const T_SMALL = 0.42
// 12.09 the user: no neuron counts in the caption ("16,000 of 166,700" read as a limitation of the
// brain; the brain is whole, the hologram shows a sample of it)
const CLOUD_CAPTION = "NEURAL ACTIVITY  //  LIVE"
// hoisted formatters: passing them as arrow functions made a fresh closure per row per frame
const UPV = new vec3(0, 1, 0)
const FMT_HZ = (x: number) => x.toFixed(1) + " Hz"
const FMT_PCT = (x: number) => Math.round(x * 100) + "%"
const FMT_CMS = (x: number) => Math.round(x) + " cm/s"

// NEURAL rows (11.09 "every bar should move"): whole-region population rates always fluctuate
// (`msg.regions`); command cells (`msg.hz`) are silent at rest by biology and flare on events.
// Every row auto-ranges to its own recent peak.
const NEURAL = [
  { key: "optic", label: "OPTIC LOBES", floor: 2 },
  { key: "central", label: "CENTRAL BRAIN", floor: 2 },
  { key: "mushroom", label: "MUSHROOM BODY", floor: 2 },
  { key: "sensory", label: "SENSORY", floor: 2 },
  { key: "descending", label: "DESCENDING", floor: 2 },
  { key: "vnc", label: "VNC", floor: 2 },
  { key: "DNa02_L", label: "STEER L  DNa02", floor: 30 },
  { key: "DNa02_R", label: "STEER R  DNa02", floor: 30 },
  { key: "escape", label: "ESCAPE  DNp01+", floor: 30 },
  { key: "stop", label: "STOP  DNpe007", floor: 30 },
  { key: "feed", label: "FEED  MN9", floor: 30 },
  { key: "stress", label: "STRESS  PPL101", floor: 60 },
]
// left holo stage (board-local cm): mini fly on top, brain below
const STAGE_X = -13.75
const STAGE_W = 20
// 12.09 the user: "shrink the 3D fly a little, that lets the brain go up and the eyes fit underneath"
const STAGE_FLY_Y = 12.5
const STAGE_FLY_H = 10.5
const STAGE_BRAIN_Y = -6.0
const STAGE_BRAIN_H = 21
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
  private fonts: { ui: Font | null; mono: Font | null }
  private header: Text
  private status: Text
  private action: Text
  private footer: Text
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
  private banner: string | null = null // overrides the header status (intro room scan)
  private thought: Text
  private thoughtFull = ""
  private thoughtShown = 0
  private scanBtn = -1
  private scanHit: SceneObject | null = null
  private scanLabel: Text | null = null
  private scanPulse = 0
  // ASK (voice find) sits in the DONE SCANNING slot once the scan is over — never both at once
  private askBtn = -1
  private askHit: SceneObject | null = null
  private askLabel: Text | null = null
  private askText = "ASK A FLY  >"
  private askLive = false
  framed = false // world-space inside a ContainerFrame (set by FlySwarm): the frame owns the transform
  private shown = 0
  private pos: vec3 | null = null
  private rot: quat | null = null

  get contentRoot(): SceneObject {
    return this.content
  }

  setBanner(s: string | null) {
    this.banner = s
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
    print("TEXTBATCH_PROBE mat=" + (this.textMat ? "ok" : "MISSING") +
      " ui=" + (this.uiFace ? "ok cap=" + this.uiFace.capEm.toFixed(3) : "MISSING") +
      " mono=" + (this.monoFace ? "ok cap=" + this.monoFace.capEm.toFixed(3) : "MISSING"))
  }

  constructor(parent: SceneObject, quad: RenderMesh, neon: Material, batchMat: Material | null, miniPrefab: ObjectPrefab | null, holo: Material | null, brain: Material | null, fonts: { ui: Font | null; mono: Font | null }) {
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
    if (this.textMat && this.uiFace) this.txt = new TextBatch(c, "BoardTextStatic", this.uiFace, this.textMat, 0)

    // ---- device body: faint plate, neon frame, corner brackets, header rule, divider ----
    ui.add(0, 0, -0.6, W, H, PLATE, FlyConfig.BOARD_PLATE) // 12.09: one solid tint, still see-through
    this.makeOccluder(quad, neon) // ...and the panel hides whatever flies behind it (12.09 the user)
    ui.add(0, H / 2, 0, W, 0.28, FRAME, 0.9)
    ui.add(0, -H / 2, 0, W, 0.28, FRAME, 0.9)
    ui.add(-W / 2, 0, 0, 0.28, H, FRAME, 0.9)
    ui.add(W / 2, 0, 0, 0.28, H, FRAME, 0.9)
    for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      this.brackets.push(ui.add(sx * (W / 2 - 1.6), sy * (H / 2), 0, 3.6, 0.75, FlyConfig.FLY_COLORS[0], 1.8))
      this.brackets.push(ui.add(sx * (W / 2), sy * (H / 2 - 1.6), 0, 0.75, 3.6, FlyConfig.FLY_COLORS[0], 1.8))
    }
    ui.add(0, H / 2 - 3.2, 0, W - 2, 0.16, FRAME, 0.6)
    ui.add(DIV_X, -1.8, 0, 0.16, H - 7, FRAME, 0.5)

    // ---- header ----
    this.still("FLY BRAIN LINK", -W / 2 + 1.5, H / 2 - 2.35, T_CAPTION, TXT2)
    this.header = this.text(c, "FLY 1", -W / 2 + 11, H / 2 - 2.35, T_TITLE, FlyConfig.FLY_COLORS[0])
    this.status = this.text(c, "BRAIN ...", W / 2 - 1.5, H / 2 - 2.35, T_CAPTION, WAIT, { align: "R" })

    // ---- left: holo stage, stacked vertically (11.09: "fly and brain can go vertical") ----
    this.still("HOLO  //  LIVE POSE", -W / 2 + 1.5, H / 2 - 5.1, T_CAPTION, TXT2)
    this.brainCaption = this.text(c, CLOUD_CAPTION, -W / 2 + 1.5, STAGE_BRAIN_Y + STAGE_BRAIN_H / 2 - 1.2, T_CAPTION, TXT2)
    this.makeRetina(quad) // the fly's own 16x8 view, in the corner under the brain (12.09 the user)
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

    // ---- right: tabs (number inside), neural, action, body ----
    // tabs share the column width, whatever the fly count (3 since 11.09)
    const pitch = (VAL_X - RX) / FlyConfig.FLY_COUNT
    for (let i = 0; i < FlyConfig.FLY_COUNT; i++) {
      const x = RX + pitch * (i + 0.5)
      this.tabs.push(ui.add(x, TAB_Y, 0, pitch - 0.6, 1.9, FlyConfig.FLY_COLORS[i], 0.35))
      this.hit(c, "TabHit" + i, x, TAB_Y, pitch - 0.6, 1.9, (it: Interactable) => {
        it.onTriggerStart.add(() => this.onTab(i))
        it.onHoverEnter.add(() => (this.hovered = i))
        it.onHoverExit.add(() => {
          if (this.hovered === i) this.hovered = -1
        })
      })
      this.tabNums.push(this.text(c, "" + (i + 1), x, TAB_Y - 0.3, T_LABEL, TXT, { align: "C", mono: true }))
    }
    this.still("NEURAL  //  MEASURED SPIKES, HZ", RX, H / 2 - 7.9, T_CAPTION, TXT2)
    let y = ROW0_Y
    for (const r of NEURAL) {
      // one label + one value Text per row at the bar's own y (11.09 device: the two multi-line
      // blocks drifted off the bars — the two fonts have different line heights)
      this.still(r.label, RX, y - 0.3, T_LABEL, TXT)
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
      })
      y -= ROW_H
    }

    this.action = this.text(c, "ACTION  HOVER", RX, y - 0.6, T_ACTION, FlyConfig.FLY_COLORS[0])
    y -= 2.2
    this.still("BODY  //  SIMULATED", RX, y, T_CAPTION, BODYC)
    y -= 1.5
    this.still("ENERGY", RX, y - 0.3, T_LABEL, TXT)
    this.rows["energy"] = this.row(y, 1, this.text(c, "0", VAL_X, y - 0.3, T_LABEL, TXT, { align: "R", mono: true }))
    y -= ROW_H
    this.still("SPEED", RX, y - 0.3, T_LABEL, TXT)
    this.rows["speed"] = this.row(y, 1, this.text(c, "0", VAL_X, y - 0.3, T_LABEL, TXT, { align: "R", mono: true }))
    // Gemini's reading of this fly, in its own voice — its OWN section: a dim plate, a caption bar
    // and bigger text (12.09 the user: "put the Gemini comments in their own section, a whole bar,
    // and make them easier to see"). Labelled as interpretation, never a measurement.
    y -= 2.2
    const gemW = W / 2 - RX - 0.4
    const gemTop = y + 0.9
    const gemBot = -H / 2 + 1.6 // stay clear of the bottom frame (12.09: the text ran across it)
    const gemH = gemTop - gemBot
    const gemX = RX + gemW / 2
    ui.add(gemX, (gemTop + gemBot) / 2, -0.05, gemW, gemH, GEMC, FlyConfig.BOARD_GEMINI_PLATE)
    ui.add(gemX, gemTop, 0, gemW, 0.12, GEMC, 1.4) // the bar that opens the section
    // 12.09 the user: "rephrase this and drop the equalisers". With VOICE_ENABLED off the fly never
    // speaks, so "inner voice" promised something that no longer happens and the five bars beside
    // it were a level meter for silence. The line is a thought now, and it follows the board's
    // own pattern (EYES // WHAT THE BRAIN SEES).
    this.still("GEMINI  //  WHAT THE FLY THINKS", RX, y, T_CAPTION, GEMC)
    const thoughtY = y - 1.5
    this.thought = this.text(c, "", RX, thoughtY, FlyConfig.BOARD_GEMINI_TEXT, TXT, { top: true })
    // how many lines actually fit above the bottom frame: the wrap clips to this, so a long line
    // can never run off the board again (12.09 the user: "make this text stop sticking out")
    this.thoughtLines = Math.max(1, Math.floor((thoughtY - gemBot) / (FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_GEMINI_TEXT)))

    // "DONE SCANNING" above the board (11.09 the user: end the room scan with a button, not a timeout)
    this.scanBtn = ui.add(0, SCAN_BTN_Y, 1.2, 26, 5, FlyConfig.FLY_COLORS[1], 1.2)
    ui.set(this.scanBtn, { visible: false })
    this.askBtn = ui.add(0, SCAN_BTN_Y, 1.2, 26, 5, FlyConfig.FLY_COLORS[1], 1.2)
    ui.set(this.askBtn, { visible: false })
    ui.flush()
    if (this.txt) this.txt.flush() // the statics never change: this mesh is built once and left alone
  }

  /** 12.09 the user: "let our panel occlude the flies". Everything on the board is additive and writes
   *  no depth, so a fly behind it showed straight through. This quad draws NO colour (the colour
   *  mask is off) but DOES write depth, just behind the plate and before the flies are drawn: a fly
   *  further away than the board now fails the depth test. The brain cloud and the mini hologram sit
   *  in FRONT of this plane, so they are untouched. */
  private makeOccluder(quad: RenderMesh | null, neon: Material | null) {
    if (!quad || !neon) return
    try {
      const occ = global.scene.createSceneObject("BoardOccluder")
      occ.setParent(this.content)
      const t = occ.getTransform()
      t.setLocalPosition(new vec3(0, 0, -0.7))
      t.setLocalScale(new vec3(W, H, 1))
      const rmv = occ.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
      rmv.mesh = quad
      const m = neon.clone()
      const p: any = m.mainPass
      p.blendMode = BlendMode.Disabled
      p.depthWrite = true
      p.depthTest = true
      p.twoSided = true
      // no pixels, only depth. If the colour mask is not writable here, fall back to a black
      // additive quad (black is transparent on the glasses' display, visible in the editor)
      try {
        p.colorMask = new vec4b(false, false, false, false)
      } catch (e) {
        p.blendMode = BlendMode.Add
        p.intensity = 0
      }
      rmv.mainMaterial = m
      rmv.setRenderOrder(-10) // before the flies, so their depth test sees this
    } catch (e) {
      print("BoardOccluder unavailable: " + e)
    }
  }

  showScanButton(on: boolean) {
    this.ui.set(this.scanBtn, { visible: on })
    if (on && !this.scanHit) {
      this.scanHit = this.hit(this.content, "ScanDoneHit", 0, SCAN_BTN_Y, 26, 5, (it: Interactable) => {
        it.onTriggerStart.add(() => this.onScanDone())
      })
      // bright text on a dim plate: the glasses' display is additive, dark INK text is invisible there (11.09)
      this.scanLabel = this.text(this.content, "DONE SCANNING  >", 0, SCAN_BTN_Y - 0.4, T_TITLE, WHITE, { align: "C" })
      this.scanLabel.getTransform().setLocalPosition(new vec3(0, SCAN_BTN_Y - 0.4, 1.5))
    }
    if (this.scanHit) this.scanHit.enabled = on
    if (this.scanLabel) this.scanLabel.getSceneObject().enabled = on
    this.ui.flush()
  }

  /** ASK (voice find, ADR 27): same slot + look as DONE SCANNING — white text on a dim plate. */
  showAskButton(on: boolean) {
    this.ui.set(this.askBtn, { visible: on, intensity: 0.45 })
    if (on && !this.askHit) {
      this.askHit = this.hit(this.content, "AskHit", 0, SCAN_BTN_Y, 26, 5, (it: Interactable) => {
        it.onTriggerStart.add(() => this.onAsk())
      })
      this.askLabel = this.text(this.content, this.askText, 0, SCAN_BTN_Y - 0.4, T_TITLE, WHITE, { align: "C" })
      this.askLabel.getTransform().setLocalPosition(new vec3(0, SCAN_BTN_Y - 0.4, 1.5))
    }
    if (this.askHit) this.askHit.enabled = on
    if (this.askLabel) this.askLabel.getSceneObject().enabled = on
    this.ui.flush()
  }

  /** ASK label (LISTENING… / THINKING… / FINDING X); live = the plate pulses. */
  setAskLabel(s: string, live: boolean) {
    this.askText = s
    this.askLive = live
    if (this.askLabel && this.askLabel.text !== s) this.askLabel.text = s
    if (!live && this.askBtn >= 0) this.ui.set(this.askBtn, { intensity: 0.45 })
  }


  // ---- what the brain sees: FlyVision's 16x8 RGB retina, the same array the brain is sent ----
  private retinaData: number[] | null = null
  private retinaBlank = false

  /** The selected fly's retina (16x8x3 bytes, row-major, top row first), or null when vision is off. */
  setRetina(r: number[] | null) {
    this.retinaData = r
  }

  /** 12.09 the user: "a bit smaller, and split it into two eyes". The retina IS two eyes already —
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
        p.twoSided = true
        try {
          ;(p as any).samplers.eye.filtering = FilteringMode.Nearest // one texel per ommatidial block
        } catch (e) {
          /* the .mat default stands */
        }
        rmv.mainMaterial = m
        this.eyes.push({ so: so, tex: prov, pix: pix, mat: m })
      }
      // 12.09 the user: "leave the text where it was, only centre the planes" — the caption keeps the
      // board's left margin like every other one; only the two quads sit under the brain.
      this.still("EYES  //  WHAT THE BRAIN SEES", -W / 2 + 1.5,
        FlyConfig.RETINA_Y + (eyeCm * h) / (2 * half) + 1.0, T_SMALL, TXT2)
    } catch (e) {
      print("RetinaPanel unavailable: " + e)
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
      if (e.so.enabled !== true) e.so.enabled = true
      if (e.mat.mainPass.tint !== color) e.mat.mainPass.tint = color
      const px = e.pix
      if (!r) {
        if (this.retinaBlank) continue
        for (let i = 0; i < half * h; i++) {
          const v = ((i % half) + Math.floor(i / half)) % 2 === 0 ? 120 : 35 // "no signal" checker
          px[4 * i] = v
          px[4 * i + 1] = v
          px[4 * i + 2] = v
          px[4 * i + 3] = 255
        }
      } else {
        // the retina is one 16x8 row-major array: columns 0..7 are the left eye, 8..15 the right.
        // 12.09 the user: "it looks washed out" — and it is, on purpose: FlyVision pins the MEAN
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
    t.setLocalPosition(new vec3(STAGE_X, STAGE_FLY_Y - 1.0, 2.0))
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
      t.worldSpaceRect = Rect.create(-200, 0, top, bottom)
    } else if (opt.align === "C") {
      t.horizontalAlignment = HorizontalAlignment.Center
      t.worldSpaceRect = Rect.create(-100, 100, top, bottom)
    } else {
      t.horizontalAlignment = HorizontalAlignment.Left
      t.worldSpaceRect = Rect.create(0, 200, top, bottom)
    }
    // multi-line blocks grow DOWN from the object (centred text would climb upward)
    if (opt.top) t.verticalAlignment = VerticalAlignment.Top
    t.textFill.color = color
    const tr = so.getTransform()
    tr.setLocalPosition(new vec3(x, y, 0.2))
    tr.setLocalScale(vec3.one().uniformScale(scale * FlyConfig.BOARD_TEXT_SCALE))
    return t
  }

  private row(y: number, floor: number, value: Text | null): Row {
    const track = this.ui.add(BAR_X0 + BAR_W / 2, y, 0, BAR_W, BAR_H, TRACK, 0.22)
    const fill = this.ui.add(BAR_X0, y, 0.1, 0, BAR_H, FlyConfig.FLY_COLORS[0], 1)
    const hl = this.ui.add((RX + BAR_X0) / 2, y, -0.2, BAR_X0 - RX + 0.4, ROW_H * 0.85, FlyConfig.FLY_COLORS[0], 0.3)
    this.ui.set(hl, { visible: false })
    return { track: track, fill: fill, hl: hl, y: y, max: floor, peak: floor, rest: 0, floor: floor, shown: 0, value: value, str: "0" }
  }

  /** Brain data lands every ~0.2-0.5 s: value AND auto-range scale both ease toward their targets
   *  at one rate (11.09 the user "no jumps, nothing twitches"). Scale = recent peak, never below floor. */
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
  // perf probe: worst ms per board section in the telemetry window (read + reset by FlySwarm)
  perf: { [k: string]: number } = {}
  private mark(k: string, t0: number): number {
    if (FlyConfig.DEBUG_TELEMETRY_S <= 0) return 0 // perf sections are only read by the telemetry row
    const t = Date.now()
    if (!(this.perf[k] >= t - t0)) this.perf[k] = t - t0
    return t
  }
  private fill(t: Text, c: vec4) {
    if (this.fills.get(t) === c) return
    this.fills.set(t, c)
    t.textFill.color = c
  }

  update(dt: number, cam: Transform, palm: vec3 | null, selected: number, body: FlyBody, msg: BrainMsg | null, linkOk: boolean) {
    const camPos = cam.getWorldPosition()
    let t0 = Date.now()
    this.textT += dt
    this.textDue = this.textT >= 1 / 6
    if (this.textDue) this.textT = 0
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
    const on = this.shown > 0.02
    if (this.content.enabled !== on) this.content.enabled = on
    if (this.cloud) this.cloud.setVisible(on) // cloud mesh lives at scene root
    if (!on) return
    if (target) {
      const rot = quat.lookAt(camPos.sub(target).normalize(), new vec3(0, 1, 0))
      const a = 1 - Math.exp(-dt * FlyConfig.BOARD_FOLLOW_RATE)
      this.pos = this.pos ? vec3.lerp(this.pos, target, a) : target
      this.rot = this.rot ? quat.slerp(this.rot, rot, a) : rot
    }
    const t = this.root.getTransform()
    const s = FlyConfig.BOARD_SCALE * (0.6 + 0.4 * this.shown)
    if (this.framed) {
      t.setLocalScale(vec3.one().uniformScale(s))
      t.setLocalPosition(new vec3(0, 0, FlyConfig.BOARD_FRAME_LIFT_CM)) // in front of the frame's plane
    }
    else {
      if (this.pos) t.setWorldPosition(this.pos)
      if (this.rot) t.setWorldRotation(this.rot)
      t.setWorldScale(vec3.one().uniformScale(s))
    }

    const color = FlyConfig.FLY_COLORS[selected % FlyConfig.FLY_COLORS.length]
    const accent = FlyConfig.FLY_ACCENTS[selected % FlyConfig.FLY_ACCENTS.length]
    // 12.09 the user: "update the panel's data at 15 fps, not 60". The board's POSITION and the brain
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
    const head = "FLY " + (selected + 1) + "  " + FlyConfig.FLY_NAMES[selected % FlyConfig.FLY_NAMES.length]
    if (this.header.text !== head) this.header.text = head
    this.fill(this.header, color)
    this.tabs.forEach((tab, i) => {
      this.ui.set(tab, { intensity: i === selected ? 0.8 : i === this.hovered ? 0.55 : 0.3 })
      this.fill(this.tabNums[i], i === selected ? WHITE : TXT)
    })
    this.fill(this.action, color)
    if (this.thoughtShown < this.thoughtFull.length) {
      this.thoughtShown = Math.min(this.thoughtFull.length, this.thoughtShown + dt * FlyConfig.NARRATE_TYPE_CPS)
      this.thought.text = this.wrap(this.thoughtFull.substring(0, Math.floor(this.thoughtShown)))
    } else if (!this.thoughtFull && this.thought.text) this.thought.text = ""
    let st = linkOk ? (msg ? "BRAIN LIVE" : "BRAIN WAIT") : "BRAIN OFFLINE"
    let stc = linkOk ? (msg ? LIVE : WAIT) : OFF
    if (this.banner) {
      st = this.banner
      stc = WAIT
    }
    if (this.status.text !== st) this.status.text = st
    this.fill(this.status, stc)
    if (this.ui.get(this.scanBtn).visible) {
      this.scanPulse += dt
      this.ui.set(this.scanBtn, { intensity: 0.45 + 0.2 * Math.sin(this.scanPulse * 4) }) // invites a press; dim so the white label reads
    }
    if (this.askLive && this.ui.get(this.askBtn).visible) {
      this.scanPulse += dt
      this.ui.set(this.askBtn, { intensity: 0.45 + 0.2 * Math.sin(this.scanPulse * 6) }) // listening / thinking
    }

    this.uploadRetina(color) // what the brain sees, at the board's own 15 Hz
    t0 = this.mark("top", t0)
    // mini hologram: mirror the selected fly's bone pose in place, slow turntable
    if (this.miniRoot) {
      // the 9 cm mini rig copied 26 bone rotations every frame; 15 Hz is indistinguishable at that
      // size, while the turntable keeps spinning per frame so it stays smooth (12.09 audit)
      this.miniT += dt
      if (this.miniT >= 1 / 15) {
        this.miniT = 0
        for (const name in this.miniBones) {
          const q = body.boneRotation(name)
          if (q) this.miniBones[name].setLocalRotation(q)
        }
      }
      this.miniSpin += dt * FlyConfig.CLOUD_SPIN
      this.miniRoot.getTransform().setLocalRotation(quat.angleAxis(this.miniSpin + 0.6, UPV))
    }
    if (this.hoverRow !== this.shownHover) {
      const was = this.shownHover ? this.rows[this.shownHover] : null
      if (was) {
        this.ui.set(was.track, { intensity: 0.22 })
        this.ui.set(was.hl, { visible: false })
      }
      const now = this.hoverRow ? this.rows[this.hoverRow] : null
      if (now) {
        this.ui.set(now.track, { intensity: 0.8 })
        this.ui.set(now.hl, { visible: true, color: color }) // hovered row lights up in the fly's colour
      }
      this.shownHover = this.hoverRow
      const row = NEURAL.filter((r) => r.key === this.hoverRow)[0]
      this.brainCaption.text = row ? "HIGHLIGHT  // " + row.label : CLOUD_CAPTION
      if (this.cloud) this.cloud.setHighlight(this.hoverRow)
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
    const g = (k: string) => (hz && typeof hz[k] === "number" ? (hz[k] as number) : 0)
    const rg = (k: string) => (reg && typeof reg[k] === "number" ? (reg[k] as number) : 0)
    const vals: { [k: string]: number } = {
      optic: rg("optic"), central: rg("central"), mushroom: rg("mushroom"), sensory: rg("sensory"),
      descending: rg("descending"), vnc: rg("vnc"),
      DNa02_L: g("DNa02_L"), DNa02_R: g("DNa02_R"),
      escape: (g("esc_L") + g("esc_R")) / 2,
      stop: g("stop"), feed: g("feed"), stress: g("stress"),
    }
    for (const r of NEURAL) this.setBar(r.key, vals[r.key], color, FMT_HZ, ddt)
    this.setBar("energy", body.energy, BODYC, FMT_PCT, ddt, 1)
    this.setBar("speed", Math.abs(body.speed), BODYC, FMT_CMS, ddt, FlyConfig.ESCAPE_CM_S)
    // 12.09 audit: these strings were built every frame and written six times a second
    if (this.textDue) {
      const act = "ACTION  " + body.actionLabel()
      if (this.action.text !== act) this.action.text = act
      const foot = msg
        ? "sim " + (msg.sim_ms / 1000).toFixed(1) + " s  |  step " + msg.wall_ms + " ms  |  MaleCNS v1.0 LIF"
        : "no brain data"
      if (this.footer.text !== foot) this.footer.text = foot
    }
    t0 = this.mark("bars", t0)
    this.ui.flush()
    this.mark("flush", t0)
  }
}
