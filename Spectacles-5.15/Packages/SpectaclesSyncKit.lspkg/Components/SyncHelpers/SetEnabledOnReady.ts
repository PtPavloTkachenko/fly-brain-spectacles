import {SessionController} from "../../Core/SessionController"
import {SyncEntity} from "../../Core/SyncEntity"

/**
 * Enables or disables groups of SceneObjects based on the readiness of a SyncEntity, or
 * SessionController if SyncEntity is not set.
 * When this script first runs, if the SyncEntity or SessionController is not ready, objects in readyObjects
 * will be disabled, and objects in notReadyObjects will be enabled.
 * As soon as the SyncEntity or SessionController are ready (including when the script first runs),
 * objects in notReadyObjects will be disabled, and objects in readyObjects will be enabled.
 */
@component
export class SetEnabledOnReady extends BaseScriptComponent {
  @ui.group_start("Entity Target")
  @input("string", "SyncEntity")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Sync Entity", "SyncEntity"),
      new ComboBoxItem("Network Root", "NetworkRoot"),
    ]),
  )
  @label("Target Type")
  private readonly targetTypeString: "SyncEntity" | "NetworkRoot" = "SyncEntity"

  @input
  @showIf("targetTypeString", "SyncEntity")
  private readonly syncEntityScript: ScriptComponent

  @ui.group_end
  @input
  private readonly readyObjects: SceneObject[]

  @input
  private readonly notReadyObjects: SceneObject[]

  private syncEntity: SyncEntity | null

  private onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.init())
  }

  /**
   * Sets the enabled state of all objects in the array.
   * @param objects - The array of SceneObjects.
   * @param enabled - The enabled state to set.
   */
  private setAllEnabled(objects: SceneObject[], enabled: boolean) {
    for (let i = 0; i < objects.length; i++) {
      objects[i].enabled = enabled
    }
  }

  /**
   * Updates the enabled state of the ready and not ready objects based on the readiness of the target.
   */
  private updateReady() {
    const isReady =
      this.targetTypeString === "SyncEntity"
        ? this.syncEntity.isSetupFinished
        : SessionController.getInstance().getIsReady()
    if (isReady) {
      this.setAllEnabled(this.notReadyObjects, false)
      this.setAllEnabled(this.readyObjects, true)
    } else {
      this.setAllEnabled(this.readyObjects, false)
      this.setAllEnabled(this.notReadyObjects, true)
    }
  }

  /**
   * Initializes the component by setting up the appropriate event listeners and updating the ready state.
   */
  private init() {
    switch (this.targetTypeString) {
      case "SyncEntity":
        this.syncEntity = SyncEntity.getSyncEntityOnComponent(
          this.syncEntityScript,
        )
        this.syncEntity.onSetupFinished.add(() => this.updateReady())
        this.updateReady()
        break
      case "NetworkRoot":
        SessionController.getInstance().notifyOnReady(() => this.updateReady())
        this.updateReady()
        break
    }
  }
}
