/**
 * FlyScan — the room-scan instruction card (ADR 58).
 *
 * Between the start choice and the fly, the user has to WALK the room and LOOK at its surfaces so
 * the world mesh and Gemini's inventory fill in. The fly's dashboard stays hidden until then; this
 * card is what stands in its place: a typewritten instruction, a chevron sweep that says "look
 * around", the live count of what was found, and DONE SCANNING. Two-phase instruction (polish
 * playbook §4): "walk around and look at the room" until the first surfaces come in, then "keep
 * going: tables, floor, walls" once the room starts filling. DONE slips the card out; the board
 * pops in under its tail.
 */
import { FlyConfig } from "./FlyConfig"
import { Anim, Ease } from "./FlyMotion"
import { NeonBatch, NeonQuadSet, QuadSink, addFrame } from "./UIBatch"
import { MkBatch, MkButton, MkText, stillText } from "./UICard"
import { FRAME, PLATE, TXT, TXT2, WHITE } from "./FlyPalette"

const CARD_W = 36
const CARD_H = 24
const CPS = 24 // typewriter, characters per second
const T_KEY = 0.66
const KEY_WAIT = 0.3 // the DONE key's resting level while the room is still empty (16.09)

export class FlyScan {
  readonly root: SceneObject
  private ui: QuadSink
  private line1: Text
  private line2: Text
  private counter: Text
  private chevrons: number[] = []
  private shown = false
  private t = 0
  private typing = ""
  private typed = 0
  private typeT = 0
  private phase = 0 // 0 = looking for the first surfaces, 1 = the room is filling
  private lastCounter = ""
  private lastFound = -1
  private lastSweep: number[] = [-1, -1, -1, -1, -1]
  private done1: { idle?: (k: number) => void; flash?: () => void } | null = null
  onDone: () => void = () => {}

  constructor(parent: SceneObject, quad: RenderMesh, neon: Material, batchMat: Material | null, mkText: MkText, mkButton: MkButton, mkBatch: MkBatch, accent: vec4) {
    this.root = global.scene.createSceneObject("FlyScan")
    this.root.setParent(parent)
    this.root.getTransform().setLocalPosition(new vec3(0, 0, 0.4))
    const r = this.root
    this.ui = batchMat ? new NeonBatch(r, batchMat, "ScanNeon") : new NeonQuadSet(r, quad, neon, "ScanNeon")
    const ui = this.ui
    const tb = mkBatch(r, "ScanText")
    const still = stillText(tb, mkText, r)
    const W = CARD_W, H = CARD_H
    ui.add(0, 0, -0.6, W, H, PLATE, FlyConfig.BOARD_PLATE, 2)
    addFrame(ui, 0, 0, W, H, FRAME, accent)
    ui.add(0, H / 2 - 3.2, 0, W - 2, 0.16, FRAME, 0.6, 2)
    still("FLY BRAIN LINK  //  SCAN", -W / 2 + 1.5, H / 2 - 2.35, 0.56, TXT2)
    this.counter = mkText(r, "", W / 2 - 1.5, H / 2 - 2.35, 0.62, accent, { align: "R", mono: true }) // 21.09: was 0.46
    // the chevron sweep: five bars that light in turn, left to right and back: "look around"
    for (let i = 0; i < 5; i++) this.chevrons.push(ui.add((i - 2) * 5.2, H / 2 - 7.2, 0, 3.2, 0.6, accent, 0.5))
    this.line1 = mkText(r, "", 0, H / 2 - 11.2, 1.05, TXT, { align: "C" })
    this.line2 = mkText(r, "", 0, H / 2 - 14.1, 0.8, TXT2, { align: "C" }) // 21.09 Pavlo: 0.56 read small on the glasses
    // 16.09: DONE SCANNING is pressable from the first frame -- a tap is never gated (polish playbook
    // §3) -- but it RESTS secondary until the room starts filling in, and then lifts to primary with
    // one flash. The instruction line already works that way; the key now says the same thing.
    this.done1 = mkButton(r, "ScanDone", 0, -H / 2 + 4.2, W - 8, 4.6, () => this.done(), ui)
    if (this.done1.idle) this.done1.idle(KEY_WAIT)
    still("DONE SCANNING   >", 0, -H / 2 + 4.2, T_KEY, WHITE, "C", 1.5)
    ui.flush()
    if (tb) tb.flush()
    r.enabled = false
  }

  private type(l1: string, l2: string) {
    this.line1.text = ""
    this.line2.text = l2
    this.typing = l1
    this.typed = 0
    this.typeT = 0
  }

  show(delay = 0) {
    if (this.shown) return
    this.shown = true
    this.root.enabled = true
    this.t = 0
    this.phase = 0
    // 21.09 Pavlo: "напиши look around, щоб відсканувати кімнату" -- say what to do AND why
    this.type("LOOK AROUND TO SCAN THE ROOM", "the walls, the table, the floor: this is where the fly will live")
    Anim.popIn("scan.card", this.root.getTransform(), 0.45, 1.2, delay)
  }

  private done() {
    if (!this.shown) return
    this.hide()
    this.onDone()
  }

  hide() {
    if (!this.shown) return
    this.shown = false
    Anim.slipOut("scan.card", this.root.getTransform(), 0.25, () => { this.root.enabled = false })
  }

  /** every frame while scanning: the typewriter, the sweep, the live count */
  tick(dt: number, seconds: number, found: number, surfaces: boolean) {
    if (!this.shown) return
    this.t += dt
    if (this.typed < this.typing.length) {
      this.typeT += dt
      const n = Math.min(this.typing.length, this.typed + Math.floor(this.typeT * CPS))
      if (n > this.typed) {
        this.typeT -= (n - this.typed) / CPS
        this.typed = n
        this.line1.text = this.typing.substring(0, n)
      }
    }
    // phase two: the room started filling; retype in place (the first line is the instruction)
    if (this.phase === 0 && (surfaces || found > 0) && seconds > 4) {
      this.phase = 1
      this.type("KEEP LOOKING AROUND", "turn slowly: the floor, the ceiling, the corners, then press DONE")
      // cause before effect: the room has started filling, so the way out becomes the thing to do
      if (this.done1 && this.done1.idle) this.done1.idle(0.55)
      if (this.done1 && this.done1.flash) this.done1.flash()
    }
    const c = Math.floor(seconds) + " S  //  " + found + " THINGS"
    if (c !== this.lastCounter) {
      this.lastCounter = c
      this.counter.text = c
      // 16.09: this used to pulse EVERY second, because the seconds are part of the string -- a tic,
      // not a signal. The pulse belongs to the number that means something.
      if (found !== this.lastFound && found > 0) Anim.pulse("scan.count", this.counter.getTransform(), 1.12)
      this.lastFound = found
    }
    // the sweep: a bright bar travels left-right-left at 0.8 Hz, its neighbours trail. Quantised to
    // 0.05 so most frames mark nothing dirty and the batch skips its upload entirely (16.09).
    const ph = 0.5 - 0.5 * Math.cos(this.t * Math.PI * 2 * 0.4) // 0..1..0
    const pos = ph * 4
    for (let i = 0; i < 5; i++) {
      const d = Math.abs(i - pos)
      const k = Math.round((0.35 + 1.4 * Math.max(0, 1 - d)) * 20) / 20
      if (k === this.lastSweep[i]) continue
      this.lastSweep[i] = k
      this.ui.set(this.chevrons[i], { intensity: k })
    }
    this.ui.flush()
  }

  get visible(): boolean {
    return this.shown
  }
}
