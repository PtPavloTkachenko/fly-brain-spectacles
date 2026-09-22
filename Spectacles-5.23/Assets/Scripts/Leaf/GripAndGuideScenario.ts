/**
 * grip_and_guide — the guide card and the board's own grip (ADR 59). The guide first ("?" = GuideHit
 * toggles it, GOT IT = GuideOkHit closes it), then the grip: hover lights it, a pinch-drag carries the
 * board's world anchor and FlySwarm turns it to face the user.
 *
 * Measured 15.09: SIK's far-field InteractableManipulation JUMPS about a metre on the first frame of a
 * drag from a synthetic LEAF ray (DefaultLeafInteractor: startPoint = camera, endPoint = the hit box),
 * whatever the vector or duration (1.2 cm x 500 ms -> 100 cm, 0.3 cm x 120 ms -> 111 cm), so a
 * calibrated 15 cm drag is not reproducible that way. The simulated hand (LeafHandInteractor) is tried
 * first; the assertion is motion + re-aim, and the centimetres are logged, not bounded from above.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { LeafHandInteractor } from "Leaf.lspkg/Interactors/interactor/LeafTwoHandInteractor"
import { findSceneObjectByName, sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, aimErrorDeg, board, ensureBoard, fmt, key, mark, note, swarm, waitFor } from "./CyberFlyTestKit"

@component
export class GripAndGuideScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    await ensureBoard(ix)
    const sw = swarm()
    const bd = board()

    // 1. the guide: "?" toggles it, GOT IT closes it
    const g = bd.guide
    const v0: boolean = g.visible
    mark("s5_guide_before", "visible=" + v0)
    await sleep(400)
    await ix.tap("GuideHit")
    await sleep(500)
    expect(g.visible).toBe(!v0)
    note("guide_toggle " + v0 + " -> " + g.visible)
    if (!g.visible) {
      await ix.tap("GuideHit")
      await sleep(500)
      expect(g.visible).toBe(true)
    }
    mark("s5_guide_open")
    await sleep(500)
    await ix.tap("GuideOkHit", "FlyGuide")
    await sleep(400)
    expect(g.visible).toBe(false)
    await waitFor(() => !findSceneObjectByName("FlyGuide")!.enabled, 2, "the guide card to slip out")
    mark("s5_guide_closed")
    await sleep(500)

    // 2. the grip
    const anchor: SceneObject = sw.boardFrameObj
    if (!anchor) throw new Error("no board anchor (FlyConfig.BOARD_IN_FRAME off?)")
    const cam: vec3 = sw.cameraObject.getTransform().getWorldPosition()
    const at = anchor.getTransform()
    const p0 = at.getWorldPosition()
    const q0 = at.getWorldRotation()
    const grip = key("GripHit")
    let hovered = false
    const unsubscribe = grip.onHoverEnter.add(() => {
      hovered = true
    })
    mark("s5_before_grip")
    await sleep(400)
    await ix.hover(grip, 500)
    unsubscribe()
    expect(hovered).toBe(true)

    let moved = 0
    let how = ""
    try {
      const hand = LeafHandInteractor.get("right")
      await hand.drag(grip, new vec3(0.5, 0, 0), 300)
      moved = at.getWorldPosition().distance(p0)
      how = "hand"
      note("hand_drag_cm=" + fmt(moved, 1))
    } catch (e) {
      note("hand_drag_failed " + e)
    }
    if (moved < 5) {
      if (!bd.content.enabled) throw new Error("the board left the view cone after the hand drag: its keys are off")
      await ix.drag(key("GripHit"), new vec3(0.3, 0, 0), 120)
      moved = at.getWorldPosition().distance(p0)
      how = how ? how + "+sik" : "sik"
      note("sik_drag_cm=" + fmt(moved, 1))
    }
    await sleep(700) // faceUserWhileCarried finishes its turn (0.3 s after release)
    const p1 = at.getWorldPosition()
    const q1 = at.getWorldRotation()
    moved = p1.distance(p0)
    const errOld = aimErrorDeg(q0, p1, cam)
    const errNew = aimErrorDeg(q1, p1, cam)
    note("grip_moved_cm=" + fmt(moved, 1) + " by=" + how + " dx=" + fmt(p1.x - p0.x, 1) + " dy=" + fmt(p1.y - p0.y, 1) + " dz=" + fmt(p1.z - p0.z, 1) +
      " aim_err_before_deg=" + fmt(errOld, 1) + " aim_err_after_deg=" + fmt(errNew, 1))
    expect(moved).toBeGreaterThan(5)
    expect(errNew).toBeLessThan(8)
    expect(errNew <= errOld + 0.5).toBe(true)
    mark("s5_after_drag", "moved_cm=" + fmt(moved, 1))
    await sleep(600)
  }
}
