/**
 * FlyStart — the start card, in the board's language (ADR 58).
 *
 * Sync Kit's own start menu (white "Lens Title / Multiplayer / Solo") stood in front of our board in a
 * different visual language. Its LOGIC stays (StartMenu.ts decides the session, checks the internet,
 * shows its alerts); its visuals are hidden and this card, a sibling of the board content on the
 * board's root, is what the user sees: CYBERFLY, what it is, MULTIPLAYER / SOLO.
 *
 * 16.09 polish audit: a choice used to slip the card out ON THE SAME LINE that wrote "STARTING", and
 * the scan card only arrives when Sync Kit's session is ready — measured at 4.97 s (TESTING.md). That
 * left ~4.7 s of empty air with nothing on screen. The card is now the loading screen (polish playbook
 * §3, mask latency with ceremony): the chosen key stays lit, the other one leaves, the note says what
 * is happening and a bar sweeps under it. `FlyBoard.showScan()` hides the card, so the handoff into
 * the scan card is still one gesture (0.16 s under the exit's tail).
 */
import { FlyConfig } from "./FlyConfig"
import { Anim } from "./FlyMotion"
import { NeonBatch, NeonQuadSet, QuadSink, addFrame } from "./UIBatch"
import { MkBatch, MkButton, MkText, stillText } from "./UICard"
import { FRAME, PLATE, TXT, TXT2, WAIT, WHITE } from "./FlyPalette"

const CARD_W = 36
const CARD_H = 27
const T_KEY = 0.66
// 16.09 typography pass: the 0.42 tier renders as mush at this cap height (0.52 cm) — the capture of
// this very line read "MalwCNS v1.0 connuctumu". 0.46 is the smallest the MSDF atlas holds up at.
const T_SMALL = 0.46
const WAIT_WATCHDOG_S = 8 // after this the note says so instead of repeating itself

export class FlyStart {
  readonly root: SceneObject
  private ui: QuadSink
  private note: Text
  private shown = false
  private chosen = false
  private waitT = -1 // >= 0 once a choice was made and we are waiting for the session
  private said = false
  private idleT = 0
  private accents: { i: number; base: number }[] = [] // the frame's accent quads: a slow idle bell
  private keys: { so: SceneObject; quads: number[] }[] = []
  private barTrack = -1
  private barFill = -1
  private lastBar = -99
  private lastIdle = -99
  onMultiplayer: () => void = () => {}
  onSolo: () => void = () => {}

  constructor(parent: SceneObject, quad: RenderMesh, neon: Material, batchMat: Material | null, mkText: MkText, mkButton: MkButton, mkBatch: MkBatch, accent: vec4) {
    this.root = global.scene.createSceneObject("FlyStart")
    this.root.setParent(parent)
    this.root.getTransform().setLocalPosition(new vec3(0, 0, 0.4))
    const r = this.root
    this.ui = batchMat ? new NeonBatch(r, batchMat, "StartNeon") : new NeonQuadSet(r, quad, neon, "StartNeon")
    const ui = this.ui
    const tb = mkBatch(r, "StartText") // every label that never changes: one mesh, one draw (15.09)
    const still = stillText(tb, mkText, r)
    const W = CARD_W, H = CARD_H
    ui.add(0, 0, -0.6, W, H, PLATE, FlyConfig.BOARD_PLATE, 2)
    const fr = addFrame(ui, 0, 0, W, H, FRAME, accent)
    for (const i of fr.brackets) this.accents.push({ i: i, base: ui.get(i).intensity })
    ui.add(0, H / 2 - 3.2, 0, W - 2, 0.16, FRAME, 0.6, 2)
    still("FLY BRAIN LINK  //  START", -W / 2 + 1.5, H / 2 - 2.35, 0.46, TXT2)
    still("CYBERFLY", 0, H / 2 - 7.2, 1.9, accent, "C")
    still("a real fly brain on your Specs", 0, H / 2 - 10.4, 0.56, TXT, "C")
    still("166,700 neurons, every one wired like a real fly  //  MaleCNS connectome", 0, H / 2 - 12.2, T_SMALL, TXT2, "C")
    // the two choices: neon keys in the card's own batch, white labels on the lit plates
    const bw = W - 8, bh = 4.6
    const y1 = H / 2 - 15.6, y2 = y1 - 5.8 // under the tagline, the two keys, then the note
    const km = mkButton(r, "StartMulti", 0, y1, bw, bh, () => this.choose(true), ui)
    this.keys.push({ so: km.so, quads: km.quads })
    still("COLOCATED   //   your fly and other people's", 0, y1, T_KEY, WHITE, "C", 1.5) // batched text centres its cap box on y
    const ks = mkButton(r, "StartSolo", 0, y2, bw, bh, () => this.choose(false), ui)
    this.keys.push({ so: ks.so, quads: ks.quads })
    still("SOLO   //   just you and the fly", 0, y2, T_KEY, WHITE, "C", 1.5)
    // the waiting bar: two quads in the card's own batch, hidden until a choice is made. It is the
    // ceremony that covers Sync Kit's session handshake — nothing about it claims progress it cannot
    // know, it only says the lens is still working.
    this.barTrack = ui.add(0, -H / 2 + 4.0, 0, 22, 0.28, FRAME, 0.18, 2)
    this.barFill = ui.add(-8, -H / 2 + 4.0, 0.05, 6, 0.28, accent, 1.4, 2)
    ui.set(this.barTrack, { visible: false })
    ui.set(this.barFill, { visible: false })
    this.note = mkText(r, "", 0, -H / 2 + 1.5, 0.46, WAIT, { align: "C" })
    ui.flush()
    if (tb) tb.flush()
    r.enabled = false
  }

