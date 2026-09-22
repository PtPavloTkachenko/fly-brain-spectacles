/**
 * LeafIndex — the LEAF scenarios of CyberFly (docs/knowledge/TESTING.md). Attached to the
 * `LeafIndex` scene object; the LEAF panel lists these ids and runs them in the preview.
 */
import { scenariosIndex } from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import { ScanCardHoldScenario } from "./ScanCardHoldScenario"
import { InspectThingScenario } from "./InspectThingScenario"
import { RowHoverPanelScenario } from "./RowHoverPanelScenario"
import { BrainLostScenario } from "./BrainLostScenario"
import { ScenarioMetadata } from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"
import { GripAndGuideScenario } from "./GripAndGuideScenario"
import { ProbeKeyScenario } from "./ProbeKeyScenario"
import { StartToBoardScenario } from "./StartToBoardScenario"
import { TrainFoodSessionScenario } from "./TrainFoodSessionScenario"
import { WebBrainHandoverScenario } from "./WebBrainHandoverScenario"

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    { id: "probe_key", typename: ProbeKeyScenario.getTypeName() },
    { id: "start_to_board", typename: StartToBoardScenario.getTypeName() },
    { id: "web_brain_handover", typename: WebBrainHandoverScenario.getTypeName() },
    { id: "train_food_session", typename: TrainFoodSessionScenario.getTypeName() },
    { id: "grip_and_guide", typename: GripAndGuideScenario.getTypeName() },
    { id: "scan_card_hold", typename: ScanCardHoldScenario.getTypeName() },
    { id: "inspect_thing", typename: InspectThingScenario.getTypeName() },
    { id: "row_hover_panel", typename: RowHoverPanelScenario.getTypeName() },
    { id: "brain_lost", typename: BrainLostScenario.getTypeName() },
  ]
}
