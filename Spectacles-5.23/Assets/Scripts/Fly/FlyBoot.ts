/**
 * FlyBoot — the card that stands where the zeros used to be (ADR 84).
 *
 * Between DONE SCANNING and the fly's first thought there can be a minute in which the lens has
 * nothing true to show: no page has joined the PIN yet, so no brain is stepping — ADR 78 withholds
 * the fly and every NEURAL / BODY row would read 0.0. A dashboard of zeros is a lie, and the lag
 * that comes with it looks like a bug.
 *
 * So the dashboard does not appear yet. This card does, in the board's own language (the start and
 * scan cards' plate, frame, keys and rhythm), and it says what is actually happening, stage by stage:
 *
 *   1 PLAYERS            the start choice (FlyStart)
 *   2 THE ROOM           the scan + Gemini's inventory (WorldScanner)
 *   3 THE BRAIN          a page joins the PIN and its first BrainMsg arrives: the dashboard opens
 *                        and the fly is allowed out (ADR 87 collapsed the old download rows)
 *
 * Every stage is read from state that already exists and is public — `link.status`, `webActive`
 * and the arrival of a BrainMsg — so nothing here can claim a stage that did not happen.
 *
 * The file also owns the WORDS for the board's brain line (`brainWhere` / `brainStep` / `brainWhy` /
 * `brainNumbers`): where the brain runs, how fast it thinks, and how much slower the fly's world runs
 * than the wearer's, in a wearer's words rather than `x1 25%`.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyConfig } from "./FlyConfig"
import { Anim } from "./FlyMotion"
import { TextBatch } from "./TextBatch"
import { NeonBatch, NeonQuadSet, QuadSink, addFrame } from "./UIBatch"
import { MkBatch, MkButton, MkText, Still, fitText, stillText } from "./UICard"
// the card's colours are the board's colours (FlyPalette). DIM here is a COLOUR; the file's own DONE
// is a stage STATE (= 2) and has nothing to do with it.
import { DIM, FRAME, LIVE, OFF, PLATE, TXT, TXT2, WHITE } from "./FlyPalette"

const log = new NativeLogger("FlyBoot")

/** What the card needs of the brain link. Every field optional: a plain BrainLink (the Mac socket)
 *  has none of them, and the card then reads that as "the brain comes over Wi-Fi". */
export interface BrainLinkView {
  connected?: boolean // BrainLink's own: it is what makes a plain socket link assignable to this view
  status?: string
  isNative?: boolean
  gpuDevice?: string
  gpuLost?: string
  gpuCheck?: string
  webActive?: boolean
  pin?: string | number // the room a page must join to become this lens's brain
}

const CARD_W = 38
const CARD_H = 34
const T_LABEL = 0.56
const T_CAPTION = 0.46
const T_SMALL = 0.46
const T_KEY = 0.66

const ROW_TOP = 6.6 // centre of row 0, under the header rule
const ROW_PITCH = 3.3
const SUB_DY = 1.45 // the result line under a row's label
const TEXT_DX = 2.6 // the label column, clear of the lamp
const KEY_Y = -14.0

// measured on the glasses, 17.09: the two ends of the same download on the same Wi-Fi
const FETCH_LOW_S = 45
const FETCH_HIGH_S = 107

const PENDING = 0
const RUNNING = 1
const DONE = 2
const FAILED = 3
const SKIPPED = 4

const STAGE_LABELS = [
  "PLAYERS",
  "THE ROOM",
  // ADR 87: the brain is a page, so the old brain-file / unpacking / GPU-check rows could only ever
  // read SKIPPED. One row is left and it is the honest one: either a page arrives or it does not.
  "THE BRAIN",
]
const N = STAGE_LABELS.length

