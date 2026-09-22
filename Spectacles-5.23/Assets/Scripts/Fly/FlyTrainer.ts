/**
 * FlyTrainer — the original conditioning protocols, run in the room (ADR 62/65/66, extends 14/48).
 *
 * The brain the lens carries runs the plasticity rule of Huang, Luo et al. 2024 (Nature 634:1141,
 * doi 10.1038/s41586-024-07819-w) on the real MaleCNS KC->MBON synapses: `rule.py` in fly-wirehead
 * and `plasticity()` in flybrain.cpp are that paper's appendix equations 3.2-3.5. What neither the
 * paper's code nor fly-wirehead ever shipped is the PROTOCOL that makes a rule into learning: the
 * trial structure. This class is that structure, and seven ways to use it.
 *
 * Every mode is one PLAN — a flat list of presentations built when the session starts — so the tick
 * has no session logic and a new protocol is a new plan, not a new state machine.
 *
 *   food      thing -> reward.   probe +/- , N x (paired CS+ , unpaired CS-) , probe +/-
 *   danger    thing -> danger.   the same, with the PPL101 US and a loom the user can see
 *   forget    extinction.        probe + , N x (CS+ , nothing) , probe +   (weights stay FREE)
 *   test      has it learned?    R x (probe + , probe -) with LEARNING OFF: a test may not teach
 *   choice    both things at once, equal lures; which does it reach first; the slot swaps each trial
 *   reset     wipe the memory (FlyMemory.clear, else the link's own `memory` message)
 *   transfer  test what was LOADED at start, so the guide can say what the fly still remembers
 *
 * The AR mapping (every approximation is disclosed in ADR 62):
 *   CS   a thing in the room the user names (ASK / Gemini, ADR 27). Its lure feeds the `odor` and
 *        `object` channels for THIS fly only, plus the thing's OWN glomerulus (ADR 65).
 *   US   food   -> `pulse "reward"` = 20 mV into the 15 PAM11 cells;
 *        danger -> `pulse "punish"` = 20 mV into the 2 PPL101 cells, plus a real loom.
 *        PAM11/PPL101 are modulatory: the kernel delivers no synaptic current from them, so a pulse
 *        moves NOTHING except through the rule. With learning off the US is inert.
 *   test the paper measured turning toward the odour on a trackball. We measure the same steering
 *        (`act.steer` toward the CS side) plus the two things AR adds: did it go, and how long.
 *
 * It owns no motion. The fly may refuse every bout (ADR 01) and that is recorded as a MISS.
 * Logs one `TRAIN_TRIAL` row per presentation and one `TRAIN_DONE` at the end.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { BrainMsg } from "./BrainLink"
import { FlyConfig } from "./FlyConfig"
import { FlyPose, Source, labelOdour } from "./WorldSources"
import { TrainVerdict, askVerdict } from "./FlyVerdict"

const log = new NativeLogger("FlyTrainer")

export type TrainMode = "lesson" | "food" | "danger" | "forget" | "test" | "choice" | "reset" | "transfer"
/** where the session is right now; the guide lights one step per phase */
export type TrainPhase =
  "off" | "menu" | "pick" | "probe0" | "bout" | "us" | "csminus" | "choice" | "iti" | "probe1" | "done"

/** the modes, in the order the picker shows them: [key, label, one line of what it does] */
/** the first key, above the grid: the way in for someone who has never taught anything */
export const TRAIN_LESSON: [TrainMode, string, string] =
  ["lesson", "FIRST LESSON  ·  5 MIN", "the whole thing once, step by step, nothing to know first"]

export const TRAIN_MODES: [TrainMode, string, string][] = [
  ["food", "FOOD", "the thing means food: reward on arrival"],
  ["danger", "DANGER", "the thing means danger: a loom and stress dopamine"],
  ["forget", "FORGET", "the thing, over and over, paying nothing"],
  ["test", "TEST", "has it learned? no reward, no weight moves"],
  ["choice", "CHOICE", "both things at once: which one does it pick"],
  ["transfer", "TRANSFER", "what does it still remember from before"],
  ["reset", "RESET", "wipe every synapse back to naive"],
]

/**
 * The eight steps of the first lesson (ADR 69). Plain words, one action each, and they live HERE —
 * the guide renders them and the page renders them, from the same `TrainState.lesson` block, so the
 * two can never drift apart. `<cue>` / `<control>` are filled in with the things actually chosen.
 */
/**
 * The first lesson (ADR 69/71): nine steps, and at every one the person chooses what happens next.
 * Plain words, one sentence each, and the consequence is always visible before the choice is made.
 * The strings and the tree live HERE — the guide renders them and the page renders them from the
 * same `TrainState.lesson`, so the two can never drift apart.
 */
type Opt = { key: string; label: string; hint: string }
const LESSON_STEPS = 9

/** the lesson's own line on the card and on the page */
export type LessonState = {
  step: number
  of: number
  title: string
  line: string
  action: string
  /** what the person may choose right now (max 3); empty while the lesson is just running */
  options: Opt[]
  /** what they chose at this step, echoed so the lens and the page stay in step */
  chosen: string
}

/** What the guide card and the web page show. Diff-cached: it changes a few times a session. */
export type TrainState = {
  mode: TrainMode
  trial: number // 1-based presentation number, 0 before training starts
  ofTrials: number
  phase: TrainPhase
  step: number // 1..4, which instruction line the guide lights
  instruction: string // the live line (the only per-frame string on the card)
  result: string // filled at `done`
  label: string // the CS+ thing
  labelMinus: string // the unpaired CS-, "" when the room had only one thing
  biasBefore: number
  biasAfter: number
  efficacy: number
  /** ADR 73: seconds since the session started, and the board's one-line banner. A session has to
   *  have a visible beginning and a visible end — Pavlo: "unclear when it started and when it ended" */
  elapsed: number
  banner: string
  /** ADR 69: the first lesson's current step, null when no lesson is running */
  lesson: LessonState | null
}

/** What FlyTrainer needs from FlySwarm. FlySwarm owns the one lure slot and the link. */
export interface TrainHost {
  fly(): number
  pose(fly: number): FlyPose
  msg(fly: number): BrainMsg | null
  /** the ONE lure slot (FlySwarm.lure): setting it removes whatever was there */
  lure(): Source | null
  setLure(s: Source | null): void
  /** everything the room scan knows, minus hands, head, lures and flies */
  things(): Source[]
  addLure(label: string, pos: vec3, fly: number): Source
  /** remove a source the trainer made that never went into the one lure slot (CHOICE's second cue) */
  dropLure(s: Source): void
  pulse(fly: number, kind: "reward" | "punish"): void
  /**
   * ADR 88: make the fly food-deprived, because appetitive conditioning on a sated animal is not a
   * weak experiment, it is no experiment. A fly looks for food only below FOOD_HUNGRY, so a fly at
   * full energy ignores the cue entirely -- measured: 16 trials, every latency MISS, zero rewards
   * delivered, nothing to pair. Real protocols starve the animal before an appetitive session; this
   * is that step, and it is disclosed here and in the log rather than hidden in the motion.
   */
  starve(fly: number): void
  setLearning(fly: number, on: boolean): void
  /** what plasticity is doing right now, so a session can put it back as it found it */
  learning?(fly: number): boolean
  /** the aversive US the user can SEE: a threat that rushes the fly */
  loom(fly: number, on: boolean): void
  landed(fly: number): Source | null
  /** wipe the plastic state (FlyMemory.clear, else the link's own memory message) */
  memoryClear(): void
  /** ADR 71: the lesson's "save this brain" — keep the version the session just made */
  memorySave(): void
  /** what was restored at start, for TRANSFER: null = no memory custodian in this build */
  memoryStatus(): { armed: boolean; changed: number; efficacy: number; ageS: number } | null
  /** ADR 68: is a web page the brain right now, and what PIN would open it */
  pageOn(): boolean
  pin(): string
  /** ADR 68: a finished session's evidence pack + Gemini's reading, for the feed and the history */
  summary(pack: any, v: TrainVerdict): void
  /** what past sessions said, newest first — TRANSFER quotes them */
  history(): any[]
}

