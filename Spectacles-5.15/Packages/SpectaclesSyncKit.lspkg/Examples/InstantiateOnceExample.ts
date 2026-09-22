import {InstantiationOptions, Instantiator} from "../Components/Instantiator"
import {SyncEntity} from "../Core/SyncEntity"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

@component
export class InstantiateOnceExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    InstantiateOnceExample.name,
  )

  private syncEntity: SyncEntity = new SyncEntity(this, null, true)

  @input()
  instantiator: Instantiator

  @input()
  prefab: ObjectPrefab

  @input()
  claimOwnership: boolean = true

  onAwake(): void {
    this.syncEntity.notifyOnReady(() => {
      this.onReady()
    })
  }

  onReady(): void {
    if (this.syncEntity.doIOwnStore()) {
      this.instantiator.notifyOnReady(() => {
        const options = new InstantiationOptions()
        options.claimOwnership = this.claimOwnership
        this.instantiator.instantiate(this.prefab, options)
      })
    }
  }
}
