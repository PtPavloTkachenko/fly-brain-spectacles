import {BaseButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"
import {SessionController} from "../Core/SessionController"
import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {DefaultGuidanceCopy} from "./GuidanceCopy"
import {SimplifiedLandmarkGuidanceController} from "./SimplifiedLandmarkGuidance"

@component
export class CustomLandmarkGuidanceBinding extends BaseScriptComponent {
  // Guidance
  @input
  private readonly guidanceRoot: SceneObject
  @input
  private readonly guidanceText: Text
  @input
  private readonly arrow: SceneObject

  // Troubleshooting
  @input
  private readonly troubleshootingRoot: SceneObject
  @input
  private readonly titleText: Text
  @input
  private readonly bullet1Title: Text
  @input
  private readonly bullet1Copy: Text
  @input
  private readonly bullet2Title: Text
  @input
  private readonly bullet2Copy: Text
  @input
  private readonly bullet3Title: Text
  @input
  private readonly bullet3Copy: Text
  @input
  private readonly bullet4Title?: Text
  @input
  private readonly bullet4Copy?: Text
  @input
  private readonly keepLookingButton: BaseButton

  // Success
  @input
  private readonly successRoot: SceneObject
  @input
  private readonly successText: Text

  @input("int", "30000")
  private readonly guidanceTimeoutMs: number = 30000

  @input("int", "1000")
  private readonly successVisibleMs: number = 1000

  private controller: SimplifiedLandmarkGuidanceController
  private readonly log = new SyncKitLogger("CustomLandmarkGuidanceBinding")
  private isLocatedFlag: boolean = false
  private lastHasLocation: boolean | null = null
  private lastIsLocated: boolean | null = null

  onAwake() {
    // Start hidden
    this.hideAll()

    // Bind lifecycle events here so OnStart actually fires
    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private onStart() {
    // Instantiate controller first
    this.controller = new SimplifiedLandmarkGuidanceController(
      {
        guidanceRoot: this.guidanceRoot,
        guidanceText: this.guidanceText,
        arrow: this.arrow,
        troubleshootingRoot: this.troubleshootingRoot,
        titleText: this.titleText,
        bullet1Title: this.bullet1Title,
        bullet1Copy: this.bullet1Copy,
        bullet2Title: this.bullet2Title,
        bullet2Copy: this.bullet2Copy,
        bullet3Title: this.bullet3Title,
        bullet3Copy: this.bullet3Copy,
        bullet4Title: this.bullet4Title,
        bullet4Copy: this.bullet4Copy,
        keepLookingButton: this.keepLookingButton,
        successRoot: this.successRoot,
        successText: this.successText
      },
      {
        copy: DefaultGuidanceCopy,
        guidanceTimeoutMs: this.guidanceTimeoutMs,
        successVisibleMs: this.successVisibleMs,
        initialGuidanceHoldMs: 2000
      }
    )

    // Initial start always transitions into guidance (controller enforces 2s hold)
    const {hasLocation, isLocated} = this.readLocatedInputs()
    this.lastHasLocation = hasLocation
    this.lastIsLocated = isLocated
    this.controller.start()
  }

  private onDestroy() {
    this.controller.stop()
  }

  private readLocatedInputs(): {hasLocation: boolean; isLocated: boolean} {
    const session = SessionController.getInstance()
    const locatedAt = (session.getLocatedAtComponent && session.getLocatedAtComponent()) as LocatedAtComponent | null
    const hasLocation = !!(locatedAt && locatedAt.location !== null)
    const isLocated = this.isLocatedFlag
    return {hasLocation, isLocated}
  }

  private hideAll() {
    if (this.guidanceRoot) this.guidanceRoot.enabled = false
    if (this.troubleshootingRoot) this.troubleshootingRoot.enabled = false
    if (this.successRoot) this.successRoot.enabled = false
  }
}
