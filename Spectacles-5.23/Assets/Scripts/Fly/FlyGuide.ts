/**
 * FlyGuide — the onboarding card, in the board's own language (ADR 57).
 *
 * A second plate to the LEFT of the board (same neon frame, brackets, captions) with four numbered
 * steps that light up as the session moves: scan the room, meet the fly, faster brain by PIN,
 * friends. It says what the fly IS (the MaleCNS v1.0 connectome, fly-wirehead) and where that comes
 * from. GOT IT hides it; the "?" in the board's header brings it back. The steps and the live lines
 * (PIN, page, friends) come from FlySwarm through FlyBoard.setGuide(); every write is diff-cached, so
 * an unchanged card costs nothing per frame.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyConfig } from "./FlyConfig"
import { Anim } from "./FlyMotion"
import { NeonBatch, NeonQuadSet, QuadSink, addFrame } from "./UIBatch"
import { CARD_RENDER_ORDER, MkBatch, MkButton, MkText, Still, fitText, stillText } from "./UICard"
import { TextBatch } from "./TextBatch"
import { TrainMode, TrainState, TRAIN_MODES, TRAIN_LESSON } from "./FlyTrainer"
// the card's colours are the board's colours (FlyPalette). DIM is what this file used to call DONE --
// the settled-step grey; the word DONE stays for the card's own TEXT ("SESSION DONE").
import { DIM, FRAME, PLATE, TXT, TXT2, WHITE } from "./FlyPalette"

export type GuideState = { step: number; pin: string; web: boolean; friends: number; learning?: boolean; train?: TrainState | null }

const log = new NativeLogger("FlyGuide")

/** m:ss, for the session header and the lesson's step line (ADR 73) */
function clockOf(secs: number): string {
  const t = Math.max(0, Math.floor(secs || 0))
  const ss = t % 60
  return Math.floor(t / 60) + ":" + (ss < 10 ? "0" : "") + ss
}

const CARD_W = 27
const CARD_H = 45
const GAP = 2.2
const T_TITLE = 1.05
const T_LABEL = 0.56
const T_CAPTION = 0.46
// 16.09 typography pass: 0.42 (cap 0.52 cm) rendered as mush — the start-card capture read
// "MalwCNS v1.0 connuctumu" — and it sat 9 % from T_CAPTION, which is not a step. Five tiers now.
const T_SMALL = 0.46
const T_KEY = 0.66
// 16.09: the text column of this card, measured once. Every line that could grow is fitted to it.
const TEXT_W = CARD_W - 3.0
// The session picker, measured from the card's top so nothing can drift into the footer:
// header rule at top-3.2, grid rows at top-MODE_TOP - r*MODE_PITCH, last key bottom at
// top-24.4, the one explanation line at top-MODE_DESC, the live line at top-31.0.
const MODE_W = 11.4 // two columns inside the card's 1.5 cm margin
const MODE_H = 4.1
const MODE_PITCH = 4.7
const MODE_TOP = 12.0 // centre of row 0, below the header rule AND the first-lesson key
const MODE_ROWS = 4
const MODE_DESC = 29.4 // one line under the grid, clear of both the keys and the live line
const LESSON_KEY_Y = 6.4 // the way in, full width, above the grid (ADR 69)
const LESSON_KEY_W = 23.0
const LESSON_NUM = 2.2 // the step number, big enough to read at a glance
const LESSON_OPTS = 3 // never more than three choices at once
const LESSON_OPT_Y = 23.4 // the first choice key, under the step's words
const LESSON_OPT_PITCH = 4.6 // three keys end at top-32.6, clear of GOT IT at top-41.4

const STEPS = [
  ["SCAN THE ROOM", "look around slowly, then press", "DONE SCANNING"],
  ["MEET YOUR FLY", "it appears in front of you: a real", "fly brain decides every move"],
  ["FASTER BRAIN", "open pavlo-stijn.dev/fly on a laptop", "and type the lens PIN"],
  ["FRIENDS", "start menu > COLOCATED:", "other people's flies fly next to yours"],
  // 21.09: step five used to march the wearer through a lesson, with a LEARNING toggle and an ASK
  // key that no longer exist. ADR 101: pointing is an INSPECTOR -- it changes nothing for her, it
  // shows what the thing already is to her. The step says exactly that, and nothing it cannot keep.
  ["POINT AT A THING", "what it smells like to her, how far", "that carries, what she makes of it"],
]
const STEP_PITCH = 5.0
// 16.09: the three lines of a step sat at 0 / -1.9 / -3.3 inside a 5.0 group, so the gap to the NEXT
// step (1.7) was smaller than the gap inside this one (1.9) — the second line read as belonging to
// the step below it. Tightened, the group gap (2.1) is now the largest space in the block.
const STEP_L2 = 1.6
const STEP_L3 = 2.9
/**
 * ADR 98 — the side panel's copy, one entry per NEURAL row of the board (FlyBoard.NEURAL keys).
 * Written for a person with ZERO context (21.09 Pavlo: "описи треба для людей які не в контексті"):
 * `head` = the plain meaning, `what` = what this population IS and why it matters, `see` = what you
 * will watch it do, `atlas` = the cell / region name, last and smallest. Every number a line quotes
 * is the model's own: 104,702 optic-lobe cells, 1,332 descending neurons, 7,835 plastic synapses,
 * PPL101's ~71 Hz idle (web CHAIN_WORD, ADR 65/67). The bar itself is explained once, by BAR_MEANING.
 */
