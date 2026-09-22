/**
 * web_brain_handover — a page joins the room by PIN and becomes the brain (ADR 55): WEB_BRAIN_ON,
 * the board says WEB, the scene feed and the room surface go out, the step time falls under 300 ms;
 * then the page stops and the lens takes the brain back within PAGE_TIMEOUT_S (6 s) + 2 s.
 * The runner starts page_sim.py before this scenario and kills it on the `s3_stop_page` marker.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, board, ensureBoard, fmt, mark, note, swarm, waitFor } from "./CyberFlyTestKit"

const STEP = /step (\d+) ms/

@component
export class WebBrainHandoverScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    await ensureBoard(ix)
    const sw = swarm()
    const bd = board()
    const link = sw.link
    if (!link.pin) throw new Error("the link has no PIN (FlyConfig.BRAIN_NATIVE / WEB_BRAIN off?)")
    const stepBefore: number = link.latest[0] ? link.latest[0].wall_ms : -1
    note("pin=" + link.pin + " relay=" + (link.relayUp ? "up" : "down") + " joined=" + link.joined + " step_ms_before=" + stepBefore)
    mark("s3_need_page", "pin=" + link.pin)
    const t0 = getTime()
    await waitFor(() => link.webActive, 150, "WEB_BRAIN_ON (a page on pin " + link.pin + " must be up)")
    note("web_on_after_s=" + fmt(getTime() - t0) + " page='" + link.pageName + "'")
    await waitFor(() => link.latest[0] && link.latest[0].engine === "web", 15, "a brain message from the page")
    // 21.09: the header stopped saying "WEB" when ADR 84 replaced the jargon with plain words. It
    // reads "BRAIN ON A PAGE" now, and the pin header reads "PAGE ON". The lens was right and this
    // assertion was stale.
    await waitFor(() => bd.status.text.indexOf("PAGE") >= 0, 6, "the board status to name the page")
    note("status='" + bd.status.text + "'")
    expect(bd.status.text.indexOf("PAGE") >= 0).toBe(true)
    mark("s3_web_on")

    const feed = sw.sceneFeed
    if (!feed) throw new Error("no FlySceneFeed (FlyConfig.WEB_SCENE_FEED off?)")
    await waitFor(() => feed.sent >= 1, 6, "SCENE_FEED on")
    await waitFor(() => !!feed.surfHead, 12, "SURFACE (the room mesh for the page)")
    note("feed_sent=" + feed.sent + " surface=" + JSON.stringify(feed.surfHead))
    await waitFor(() => link.latest[0] && link.latest[0].engine === "web" && link.latest[0].wall_ms < 300, 25, "a page step under 300 ms")
    await waitFor(() => STEP.test(bd.footer.text) && parseInt(STEP.exec(bd.footer.text)![1], 10) < 300, 8, "the board footer to report a step under 300 ms")
    const stepWeb = parseInt(STEP.exec(bd.footer.text)![1], 10)
    note("step_ms_before=" + stepBefore + " step_ms_web=" + stepWeb + " footer='" + bd.footer.text + "'")
    expect(stepWeb).toBeLessThan(300)
    expect(link.latest[0].engine).toBe("web")
    mark("s3_web_step", "step_ms=" + stepWeb)
    await sleep(500)

    // hand-back: the runner stops the page on this marker
    mark("s3_stop_page")
    const tStop = getTime()
    await waitFor(() => !link.webActive, 14, "WEB_BRAIN_OFF after the page stopped")
    const tOff = getTime()
    const quiet: number = link.webT - link.pageSeenAt // how long the page had been silent when the lens took over
    note("stop_to_web_off_s=" + fmt(tOff - tStop) + " page_quiet_s=" + fmt(quiet))
    expect(quiet).toBeGreaterThan(5.9) // PAGE_TIMEOUT_S
    expect(quiet).toBeLessThan(8) // + 2 s
    expect(tOff - tStop).toBeLessThan(10) // the runner's reaction to the marker included
    await waitFor(() => bd.status.text.indexOf("WEB") < 0, 8, "the board status to leave WEB")
    note("status_after='" + bd.status.text + "' engine=" + (link.latest[0] ? link.latest[0].engine : "-"))
    mark("s3_web_off")
    await sleep(600)
  }
}