const L_EDITOR = "the editor has no brain of its own"
const L_WEB_TAKING = "a web page is becoming the brain"
const L_LINK_UP = "connected  ·  no brain is thinking yet"
const L_NO_ANSWER = "NOTHING IS ANSWERING  ·  no brain has arrived"
// The way out of a stuck card has to name a route that is actually OPEN. With the LAN socket off
// (ADR 84) the Mac server cannot be reached at all, and since ADR 86/87 a page is the only brain
// there is - so telling the wearer to run a server would send them nowhere.
// Both lines stay under ~75 characters or they wrap onto the next row.
// 21.09 Pavlo, looking at this very card: "I can't see which PIN to enter". The line told a wearer
// to type a PIN the card never showed them. Without it the instruction is unusable and the flow
// stops here, because a page is the only brain there is (ADR 87).
const A_PAGE = "open pavlo-stijn.dev/fly on a computer and enter this lens's PIN"
function pageAdvice(link: BrainLinkView | null): string {
  const pin = link && link.pin ? String(link.pin) : ""
  return pin ? "open pavlo-stijn.dev/fly and enter PIN " + pin : A_PAGE
}
const A_NO_ANSWER = FlyConfig.BRAIN_SOCKET_ENABLED
  ? "run scripts/run_server.sh on the Mac, or open the page with the PIN"
  : A_PAGE
const A_EDITOR = FlyConfig.BRAIN_SOCKET_ENABLED
  ? "the Mac server is the brain in the editor: scripts/run_server.sh"
  : A_PAGE
const BOOT_STUCK_S = 25
// how long the card waits before it offers the way out, when waiting is the only thing left to do
const BOOT_KEY_AFTER_S = 3 // the card has been up this long with no brain and no route left to wait on
const L_SURFACES = "surfaces found, nothing named yet"
const L_LOOKING = "looking for surfaces"
const PROMISE_OK = "THE FLY APPEARS WHEN ITS BRAIN IS READY"
const PROMISE_BAD = "THE FLY CANNOT APPEAR WITHOUT ITS BRAIN"
const PROMISE_SUB = "nothing else moves it: no brain, no fly"

interface Stage {
  state: number
  result: string // what the row says once it is settled (drawn into the batched mesh)
  t: number // seconds this stage has been running
}

/** m:ss for the header's boot age */
function clockOf(secs: number): string {
  const t = Math.max(0, Math.floor(secs))
  const ss = t % 60
  return Math.floor(t / 60) + ":" + (ss < 10 ? "0" : "") + ss
}

/** the fallback reason NativeBrainLink packed into `status` = "socket (<reason>)" */
function socketReason(status: string): string {
  const i = status.indexOf("(")
  return i < 0 ? "" : status.substring(i + 1, status.length - 1)
}

/** true while a native core is comparing its two kernels (ADR 82); never for a page brain */
export function gpuCheckRunning(link: BrainLinkView | null): boolean {
  if (!link || FlyConfig.NATIVE_GPU_CHECK_CHUNKS <= 0) return false
  return !!link.gpuDevice && !link.gpuLost && !link.gpuCheck
}

/** WHERE the brain runs, in a wearer's words (the header used to read "BRAIN native x1 25%"). */
export function brainWhere(link: BrainLinkView | null, msg: any): string {
  if (msg && msg.engine === "web") return "" // the status line already reads BRAIN ON A PAGE; do not echo it
  if (link && link.isNative) return msg && msg.gpu_on ? "NATIVE CORE  ·  GPU" : "NATIVE CORE  ·  CPU"
  if (msg) return "ON THE MAC  ·  OVER WI-FI"
  return "NOT RUNNING YET"
}

/** HOW FAST it thinks: the wall time of one brain step. One step is NATIVE_STEP_MS of fly time. */
export function brainStep(msg: any): string {
  if (!msg || !(msg.wall_ms > 0)) return "--"
  const ms = msg.wall_ms as number
  return ms >= 1000 ? "a thought every " + (ms / 1000).toFixed(1) + " s" : "a thought every " + Math.round(ms) + " ms"
}