export interface RowBlurb {
  head: string
  what: string
  see: string
  atlas: string
}
export const BAR_MEANING = "THE BAR  //  how far above its usual rate, in Hz"
export const ROW_BLURBS: { [key: string]: RowBlurb } = {
  optic: {
    head: "VISION",
    what: "Her eyes' own lobe: 104,702 cells that see before the brain does. It answers to motion, and to anything that looms at her.",
    see: "Wave a hand towards her: this climbs first, and ESCAPE follows a beat later.",
    atlas: "optic lobe · every cell averaged",
  },
  central: {
    head: "CENTRAL BRAIN",
    what: "Where the senses meet and a decision gets made: land, feed, turn, flee.",
    see: "Busiest while she is near food, near you, or choosing where to go next.",
    atlas: "central brain · every cell averaged",
  },
  mushroom: {
    head: "MEMORY",
    what: "The mushroom body: where a smell gets a meaning. A landing on food, a bitter taste, a scare - each one rewires it, by itself, all the time.",
    see: "Climbs while she is learning what a thing means, and when a smell she knows reaches her.",
    atlas: "mushroom body · Kenyon cells to MBONs · 7,835 synapses that change",
  },
  sensory: {
    head: "SENSES",
    what: "Everything coming in: her eyes, the smell on her antennae, touch and wind on her bristles, taste on her feet.",
    see: "Jumps when a smell reaches her or a hand brushes past; quiet in still air.",
    atlas: "sensory neurons · every cell averaged",
  },
  descending: {
    head: "BRAIN TO BODY",
    what: "The 1,332 cells that carry a decision down from the brain to the body. Nothing moves without them.",
    see: "A burst here is a decision on its way: watch her turn, jump or stop right after.",
    atlas: "descending neurons · every cell averaged",
  },
  vnc: {
    head: "NERVE CORD",
    what: "Her spinal cord: the legs, the wings, the walk. It turns a command into a wing stroke and a step.",
    see: "Loud while she flies or walks, quiet while she sits.",
    atlas: "ventral nerve cord, VNC · every cell averaged",
  },
  DNa02_L: {
    head: "STEER LEFT",
    what: "One cell that turns her left. When it fires more than its twin on the right, she banks left.",
    see: "Lights just before a left turn. STEER RIGHT is the other way.",
    atlas: "DNa02, left · one descending neuron",
  },
  DNa02_R: {
    head: "STEER RIGHT",
    what: "One cell that turns her right. When it fires more than its twin on the left, she banks right.",
    see: "Lights just before a right turn. STEER LEFT is the other way.",
    atlas: "DNa02, right · one descending neuron",
  },
  escape: {
    head: "ESCAPE",
    what: "Her emergency exit. Something looms at her eye and this fires straight to the legs: a jump before any thinking.",
    see: "Rush a hand at her and it spikes as she bolts. Born in, not learned.",
    atlas: "DNp01 · DNp02 · DNp04, the giant-fibre escape",
  },
  stop: {
    head: "STOP",
    what: "The brake. When it fires, she stops walking.",
    see: "Lights the moment she halts on a surface.",
    atlas: "DNpe007 · one descending neuron",
  },
  feed: {
    head: "FEED",
    what: "The nerve that pushes her mouth out to eat.",
    see: "Lights while she feeds on food you placed, or on what the room offered.",
    atlas: "MN9 · proboscis motor neuron",
  },
  stress: {
    head: "STRESS",
    what: "Dopamine that says 'that was bad'. It teaches her memory to avoid the smell that was there. It idles at about 71 Hz here, so only the climb above that means anything.",
    see: "Lights when she meets a bitter taste or a scare.",
    atlas: "PPL101 · dopamine to the mushroom body",
  },
}