  private choose(multi: boolean) {
    if (this.chosen) return
    if (multi && !global.deviceInfoSystem.isInternetAvailable()) {
      // the refusal is visible and named (polish playbook §4)
      this.note.text = "NO INTERNET  //  multiplayer needs Wi-Fi; solo works offline"
      Anim.pulse("start.note", this.note.getTransform(), 1.06)
      return
    }
    this.chosen = true
    this.note.text = multi ? "JOINING  //  map the room with your friends" : "STARTING  //  waking the brain"
    Anim.pulse("start.note", this.note.getTransform(), 1.08)
    // the chosen key stays lit and says what was picked; the other one leaves. Both stop taking input
    // by DISABLING the hit object, never by swallowing the event (polish playbook §4).
    const gone = this.keys[multi ? 1 : 0]
    // 21.09: disable the hit objects on the NEXT frame, not inside this handler. SIK emits a press
    // as onTriggerStart then onTriggerEnd; disabling the object mid-press means the release can
    // never be delivered, and anything waiting for it waits forever. That is exactly what hung
    // every LEAF card scenario: the interactor pressed SOLO, the card vanished under its finger,
    // and `await onTriggerEnd` never resolved. `chosen` already guards against a second press, so
    // nothing takes input in the meantime and the behaviour a wearer sees is unchanged.
    this.disarmIn = 2 // frames
    for (const q of gone.quads) this.ui.set(q, { visible: false })
    this.ui.set(this.barTrack, { visible: true })
    this.ui.set(this.barFill, { visible: true })
    this.ui.flush()
    this.waitT = 0
    if (multi) this.onMultiplayer()
    else this.onSolo()
  }

  /** every frame while the card is up (FlyBoard drives it from the intro tick) */
  /** frames left before the keys stop taking input; see choose() */
  private disarmIn = -1

  tick(dt: number) {
    if (this.disarmIn > 0) {
      this.disarmIn--
      if (this.disarmIn === 0) for (const k of this.keys) k.so.enabled = false
    }
    if (!this.shown) return
    this.idleT += dt
    // law 3: nothing idle is frozen. The frame's accent quads breathe together, off their AUTHORED
    // intensities, quantised so most ticks mark nothing dirty.
    const k = Math.round((1 + 0.3 * Math.sin(this.idleT * 1.1)) * 50) / 50
    if (k !== this.lastIdle) {
      this.lastIdle = k
      for (const a of this.accents) this.ui.set(a.i, { intensity: a.base * k })
    }
    if (this.waitT >= 0) {
      this.waitT += dt
      if (!this.said && this.waitT > WAIT_WATCHDOG_S) {
        this.said = true
        this.note.text = "STILL CONNECTING  //  this can take a moment"
        Anim.pulse("start.note", this.note.getTransform(), 1.06)
      }
      // the bar sweeps left to right and back, on the same 0.4 Hz as the scan card's chevrons so the
      // two screens share one rhythm
      const ph = 0.5 - 0.5 * Math.cos(this.waitT * Math.PI * 2 * 0.4)
      const x = Math.round((-8 + 16 * ph) * 20) / 20
      if (x !== this.lastBar) {
        this.lastBar = x
        this.ui.set(this.barFill, { x: x })
      }
    }
    this.ui.flush()
  }

  show() {
    if (this.shown) return
    this.shown = true
    this.root.enabled = true
    Anim.popIn("start.card", this.root.getTransform(), 0.45, 1.2)
  }

  hide() {
    if (!this.shown) return
    this.shown = false
    Anim.slipOut("start.card", this.root.getTransform(), 0.25, () => { this.root.enabled = false })
  }

  get visible(): boolean {
    return this.shown
  }
}