/**
 * WHY the strip has something to say: the self-check while it runs, or how much slower the fly's world
 * runs than the wearer's (down to real time). Order matters: the loudest true cause wins.
 */
export function brainWhy(link: BrainLinkView | null, msg: any): string {
  // these land in a Component.Text on a 24 cm strip, which renders far wider per character than the
  // batched MSDF the cards use: keep every one of them under ~44 characters
  if (gpuCheckRunning(link)) return "CHECKING ITSELF TWICE  ·  hence the stutter"
  if (msg && msg.engine === "web") return "" // 21.09 Pavlo: the explaining strip is noise on the live board; the "?" card has it
  if (!msg) return "waiting for the brain"
  // ADR 83: the ratio is the honest headline. On a slow host the fly's clock really does run many
  // times slower than the wearer's, and that is the model, not a bug. Rounded, because it moves.
  const slow = msg.wall_ms > 0 ? Math.round(msg.wall_ms / FlyConfig.NATIVE_STEP_MS) : 0
  return slow > 1 ? "the fly's world runs " + slow + "x slower than yours"
    : "the fly is thinking in real time"
}

/** The raw brain numbers, for the "?" card. Nobody has to read this to use the lens (ADR 84). */
export function brainNumbers(link: BrainLinkView | null): string {
  // ONE line on a 24 cm card, so it is terse on purpose. Since ADR 87 the brain is a page and the
  // line stays empty.
  return link && link.isNative ? "native core, no load policy" : ""
}

export class FlyBoot {
  readonly root: SceneObject
  private ui: QuadSink
  private tb: TextBatch | null
  private still: Still
  private fit: (s: string, x: number, y: number, scale: number, color: vec4, maxCm: number,
                opt?: { align?: "L" | "R" | "C"; lineCm?: number; min?: number }) => number
  private lamps: number[] = []
  private sweepTrack = -1
  private sweepFill = -1
  private num: Text // the running stage's live number, at that row
  private clock: Text // how long the lens has been awake
  private bigUrl!: Text
  private bigPin!: Text
  private key: { so: SceneObject; quads: number[]; flash?: () => void } | null = null
  private keyOn = false
  private stages: Stage[] = []
  private lastLamp: number[] = []
  private lastState: number[] = []
  private failedStage = -1
  private failAction = A_NO_ANSWER // the one thing to DO, shown at the foot of the card when it fails
  private skipEditor = false
  private L = 0
  private R = 0
  private top = 0
  private accent: vec4
  private shown = false
  private cardT = 0
  private age = 0
  private hold = -1 // >= 0: the beat between the last stage landing and the dashboard opening
  private forced = false
  private lastSweep = -99
  private numStr = ""
  private numRow = -1
  private numVal = -1
  private clockSec = -1
  private dirty = true
  private scanS = 0
  private scanN = -1
  private scanSurf = false
  private scanSec = -1