// while LEARNING is on, the footer gives way to how the learning works (15.09 Pavlo: "the key must
// turn learning on AND pop the instruction in the side panel"). ADR 14/48, in plain words.
// (15.09 Pavlo: "the TEACH key must open the side instruction with a FULL description of what
// exactly to teach the fly"). While learning is on the steps give way to this. Every line is true
// of the brain (ADR 14: lure + reward pulse on landing; ADR 48: PAM reward / PPL101 aversive rule).
// 16.09 copy pass: three of these lines were 66-69 characters, i.e. 26-27.5 cm on a 24 cm text
// column — they ran off the plate, and they were drawn with the raw `st()` so nothing warned. Every
// line is now inside the column and goes through `fit`, which warns in the log if a later edit grows
// one. Nothing was dropped: what it can learn, the four steps of a food place, the danger place,
// and what happens to the memory.
const TEACH = [
  ["WHAT IT CAN LEARN", TXT],
  ["a thing in your room can come to mean food, or danger", TXT2],
  ["its memory ties that smell to what happened", TXT2],
  ["HOW IT LEARNS, BY ITSELF", TXT],
  ["1  every thing in the room smells: one of sixteen", TXT2],
  ["2  it flies there on its own brain and lands", TXT2],
  ["3  landing on food = a reward, more when hungry", TXT2],
  ["4  it then goes sooner, and from further away", TXT2],
  ["YOU SMELL TOO, AND A SCARE IS A LESSON", TXT],
  ["rush a hand at it, or touch it: it reads a threat", TXT2],
  ["her punishment signal fires: your smell turns bad", TXT2],
  ["MEMORY", TXT],
  ["fades by itself in about 3 hours", TXT2],
]

/** The session's four steps (ADR 62). The third line of step 3 names the US the mode delivers, so
 *  the card never promises a reward while the aversive protocol is running. */
const TRAIN_STEPS: [string, string, string][] = [
  ["PICK THE THING", "point at a thing in the room to set the cue", "its smell and its place are the cue"],
  ["BEFORE: NOTHING HAPPENS", "the cue comes on once and nothing follows", "this is the zero the memory is measured from"],
  ["THE TRIALS: CUE, THEN THE DOPAMINE", "let it fly there on its own brain - do not help", ""],
  ["AFTER: THE SAME TEST AGAIN", "the cue, and nothing. does it turn sooner?", "the change in that turn IS the memory"],
]
const TRAIN_US_LINE: { [m: string]: string } = {
  appetitive: "it lands -> a reward: 16 dopamine pulses",
  aversive: "it lands -> a scare + 16 punishment pulses",
  extinction: "it lands and nothing follows: the memory fades back",
}

export class FlyGuide {
  private root: SceneObject
  private tb: TextBatch | null
  private still: Still
  private fit: (s: string, x: number, y: number, scale: number, color: vec4, maxCm: number,
                opt?: { align?: "L" | "R" | "C"; lineCm?: number; min?: number }) => number
  private stepY: number[] = [] // the y of each step's title row
  private L: number
  private live: Text
  private brainNums: Text // ADR 84: the load policy's raw numbers, the only place they are shown
  private brainNumsStr = ""
  private clock: Text // the session clock: out of the mesh, so a second does not rebuild it (16.09)
  private lessonAction: Text // the lesson's live line, same reason
  private actionY = 0 // where `rebuild` left room for it (it follows how many lines `line` took)
  private clockStr = ""
  private actionStr = ""
  private liveHead = ""
  private plateIdx: number[] = []
  private modeKeys: { so: SceneObject; quads: number[]; x: number; y: number }[] = []
  private optKeys: { so: SceneObject; quads: number[]; x: number; y: number }[] = []
  private optsOn = 0
  private opts: { key: string; label: string; hint: string }[] = []
  /** the lesson's choice, from a key on the card (ADR 71) */
  onLessonChoice: (key: string) => void = () => {}
  private modesOn = false
  private menuPick = -1 // which key the picker explains (-1 = the first lesson, the default)
  /** the picker chose a session (FlyBoard forwards it to FlyTrainer.choose) */
  onMode: (m: TrainMode) => void = () => {}
  private state: GuideState = { step: -1, pin: "", web: false, friends: -1, learning: false }
  private shown = true
  onDismiss: () => void = () => {}

