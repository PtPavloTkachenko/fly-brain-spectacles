/**
 * CyberFlyTestKit — what the LEAF scenarios share (docs/knowledge/TESTING.md).
 *
 * The scenarios press the REAL keys (the SIK Interactables FlyBoard builds at runtime, named
 * `<Key>Hit`) and read the lens's own state through the FlySwarm instance — its private fields
 * through `any`, because a test may look inside. They log `LEAF_STEP <name>` (the runner captures
 * a screenshot on each) and `LEAF_NOTE k=v` (the measured numbers), next to the lens's own markers.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { StartMenu as SyncStartMenu } from "SpectaclesSyncKit.lspkg/StartMenu/Scripts/StartMenu"
import { DefaultLeafInteractor } from "Leaf.lspkg/Interactors/interactor/DefaultLeafInteractor"
import { findInteractablesByName } from "Leaf.lspkg/Interactors/InteractableUtils"
import { findSceneObjectByName, hasAncestorWithName, nextFrame, sleep } from "Leaf.lspkg/Utils/common/Utils"
import { FlySwarm } from "../Fly/FlySwarm"

const log = new NativeLogger("LeafTest")

/** a screenshot point for the runner */
export function mark(step: string, extra: string = ""): void {
  log.i("LEAF_STEP " + step + (extra ? " " + extra : ""))
}

/** a measured number, for the report */
export function note(kv: string): void {
  log.i("LEAF_NOTE " + kv)
}

export function line(s: string): void {
  log.i(s)
}

export const fmt = (x: number, d: number = 2): string => (typeof x === "number" && isFinite(x) ? x.toFixed(d) : "nan")

/** the FlySwarm script instance (the TS class, methods and private fields included) */
export function swarm(): any {
  const so = findSceneObjectByName("FlySwarm")
  if (!so) throw new Error("no 'FlySwarm' scene object in the scene")
  const c = so.getComponent(FlySwarm.getTypeName()) as any
  if (!c) throw new Error("no FlySwarm script on the 'FlySwarm' object")
  return c
}

export function board(): any {
  const b = swarm().board
  if (!b) throw new Error("FlySwarm has no board (FlyConfig.BOARD off?)")
  return b
}

/** polls once a frame; returns the seconds it took, throws after `timeoutS` */
export async function waitFor(pred: () => boolean, timeoutS: number, what: string): Promise<number> {
  const t0 = getTime()
  while (!pred()) {
    if (getTime() - t0 > timeoutS) throw new Error("timeout " + timeoutS + " s waiting for " + what)
    await nextFrame()
  }
  return getTime() - t0
}

/** an ENABLED hit box by name, optionally under a named ancestor (the scan card and the board both own a ScanDoneHit) */
export function key(name: string, under?: string): Interactable {
  const all = findInteractablesByName(name, undefined, true)
  const hits = under ? all.filter((it) => hasAncestorWithName(it.getSceneObject(), under)) : all
  if (hits.length === 0) {
    throw new Error("no enabled Interactable '" + name + "'" + (under ? " under '" + under + "'" : "") + " (" + all.length + " enabled in total)")
  }
  return hits[0]
}

export class CyberFlyLeafInteractor extends DefaultLeafInteractor {
  constructor() {
    super("CyberFlyLeafInteractor")
  }

  /**
   * Press a key; resolves to the lens time at which its onTriggerStart fired.
   *
   * 21.09: this does the press by hand instead of calling LEAF's `trigger()`, and the reason is a
   * real difference between this lens and the buttons LEAF was written for.
   *
   * `BaseLeafInteractor.executeTrigger` presses and then AWAITS `onTriggerEnd` before it returns.
   * That assumes the button is still there to release. Every card in this lens is dismiss-on-press:
   * the key's own handler closes the card, the hit object goes with it, and SIK can never deliver a
   * release from an object that is gone. Measured with the probe_key scenario: `triggerStart=1`,
   * `triggerEnd=0`, and both `await triggerEnded` and `exitHover()` then hang forever. That single
   * fact is why every card scenario in this suite timed out.
   *
   * So: hover, hold Select until the press lands, let go, and drop the hover by clearing the
   * override rather than awaiting a hover-exit that a dead object cannot send either.
   */
  async tap(name: string, under?: string): Promise<number> {
    const it = key(name, under)
    let at = -1
    const unsubscribe = it.onTriggerStart.add(() => {
      at = getTime()
    })
    try {
      await (this as any).enterHover(it)
      await nextFrame()
      ;(this as any).overrideTrigger = 1 // InteractorTriggerType.Select
      for (let i = 0; i < 90 && at < 0; i++) await nextFrame()
      ;(this as any).overrideTrigger = 0 // None: the release, for a key that survives its own press
      await nextFrame()
      await nextFrame()
    } finally {
      ;(this as any).overrideTrigger = 0
      ;(this as any).overrideInteractable = undefined
      unsubscribe()
    }
    if (at < 0) throw new Error("onTriggerStart never fired on '" + name + "' (90 frames)")
    return at
  }
}

/** Sync Kit's StartMenu object (its visuals are the children FlySwarm disables) */
export function syncMenuObject(): SceneObject | null {
  const visit = (so: SceneObject): SceneObject | null => {
    if (so.getComponent(SyncStartMenu.getTypeName())) return so
    for (let i = 0; i < so.getChildrenCount(); i++) {
      const r = visit(so.getChild(i))
      if (r) return r
    }
    return null
  }
  for (let i = 0; i < global.scene.getRootObjectsCount(); i++) {
    const r = visit(global.scene.getRootObject(i))
    if (r) return r
  }
  return null
}

