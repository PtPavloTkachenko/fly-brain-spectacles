/**
 * inspect_thing — pointing at a scanned thing is an INSPECTOR (21.09 Pavlo): no box, floor rings
 * for the reach, and a caption that says what it smells of to her and what it means.
 *
 * Gets past the intro, waits for the room scan to name a thing, taps its attention hit, and
 * checks the caption's lines. It leaves the thing ATTENDED on purpose, for a screenshot.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { expect } from "Leaf.lspkg/Utils/common/Expect"
import { sleep } from "Leaf.lspkg/Utils/common/Utils"
import { CyberFlyLeafInteractor, ensureBoard, fmt, mark, note, swarm, waitFor } from "./CyberFlyTestKit"

@component
export class InspectThingScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    await ensureBoard(ix)
    const sw = swarm()
    const pick = () => (sw.sources.items as any[]).find((s) => s.cls === "object" || s.cls === "scent" || s.cls === "food")
    await waitFor(() => !!pick(), 30, "a scanned thing (Gemini's room inventory)")
    const s = pick()
    note("thing label='" + s.label + "' id=" + s.id + " cls=" + s.cls + " smell=" + fmt(s.smell) + " reach=" + fmt(s.sigma, 0) + "cm")
    mark("s1_thing_named")
    await ix.tap("AttnHit_" + s.id, "FlyAttention")
    await sleep(1400) // pop-in + the caption rebuild
    const att = sw.attention
    expect(att).not.toBeNull()
    const attended = att.attended
    expect(attended).not.toBeNull()
    expect(attended.id).toBe(s.id)
    const lines: { text: string }[] = att.capLines(attended)
    note("caption=" + lines.map((l) => "[" + l.text + "]").join(" "))
    expect(lines.length >= 3).toBe(true)
    expect(lines[0].text).toBe(String(s.label).toUpperCase())
    expect(lines[1].text.indexOf("to her: the smell of")).toBe(0)
    expect(lines[lines.length - 1].text.length > 0).toBe(true) // the meaning line is always there
    note("rings=" + (att.ringOn ? "on" : "OFF") + " boxDrawn=false(BOX_SHOWN)")
    expect(att.ringOn).toBe(true)
    mark("s2_inspector_ok")
    // left ATTENDED on purpose: screenshot the rings + caption now
  }
}
