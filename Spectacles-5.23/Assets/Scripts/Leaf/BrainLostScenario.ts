/**
 * brain_lost — ADR 107 (21.09 Pavlo: "visualise that the brain dropped"): when the brain link
 * drops, the fly BLINKS OUT over BRAIN_LOST_BLINK_S (both states seen while it blinks), then is
 * withheld; when a brain is back it blinks in and stays. Driven through FlySwarm.debugLinkStatus,
 * which needs a real brain on the lens first (the fly must be shown before it can be lost).
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, ensureBoard, mark, note, swarm } from "./CyberFlyTestKit"

@component
export class BrainLostScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    await ensureBoard(ix)
    const sw = swarm()
    const shown = () => !!(sw.flies && sw.flies[0] && sw.flies[0].sceneObject.enabled)
    // a brain must be stepping her: wait up to 30 s for the fly to be shown at all
    for (let i = 0; i < 60 && !shown(); i++) await sleep(500)
    note("fly shown before the drop: " + shown())
    expect(shown()).toBe(true)
    sw.debugLinkStatus(false)
    mark("s1_dropped")
    let sawOn = false, sawOff = false
    for (let i = 0; i < 12; i++) { // 1.2 s inside the 1.8 s blink: both states must appear
      await sleep(100)
      if (shown()) sawOn = true
      else sawOff = true
    }
    note("blink: sawOn=" + sawOn + " sawOff=" + sawOff)
    expect(sawOn).toBe(true)
    expect(sawOff).toBe(true)
    await sleep(1400) // past the end of the blink
    note("after the blink: shown=" + shown())
    expect(shown()).toBe(false)
    mark("s2_withheld")
    sw.debugLinkStatus(true)
    await sleep(1100) // past BRAIN_BACK_BLINK_S
    note("brain back: shown=" + shown())
    expect(shown()).toBe(true)
    mark("s3_back")
  }
}
