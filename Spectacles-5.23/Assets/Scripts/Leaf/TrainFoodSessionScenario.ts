/**
 * train_food_session — a page drives a FOOD session (ADR 62/66/68): `cmd train mode=food cs=<thing>`
 * from page_sim.py (the runner reads the cue from this scenario's LEAF_THINGS line, nearest first),
 * TRAIN_START, one TRAIN_TRIAL row per presentation with the paired bout delivering 16 US pulses,
 * TRAIN_DONE, the evidence pack and the verdict (Gemini through the lens's gateway, or the local
 * reading — `via` says which), and the guide's result line changed. Budget: four minutes.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { nextFrame, sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, board, ensureBoard, fmt, line, mark, note, presentCue, swarm, waitFor } from "./CyberFlyTestKit"

// 21.09: a real page brain steps in ~45 ms and the fly has to actually fly to each cue, so a six
// bout session takes longer than the four minutes sized for page_sim's instant native core.
const SESSION_BUDGET_S = 900

@component
export class TrainFoodSessionScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    await ensureBoard(ix)
    const sw = swarm()
    const bd = board()
    const link = sw.link
    const tr = sw.train
    if (!tr) throw new Error("FlySwarm has no FlyTrainer")

    // what the room knows, nearest to the fly first: the runner names the cue from this line. A short
    // intro leaves Gemini's inventory empty; after it the scanner runs every EDITOR_SCAN_EVERY_S.
    const known = () => sw.sources.items.filter((s: any) => s.cls !== "threat" && s.cls !== "lure" && s.cls !== "fly")
    await waitFor(() => known().length >= 2, 90, "two known room things (Gemini scans of the preview scene)")
    const head: vec3 = sw.flies[0].pose().head
    const things: any[] = known()
    const list = things.map((s: any) => [s.label, Math.round(s.pos.distance(head))]).sort((a: any, b: any) => a[1] - b[1])
    line("LEAF_THINGS " + JSON.stringify(list))
    expect(list.length).toBeGreaterThan(0)
    mark("s4_need_page", "pin=" + link.pin)
    await waitFor(() => link.webActive, 150, "WEB_BRAIN_ON (page_sim --cmd train must be up)")
    mark("s4_web_on")
    const key0: string = bd.guide.key
    const result0: string = tr.state.result
    if (tr.running) note("trainer_was=" + tr.state.phase) // the page's order replaces it (TRAIN_DONE why=stopped)
    await waitFor(() => tr.running && tr.state.phase !== "menu" && tr.state.phase !== "done", 40, "TRAIN_START from the page's cmd")
    note("train_start mode=" + tr.state.mode + " bouts=" + tr.state.ofTrials)
    expect(tr.state.mode).toBe("food")
    mark("s4_train_start")
    await waitFor(() => tr.state.label.length > 0, 20, "TRAIN_CS (the cue named)")
    note("cs_plus='" + tr.state.label + "' cs_minus='" + tr.state.labelMinus + "'")

    // the session, one marker per presentation row
    // The session presents its cue by having a PERSON pick the thing up (ADR 70): class `object`
    // has no odour of its own, so without that the mushroom body never smells the CS and the first
    // probe never resolves. Nobody is here to pick anything up, so the test does it, out loud.
    const held = presentCue(tr.state.label, true)
    note("LEAF stands in for the wearer: holding up '" + tr.state.label + "' -> " + (held ? "presented" : "NO SUCH SOURCE"))
    expect(held).toBe(true)

    const t0 = getTime()
    let seen: number = tr.rows.length
    while (tr.state.phase !== "done") {
      if (getTime() - t0 > SESSION_BUDGET_S) {
        throw new Error("the session did not finish in " + SESSION_BUDGET_S + " s (phase " + tr.state.phase + ", rows " + tr.rows.length + ")")
      }
      if (!tr.running) throw new Error("the session stopped: " + tr.state.result)
      presentCue(tr.state.label, true) // the hand stays up: FlySwarm fades `present` every frame
      if (tr.rows.length > seen) {
        const r = tr.rows[tr.rows.length - 1]
        seen = tr.rows.length
        mark("s4_row" + seen, "cs" + r.cs + " n=" + r.n + " lat=" + (r.lat < 0 ? "MISS" : fmt(r.lat, 1) + "s") + " us=" + r.us + " learn=" + r.learn)
      }
      await nextFrame()
    }
    const plus = tr.rows.filter((r: any) => r.cs === "+")
    const usRows = plus.filter((r: any) => r.us >= 16)
    note("session_s=" + fmt(getTime() - t0, 1) + " rows=" + tr.rows.length + " us16_rows=" + usRows.length + " lat=[" + plus.map((r: any) => (r.lat < 0 ? "MISS" : fmt(r.lat, 1))).join(",") + "]")
    mark("s4_done", "why=done")
    expect(tr.rows.length).toBeGreaterThan(0)
    expect(usRows.length).toBeGreaterThan(0)

    // the verdict (TRAIN_PACK first, then Gemini or the local reading)
    await waitFor(() => !!tr.verdict, 45, "TRAIN_VERDICT")
    const v = tr.verdict
    note("verdict via='" + v.via + "' learned=" + v.learned + " conf=" + fmt(v.confidence) + " what='" + v.what + "'")
    expect(typeof v.via).toBe("string")
    expect(tr.state.result.length).toBeGreaterThan(0)
    expect(tr.state.result === result0).toBe(false)
    await waitFor(() => bd.guide.key !== key0 && bd.guide.key.indexOf(tr.state.result) >= 0, 5, "the guide's result line to change")
    note("guide_result='" + tr.state.result + "'")
    mark("s4_verdict", "via=" + v.via)
    await sleep(800)
  }
}
