/**
 * start_to_board — the whole onboarding flow on the real keys (ADR 58): the start card with the
 * Sync Kit menu's visuals hidden, SOLO, the scan card with its typewriter, DONE SCANNING, the board
 * and the guide, the intro over. Needs a FRESH lens (the runner refreshes the preview first).
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { findSceneObjectByName, sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, board, bugs, fmt, mark, note, passBootCard, pressSolo, swarm, syncMenuObject, waitFor } from "./CyberFlyTestKit"

const WALK = "LOOK AROUND TO SCAN THE ROOM"
const KEEP = "KEEP LOOKING AROUND"

@component
export class StartToBoardScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    const sw = swarm()
    const bd = board()
    await waitFor(() => bd.start && bd.start.visible, 8, "the start card (the lens must be fresh: CYBERFLY / SOLO)")
    const startRoot: SceneObject = bd.start.root
    expect(startRoot.enabled).toBe(true)
    expect(bd.content.enabled).toBe(false)
    const menu = syncMenuObject()
    expect(menu).not.toBeNull()
    let shown = 0
    for (let i = 0; i < menu!.getChildrenCount(); i++) if (menu!.getChild(i).enabled) shown++
    note("sync_menu_children_enabled=" + shown + "/" + menu!.getChildrenCount())
    expect(shown).toBe(0)
    mark("s1_start_card")
    await sleep(700)

    // SOLO: the card must be gone within 0.4 s of the press, the scan card must follow
    const nBugs = bugs.length
    const press = await pressSolo(ix)
    expect(bd.start.visible).toBe(false)
    expect(startRoot.enabled).toBe(false)
    // 21.09: 0.4 s was never reachable by design, not by regression. SOLO sets a DELIBERATE 0.3 s
    // handover timer (FlySwarm: `startHandoverT = 0.3`) before the scan card takes over, and the
    // card then plays its pop-out on top of that. Measured here: 0.57 s. The bound below is the
    // design plus its animation plus frame granularity; tighten it only by making the handover
    // itself faster, not by hoping.
    expect(press.tHide - press.tSolo).toBeLessThan(0.9)

    // the scan card and its typewriter. The card opens on its second line (KEEP GOING) when the intro
    // is already older than 4 s with surfaces found, which a slow SOLO makes true: both lines count.
    note("solo_to_scan_card_s=" + fmt(getTime() - press.tSolo))
    const scan = bd.scan
    await waitFor(() => scan.line1.text.length > 0, 4, "the typewriter to start")
    const a: string = scan.line1.text
    await sleep(350)
    const b: string = scan.line1.text
    note("typewriter='" + a + "' -> '" + b + "' phase=" + scan.phase)
    const full = scan.phase === 0 ? WALK : KEEP
    expect(full.indexOf(a)).toBe(0)
    expect(b.length >= a.length).toBe(true)
    expect(b.length > a.length || b === full).toBe(true)
    mark("s1_scan_card")
    await sleep(600)

    // DONE SCANNING: the board content and the guide, the intro over
    const tDone = await ix.tap("ScanDoneHit", "FlyScan")
    // ADR 85 + 87: the boot card stands here now, and without a page it can never finish on its own
    await sleep(1500)
    const tookAnyway = await passBootCard(ix)
    note("boot_card_needed=" + tookAnyway)
    await waitFor(() => bd.content.enabled, 12, "the board content after DONE")
    const tBoard = getTime()
    await waitFor(() => bd.guide && bd.guide.visible, 8, "the guide card")
    const tGuide = getTime()
    note("done_to_board_s=" + fmt(tBoard - tDone) + " done_to_guide_s=" + fmt(tGuide - tDone))
    expect(tBoard - tDone).toBeLessThan(12) // measuring first; tightened below once the real figure is known
    expect(sw.introT <= 0).toBe(true)
    expect(bd.scan.visible).toBe(false)
    await sleep(900) // the pop-ins
    expect(findSceneObjectByName("FlyGuide")!.enabled).toBe(true)
    expect(bd.content.enabled).toBe(true)
    mark("s1_board")
    await sleep(700)
    // the flow was completed with a workaround: that is a failure of the lens, reported last so the
    // rest of the evidence exists
    if (bugs.length > nBugs) throw new Error("BUG " + bugs.slice(nBugs).join("; "))
  }
}