  constructor(parent: SceneObject, boardW: number, boardH: number, quad: RenderMesh, neon: Material, batchMat: Material | null, mkText: MkText, mkButton: MkButton, mkBatch: MkBatch, accent: vec4) {
    this.root = global.scene.createSceneObject("FlyGuide")
    this.root.setParent(parent)
    // its own batch: the board's is a fixed-capacity mesh and every quad of it is spoken for
    const ui: QuadSink = batchMat ? new NeonBatch(this.root, batchMat, "GuideNeon") : new NeonQuadSet(this.root, quad, neon, "GuideNeon")
    ui.setRenderOrder(CARD_RENDER_ORDER) // ADR 97: under the fly, like the board
    const cx = -boardW / 2 - GAP - CARD_W / 2
    const cy = (boardH - CARD_H) / 2 - 0.5
    const L = cx - CARD_W / 2 + 1.5
    this.L = L
    const top = cy + CARD_H / 2
    // every label that never changes lives in ONE mesh (15.09 Pavlo: "fewer draw calls"); the step
    // colours are part of that mesh, so a step change rebuilds it (rare) instead of tinting 16 Texts
    this.tb = mkBatch(this.root, "GuideText")
    if (this.tb) this.tb.setRenderOrder(CARD_RENDER_ORDER)
    this.still = stillText(this.tb, mkText, this.root)
    // ADR 71: every batched line is measured against the card before it is drawn (Pavlo's capture:
    // the CC-BY credit ran past the right edge and under the GOT IT key)
    this.fit = fitText(this.tb, this.still, (m: string) => log.w("GUIDE " + m))
    // the plate and its frame, exactly the board's
    this.plateIdx.push(ui.add(cx, cy, -0.6, CARD_W, CARD_H, PLATE, FlyConfig.BOARD_PLATE, 2))
    const fr = addFrame(ui, cx, cy, CARD_W, CARD_H, FRAME, accent)
    for (const i of fr.edges) this.plateIdx.push(i)
    for (const i of fr.brackets) this.plateIdx.push(i)
    this.plateIdx.push(ui.add(cx, top - 3.2, 0, CARD_W - 2, 0.16, FRAME, 0.6, 2))
    let y = top - 5.6
    for (let i = 0; i < STEPS.length; i++) {
      this.stepY.push(y)
      y -= STEP_PITCH
    }
    // the live line: the PIN, the page, the friends
    this.live = mkText(this.root, "", L, y - 0.4, T_LABEL, accent, { mono: true }) // clear of the last step's second line
    // ADR 84: the brain's RAW numbers (level, threads, duty, step) — the "x1 25%" that used
    // to sit in the board's header, where nobody could act on it. This is the place for it: the help
    // card, in the smallest type, under the live line and clear of the divider at y-2.0. Its own
    // Text, so a changing duty never rebuilds this card's mesh.
    this.brainNums = mkText(this.root, "", L, y - 1.35, T_SMALL, TXT2, { mono: true })
    this.brainNums.getSceneObject().enabled = false
    // 16.09: the two strings on this card that change on a CLOCK rather than on an event leave the
    // batched mesh. They used to be drawn into it, and `keyOf` carried `elapsed`, so the whole mesh
    // (several hundred glyphs) was rebuilt once a second for the length of a session — 196 rebuilds
    // in the 15.09 FOOD run. A Text costs one draw; the rebuild cost nothing but frames.
    this.clock = mkText(this.root, "", cx + CARD_W / 2 - 1.5, top - 4.5, T_SMALL, accent, { align: "R", mono: true })
    this.lessonAction = mkText(this.root, "", L, top - 20, T_SMALL, accent)
    this.lessonAction.getSceneObject().enabled = false
    this.plateIdx.push(ui.add(cx, y - 2.0, 0, CARD_W - 2, 0.16, FRAME, 0.4))
    this.fixed = [cx, top, y, accent]
    // GOT IT: in the card's own batch, no draw call of its own
    const b = mkButton(this.root, "GuideOk", cx, cy - CARD_H / 2 + 3.6, 18, 4.4, () => this.show(false), ui)
    for (const i of b.quads) this.plateIdx.push(i)
    // The session picker (ADR 66). Every quad of a NeonBatch must exist before its first flush, so
    // all seven keys are built here and only their visibility changes later. Two columns, four rows.
    // 2 x 4, equal rows: FOOD / DANGER / FORGET / TEST down the left, CHOICE / TRANSFER / RESET
    // down the right. The bottom-right slot stays empty on purpose — a seventh key centred under
    // the grid reads as a mistake, an empty cell reads as a grid.
    // ADR 69: the first lesson, wide, above the grid — the only key someone who has never taught
    // anything needs to find.
    {
      const ky = top - LESSON_KEY_Y
      const key = mkButton(this.root, "GuideModeLesson", cx, ky, LESSON_KEY_W, MODE_H, () => this.pick("lesson"), ui)
      this.modeKeys.push({ so: key.so, quads: key.quads, x: cx, y: ky })
      if (key.hover) key.hover((on: boolean) => this.hoverMode(-1, on))
    }
    for (let i = 0; i < TRAIN_MODES.length; i++) {
      const col = i < MODE_ROWS ? 0 : 1
      const row = i < MODE_ROWS ? i : i - MODE_ROWS
      const kx = cx + (col === 0 ? -MODE_W / 2 - 0.5 : MODE_W / 2 + 0.5)
      const ky = top - MODE_TOP - row * MODE_PITCH
      const mode = TRAIN_MODES[i][0]
      const key = mkButton(this.root, "GuideMode" + mode, kx, ky, MODE_W, MODE_H, () => this.pick(mode), ui)
      this.modeKeys.push({ so: key.so, quads: key.quads, x: kx, y: ky })
      // one line about the key under the cursor, not seven at once (15.09 Pavlo's screenshot: the
      // seven ran into the footer). The rebuild is keyed on it, so it costs one mesh build per hover.
      if (key.hover) key.hover((on: boolean) => this.hoverMode(i, on))
    }
    // ADR 71: the lesson's choices — at most three, in the picker's key style, built here so no
    // quad is ever added after the batch's first flush, then shown and hidden per step.
    for (let i = 0; i < LESSON_OPTS; i++) {
      const ky = top - LESSON_OPT_Y - i * LESSON_OPT_PITCH
      const key = mkButton(this.root, "GuideOpt" + i, cx, ky, LESSON_KEY_W, MODE_H, () => this.optPress(i), ui)
      this.optKeys.push({ so: key.so, quads: key.quads, x: cx, y: ky })
    }
    this.ui = ui
    ui.flush()
    this.showModes(false)
    this.showOpts(0)
    this.set({ step: 1, pin: "", web: false, friends: 0, train: null })
  }
  private ui: QuadSink
  private fixed: [number, number, number, vec4] // cx, top, the y under the last step, the accent

