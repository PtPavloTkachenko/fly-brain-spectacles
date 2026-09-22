import {StorageProperty} from "../../Core/StorageProperty"
import {StoragePropertySet} from "../../Core/StoragePropertySet"
import {StorageTypes} from "../../Core/StorageTypes"
import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"

// The speed at which the property changes
const PROP_CHANGE_SPEED = 1

@component
export class RmvPropertyStoragePropertyExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    RmvPropertyStoragePropertyExample.name
  )

  @input
  myRmv: RenderMeshVisual = null

  private myPropRmv = StorageProperty.forMeshVisualProperty(
    this.myRmv,
    "stripes",
    StorageTypes.float,
    true
  )

  private myStoragePropertySet = new StoragePropertySet([this.myPropRmv])

  private syncEntity: SyncEntity = new SyncEntity(
    this,
    this.myStoragePropertySet,
    true
  )

  onAwake(): void {
    this.myRmv.mainMaterial.mainPass.baseColor = new vec4(0, 1, 0, 1)
    this.createEvent("UpdateEvent").bind(() => this.updateProp())
  }

  private updateProp(): void {
    if (!this.syncEntity.doIOwnStore()) {
      this.log.i("Not the syncEntity owner, not changing anything.")
      return
    }

    const stripes = (getTime() * PROP_CHANGE_SPEED) % 1
    this.myRmv.mainMaterial.mainPass["stripes"] = stripes
  }
}