  constructor(parent: SceneObject, quad: RenderMesh, neon: Material, batchMat: Material | null,
              mkText: MkText, mkButton: MkButton, mkBatch: MkBatch, accent: vec4) {
    this.accent = accent
    this.root = global.scene.createSceneObject("FlyBoot")
    this.root.setParent(parent)
    this.root.getTransform().setLocalPosition(new vec3(0, 0, 0.4))
    const r = this.root
    this.ui = batchMat ? new NeonBatch(r, batchMat, "BootNeon") : new NeonQuadSet(r, quad, neon, "BootNeon")
    const ui = this.ui
    this.tb = mkBatch(r, "BootText")
    this.still = stillText(this.tb, mkText, r)
    this.fit = fitText(this.tb, this.still, (m: string) => log.w(m))
    const W = CARD_W, H = CARD_H
    this.top = H / 2
    this.L = -W / 2 + 1.5
    this.R = W / 2 - 1.5
    ui.add(0, 0, -0.6, W, H, PLATE, FlyConfig.BOARD_PLATE, 2)
    addFrame(ui, 0, 0, W, H, FRAME, accent)
    ui.add(0, this.top - 3.2, 0, W - 2, 0.16, FRAME, 0.6, 2)
    ui.add(0, this.top - 25.9, 0, W - 2, 0.16, FRAME, 0.4, 2) // under the last row
    // one lamp per stage: the whole state of a row in one quad, in the board's own neon
    for (let i = 0; i < N; i++) {
      this.stages.push({ state: PENDING, result: "", t: 0 })
      this.lamps.push(ui.add(this.L + 0.55, this.rowY(i), 0, 0.9, 0.9, TXT2, 0.22, 2))
      this.lastLamp.push(-1)
      this.lastState.push(-1)
    }
    // the running row's own sweep: law 3, the stage that is working must never look frozen. Two quads
    // moved to whichever row runs, on the same 0.4 Hz the start and scan cards breathe at.
    this.sweepTrack = ui.add(0, 0, 0, 22, 0.22, FRAME, 0.16, 2)
    this.sweepFill = ui.add(0, 0, 0.05, 5.5, 0.22, accent, 1.3, 2)
    ui.set(this.sweepTrack, { visible: false })
    ui.set(this.sweepFill, { visible: false })
    // the way out when the brain never arrives (ADR 84): built now, hidden, so its quads join the
    // batch before the first flush. It never makes a fly appear — ADR 78 still owns that.
    const k = mkButton(r, "BootAnyway", 0, KEY_Y, 24, 3.8, () => { this.forced = true }, ui)
    this.key = { so: k.so, quads: k.quads, flash: k.flash }
    k.so.enabled = false
    for (const q of k.quads) ui.set(q, { visible: false })
    // the two texts that move on a clock stay OUT of the mesh (the guide learnt this the hard way:
    // a passing second must never rebuild several hundred glyphs)
    this.clock = mkText(r, "", this.R, this.top - 2.35, T_CAPTION, accent, { align: "R", mono: true })
    this.num = mkText(r, "", this.R, this.rowY(0), T_LABEL, accent, { align: "R", mono: true })
    this.num.getSceneObject().enabled = false
    // 21.09 Pavlo: "адресу сайту і PIN великими" -- the empty middle of the card carries the two things a
    // wearer has to act on, big enough to read across the room; hidden once a page has the brain
    this.bigUrl = mkText(r, "pavlo-stijn.dev/fly", 0, this.top - 19.0, 1.05, WHITE, { align: "C" })
    this.bigPin = mkText(r, "", 0, this.top - 23.2, 2.0, accent, { align: "C", mono: true })
    this.bigUrl.getSceneObject().enabled = false
    this.bigPin.getSceneObject().enabled = false
    this.rebuild()
    this.dirty = false
    ui.flush()
    r.enabled = false
  }

  private rowY(i: number): number {
    return this.top - ROW_TOP - i * ROW_PITCH
  }

