import {StorageProperty} from "../../Core/StorageProperty"
import {StoragePropertySet} from "../../Core/StoragePropertySet"
import {SyncEntity} from "../../Core/SyncEntity"

@component
export class CurrentTimeObject extends BaseScriptComponent {
  currentTimeStorageProperty = StorageProperty.manualInt("currentTime", 0)

  private storagePropertySet = new StoragePropertySet([
    this.currentTimeStorageProperty,
  ])

  private syncEntity = new SyncEntity(this, this.storagePropertySet, true)

  private onAwake(): void {
    this.createEvent("UpdateEvent").bind(() => this.onUpdate())
  }

  onUpdate(): void {
    if (this.syncEntity.doIOwnStore()) {
      this.currentTimeStorageProperty.setPendingValue(Math.floor(getTime()))
    }
  }
}