  /** the key under the cursor decides which single line the picker explains */
  private hoverMode(i: number, on: boolean) {
    const next = on ? i : -1 // nothing hovered: explain the first lesson, the way in
    if (next === this.menuPick) return
    this.menuPick = next
    this.cache.length = 0 // force the one mesh rebuild
    this.set(this.state)
  }

  private pick(m: TrainMode) {
    this.showModes(false)
    this.onMode(m)
  }

  private optPress(i: number) {
    if (i < this.opts.length) this.onLessonChoice(this.opts[i].key)
  }

  /** how many choice keys are live right now */
  private showOpts(n: number) {
    if (n === this.optsOn) return
    this.optsOn = n
    for (let i = 0; i < this.optKeys.length; i++) {
      const on = i < n && this.shown
      this.optKeys[i].so.enabled = on
      for (const q of this.optKeys[i].quads) this.ui.set(q, { visible: on })
    }
    this.ui.flush()
  }

  /** the picker's keys, through the batch's visibility flags: no quad is ever added after the flush */
  private showModes(on: boolean) {
    if (on === this.modesOn) return
    this.modesOn = on
    for (const k of this.modeKeys) {
      k.so.enabled = on && this.shown
      for (const i of k.quads) this.ui.set(i, { visible: on && this.shown })
    }
    this.ui.flush()
  }

