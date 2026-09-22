/**
 * probe_key — why a card key hovers but never triggers.
 *
 * start_to_board hangs inside LEAF's own `executeTrigger`: `enterHover` succeeds and then
 * `await awaitEventOnce(target.onTriggerStart)` never resolves. This scenario does not try to
 * press anything. It reports the state of the interactable so the next change is aimed, not
 * guessed: is the object enabled, what targeting mode does it carry, is the Interactable enabled,
 * and does SIK see it at all.
 */
import { Scenario } from "Leaf.lspkg/Scenarios/scenario/Scenario"
import { sleep } from "Leaf.lspkg/Utils/common/Utils"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { CyberFlyLeafInteractor, board, key, note, waitFor } from "./CyberFlyTestKit"

@component
export class ProbeKeyScenario extends Scenario {
  async run(): Promise<void> {
    const ix = new CyberFlyLeafInteractor()
    const bd = board()
    await waitFor(() => bd.start && bd.start.visible, 12, "the start card")
    await sleep(900)

    const it = key("StartSoloHit", "FlyStart")
    const so = it.getSceneObject()
    note("PROBE object='" + so.name + "' enabled=" + so.enabled + " parentEnabled=" + (so.getParent() ? so.getParent().enabled : "none"))
    note("PROBE interactable enabled=" + it.enabled + " targetingMode=" + (it as any).targetingMode)
    const col = so.getComponent("Physics.ColliderComponent") as any
    note("PROBE collider=" + (col ? "yes enabled=" + col.enabled : "MISSING"))
    const t = so.getTransform()
    const p = t.getWorldPosition()
    note("PROBE worldPos=" + p.x.toFixed(1) + "," + p.y.toFixed(1) + "," + p.z.toFixed(1) +
      " scale=" + t.getWorldScale().x.toFixed(2) + "," + t.getWorldScale().y.toFixed(2))

    // does SIK fire ANY of its events on this interactable while the interactor hovers it?
    let hoverIn = 0, hoverOut = 0, trigStart = 0, trigEnd = 0, trigCancel = 0
    const u1 = it.onHoverEnter.add(() => hoverIn++)
    const u2 = it.onHoverExit.add(() => hoverOut++)
    const u3 = it.onTriggerStart.add(() => trigStart++)
    const u4 = it.onTriggerEnd.add(() => trigEnd++)
    const u5 = (it as any).onTriggerCanceled ? (it as any).onTriggerCanceled.add(() => trigCancel++) : () => {}

    // hover only, no trigger: this must not hang
    await (ix as any).enterHover(it)
    await sleep(500)
    note("PROBE after hover: hoverEnter=" + hoverIn + " hoverExit=" + hoverOut +
      " triggerStart=" + trigStart + " triggerEnd=" + trigEnd + " triggerCanceled=" + trigCancel)

    // now ask SIK's own interactor what it is targeting
    const sik = (ix as any).sikInteractor
    if (sik) {
      note("PROBE sik interactor: enabled=" + sik.enabled +
        " currentInteractable=" + (sik.currentInteractable ? sik.currentInteractable.getSceneObject().name : "none") +
        " activeTargetingMode=" + sik.activeTargetingMode +
        " isActive=" + (typeof sik.isActive === "function" ? sik.isActive() : sik.isActive))
    } else note("PROBE sik interactor: NOT REACHABLE")

    // Does the Select signal reach SIK at all? executeTrigger sets `overrideTrigger` and then waits
    // on onTriggerStart; if the interactor never reports Select to SIK, that wait is forever.
    const before = trigStart
    ;(ix as any).overrideTrigger = 1 // InteractorTriggerType.Select
    for (let i = 0; i < 12; i++) {
      await sleep(60)
      const cur = sik ? (typeof sik.currentTrigger === "function" ? sik.currentTrigger() : sik.currentTrigger) : "n/a"
      if (i === 0 || i === 5 || i === 11) note("PROBE frame" + i + " sikTrigger=" + cur + " triggerStart=" + trigStart)
      if (trigStart > before) { note("PROBE SELECT REACHED SIK on frame " + i); break }
    }
    ;(ix as any).overrideTrigger = 0
    await sleep(200)
    note("PROBE final triggerStart=" + trigStart + " triggerEnd=" + trigEnd)
    await (ix as any).exitHover()
    u1(); u2(); u3(); u4(); u5()
    note("PROBE done")
    await sleep(400)
  }
}
