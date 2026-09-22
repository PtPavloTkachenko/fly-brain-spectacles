import {SessionController} from "../Core/SessionController"
import {SyncKitLogger} from "../Utils/SyncKitLogger"
import {CustomLandmarkGuidanceBinding} from "./CustomLandmarkGuidanceBinding"

@component
export class CustomLandmarkController extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(CustomLandmarkController.name)

  @input
  private readonly locatedAtComponent: LocatedAtComponent

  @input
  private readonly guidancePrefab: ObjectPrefab

  // Optional parent for spawned guidance instance
  @input
  private readonly parentObject?: SceneObject

  private spawnedGuidanceRoot: SceneObject | null = null
  private spawnedGuidance: CustomLandmarkGuidanceBinding | null = null

  onAwake(): void {
    SessionController.getInstance().onConnected.add(() => this.onConnected())
    this.createEvent("OnDestroyEvent").bind(() => this.onDestroy())
  }

  private onConnected() {
    if (!this.locatedAtComponent) {
      this.log.w("No LocatedAtComponent provided; not spawning guidance")
      return
    }

    const hasLocation = this.locatedAtComponent.location !== null
    if (!hasLocation) {
      this.log.i("No location set; not spawning guidance")
      return
    }

    if (!this.guidancePrefab) {
      this.log.w("Missing instantiator or prefab; cannot spawn guidance")
      return
    }

    this.guidancePrefab.instantiateAsync(
      this.parentObject,
      (spawnedRoot) => {
        this.spawnedGuidanceRoot = spawnedRoot
        this.spawnedGuidance = spawnedRoot.getComponent(CustomLandmarkGuidanceBinding.getTypeName())
        this.log.i("CustomLandmarkGuidance spawned")
      },
      (error) => {
        this.log.e("Failed to instantiate CustomLandmarkGuidance: " + error)
      },
      () => {}
    )
  }

  private onDestroy() {
    if (this.spawnedGuidance) {
      this.spawnedGuidance.enabled = false
      this.spawnedGuidance = null
    }
  }
}