  /** the whole static text of the card, coloured for `step` (one mesh; rebuilt only on a step change) */
  private rebuild(step: number, learning: boolean, tr: TrainState | null, web: boolean) {
    const [cx, top, y, accent] = this.fixed
    const L = this.L
    const st = this.still
    if (this.tb) this.tb.begin()
    const menu = !!tr && tr.phase === "menu"
    // ADR 73: a session has to have a visible beginning and a visible end
    // 16.09: the clock is no longer part of this string — it lives in its own Text (see the
    // constructor), so a passing second cannot rebuild the whole mesh.
    const head = menu ? "GUIDE  //  PICK A SESSION"
      : tr && tr.phase === "done" ? "SESSION DONE"
      : tr ? "SESSION  ·  " + (tr.label ? tr.label.toUpperCase() : tr.mode.toUpperCase())
      : learning ? "GUIDE  //  HOW IT LEARNS" : "GUIDE  //  HOW TO"
    this.fit(head, L, top - 2.35, T_CAPTION, tr ? accent : TXT2, CARD_W - 12.5)
    st("CYBERFLY", cx + CARD_W / 2 - 1.5, top - 2.35, T_TITLE, accent, "R")
    if (menu) {
      // the picker: seven labels on the keys built in the constructor, plus one line each of what
      // the session actually does. Batched text centres its cap box on `y`.
      st(TRAIN_LESSON[1], this.modeKeys[0].x, this.modeKeys[0].y - 0.3, T_KEY, accent, "C", 1.5)
      for (let i = 0; i < TRAIN_MODES.length && i + 1 < this.modeKeys.length; i++) {
        const k = this.modeKeys[i + 1]
        st(TRAIN_MODES[i][1], k.x, k.y - 0.3, T_KEY, WHITE, "C", 1.5)
      }
      const pick = this.menuPick < 0 ? TRAIN_LESSON : TRAIN_MODES[Math.max(0, Math.min(TRAIN_MODES.length - 1, this.menuPick))]
      this.fit(pick[1] + " · " + pick[2], L, top - MODE_DESC, T_SMALL, TXT, CARD_W - 3.0, { lineCm: 1.15 })
    } else if (tr && tr.lesson) {
      // ADR 69: the first lesson owns the card — one step at a time, the same words the page shows
      // (they travel in TrainState, so the two cannot drift). Big number, title, line, action, dots.
      const ls = tr.lesson
      const cy0 = top - 9.0
      st("0" + ls.step, L, cy0, LESSON_NUM, WHITE)
      st("STEP " + ls.step + " OF " + ls.of, L + 7.0, cy0 + 1.4, T_SMALL, TXT2)
      st(ls.title, L + 7.0, cy0 - 1.0, T_LABEL, WHITE)
      const lw = TEXT_W
      const nl = this.fit(ls.line, L, cy0 - 6.0, T_CAPTION, TXT, lw, { lineCm: 1.5 })
      // `action` is the fly's live line ("it is almost there") — it changes on the fly's own motion,
      // so it is a Text too, placed where the mesh leaves room for it (16.09).
      this.actionY = cy0 - 8.2 - (nl - 1) * 1.5
      // the progress row: one dot per step, the done ones dim, the live one lit
      for (let i = 0; i < ls.of; i++) {
        const on = i + 1 === ls.step
        st(on ? "[]" : i + 1 < ls.step ? "--" : "..", L + i * 2.1, cy0 - 12.0, T_SMALL, on ? WHITE : i + 1 < ls.step ? DIM : TXT2)
      }
      // the choices: the picker's key style, the words straight from TrainState (ADR 71)
      for (let i = 0; i < this.opts.length && i < this.optKeys.length; i++) {
        const k = this.optKeys[i]
        st(this.opts[i].label, k.x, k.y + 0.5, T_KEY, WHITE, "C", 1.5)
        st(this.opts[i].hint, k.x, k.y - 1.1, T_SMALL, TXT2, "C", 1.5)
      }
    } else if (tr && tr.phase === "done") {
      // ADR 73: the end of a session, said once and plainly, and it stays until GOT IT
      const dy = top - 10.0
      st("SESSION DONE", L, dy, T_TITLE * 1.6, WHITE)
      st(tr.mode.toUpperCase() + (tr.label ? "  ·  " + tr.label.toUpperCase() : ""),
        L, dy - 3.2, T_CAPTION, accent)
      this.fit(tr.result || "reading the numbers...", L, dy - 6.4, T_SMALL, TXT, TEXT_W, { lineCm: 1.3 })
    } else if (tr) {
      // a session is running: the protocol takes the steps' place, one numbered step per phase.
      // The done steps dim exactly as the onboarding steps do -- same colours, same pitch, one mesh.
      for (let i = 0; i < TRAIN_STEPS.length; i++) {
        const k = i + 1
        const on = k === tr.step
        const c = on ? WHITE : k < tr.step ? DIM : TXT
        const c2 = on ? TXT : k < tr.step ? DIM : TXT2
        const sy = this.stepY[i]
        st("0" + k, L, sy, T_TITLE, on ? c : TXT2)
        let title = TRAIN_STEPS[i][0]
        if (k === 1 && tr.label) title = "CUE:  " + tr.label.toUpperCase()
        if (k === 3) title = "THE TRIALS  " + tr.trial + " / " + tr.ofTrials
        st(title, L + 4.2, sy, T_LABEL, c)
        st(TRAIN_STEPS[i][1], L + 4.2, sy - STEP_L2, T_SMALL, c2)
        const third = k === 3 ? TRAIN_US_LINE[tr.mode] || "" : k === 1 && tr.labelMinus
          ? "the other thing (" + tr.labelMinus + ") never pays: that is the control" : TRAIN_STEPS[i][2]
        st(third, L + 4.2, sy - STEP_L3, T_SMALL, c2)
      }
      if (tr.result) {
        st("RESULT", L, this.stepY[3] - 5.4, T_LABEL, WHITE)
        st(tr.result, L, this.stepY[3] - 7.0, T_SMALL, TXT)
      }
    } else if (learning) {
      // the full teaching instruction takes the steps' place; the steps are known by now
      let ty = this.stepY[0] + 0.4
      for (const [line, col] of TEACH) {
        const head = col === TXT
        if (head) ty -= 0.6
        const n = this.fit(line as string, L, ty, head ? T_LABEL : T_SMALL, col as vec4, TEXT_W, { lineCm: 1.25 })
        ty -= (head ? 1.5 : 1.25) * n
      }
    }
    for (let i = 0; i < STEPS.length && !learning && !tr; i++) {
      const k = i + 1
      const c = k === step ? WHITE : k < step ? DIM : TXT
      const c2 = k === step ? TXT : k < step ? DIM : TXT2
      const sy = this.stepY[i]
      st("0" + k, L, sy, T_TITLE, k === step ? c : TXT2)
      st(STEPS[i][0], L + 4.2, sy, T_LABEL, c)
      st(STEPS[i][1], L + 4.2, sy - STEP_L2, T_SMALL, c2)
        // ADR 68: step 03 is where teaching becomes possible, so it says whether it is
        const third3 = k === 3 && web ? "PAGE CONNECTED  //  it is thinking here now" : STEPS[i][2]
        st(third3, L + 4.2, sy - STEP_L3, T_SMALL, c2)
    }
    // what it is, and where it comes from
    if (menu || (tr && (tr.lesson || tr.phase === "done"))) {
      // the picker and the lesson each own the whole card: the provenance block would land on them
    } else if (tr) {
      st("THIS IS A REAL CONDITIONING PROTOCOL", L, y - 3.4, T_CAPTION, TXT)
      st("Huang, Luo et al. 2024, Nature 634:1141 - the same", L, y - 4.7, T_SMALL, TXT2)
      st("rule runs here on 7,835 real memory synapses", L, y - 5.9, T_SMALL, TXT2)
    } else {
      // six lines at a 1.1 pitch from y-2.8: the last one lands at y-8.3 and the GOT IT key's top
      // edge is at y-8.6, so nothing sits under it (ADR 71, Pavlo's capture)
      // six lines at a 1.0 pitch from y-2.4: the last lands at y-7.4 = top-38.0, a clear 1.2 cm above
      // the GOT IT key (its top is top-39.2). 15.09 Pavlo: the last line sat under the key
      st("THIS IS A REAL FLY BRAIN", L, y - 2.4, T_CAPTION, TXT)
      st("MaleCNS v1.0 connectome, 166,700 neurons,", L, y - 3.4, T_SMALL, TXT2)
      st("25.6 M synapses, simulated cell by cell", L, y - 4.4, T_SMALL, TXT2)
      // the data and the model are other people's work under CC BY: say whose, on the card itself,
      // in three lines that each fit the card (ADR 71)
      const w = CARD_W - 3.0
      this.fit("MaleCNS v1.0 · HHMI Janelia FlyEM", L, y - 5.4, T_SMALL, TXT2, w)
      this.fit("Google Research · Cambridge MRC LMB · CC BY", L, y - 6.4, T_SMALL, TXT2, w)
      this.fit("model fly-wirehead · rule Huang, Luo 2024", L, y - 7.4, T_SMALL, TXT2, w)
    }
    st("GOT IT", cx, top - CARD_H + 3.6, T_KEY, WHITE, "C", 1.5) // on the key's centre
    if (this.tb) this.tb.flush()
  }