/** one presentation's measurements */
type Bout = {
  cs: "+" | "-"
  n: number
  lat: number // seconds from CS on to arrival, -1 = never arrived
  d0: number // distance to the CS when it came on
  dmin: number
  bias: number // -1..1: share of samples steering TOWARD the CS, minus those steering away
  kc: number // regions.mushroom Hz (does the cue reach the mushroom body at all?)
  mbon7: number // MBON07 Hz: the PAM11/appetitive compartment's OUTPUT (ADR 65)
  mbon11: number // MBON11 Hz: the PPL101/aversive one
  eff: number // memory.mean_efficacy at the end of the presentation
  chg: number
  effOn: number // ADR 67: efficacy of the synapses THIS cue drives — the cue-specific memory
  nOn: number
  us: number // US pulses actually delivered
  won: string // CHOICE only: "+" / "-" / "" if it reached neither
  d0b: number // CHOICE only: how far the OTHER cue was when the trial began
  learn: string // "on" | "off" | "none": was plasticity live? a frozen session is not a result
}

/** one presentation in the session's plan */
type Step = { phase: TrainPhase; cs: "+" | "-"; n: number }

const fmt = (x: number, n: number) => (isFinite(x) ? x.toFixed(n) : "-")
const nz = (x: number) => (isFinite(x) ? Math.round(x * 1e5) / 1e5 : null)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

export class FlyTrainer {
  state: TrainState = {
    mode: "food", trial: 0, ofTrials: 0, phase: "off",
    step: 1, instruction: "", result: "", label: "", labelMinus: "",
    biasBefore: NaN, biasAfter: NaN, efficacy: 1, elapsed: 0, banner: "", lesson: null,
  }
  /** bumps whenever `state` changed in a way worth redrawing or sending (guide, web page) */
  version = 0
  private fly = 0
  /** plasticity as it was before this session started (ADR 89) */
  private learnWas = FlyConfig.NATIVE_LEARNING
  private csPlus: Source | null = null // the room thing (never our lure)
  private csMinus: Source | null = null
  private csPos = vec3.zero()
  private csPosB = vec3.zero() // CHOICE: the second thing
  private lure: Source | null = null // OUR lure, alive only while a CS is on
  private lureB: Source | null = null // CHOICE: the second lure
  private t = 0 // seconds in the current phase
  private sim0 = 0 // msg.sim_ms at CS onset: the brain's own clock, not ours
  private cur: Bout | null = null
  private rows: Bout[] = []
  private plan: Step[] = []
  private at = -1
  private sampleT = 0
  private toward = 0
  private away = 0
  private kcSum = 0
  private kcN = 0
  private m7Sum = 0
  private m11Sum = 0
  private mN = 0 // a brain file exported before ADR 65 carries no MBON readout: then this stays 0
  private usLeft = 0
  private usT = 0
  private arrivedSim = -1
  private effStart = 1
  private chgStart = 0
  private learnRestore = false // TEST / CHOICE froze the weights and must hand them back
  private csOdour = -1 // which glomerulus each cue smells of (ADR 65)
  private csOdourMinus = -1
  private movedOdour = false
  private engine = "" // which core answered last (ADR 68)
  private sessionT = 0
  private shownSecs = -1
  private doneAt = -1 // sessionT when the verdict landed, for the board banner's 20 s

  constructor(private host: TrainHost, private editor: boolean) {}

  get running(): boolean {
    return this.state.phase !== "off"
  }

  /**
   * ADR 68: teaching only runs while a web page is the brain. On the glasses alone a 50 ms brain
   * step costs 1-2 s of the user's, so six bouts is an hour of standing still and every probe reads
   * a fly that has barely thought — the session would produce numbers that mean nothing. ONE gate,
   * read by the board's key, by the guide's picker and by every entry point here.
   */
  available(): boolean {
    return !FlyConfig.TRAIN_WEB_ONLY || this.host.pageOn()
  }

  /** why not, for the key's caption */
  unavailableReason(): string {
    return FlyConfig.TRAIN_NEEDS_PAGE_MSG + this.host.pin()
  }

  /** ADR 88: an appetitive session needs a hungry fly, or the cue means nothing to it */
  private appetitive(m: TrainMode): boolean {
    return m === "food" || m === "lesson" || m === "choice" || m === "test" || m === "transfer"
  }

  /** does this mode move synapses? TEST and CHOICE must not: a measurement may not teach. */
  private static teaches(m: TrainMode): boolean {
    return m === "lesson" || m === "food" || m === "danger" || m === "forget"
  }

  /** the board's TEACH THE FLY key: open the picker. `off` abandons whatever is running. */
  setOn(on: boolean, fly: number) {
    if (!on) {
      this.stop("key_off") // the board's TEACH key, or whoever calls setOn(false)
      return
    }
    if (this.running) return
    if (!this.available()) {
      log.i("TRAIN_UNAVAILABLE reason=no_page pin=" + this.host.pin())
      this.state.instruction = this.unavailableReason()
      this.bump()
      return
    }
    this.fly = fly
    this.clearSession()
    this.enter("menu", 1)
    this.state.instruction = "PICK WHAT TO TEACH"
    log.i("TRAIN_MENU fly=" + fly)
    // ADR 69: never taught anything? The picker is seven questions someone cannot answer yet — go
    // straight into the lesson, which is the answer to all of them.
    const st = this.host.memoryStatus()
    const taught = this.host.history().length > 0 || (st ? st.changed > 0 : false)
    // 21.09: a fly that had never been taught used to be dragged straight into the nine-step
    // lesson. It teaches itself now, so the picker simply opens and nobody is marched through a
    // tutorial they did not ask for.
    if (!taught && FlyConfig.LESSON_ENABLED) {
      log.i("TRAIN_LESSON_FIRST fly=" + fly + " (nothing taught before)")
      this.choose("lesson")
    }
  }