  /** the whole static text of the card, coloured for the stage states: one mesh, rebuilt on a change */
  private rebuild() {
    const tb = this.tb
    if (tb) tb.begin()
    const st = this.still
    const L = this.L
    const top = this.top
    const failed = this.failedStage >= 0
    st("THE FLY'S BRAIN  //  WAKING UP", L, top - 2.35, T_CAPTION, TXT2)
    for (let i = 0; i < N; i++) {
      const s = this.stages[i]
      const y = this.rowY(i)
      const c = s.state === RUNNING ? WHITE : s.state === DONE ? TXT : s.state === FAILED ? OFF : s.state === SKIPPED ? DIM : TXT2
      st(STAGE_LABELS[i], L + TEXT_DX, y, T_LABEL, c)
      if (s.result) {
        this.fit(s.result, L + TEXT_DX, y - SUB_DY, T_SMALL,
          s.state === FAILED ? OFF : s.state === RUNNING ? TXT : TXT2, CARD_W - 3.0 - TEXT_DX,
          { lineCm: 1.2, min: T_SMALL })
      }
    }
    // the one thing a wearer has to understand about the wait, and — when it will not come — the one
    // thing they can do about it. The key under it is the way out, never a way to a fly (ADR 78).
    st(failed ? PROMISE_BAD : PROMISE_OK, L, top - 27.1, T_CAPTION, failed ? OFF : TXT)
    this.fit(failed ? this.failAction : PROMISE_SUB, L, top - 28.5, T_SMALL, failed ? TXT : TXT2,
      CARD_W - 3.0, { lineCm: 1.2, min: T_SMALL })
    if (this.keyOn) st("OPEN THE DASHBOARD ANYWAY", 0, KEY_Y, T_KEY, WHITE, "C", 1.5)
    if (tb) tb.flush()
  }

  show(delay = 0) {
    if (this.shown) return
    this.shown = true
    this.root.enabled = true
    this.cardT = 0
    log.i("DEBUG_STATE_ENTER boot_panel age=" + this.age.toFixed(1) + "s")
    Anim.popIn("boot.card", this.root.getTransform(), 0.45, 1.2, delay)
  }

  hide() {
    if (!this.shown) return
    this.shown = false
    Anim.slipOut("boot.card", this.root.getTransform(), 0.25, () => { this.root.enabled = false })
  }

  get visible(): boolean {
    return this.shown
  }

  /** the dashboard may open: a brain is stepping (and the last row has been read), or the wearer said so */
  get done(): boolean {
    return this.forced || (this.hold >= 0 && this.hold <= 0)
  }

  /** the stage that failed, for the board's own status line ("" = nothing has failed) */
  get failure(): string {
    return this.failedStage >= 0 ? this.stages[this.failedStage].result : ""
  }

  private set(i: number, state: number, result: string) {
    const s = this.stages[i]
    if (s.state === state && s.result === result) return
    s.state = state
    s.result = result
    if (state === FAILED) this.failedStage = i
    else if (this.failedStage === i) this.failedStage = -1
    this.dirty = true
  }

  /** latched from the board: the start choice */
  session(multi: boolean) {
    this.set(0, DONE, multi ? "COLOCATED  ·  yours and other people's flies" : "SOLO  ·  just you and the fly")
  }

  /** the scan card's own numbers, forwarded while it is up */
  scan(seconds: number, found: number, surfaces: boolean) {
    this.scanS = seconds
    this.scanN = found
    this.scanSurf = surfaces
  }

  /** DONE SCANNING: the room stage is finished, whatever it found */
  scanDone() {
    if (this.stages[1].state === DONE) return
    this.set(1, DONE, this.scanN > 0 ? this.scanN + " things named in " + Math.round(this.scanS) + " s"
      : "nothing named  ·  the fly uses the room's shape alone")
  }

