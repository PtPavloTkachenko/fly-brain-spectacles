/**
 * scan_card_hold — the start and scan cards are head-locked during the intro (21.09 Pavlo).
 *
 * Presses SOLO, waits for the scan card, and checks that the board anchor sits where the head
 * looks: BOARD_FRAME_DIST_CM in front of the eyes and aimed at them. It leaves the scan card UP on
 * purpose, so the preview camera can be turned afterwards and a screenshot shows the card following.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { sleep } from "Leaf.lspkg/Utils/common/Utils"
import { FlyConfig } from "../Fly/FlyConfig"
import { CyberFlyLeafInteractor, aimErrorDeg, board, fmt, mark, note, pressSolo, swarm, waitFor } from "./CyberFlyTestKit"

@component
export class ScanCardHoldScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    const sw = swarm()
    const bd = board()
    await waitFor(() => bd.start && bd.start.visible, 8, "the start card")
    await sleep(600)
    await pressSolo(ix)
    await waitFor(() => bd.scan && bd.scan.visible, 6, "the scan card")
    await sleep(1200) // the follow eases at INTRO_HEADLOCK_RATE; give it a second to settle
    mark("s1_scan_card_up")
    const frame: SceneObject | null = sw.boardFrameObj
    expect(frame).not.toBeNull()
    const ft = frame!.getTransform()
    const cam = sw.cameraObject.getTransform()
    const camPos: vec3 = cam.getWorldPosition()
    const fp: vec3 = ft.getWorldPosition()
    const dist = fp.distance(camPos)
    const aim = aimErrorDeg(ft.getWorldRotation(), fp, camPos)
    note("headlock dist=" + fmt(dist, 0) + "cm (want " + FlyConfig.BOARD_FRAME_DIST_CM + ") aim=" + fmt(aim, 1) + "deg introT=" + fmt(sw.introT, 1))
    expect(sw.introT > 0).toBe(true)
    expect(Math.abs(dist - Math.sqrt(FlyConfig.BOARD_FRAME_DIST_CM ** 2 + FlyConfig.BOARD_FRAME_RIGHT_CM ** 2 + FlyConfig.BOARD_FRAME_DOWN_CM ** 2))).toBeLessThan(25)
    expect(aim).toBeLessThan(25)
    mark("s2_headlock_ok")
    // left UP on purpose: turn the preview camera now and the card must come along
  }
}