  /** a key on the guide's picker. RESET acts at once; everything else opens a session. */
  choose(mode: TrainMode) {
    if (this.state.phase !== "menu") return
    if (!this.available()) {
      log.i("TRAIN_UNAVAILABLE reason=no_page mode=" + mode)
      return
    }
    this.state.mode = mode
    if (mode === "reset") {
      const st = this.host.memoryStatus()
      this.host.memoryClear()
      log.i("TRAIN_RESET fly=" + this.fly + " had=" + (st ? st.changed + " synapses, x" + fmt(st.efficacy, 4) : "unknown"))
      this.state.result = "MEMORY WIPED" + (st ? "  //  " + st.changed + " SYNAPSES HAD MOVED" : "")
      this.state.phase = "done"
      this.state.step = 4
      this.state.instruction = "IT IS NAIVE AGAIN"
      this.bump()
      return
    }
    this.state.ofTrials = this.boutCount(mode)
    this.sessionT = 0
    this.shownSecs = -1
    this.doneAt = -1
    // remember what plasticity was doing before this session, so stopping can put it back
    this.learnWas = this.host.learning ? this.host.learning(this.fly) : FlyConfig.NATIVE_LEARNING
    if (FlyTrainer.teaches(mode)) this.host.setLearning(this.fly, true)
    else {
      // a test may not teach: freeze the weights for its duration and hand them back after
      this.host.setLearning(this.fly, false)
      this.learnRestore = true
    }
    if (mode === "lesson") {
      this.lessonStep = 1
      this.lessonAwait = true
      this.lessonPick = {}
      this.lessonThing = null
    }
    this.enter("pick", 1)
    // ADR 88: a sated fly will not go to the cue, so an appetitive session starts by making it
    // hungry -- the same step a real protocol takes, and said out loud rather than done quietly.
    if (this.appetitive(mode)) {
      this.host.starve(this.fly)
      log.i("TRAIN_STARVE fly=" + this.fly + " (appetitive session: a sated fly ignores the cue)")
    }
    log.i("TRAIN_START fly=" + this.fly + " mode=" + mode + " (" + FlyTrainer.science(mode) + ") bouts=" + this.state.ofTrials)
  }

  private static science(m: TrainMode): string {
    return m === "lesson" ? "appetitive conditioning, guided" : m === "food" ? "appetitive conditioning" : m === "danger" ? "aversive conditioning"
      : m === "forget" ? "extinction" : m === "choice" ? "two-alternative choice"
      : m === "transfer" ? "retention test of a restored memory" : "unrewarded test"
  }

  private boutCount(m: TrainMode): number {
    if (m === "lesson") return FlyConfig.TRAIN_LESSON_BOUTS // the same however it is run: a lesson is a lesson
    if (m === "test" || m === "transfer") return this.editor ? 1 : FlyConfig.TRAIN_TEST_REPEATS
    return this.editor ? FlyConfig.TRAIN_BOUTS_EDITOR : FlyConfig.TRAIN_BOUTS
  }

  /**
   * ADR 68: the page drives a session. One entry point for every `{t:"cmd"}` the relay carries, so
   * the page and the guide's picker go through exactly the same code — a session started from a
   * laptop is the same session, logged the same way.
   */
  command(c: any): void {
    if (!c || !c.cmd) return
    const cmd = "" + c.cmd
    log.i("TRAIN_CMD " + cmd + (c.mode ? " mode=" + c.mode : "") + (c.cs ? " cs='" + c.cs + "'" : ""))
    if (cmd === "train_stop") {
      this.stop("page_stop")
      return
    }
    if (cmd === "reset") {
      this.host.memoryClear()
      log.i("TRAIN_RESET fly=" + this.fly + " by=page")
      return
    }
    if (cmd !== "train") return
    if (!this.available()) {
      log.i("TRAIN_UNAVAILABLE reason=no_page by=page")
      return
    }
    if (this.running) this.stop("replaced") // a new order replaces whatever was running
    this.setOn(true, this.host.fly())
    // 21.09: normalise the case. TrainMode is lowercase everywhere inside the lens, but the page
    // sends whatever its picker holds, which is upper case ("FOOD"). An unnormalised value matched
    // nothing in the mode switches and only appeared to work; it also leaked into the evidence pack
    // and into the guide's words. The lens does not get to trust the page's spelling.
    const mode = ("" + (c.mode || "food")).toLowerCase() as TrainMode
    // 21.09: an EXPLICIT order from the page outranks the automatic lesson. `setOn` sends a fly that
    // has never been taught straight into the lesson (ADR 69), which leaves the phase somewhere other
    // than "menu" -- and this used to `return` there, with nothing in the log. A naive fly is the
    // NORMAL case and the page is the intended driver (ADR 68), so the page's START button did
    // nothing, silently, for exactly the flies it was most likely to be pressed on. Reproduced end to
    // end on 21.09: the page took the brain (WEB_BRAIN_ON), sent `cmd train`, and no TRAIN_START ever
    // followed. If the page asked for the lesson itself, let the lesson stand.
    if (this.state.phase !== "menu") {
      if (mode === "lesson") return // the page asked for the lesson and setOn already started it
      log.i("TRAIN_OVERRIDE fly=" + this.fly + " was=" + this.state.phase + " -> " + mode + " by=page")
      this.enter("menu", 1)
    }
    this.state.mode = mode
    if (mode === "reset") {
      this.choose("reset")
      return
    }
    this.choose(mode)
    if (typeof c.bouts === "number" && c.bouts >= 1) this.state.ofTrials = Math.min(24, Math.round(c.bouts))
    // the page names the things by label; the cue must be something the room actually knows
    const things = this.host.things()
    const find = (label: string | undefined) => {
      if (!label) return null
      const want = ("" + label).toLowerCase()
      for (const t of things) if (t.label.toLowerCase() === want) return t
      return null
    }
    const plus = find(c.cs)
    if (!plus) {
      // say what WAS there: the page sends `things` from the same list, so a mismatch is worth seeing
      log.w("TRAIN_CMD no such thing: '" + c.cs + "' — the room knows [" +
        things.map((t) => t.label).join(", ").substr(0, 180) + "]. Waiting for ASK instead")
      return
    }
    const minus = find(c.csMinus)
    this.forcedMinus = minus
    this.offer(plus)
  }
  private forcedMinus: Source | null = null

  /** FlySwarm asks before it fires the landing reward: a probe, a control and every unrewarded mode
   *  must stay unrewarded, and in a paired bout the trainer owns the US timing. */
  noReward(fly: number): boolean {
    return this.running && fly === this.fly
  }

  /** the CS the user named. Called when a lure appears for our fly while we are waiting for one. */
  offer(thing: Source) {
    if (!this.running || this.state.phase !== "pick" || this.csPlus) return
    this.csPlus = thing
    this.csPos = thing.pos
    this.state.label = thing.label
    if (this.forcedMinus && this.forcedMinus !== thing) {
      this.csMinus = this.forcedMinus // the page chose the control itself
      this.state.labelMinus = this.forcedMinus.label
      this.forcedMinus = null
    } else if (FlyConfig.TRAIN_AUTO_CS_MINUS) {
      // the paper gave every fly two attractive odours and shocked only one. The second thing the
      // room knows becomes the unpaired CS-: without it there is no discrimination, only a session.
      let best: Source | null = null
      let bestD = 0
      const head = this.host.pose(this.fly).head
      for (const s of this.host.things()) {
        if (s === thing || s.label === thing.label) continue
        const d = s.pos.distance(head)
        if (!best || d < bestD) {
          best = s
          bestD = d
        }
      }
      this.csMinus = best
      this.state.labelMinus = best ? best.label : ""
    }
    // ADR 65: the cue's smell is a property of the THING's label, and the lure the trainer puts on
    // it is what carries that smell into the brain -- most room things are `object` class and have
    // no odour of their own. A control that smells like the cue is not a control, so when the two
    // labels hash to the same glomerulus the control moves to the least-overlapping one.
    this.csOdour = labelOdour(this.state.label)
    this.csOdourMinus = this.state.labelMinus ? labelOdour(this.state.labelMinus) : -1
    if (FlyConfig.ODOUR_ID && this.csOdourMinus === this.csOdour) {
      this.csOdourMinus = FlyConfig.ODOUR_FAR[this.csOdour] || 0
      this.movedOdour = true
    }
    const smell = (k: number) => (k >= 0 && FlyConfig.ODOUR_ID ? FlyConfig.ODOUR_IDS[k] : "generic")
    log.i("TRAIN_CS fly=" + this.fly + " mode=" + this.state.mode + " cs+='" + this.state.label + "' (" + smell(this.csOdour) + ")" +
      " cs-='" + this.state.labelMinus + "' (" + smell(this.csOdourMinus) + (this.movedOdour ? ", moved apart" : "") + ")")
    const m = this.host.msg(this.fly)
    if (m && m.memory) {
      this.effStart = m.memory.mean_efficacy
      this.chgStart = m.memory.changed
    }
    this.plan = this.build(this.state.mode)
    this.at = -1
    this.next()
  }