  /**
   * Every frame, whether or not the card is on screen — the stage clocks have to start when the lens
   * does, not when DONE SCANNING is pressed. `on` drives only the drawing.
   */
  tick(dt: number, link: BrainLinkView | null, msg: any, linkOk: boolean, on: boolean) {
    this.age += dt
    const status = link && typeof link.status === "string" ? link.status : ""
    const native = !!(link && link.isNative)
    const socket = status.indexOf("socket") === 0
    const web = !!(link && link.webActive)

    // --- 2 THE ROOM ------------------------------------------------------------------------------
    // the only row whose words change on a clock while it runs: rebuilt on the second, not the frame
    if (this.stages[1].state !== DONE) {
      const sec = Math.floor(this.scanS)
      if (sec !== this.scanSec) {
        this.scanSec = sec
        const what = this.scanN > 0 ? this.scanN + (this.scanN === 1 ? " thing named" : " things named")
          : this.scanSurf ? L_SURFACES : L_LOOKING
        this.set(1, this.scanS > 0 ? RUNNING : PENDING, sec + " s  ·  " + what)
      }
    }

    // --- 3 THE BRAIN --------------------------------------------------------------------------
    // A page is the only thing that can think for this fly (ADR 87). Three states, no more: a page
    // has taken it, a page is taking it, or nothing has answered yet.
    if (msg) {
      if (this.stages[2].state !== DONE) {
        this.set(2, DONE, brainWhere(link, msg) + "  ·  " + brainStep(msg))
        this.hold = 0.9 // one beat, so the row is read before the card leaves
        log.i("DEBUG_STATE_READY boot_panel a brain is stepping at " + this.age.toFixed(1) + "s")
      }
    } else if (web) {
      this.set(2, RUNNING, L_WEB_TAKING)
      if (this.bigPin.text !== "") { this.bigPin.text = ""; this.bigPin.getSceneObject().enabled = false; this.bigUrl.getSceneObject().enabled = false }
    }
    else if (this.stages[2].state !== FAILED) {
      // The row that is WAITING is the row that must say what to wait on. A wearer cannot type a
      // PIN they were never shown, and this is the only screen that knows it.
      const pin = link && link.pin ? String(link.pin) : ""
      this.set(2, PENDING, pin ? "PIN " + pin + "  \u00b7  open the page and enter it" : linkOk ? L_LINK_UP : "")
      const big = pin ? "PIN " + pin : ""
      if (this.bigPin.text !== big) { this.bigPin.text = big; this.bigPin.getSceneObject().enabled = big !== ""; this.bigUrl.getSceneObject().enabled = big !== "" }
    }
    if (this.hold > 0) this.hold = Math.max(0, this.hold - dt)

    if (!on) return
    this.cardT += dt
    // A card that can only ever wait is a dead end (ADR 84 D). When there is no core coming — the
    // editor preview, NATIVE_ENABLED off, a failed download — the only brain left is the Mac or a
    // page, and neither may ever arrive. Say that, and put the way out on screen.
    // (a FAILED download already put the key on screen and already says everything)
    if (this.stages[2].state === PENDING && this.cardT > BOOT_STUCK_S) {
      this.failAction = this.skipEditor ? A_EDITOR : FlyConfig.BRAIN_SOCKET_ENABLED ? A_NO_ANSWER : pageAdvice(link)
      this.set(2, FAILED, L_NO_ANSWER)
    }
    if (this.dirty) {
      this.dirty = false
      this.rebuild()
    }
    this.draw()
  }

  private gpuWords(raw: string): string {
    try {
      const c = JSON.parse(raw)
      const cpu = typeof c.cpu_ms === "number" ? c.cpu_ms : 0
      const gpu = typeof c.gpu_ms === "number" ? c.gpu_ms : 0
      const diff = typeof c.cells_diff === "number" ? c.cells_diff : -1
      const same = diff === 0 ? "identical, cell for cell" : diff > 0 ? diff + " cells differ: the CPU keeps it" : "compared"
      if (cpu > 0 && gpu > 0) return "GPU " + (gpu / 1000).toFixed(1) + " s vs CPU " + (cpu / 1000).toFixed(1) + " s  ·  " + same
      return same
    } catch (e) {
      return "compared"
    }
  }

