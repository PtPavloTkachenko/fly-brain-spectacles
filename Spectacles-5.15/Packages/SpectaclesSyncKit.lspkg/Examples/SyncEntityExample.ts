import {SyncEntity} from "../Core/SyncEntity"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

@component
export class SyncEntityExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    SyncEntityExample.name
  )

  onAwake(): void {
    const syncEntity: SyncEntity = new SyncEntity(this, null, true)

    syncEntity.notifyOnReady(() => this.onReady())
  }

  onReady(): void {
    this.log.i("Example Component: The sync entity is ready!")
  }
}