  // ---- the plan: one flat list per mode, so the tick has no session logic --------------------

  private build(mode: TrainMode): Step[] {
    const p: Step[] = []
    const n = this.state.ofTrials
    const two = !!this.csMinus
    const probe = (phase: TrainPhase) => {
      p.push({ phase: phase, cs: "+", n: 0 })
      if (two) p.push({ phase: phase, cs: "-", n: 0 })
    }
    if (mode === "lesson" || mode === "food" || mode === "danger") {
      probe("probe0")
      for (let i = 1; i <= n; i++) {
        p.push({ phase: "bout", cs: "+", n: i })
        if (two) p.push({ phase: "csminus", cs: "-", n: i })
      }
      probe("probe1")
    } else if (mode === "forget") {
      // extinction: the cue, over and over, paying nothing. The weights stay FREE -- unlearning is
      // the rule running with the DAN silent, not the rule switched off.
      probe("probe0")
      for (let i = 1; i <= n; i++) p.push({ phase: "bout", cs: "+", n: i })
      probe("probe1")
    } else if (mode === "test" || mode === "transfer") {
      for (let i = 1; i <= n; i++) {
        p.push({ phase: "probe1", cs: "+", n: i })
        if (two) p.push({ phase: "probe1", cs: "-", n: i })
      }
    } else if (mode === "choice") {
      // the slot alternates: whichever cue holds FlySwarm's one lure slot gets the landing gate, so
      // swapping it every trial cancels that advantage the way swapping sides cancels a side bias
      for (let i = 1; i <= n; i++) p.push({ phase: "choice", cs: i % 2 === 1 ? "+" : "-", n: i })
    }
    return p
  }

  // ---- the session ---------------------------------------------------------------------------

  tick(dt: number) {
    if (!this.running) return
    this.t += dt
    if (this.state.phase !== "menu") this.sessionT += dt
    const secs = Math.floor(this.sessionT)
    if (secs !== this.shownSecs) {
      this.shownSecs = secs
      this.state.elapsed = secs
      this.bump() // the clock IS a state change: one mesh rebuild a second while a session runs
    }
    const msg = this.host.msg(this.fly)
    switch (this.state.phase) {
      case "menu":
      case "done":
        return
      case "pick": {
        if (this.state.mode === "lesson") {
          // the wizard: the lesson does not move until the person chooses (ADR 71)
          this.state.instruction = this.lessonAwait ? "CHOOSE ON THE CARD" : "SETTING UP..."
          return
        }
        this.state.instruction = "PRESS ASK AND NAME A THING"
        const l = this.host.lure()
        if (l && (l.forFly < 0 || l.forFly === this.fly)) this.offer(this.thingUnder(l))
        return
      }
      case "probe0":
      case "probe1": {
        this.sample(dt, msg)
        if (!this.cur) return this.next()
        const which = (this.cur.cs === "+" ? this.state.label : this.state.labelMinus).toUpperCase()
        const head = this.state.mode === "test" || this.state.mode === "transfer"
          ? "TEST " + this.cur.n + " / " + this.state.ofTrials + "  "
          : this.state.phase === "probe0" ? "BEFORE  " : "AFTER  "
        this.state.instruction = head + which + "  //  " + fmt(FlyConfig.TRAIN_PROBE_S - this.t, 0) + "s"
        if (this.t >= FlyConfig.TRAIN_PROBE_S) this.endPresentation()
        return
      }
      case "bout": {
        this.sample(dt, msg)
        if (!this.cur) return this.next()
        this.state.instruction = "TRIAL " + this.state.trial + " / " + this.state.ofTrials + "  //  " +
          (this.cur.lat >= 0 ? "IT LANDED" : "WAITING FOR THE LANDING  " + fmt(FlyConfig.TRAIN_BOUT_MAX_S - this.t, 0) + "s")
        if (this.cur.lat >= 0 && this.state.mode === "forget") {
          this.endPresentation() // the cue alone: fly-wirehead's own `--no-video-reward` control
        } else if (this.cur.lat >= 0) {
          // the paper's fixed CS+ -> US interval, counted on the BRAIN's clock, capped in wall time
          const simGap = msg ? msg.sim_ms - this.arrivedSim : 0
          if (simGap >= FlyConfig.TRAIN_US_DELAY_SIM_MS || this.t - this.cur.lat >= FlyConfig.TRAIN_US_DELAY_MAX_S) {
            this.usLeft = FlyConfig.TRAIN_US_PULSES
            this.usT = 0
            this.state.phase = "us"
            this.state.step = 3
            this.bump()
          }
        } else if (this.t >= FlyConfig.TRAIN_BOUT_MAX_S) this.endPresentation() // a MISS: it refused
        return
      }
      case "us": {
        this.sample(dt, msg)
        if (!this.cur) return this.next()
        this.usT += dt
        if (this.state.mode === "danger") this.host.loom(this.fly, true)
        if (this.usT >= FlyConfig.TRAIN_US_PERIOD_S && this.usLeft > 0) {
          this.usT = 0
          this.usLeft--
          this.cur.us++
          this.host.pulse(this.fly, this.state.mode === "danger" ? "punish" : "reward")
        }
        this.state.instruction = (this.state.mode === "danger" ? "DANGER  " : "REWARD  ") +
          (FlyConfig.TRAIN_US_PULSES - this.usLeft) + " / " + FlyConfig.TRAIN_US_PULSES
        if (this.usLeft <= 0) {
          this.host.loom(this.fly, false)
          this.endPresentation()
        }
        return
      }
      case "csminus": {
        this.sample(dt, msg)
        if (!this.cur) return this.next()
        this.state.instruction = "THE OTHER THING, PAYING NOTHING  //  " + fmt(FlyConfig.TRAIN_CS_MINUS_S - this.t, 0) + "s"
        if (this.t >= FlyConfig.TRAIN_CS_MINUS_S) this.endPresentation()
        return
      }
      case "choice": {
        this.sample(dt, msg)
        if (!this.cur) return this.next()
        this.state.instruction = "CHOICE " + this.state.trial + " / " + this.state.ofTrials + "  //  " +
          (this.cur.won
            ? "IT PICKED " + (this.cur.won === "+" ? this.state.label : this.state.labelMinus).toUpperCase()
            : "BOTH ARE OUT  " + fmt(FlyConfig.TRAIN_BOUT_MAX_S - this.t, 0) + "s")
        if (this.cur.won || this.t >= FlyConfig.TRAIN_BOUT_MAX_S) this.endPresentation()
        return
      }
      case "iti":
        this.state.instruction = "AIR  //  " + fmt(FlyConfig.TRAIN_ITI_S - this.t, 0) + "s"
        if (this.t >= FlyConfig.TRAIN_ITI_S) this.next()
        return
    }
  }