  /** the lamps, the running row's sweep, its live number and the header clock */
  private draw() {
    const ui = this.ui
    // law 3: the running lamp breathes; everything else rests at its state's level. Quantised, so
    // most frames mark nothing dirty and the batch skips its upload entirely.
    const breath = Math.round((1.0 + 0.5 * Math.sin(this.cardT * 2.2)) * 20) / 20
    let run = -1
    for (let i = 0; i < N; i++) {
      const s = this.stages[i]
      if (s.state === RUNNING) run = i
      const k = s.state === RUNNING ? breath * 1.4 : s.state === DONE ? 1.0 : s.state === FAILED ? 1.5 : s.state === SKIPPED ? 0.12 : 0.22
      // the STATE is part of the cache key: a running lamp's breath sweeps a range that could sit on
      // a settled level, and then a row that went done would have kept the accent colour
      if (k === this.lastLamp[i] && s.state === this.lastState[i]) continue
      this.lastLamp[i] = k
      this.lastState[i] = s.state
      ui.set(this.lamps[i], {
        intensity: k,
        color: s.state === DONE ? LIVE : s.state === FAILED ? OFF : s.state === RUNNING ? this.accent : TXT2,
      })
    }
    // the sweep rides the row that is working; nothing running = nothing sweeping
    if (run < 0) {
      if (this.lastSweep !== -99) {
        this.lastSweep = -99
        ui.set(this.sweepTrack, { visible: false })
        ui.set(this.sweepFill, { visible: false })
      }
    } else {
      const y = this.rowY(run) - SUB_DY - 0.95
      const ph = 0.5 - 0.5 * Math.cos(this.cardT * Math.PI * 2 * 0.4)
      const x = Math.round((this.L + TEXT_DX + 16.0 * ph) * 20) / 20
      if (x !== this.lastSweep) {
        this.lastSweep = x
        ui.set(this.sweepTrack, { visible: true, x: this.L + TEXT_DX + 11.0, y: y })
        ui.set(this.sweepFill, { visible: true, x: x, y: y })
      }
    }
    // the live number of the running stage, at that row (one Text, moved: six would be six draws)
    const v = run < 0 ? -1 : run === 1 ? Math.floor(this.scanS) : Math.floor(this.stages[run].t)
    if (run !== this.numRow) {
      this.numRow = run
      if (run >= 0) this.num.getTransform().setLocalPosition(new vec3(this.R, this.rowY(run) - 0.3, 0.3))
      if (this.num.getSceneObject().enabled !== (run >= 0)) this.num.getSceneObject().enabled = run >= 0
      this.numVal = -1
    }
    if (v !== this.numVal) {
      this.numVal = v
      const s = v < 0 ? "" : v + " s"
      if (s !== this.numStr) {
        this.numStr = s
        this.num.text = s
      }
    }
    const sec = Math.floor(this.age)
    if (sec !== this.clockSec) {
      this.clockSec = sec
      this.clock.text = clockOf(this.age)
    }
    // 21.09: the way out used to appear ONLY after a stage failed, i.e. after the 25 s watchdog.
    // That was right while the lens carried its own brain: waiting meant something was coming. Since
    // ADR 87 it does not. The only brain is a page someone has to open, so "no brain yet" is the
    // ORDINARY state, not a failure, and making a wearer watch a card for 25 seconds before they may
    // even open the board is a regression the native cut introduced and nobody noticed. The key now
    // appears as soon as waiting is all that is left: the room is behind us and no brain has landed.
    const onlyWaiting = this.stages[2].state === PENDING && this.stages[1].state === DONE && this.cardT > BOOT_KEY_AFTER_S
    const wantKey = this.failedStage >= 0 || onlyWaiting
    if (wantKey !== this.keyOn && this.key) {
      this.keyOn = wantKey
      // 21.09: the LABEL on this key lives in the batched text mesh, which is only rebuilt when the
      // card is marked dirty. The key used to appear only together with a FAILURE, and the failure
      // changed the promise text as well, so a rebuild happened by luck. Now the key can appear on
      // its own (3 s after the room is done) and nothing else changes -- so the plate drew and the
      // words did not. Pavlo, twice: "what's on this panel with the button?"
      this.dirty = true
      this.key.so.enabled = wantKey
      for (const q of this.key.quads) ui.set(q, { visible: wantKey })
      if (wantKey && this.key.flash) this.key.flash()
    }
    ui.flush()
  }
}
