import {HSLToRGB} from "SpectaclesInteractionKit.lspkg/Utils/color"
import {StorageProperty} from "../../Core/StorageProperty"
import {StoragePropertySet} from "../../Core/StoragePropertySet"
import {SyncEntity} from "../../Core/SyncEntity"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"

// The speed at which the hue changes
const COLOR_CHANGE_SPEED = 30

@component
export class ColorStoragePropertyExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(ColorStoragePropertyExample.name)

  @input
  myRmv: RenderMeshVisual = null

  private myPropRmv = StorageProperty.forMeshVisualBaseColor(this.myRmv, true)

  private myStoragePropertySet = new StoragePropertySet([this.myPropRmv])

  private syncEntity: SyncEntity = new SyncEntity(this, this.myStoragePropertySet, true)

  onAwake(): void {
    this.createEvent("UpdateEvent").bind(() => this.updateColor())
  }

  private updateColor(): void {
    if (!this.syncEntity.doIOwnStore()) {
      this.log.i("Not the syncEntity owner, not changing anything.")
      return
    }

    const numChars = getTime() * COLOR_CHANGE_SPEED
    const newColor = HSLToRGB(new vec3(numChars % 360, 1, 0.5))
    this.myRmv.mainMaterial.mainPass.baseColor = new vec4(newColor.x, newColor.y, newColor.z, 1)
  }
}