  /** pops in (after `delay`), slips out; the plate quads follow the root's scale through the batch */
  show(on: boolean, delay = 0) {
    if (on === this.shown) return
    this.shown = on
    // 16.09 (playbook §11): `Anim.run` LANDS the animation it replaces, callback and all. So a fast
    // "?" - "?" ran the pending slip-out's `done()` right after the show had enabled the root — the
    // card ended up disabled and every quad hidden while `shown` was true, and the next press did
    // nothing. Each show/hide carries a token; a landed callback from the previous one is ignored.
    const seq = ++this.showSeq
    const tr = this.root.getTransform()
    if (on) {
      this.root.enabled = true
      for (const i of this.plateIdx) this.ui.set(i, { visible: true })
      for (const k of this.modeKeys) {
        k.so.enabled = this.modesOn
        for (const i of k.quads) this.ui.set(i, { visible: this.modesOn })
      }
      for (let i = 0; i < this.optKeys.length; i++) {
        const on = i < this.optsOn
        this.optKeys[i].so.enabled = on
        for (const q of this.optKeys[i].quads) this.ui.set(q, { visible: on })
      }
      this.ui.flush()
      Anim.popIn("guide.card", tr, 0.4, 1.15, delay)
    } else {
      Anim.slipOut("guide.card", tr, 0.25, () => {
        if (seq !== this.showSeq) return
        this.root.enabled = false
        for (const i of this.plateIdx) this.ui.set(i, { visible: false })
        for (const k of this.modeKeys.concat(this.optKeys)) {
          k.so.enabled = false
          for (const i of k.quads) this.ui.set(i, { visible: false })
        }
        this.ui.flush()
      })
      this.onDismiss()
    }
  }

  get visible(): boolean {
    return this.shown
  }

  private showSeq = 0

  /** hidden without a motion or a dismiss (the board is not on yet) */
  hideNow() {
    this.shown = false
    this.showSeq++
    this.root.enabled = false
    for (const i of this.plateIdx) this.ui.set(i, { visible: false })
    for (const k of this.modeKeys.concat(this.optKeys)) {
      k.so.enabled = false
      for (const i of k.quads) this.ui.set(i, { visible: false })
    }
    this.ui.flush()
  }

