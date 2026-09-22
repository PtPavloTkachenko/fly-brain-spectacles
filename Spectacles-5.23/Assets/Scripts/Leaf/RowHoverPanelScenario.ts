/**
 * row_hover_panel — hovering a NEURAL row opens its side panel (21.09 Pavlo: "коли наводжу на
 * параметри — описуються в випливаючому боковому меню"), a tap pins/closes it.
 *
 * Gets past the intro, hovers the MEMORY row for longer than the dwell, expects the panel open on
 * that row; then hovers another row and expects the swap. Leaves the panel OPEN for a screenshot.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, board, ensureBoard, key, mark, note } from "./CyberFlyTestKit"

@component
export class RowHoverPanelScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    await ensureBoard(ix)
    const bd = board()
    await sleep(600)
    await (ix as any).enterHover(key("RowHit_mushroom", "FlyBoard"))
    await sleep(900) // > SIDE_HOVER_OPEN_S 0.35 + the pop
    note("side after hover(mushroom): open=" + bd.sideOpen + " row=" + (bd.side ? bd.side.row : "none"))
    expect(bd.sideOpen).toBe(true)
    expect(bd.side.row).toBe("mushroom")
    mark("s1_hover_opens")
    await (ix as any).exitHover()
    await sleep(200)
    await (ix as any).enterHover(key("RowHit_stress", "FlyBoard"))
    await sleep(900)
    note("side after hover(stress): row=" + (bd.side ? bd.side.row : "none"))
    expect(bd.side.row).toBe("stress")
    mark("s2_hover_swaps")
    // left OPEN on purpose: screenshot the side panel now
  }
}