  /** ADR 69: the lesson's cue, chosen for the person — the nearest thing the room knows. (It cannot
   *  test for a landing surface from here; the trainer sees labels and positions, not geometry, so
   *  "nearest named thing" is the honest approximation and a miss is still recorded as a miss.) */
  private nearestThing(): Source | null {
    let best: Source | null = null
    let bestD = 0
    const head = this.host.pose(this.fly).head
    for (const s of this.host.things()) {
      const d = s.pos.distance(head)
      if (!best || d < bestD) {
        best = s
        bestD = d
      }
    }
    return best
  }

  /** the room thing a lure sits on: the lure itself is a copy, we want the thing that can move */
  private thingUnder(l: Source): Source {
    let best = l
    let bestD = FlyConfig.TRAIN_NEAR_CM
    for (const s of this.host.things()) {
      const d = s.pos.distance(l.pos)
      if (d < bestD) {
        best = s
        bestD = d
      }
    }
    return best
  }

  private enter(p: TrainPhase, step: number) {
    this.state.phase = p
    this.state.step = step
    this.t = 0
    this.bump()
  }

  /** m:ss */
  private clock(): string {
    const t = Math.max(0, Math.floor(this.sessionT))
    const m = Math.floor(t / 60)
    const ss = t % 60
    return m + ":" + (ss < 10 ? "0" : "") + ss
  }

  /**
   * ADR 73: what the person should be doing or watching RIGHT NOW. It follows the phase, so the
   * card is never a static instruction while the fly is doing its part.
   */
  private liveAction(): string {
    const cue = this.state.label || "the thing"
    const ctl = this.state.labelMinus || "the other thing"
    const show = this.lessonPick["4"] || "hand"
    const c = this.cur
    switch (this.state.phase) {
      case "menu": return "choose a session on the card"
      case "pick": return this.state.mode === "lesson" ? "choose on the card" : "press ASK and name a thing"
      case "probe0":
      case "probe1":
        if (c && c.lat >= 0) return "it reached the " + (c.cs === "+" ? cue : ctl) + " in " + fmt(c.lat, 0) + " s"
        return show === "hand" ? "pick up the " + (c && c.cs === "-" ? ctl : cue) + " and hold still"
          : "stand still and watch it"
      case "bout":
        if (!c) return "watch"
        if (c.lat >= 0) return "it landed — hold still"
        if (c.dmin < FlyConfig.TRAIN_NEAR_CM * 2) return "it is almost there"
        return "it is flying to the " + cue + " — do not help it"
      case "us":
        return this.state.mode === "danger" ? "danger arriving — watch it flee (PPL101)"
          : "reward arriving — watch the brain flash (PAM)"
      case "csminus": return "showing the " + ctl + " — nothing follows this one"
      case "choice": return "both are out — which one does it pick?"
      case "iti": return "air — wait for the next one"
      case "done": return this.verdict ? "learned: " + this.verdict.learned : "reading the numbers..."
    }
    return ""
  }

  /** the board's one line, in the accent colour: a session must be visible from the dashboard */
  private bannerLine(): string {
    const mode = this.state.mode.toUpperCase()
    if (this.state.phase === "done") {
      if (this.doneAt >= 0 && this.sessionT - this.doneAt > FlyConfig.TRAIN_DONE_BANNER_S) return ""
      const v = this.verdict
      const word = !v ? "..." : v.learned === "yes" ? "LEARNED" : v.learned === "no" ? "NO CHANGE" : "UNCLEAR"
      return "DONE  ·  " + word
    }
    if (this.state.phase === "menu" || this.state.phase === "pick") return "TRAINING  ·  " + mode + "  ·  setting up"
    const what = this.state.phase === "bout" || this.state.phase === "us" ? "pairing" :
      this.state.phase === "csminus" ? "control" : this.state.phase === "choice" ? "choice" :
      this.state.phase === "iti" ? "air" : "measuring"
    const n = this.state.trial > 0 ? "  " + this.state.trial + " of " + this.state.ofTrials : ""
    return "TRAINING  ·  " + mode + "  ·  " + what + n
  }

  private bump() {
    this.version++
    this.state.banner = this.bannerLine()
    this.state.lesson = this.state.mode === "lesson" ? this.lessonAt() : null
  }

  /**
   * ADR 71: where the lesson is, what it says, and what may be chosen next. Steps 1-5 are the
   * wizard (nothing is running yet); 6-8 follow the session's own phases; 9 is the verdict and the
   * way on. Derived in one place so the card, the page and the log can never disagree.
   */
  private lessonAt(): LessonState {
    const cue = this.state.label || "the thing"
    const ctl = this.state.labelMinus || "the other thing"
    const teach = this.lessonPick["2"] || "food"
    const show = this.lessonPick["4"] || "hand"
    let step = this.lessonStep
    // once the session is running the phase decides, not the wizard
    if (step >= 6) {
      const ph = this.state.phase
      step = ph === "probe0" ? 6 : ph === "bout" || ph === "us" || ph === "csminus" ? 7
        : ph === "probe1" ? 8 : ph === "done" ? 9 : step
    }
    const O = (k: string, l: string, h: string): Opt => ({ key: k, label: l, hint: h })
    let title = "", line = "", action = "", opts: Opt[] = []
    if (step === 1) {
      title = "MEET YOUR FLY"
      line = "it has a real brain, nothing is scripted"
      action = "watch it move for a moment"
      opts = [O("go", "LET'S GO", "start the lesson")]
    } else if (step === 2) {
      title = "WHAT TO TEACH IT"
      line = "one thing in your room can come to mean something"
      action = "choose what it should mean"
      opts = [O("food", "A THING MEANS FOOD", "it learns to come to it"),
              O("danger", "A THING MEANS DANGER", "it learns to keep away"),
              O("test", "JUST TEST WHAT IT KNOWS", "change nothing, only measure")]
    } else if (step === 3) {
      title = "WHICH THING"
      line = "these are the things the room scan found near you"
      action = "pick one; the other becomes the control"
      opts = this.nearThings(3).map((t) => O("thing:" + t.label, t.label.toUpperCase(), "use the " + t.label))
      if (!opts.length) {
        line = "the scan has not found anything yet"
        action = "look around the room and wait"
      }
    } else if (step === 4) {
      title = "HOW TO SHOW IT"
      line = "the fly has to notice the " + cue + " before it can learn about it"
      action = "choose how you will present it"
      opts = teach === "danger"
        ? [O("rush", "RUSH A HAND AT IT", "it sees the looming shape"),
           O("bitter", "PUT A BITTER TREAT ON IT", "it tastes something wrong")]
        : [O("hand", "PICK IT UP IN YOUR HAND", "hold it still; the fly smells it"),
           O("ask", "SAY IT: \"FIND MY " + cue.toUpperCase() + "\"", "press ASK and say it out loud"),
           O("treat", "PUT A TREAT ON IT", "the taste does the teaching")]
    } else if (step === 5) {
      title = "HOW MUCH"
      line = "more lessons make a stronger memory and take longer"
      action = "choose the length"
      opts = [O("quick", "QUICK: 3 LESSONS", "about five minutes"),
              O("thorough", "THOROUGH: 6 LESSONS", "the full protocol, about ten")]
    } else if (step === 6) {
      title = "MEASURE FIRST"
      line = "does it care about the " + cue + " yet? this is the zero we compare to"
      action = show === "hand" ? "pick up the " + cue + " and count the seconds" : "stand still and watch"
      opts = []
    } else if (step === 7) {
      title = "THE LESSONS"
      line = "lesson " + Math.max(1, this.state.trial) + " of " + this.state.ofTrials + "  ·  " +
        (teach === "danger" ? "when it lands, the danger arrives" : "when it lands on the " + cue + " it gets a taste of reward")
      action = teach === "danger" ? "watch it flee (PPL101)" : "watch the brain flash (PAM)"
      opts = [O("skip", "SKIP THE REST", "go straight to the after-measurement")]
    } else if (step === 8) {
      title = "MEASURE AGAIN"
      // 21.09: `ctl` falls back to "the other thing", which already carries its article, so the
      // sentence read "and the the other thing". And at this length it ran off the card. Shorter,
      // and the article is only added when the control has a real name.
      line = "the same test — " + (ctl.indexOf("the ") === 0 ? ctl : "the " + ctl) + " was shown too, never paid"
      action = "this is how we know it is the " + cue + ", not luck"
      opts = [O("verdict", "SHOW ME THE VERDICT", "read the numbers")]
    } else {
      title = "THE VERDICT"
      line = this.verdict ? this.verdict.plain : "reading the numbers..."
      action = this.verdict ? "learned: " + this.verdict.learned : "one moment"
      opts = [O("opposite", "TEACH THE OPPOSITE", "same thing, other meaning"),
              O("forget", "MAKE IT FORGET", "show it and pay nothing"),
              O("save", "SAVE THIS BRAIN", "keep this version"),
              O("done", "DONE", "close the lesson")].slice(0, 3)
    }
    const live = this.liveAction()
    return { step: step, of: LESSON_STEPS, title: title, line: line, action: live || action,
             options: this.lessonAwait || step >= 6 ? opts : [], chosen: this.lessonPick["" + step] || "" }
  }