/** the bugs a run had to work around (the scenario decides whether they fail it) */
export const bugs: string[] = []

/**
 * SOLO on the real key. Returns the lens time of the press. If the session does not start (found
 * 15.09: FlySwarm.start wires `board.onStart` at line 274, before the board exists at line 292, so the
 * card's keys hide the card and do nothing else) the press is recorded as a bug and the same call the
 * bench makes, `FlySwarm.chooseStart(false)`, takes the flow on so the rest of the lens is still tested.
 */
export async function pressSolo(ix: CyberFlyLeafInteractor): Promise<{ tSolo: number; tHide: number }> {
  const sw = swarm()
  const bd = board()
  await waitFor(() => bd.start && bd.start.visible, 8, "the start card")
  await sleep(800) // never press a card that is still popping in (0.45 s)
  const startRoot: SceneObject = bd.start.root
  const tSolo = await ix.tap("StartSoloHit", "FlyStart")
  await waitFor(() => !startRoot.enabled, 3, "the start card to leave after SOLO")
  const tHide = getTime()
  note("solo_to_start_hidden_s=" + fmt(tHide - tSolo))
  try {
    await waitFor(() => bd.scan && bd.scan.visible, 4, "the scan card after SOLO")
  } catch (e) {
    const msg = "start card SOLO key is not wired: no session after the press (FlySwarm.start: board.onStart is set before the board exists); falling back to FlySwarm.chooseStart(false)"
    bugs.push(msg)
    note("BUG " + msg)
    sw.chooseStart(false)
    await waitFor(() => bd.scan && bd.scan.visible, 15, "the scan card after chooseStart(false)")
  }
  return { tSolo: tSolo, tHide: tHide }
}

/**
 * The boot card stands between DONE SCANNING and the board: `FlyBoard.reveal()` hands over to it
 * and RETURNS, so the dashboard never opens until the card is done. Since ADR 87 the lens has no
 * brain of its own, so the card can only finish when a web page takes the brain over — and in a
 * bare preview there is no page. Its way out ("OPEN THE BOARD ANYWAY", object `BootAnyway`) exists
 * from the moment the card is built, so a test can take it immediately instead of waiting out the
 * 25 s watchdog that makes the label appear.
 */
export async function passBootCard(ix: CyberFlyLeafInteractor): Promise<boolean> {
  const bd = board()
  if (bd.content.enabled) return false
  // the card offers its way out BOOT_KEY_AFTER_S after the room is done; wait for it rather than
  // assuming it is already there
  let anyway = findSceneObjectByName("BootAnyway")
  for (let i = 0; i < 60 && (!anyway || !anyway.enabled); i++) {
    await sleep(200)
    anyway = findSceneObjectByName("BootAnyway")
  }
  if (!anyway || !anyway.enabled) return false
  // the Interactable lives on the child the button factory makes, `<name>Hit` — same as
  // StartSoloHit and ScanDoneHit
  note("boot_card_open: taking OPEN THE BOARD ANYWAY (no page is the brain in this preview)")
  await ix.tap("BootAnywayHit", "FlyBoot")
  return true
}

/** the lens past its intro: SOLO and DONE SCANNING pressed if the cards are still up */
export async function ensureBoard(ix: CyberFlyLeafInteractor): Promise<void> {
  const sw = swarm()
  const bd = board()
  if (bd.content.enabled && sw.introT <= 0) return
  await waitFor(() => (bd.start && bd.start.visible) || (bd.scan && bd.scan.visible), 10, "a start or scan card")
  if (bd.start && bd.start.visible) await pressSolo(ix)
  if (bd.scan && bd.scan.visible) {
    await sleep(1200) // the card lands (popIn 0.45 s), the typewriter starts
    await ix.tap("ScanDoneHit", "FlyScan")
  }
  await sleep(1500) // the boot card lands if it is going to
  await passBootCard(ix)
  await waitFor(() => bd.content.enabled && sw.introT <= 0, 10, "the board after DONE SCANNING")
  await sleep(800)
}

/**
 * Stand in for a person holding the cue up to the fly.
 *
 * 21.09, measured: a FOOD session sits in phase `probe0` forever with the Kenyon cells flat at
 * 0.00 Hz. Not a bug — the design. `WorldSources` gives class `object` sigma 0 and strength 0
 * ("seen only"), and a thing only smells while `present > 0`, which `FlySwarm` sets when the wearer
 * PICKS IT UP (ADR 70, PRESENT_HOLD_S). In a bare preview nobody picks anything up, so the cue has
 * no odour, the mushroom body has nothing to learn on, and the probe can never resolve.
 *
 * A headless test therefore has to play the person. This is DISCLOSED, not silent: it says so in
 * the log, it only touches the two sources the session itself named, and it changes nothing about
 * how the brain treats the smell once it is there.
 */
export function presentCue(label: string, on: boolean): boolean {
  const sw = swarm()
  let found = false
  for (const s of sw.sources.items as any[]) {
    if (s.label === label) { s.present = on ? 1 : 0; found = true }
  }
  return found
}

/** degrees between where `rot` aims (its z axis, either sign: a plate) and the direction from `from` to `to` */
export function aimErrorDeg(rot: quat, from: vec3, to: vec3): number {
  const dir = to.sub(from).normalize()
  let best = -1
  for (const ax of [vec3.forward(), vec3.back()]) best = Math.max(best, rot.multiplyVec3(ax).normalize().dot(dir))
  return (Math.acos(Math.max(-1, Math.min(1, best))) * 180) / Math.PI
}