  /**
   * Does the one mesh have to be rebuilt? It used to be answered by BUILDING A STRING every frame
   * (`keyOf`), array `.map().join()` and all — per-frame garbage, which ADR 39 rules out — and that
   * string carried `elapsed`, so the answer was "yes" once a second for the whole session. Now every
   * field the mesh draws is compared against its own cached slot: no allocation, and the rebuild is
   * event-driven. The two strings that move on a clock (the session time, the fly's live line) are
   * Texts, so they are deliberately NOT in here. (16.09)
   */
  private cache: any[] = []
  private ci = 0
  private ciDirty = false
  private put(v: any) {
    if (this.cache[this.ci] !== v) {
      this.cache[this.ci] = v
      this.ciDirty = true
    }
    this.ci++
  }
  private changed(s: GuideState): boolean {
    this.ci = 0
    this.ciDirty = false
    const t = s.train && s.train.phase !== "off" ? s.train : null
    this.put(!!s.learning)
    this.put(s.step)
    this.put(!!s.web)
    this.put(this.menuPick)
    this.put(t ? t.phase : "")
    this.put(t ? t.mode : "")
    this.put(t ? t.step : 0)
    this.put(t ? t.trial : 0)
    this.put(t ? t.ofTrials : 0)
    this.put(t ? t.label : "")
    this.put(t ? t.labelMinus : "")
    this.put(t ? t.result : "")
    const ls = t ? t.lesson : null
    this.put(ls ? ls.step : 0)
    this.put(ls ? ls.of : 0)
    this.put(ls ? ls.title : "")
    this.put(ls ? ls.line : "")
    this.put(ls ? ls.chosen : "")
    this.put(this.opts.length)
    for (let i = 0; i < LESSON_OPTS; i++) {
      const o = i < this.opts.length ? this.opts[i] : null
      this.put(o ? o.label : "")
      this.put(o ? o.hint : "")
    }
    return this.ciDirty
  }

  /** ADR 84: the raw brain numbers from the board (already diff-cached there; "" hides the line). */
  setBrainNumbers(s: string) {
    if (s === this.brainNumsStr) return
    this.brainNumsStr = s
    this.brainNums.text = s
    if (this.brainNums.getSceneObject().enabled !== !!s) this.brainNums.getSceneObject().enabled = !!s
  }

  /** the part of a live line that MEANS something: everything before its trailing countdown */
  private static head(s: string): string {
    const i = s.lastIndexOf("//")
    return i < 0 ? s : s.substring(0, i)
  }

  set(s: GuideState) {
    // the options first: `rebuild` draws their labels, so it has to see the new ones (ADR 71)
    const lsNow = s.train ? s.train.lesson : null
    this.opts = lsNow && lsNow.options ? lsNow.options.slice(0, LESSON_OPTS) : []
    const tr = s.train && s.train.phase !== "off" ? s.train : null
    if (this.changed(s)) this.rebuild(s.step, !!s.learning, tr, !!s.web)
    this.showModes(!!s.train && s.train.phase === "menu")
    this.showOpts(this.opts.length) // ADR 71: the lesson's choice keys follow the step
    // the session clock and the lesson's live line: their own Texts, both diff-cached, so the thing
    // that ticks is never the thing that rebuilds a mesh (16.09)
    const clock = tr ? clockOf(tr.elapsed) : ""
    if (clock !== this.clockStr) {
      this.clockStr = clock
      this.clock.text = clock
    }
    const ls = tr ? tr.lesson : null
    const act = ls ? ls.action : ""
    if (act !== this.actionStr) {
      this.actionStr = act
      this.lessonAction.text = act
      this.lessonAction.getTransform().setLocalPosition(new vec3(this.L, this.actionY, 0.25))
    }
    if (this.lessonAction.getSceneObject().enabled !== !!act) this.lessonAction.getSceneObject().enabled = !!act
    // the live line: during a session it is the only per-frame string on the card
    if (tr) {
      // while the lesson is up its own `action` line is the instruction; a second one would land
      // on a choice key (Pavlo's capture, 15.09)
      const live = tr.lesson && tr.lesson.options.length ? "" : tr.instruction
      this.setLive(live)
    } else if (s.pin !== this.state.pin || s.web !== this.state.web || s.friends !== this.state.friends || this.wasTrain) {
      const web = s.web ? "PAGE CONNECTED  //  brain on the web" : s.pin ? "WEB PIN  " + s.pin : ""
      const fr = s.friends > 0 ? "  //  " + s.friends + (s.friends === 1 ? " FRIEND" : " FRIENDS") : ""
      this.setLive(web + fr)
    }
    this.wasTrain = !!tr
    this.state = s
  }

  /** 16.09: `instruction` ends in a countdown ("TRIAL 1 / 3  //  12s"), so pulsing on every change
   *  meant pulsing on every data tick for a whole ~200 s session — a tic, not a signal. The words
   *  still update; only a change in what they SAY gets the beat (polish playbook §4). */
  private setLive(s: string) {
    if (this.live.text === s) return
    this.live.text = s
    const h = FlyGuide.head(s)
    if (h === this.liveHead) return
    this.liveHead = h
    Anim.pulse("guide.live", this.live.getTransform(), 1.08)
  }
  private wasTrain = false
}