  /** the nearest things the room knows, for step 3's keys */
  private nearThings(n: number): Source[] {
    const head = this.host.pose(this.fly).head
    const all = this.host.things().slice()
    all.sort((a, b) => a.pos.distance(head) - b.pos.distance(head))
    const out: Source[] = []
    for (const t of all) {
      if (out.length >= n) break
      let dup = false
      for (const o of out) if (o.label === t.label) dup = true
      if (!dup) out.push(t)
    }
    return out
  }

  /**
   * ADR 71: a choice, from a guide key or from the page (`{cmd:"lesson_choice", key}`). It is the
   * only thing that advances the wizard, so the lens and the page cannot get out of step.
   */
  lessonChoice(key: string) {
    if (this.state.mode !== "lesson" || !key) return
    const step = this.lessonStep
    log.i("LESSON_CHOICE step=" + step + " key=" + key)
    this.lessonPick["" + step] = key
    if (step === 1) this.lessonStep = 2
    else if (step === 2) this.lessonStep = 3
    else if (step === 3) {
      const label = key.substring(key.indexOf(":") + 1)
      this.lessonThing = null
      for (const t of this.host.things()) if (t.label === label) this.lessonThing = t
      this.lessonStep = this.lessonPick["2"] === "test" ? 6 : 4 // "just test" skips how and how much
      if (this.lessonStep === 6) this.lessonStart()
    } else if (step === 4) this.lessonStep = 5
    else if (step === 5) {
      this.lessonStep = 6
      this.lessonStart()
    } else if (step === 7 && key === "skip") {
      this.plan = this.plan.filter((x) => x.phase !== "bout" && x.phase !== "csminus")
      this.next()
    } else if (step === 9) {
      if (key === "done") this.stop("lesson_done")
      else if (key === "forget") { this.lessonReuse("forget") }
      else if (key === "opposite") { this.lessonReuse(this.lessonPick["2"] === "danger" ? "food" : "danger") }
      else if (key === "save") { this.host.memorySave() }
    }
    this.bump()
  }

  /** the wizard is done: turn the choices into a real session */
  private lessonStart() {
    const teach = this.lessonPick["2"] || "food"
    this.state.ofTrials = this.lessonPick["5"] === "thorough" ? FlyConfig.TRAIN_BOUTS : FlyConfig.TRAIN_LESSON_BOUTS
    this.lessonAwait = false
    if (teach === "test") this.host.setLearning(this.fly, false)
    else this.host.setLearning(this.fly, true)
    this.lessonTeach = teach
    const thing = this.lessonThing || this.nearestThing()
    if (!thing) return
    this.plan = []
    this.at = -1
    this.offer(thing)
  }

  /** step 9's "teach the opposite" / "make it forget": the same cue, a new session */
  private lessonReuse(mode: string) {
    const thing = this.csPlus || this.lessonThing
    this.stop("lesson_next")
    if (!thing) return
    this.setOn(true, this.fly)
    this.state.mode = mode as TrainMode
    this.state.ofTrials = this.boutCount(mode as TrainMode)
    this.host.setLearning(this.fly, true)
    this.enter("pick", 1)
    this.offer(thing)
  }
  private lessonStep = 1
  private lessonAwait = true
  private lessonPick: { [k: string]: string } = {}
  private lessonThing: Source | null = null
  private lessonTeach = "food"

  /** CS on: our own lure on the thing, the measurement reset, the brain's clock read */
  private begin(s: Step) {
    const thing = s.cs === "+" ? this.csPlus : this.csMinus
    if (!thing) return this.next()
    this.csPos = thing.pos
    this.lure = this.host.addLure("cs" + s.cs + " " + thing.label, thing.pos, this.fly)
    this.lure.odourId = s.cs === "+" ? this.csOdour : this.csOdourMinus
    if (s.phase === "choice") {
      // BOTH cues, equal size and equal strength; only the slot (the landing gate) can differ, and
      // it swaps every trial. The geometry is whatever the room gives: `d0` records it per trial.
      const other = s.cs === "+" ? this.csMinus : this.csPlus
      if (other) {
        this.csPosB = other.pos
        this.lureB = this.host.addLure("cs" + (s.cs === "+" ? "-" : "+") + " " + other.label, other.pos, this.fly)
        this.lureB.odourId = s.cs === "+" ? this.csOdourMinus : this.csOdour
      }
    }
    this.host.setLure(this.lure)
    const msg = this.host.msg(this.fly)
    this.sim0 = msg ? msg.sim_ms : 0
    const head = this.host.pose(this.fly).head
    const d0 = head.distance(this.csPos)
    this.cur = {
      cs: s.cs, n: s.n, lat: -1, d0: d0, dmin: d0, bias: 0, kc: 0, mbon7: NaN, mbon11: NaN,
      eff: 1, chg: 0, effOn: NaN, nOn: 0, us: 0, won: "", d0b: NaN, learn: "none",
    }
    this.toward = 0
    this.away = 0
    this.kcSum = 0
    this.kcN = 0
    this.m7Sum = 0
    this.m11Sum = 0
    this.mN = 0
    this.sampleT = 0
    this.arrivedSim = -1
    if (s.phase === "choice") this.cur.d0b = head.distance(this.csPosB)
    this.state.trial = s.n
    this.enter(s.phase, s.phase === "probe0" ? 2 : s.phase === "probe1" ? 4 : 3)
  }

  /** the two things the paper read out: did it turn toward the odour, and (AR) did it get there */
  private sample(dt: number, msg: BrainMsg | null) {
    const c = this.cur
    if (!c) return
    this.sampleT += dt
    if (this.sampleT < FlyConfig.TRAIN_SAMPLE_S) return
    this.sampleT = 0
    const p = this.host.pose(this.fly)
    const v = this.csPos.sub(p.head)
    const d = v.length
    if (d < c.dmin) c.dmin = d
    if (this.state.phase === "choice" && !c.won) {
      // first past the post; when both are inside the radius in one sample, the nearer one wins
      const dB = this.csPosB.sub(p.head).length
      const a = d < FlyConfig.TRAIN_NEAR_CM
      const bb = dB < FlyConfig.TRAIN_NEAR_CM
      if (a || bb) {
        const pickedA = a && (!bb || d <= dB)
        c.won = pickedA === (c.cs === "+") ? "+" : "-"
        c.lat = this.t
      }
    } else if (c.lat < 0) {
      const there = this.state.phase === "bout" ? this.host.landed(this.fly) === this.lure : d < FlyConfig.TRAIN_NEAR_CM
      if (there) {
        c.lat = this.t
        this.arrivedSim = msg ? msg.sim_ms : 0
      }
    }
    if (!msg) return
    // the paper's 5 s test bout: the bias is read over the first 5 s of the BRAIN's time after CS
    // onset. After that the decoder's own baselines creep (BASE_TAU_MS 8 s) and a held cue fades.
    if (msg.sim_ms - this.sim0 <= FlyConfig.TRAIN_BIAS_SIM_MS && d > 1) {
      const lat = v.uniformScale(1 / d).dot(p.left) // + = the CS is on the fly's left
      const steer = msg.act ? msg.act.steer : 0 // + = right (DNa02 + DNp66 + DNp03)
      if (Math.abs(steer) > FlyConfig.TRAIN_STEER_DEAD) {
        if (lat > 0 ? steer < 0 : steer > 0) this.toward++
        else this.away++
      }
      const reg: any = (msg as any).regions
      if (reg && typeof reg.mushroom === "number") {
        this.kcSum += reg.mushroom
        this.kcN++
        // the two mushroom-body output neurons the plastic synapses feed (ADR 65): a conditioned
        // response is a CS+ rate that moves while the CS- rate does not
        const hz: any = msg.hz || {}
        if (typeof hz.MBON07 === "number") {
          this.m7Sum += hz.MBON07
          this.m11Sum += typeof hz.MBON11 === "number" ? hz.MBON11 : 0
          this.mN++
        }
      }
    }
    // ADR 68: which engine answered. A swap mid-session (native <-> web) changes WHICH core holds
    // the plastic state, so it must never be silent — the LEAF run of 15.09 lost half a session to it.
    const eng = (msg as any).engine || "?"
    if (eng !== this.engine) {
      log.i("TRAIN_ENGINE " + this.engine + " -> " + eng + " phase=" + this.state.phase +
        " learning=" + (msg.memory ? msg.memory.learning : "?"))
      this.engine = eng
    }
    if (msg.memory) {
      c.eff = msg.memory.mean_efficacy
      c.chg = msg.memory.changed
      if (typeof msg.memory.eff_on === "number") {
        c.effOn = msg.memory.eff_on
        c.nOn = msg.memory.n_on || 0
      }
      c.learn = msg.memory.learning ? "on" : "off"
      this.state.efficacy = c.eff
    }
  }

  /** CS off, the row logged, on to the next presentation */
  private endPresentation() {
    const c = this.cur
    if (c) {
      const n = this.toward + this.away
      c.bias = n > 0 ? (this.toward - this.away) / n : 0
      c.kc = this.kcN > 0 ? this.kcSum / this.kcN : 0
      c.mbon7 = this.mN > 0 ? this.m7Sum / this.mN : NaN
      c.mbon11 = this.mN > 0 ? this.m11Sum / this.mN : NaN
      this.rows.push(c)
      log.i("TRAIN_TRIAL mode=" + this.state.mode + " cs" + c.cs + " n=" + c.n + "/" + this.state.ofTrials +
        " phase=" + this.state.phase + " lat=" + (c.lat < 0 ? "MISS" : fmt(c.lat, 1) + "s") +
        " d0=" + fmt(c.d0, 0) + " dmin=" + fmt(c.dmin, 0) + " bias=" + fmt(c.bias, 2) +
        (c.won || this.state.phase === "choice" ? " won=" + (c.won || "none") + " d0b=" + fmt(c.d0b, 0) : "") +
        " kc=" + fmt(c.kc, 2) + "Hz mbon07=" + fmt(c.mbon7, 2) + " mbon11=" + fmt(c.mbon11, 2) +
        " eff=" + fmt(c.eff, 4) + " effOn=" + fmt(c.effOn, 5) + "/" + c.nOn + " chg=" + c.chg + " us=" + c.us + " learn=" + c.learn)
    }
    this.cur = null
    this.clearLures()
    this.enter("iti", this.state.step)
  }

  private clearLures() {
    if (this.lure) {
      if (this.host.lure() === this.lure) this.host.setLure(null)
      else this.host.dropLure(this.lure)
      this.lure = null
    }
    if (this.lureB) {
      this.host.dropLure(this.lureB)
      this.lureB = null
    }
  }

  private next() {
    this.at++
    if (this.at >= this.plan.length) return this.stop("done")
    this.begin(this.plan[this.at])
  }

  private clearSession() {
    this.state.trial = 0
    this.state.result = ""
    this.state.label = ""
    this.state.labelMinus = ""
    this.state.biasBefore = NaN
    this.state.biasAfter = NaN
    this.rows = []
    this.plan = []
    this.at = -1
    this.csPlus = null
    this.csMinus = null
    this.forcedMinus = null
    this.cur = null
    this.movedOdour = false
    this.effStart = 1
    this.chgStart = 0
  }

  /**
   * ADR 68: everything the session measured, as one flat pack, then Gemini's reading of it. The
   * pack is the evidence — it goes to the page and into the fly's history unchanged, so a verdict
   * can always be checked against the numbers it was built from.
   */
  private report(plus: Bout[], minus: Bout[], tail: Bout | null) {
    const row = (b: Bout) => ({
      cs: b.cs, n: b.n, lat: b.lat < 0 ? null : Math.round(b.lat * 10) / 10,
      d0: Math.round(b.d0), dmin: Math.round(b.dmin), bias: nz(b.bias),
      effOn: nz(b.effOn), nOn: b.nOn, mbon07: nz(b.mbon7), mbon11: nz(b.mbon11),
      us: b.us, won: b.won || null,
    })
    const first = (xs: Bout[]) => (xs.length ? xs[0] : null)
    const last = (xs: Bout[]) => (xs.length ? xs[xs.length - 1] : null)
    const bp0 = first(plus), bp1 = last(plus), bm0 = first(minus), bm1 = last(minus)
    const pack: any = {
      mode: this.state.mode,
      protocol: FlyTrainer.science(this.state.mode),
      cue: this.state.label,
      control: this.state.labelMinus || null,
      bouts: this.state.ofTrials,
      // the one flag that decides everything: a frozen run cannot have learned
      frozen: !(tail && tail.learn === "on"),
      plasticity: tail ? tail.learn : "none",
      bias: { before: nz(this.state.biasBefore), after: nz(this.state.biasAfter),
              controlBefore: bm0 ? nz(bm0.bias) : null, controlAfter: bm1 ? nz(bm1.bias) : null },
      effOn: { cue: bp1 ? nz(bp1.effOn) : null, control: bm1 ? nz(bm1.effOn) : null,
               cueBefore: bp0 ? nz(bp0.effOn) : null },
      mbon: { cue07: bp1 ? nz(bp1.mbon7) : null, control07: bm1 ? nz(bm1.mbon7) : null },
      efficacy: { start: nz(this.effStart), end: tail ? nz(tail.eff) : null, changed: tail ? tail.chg : 0 },
      misses: plus.filter((b) => b.lat < 0).length,
      rows: this.rows.map(row),
      note: "effOn is the efficacy of ONLY the synapses this cue drives; mean efficacy averages all " +
        "7,835 and hides a cue-specific change. bias is the fly's turning and is noisy between sessions.",
    }
    log.i("TRAIN_PACK " + JSON.stringify({ mode: pack.mode, cue: pack.cue, control: pack.control,
      frozen: pack.frozen, effOn: pack.effOn, rows: pack.rows.length }))
    askVerdict(pack, (v) => {
      this.verdict = v
      this.doneAt = this.sessionT
      if (v.plain) this.state.result = v.plain
      this.bump() // ADR 69: the lesson steps to WHAT NEXT the moment the reading lands
      log.i("TRAIN_VERDICT learned=" + v.learned + " conf=" + v.confidence.toFixed(2) + " via=" + v.via + " | " + v.what)
      this.host.summary(pack, v)
    })
  }
  /** the last session's reading, for the guide and for TRANSFER */
  verdict: TrainVerdict | null = null

  /** the verdict, in each mode's own terms */
  private stop(why: string) {
    if (!this.running) return
    this.clearLures()
    this.host.loom(this.fly, false)
    if (this.learnRestore) {
      this.learnRestore = false
      // 21.09: this used to hard-code `true`, whatever the state had been, so every measurement
      // silently switched plasticity on behind itself -- which is how the fly came to be learning
      // at all. It restores what it found now, and the ordinary state is set in FlyConfig.
      this.host.setLearning(this.fly, this.learnWas)
    }
    const mode = this.state.mode
    const plus = this.rows.filter((b) => b.cs === "+")
    const minus = this.rows.filter((b) => b.cs === "-")
    const first = (xs: Bout[]) => (xs.length ? xs[0] : null)
    const last = (xs: Bout[]) => (xs.length ? xs[xs.length - 1] : null)
    const tail = this.rows.length ? this.rows[this.rows.length - 1] : null
    const eff = tail ? tail.eff : 1
    const chg = tail ? tail.chg : 0
    this.state.efficacy = eff
    if (why === "done") {
      if (mode === "test" || mode === "transfer") {
        const bp = mean(plus.map((b) => b.bias))
        const bm = mean(minus.map((b) => b.bias))
        this.state.biasBefore = bm
        this.state.biasAfter = bp
        const st = mode === "transfer" ? this.host.memoryStatus() : null
        if (mode === "transfer") {
          const h = this.host.history()
          if (h.length) log.i("TRAIN_HISTORY " + h.length + " past sessions, last: " + JSON.stringify(h[0]).substr(0, 220))
        }
        this.state.result =
          (st ? (st.armed ? "RESTORED " + st.changed + " SYNAPSES, " + Math.round(st.ageS / 60) + " MIN OLD  //  "
            : "NOTHING WAS RESTORED  //  ") : "") +
          "CUE " + fmt(bp, 2) + "  vs  CONTROL " + fmt(bm, 2) +
          (isFinite(bp) && isFinite(bm) ? "  (" + (bp - bm >= 0 ? "+" : "") + fmt(bp - bm, 2) + ")" : "") +
          "  //  " + plus.length + " TESTS, NO REWARD"
      } else if (mode === "choice") {
        const won = this.rows.filter((b) => b.won === "+").length
        const lost = this.rows.filter((b) => b.won === "-").length
        const none = this.rows.length - won - lost
        this.state.result = "PICKED THE CUE " + won + " / " + (won + lost) +
          (none ? "  (" + none + " REFUSED)" : "") +
          (won + lost > 0 ? "  //  " + fmt((100 * won) / (won + lost), 0) + "%" : "")
      } else if (mode === "forget") {
        const b0 = first(plus)
        const b1 = last(plus)
        this.state.biasBefore = b0 ? b0.bias : NaN
        this.state.biasAfter = b1 ? b1.bias : NaN
        this.state.result = "BIAS " + fmt(this.state.biasBefore, 2) + " -> " + fmt(this.state.biasAfter, 2) +
          "  //  SYNAPSES " + fmt((eff - 1) * 100, 2) + "%, " + chg + " STILL MOVED"
      } else {
        const b0 = first(plus)
        const b1 = last(plus)
        const m0 = first(minus)
        const m1 = last(minus)
        this.state.biasBefore = b0 ? b0.bias : NaN
        this.state.biasAfter = b1 ? b1.bias : NaN
        const dCue = b1 && b0 ? b1.bias - b0.bias : NaN
        const dCtl = m1 && m0 ? m1.bias - m0.bias : NaN
        this.state.result =
          "CUE " + fmt(this.state.biasBefore, 2) + " -> " + fmt(this.state.biasAfter, 2) +
          (m0 && m1 ? "  //  CONTROL " + fmt(m0.bias, 2) + " -> " + fmt(m1.bias, 2) : "  //  NO CONTROL") +
          (isFinite(dCue) && isFinite(dCtl) ? "  //  DIFFERENCE " + (dCue - dCtl >= 0 ? "+" : "") + fmt(dCue - dCtl, 2) : "") +
          "  //  SYNAPSES " + fmt((eff - 1) * 100, 2) + "%, " + chg + " MOVED" +
          (b1 && m1 && isFinite(b1.effOn) && isFinite(m1.effOn)
            ? "  //  ON THE CUE " + fmt((b1.effOn - 1) * 100, 2) + "%  vs  ON THE CONTROL " + fmt((m1.effOn - 1) * 100, 2) + "%"
            : "")
      }
      if (tail && FlyTrainer.teaches(mode) && tail.learn !== "on") {
        // the brain never confirmed plasticity: this was a control run, not a failed experiment
        this.state.result = "PLASTICITY WAS OFF - CONTROL RUN, NO MEMORY COULD FORM  //  " + this.state.result
      }
    } else this.state.result = ""
    log.i("TRAIN_DONE why=" + why + " mode=" + mode + " cs+='" + this.state.label + "'" +
      " rows=" + this.rows.length + " lat=[" + plus.map((b) => fmt(b.lat, 1)).join(",") + "]" +
      " bias " + fmt(this.state.biasBefore, 2) + "->" + fmt(this.state.biasAfter, 2) +
      " eff " + fmt(this.effStart, 4) + "->" + fmt(eff, 4) + " chg " + this.chgStart + "->" + chg +
      " kc=" + fmt(first(plus) ? first(plus)!.kc : NaN, 2) + "Hz" +
      " mbon07 " + fmt(first(plus) ? first(plus)!.mbon7 : NaN, 2) + "->" + fmt(last(plus) ? last(plus)!.mbon7 : NaN, 2) +
      " mbon11 " + fmt(first(plus) ? first(plus)!.mbon11 : NaN, 2) + "->" + fmt(last(plus) ? last(plus)!.mbon11 : NaN, 2) +
      " learn=" + (tail ? tail.learn : "none") + " | " + this.state.result)
    if (why === "done") this.report(plus, minus, tail)
    this.csPlus = null
    this.csMinus = null
    this.cur = null
    this.forcedMinus = null
    if (why === "done") {
      this.state.phase = "done"
      this.state.step = 4
      this.state.instruction = "SESSION COMPLETE"
    } else {
      this.state.phase = "off"
      this.state.step = 1
      this.state.instruction = ""
    }
    this.bump()
  }
}
