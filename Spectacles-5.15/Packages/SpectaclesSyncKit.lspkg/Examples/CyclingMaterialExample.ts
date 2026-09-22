import {SyncEntity} from "../Core/SyncEntity"
import {SyncKitLogger} from "../Utils/SyncKitLogger"

@component
export class CyclingMaterialExample extends BaseScriptComponent {
  private readonly log: SyncKitLogger = new SyncKitLogger(
    CyclingMaterialExample.name
  )

  private syncEntity: SyncEntity = new SyncEntity(this, null, true)

  @input
  myRmv: RenderMeshVisual = null

  onAwake(): void {
    this.createEvent("UpdateEvent").bind(() => this.updateMaterial())
  }

  private updateMaterial(): void {
    if (!this.syncEntity.doIOwnStore()) {
      return
    }

    const myMaterial = this.myRmv.mainMaterial
    const myPass = myMaterial.mainPass

    // Set these to reasonable cycling values
    const stripiness = Math.sin(getTime() * 2) * 0.5 + 0.5
    const enableStripes = Math.floor(getTime() * 0.5) % 2 === 0
    const stripeColor = new vec4(getTime() % 1, 0, 1, 1)
    const stripeScale = new vec2(1, 1).uniformScale((1 + (getTime() % 1)) * 20)

    myPass.stripeColor = stripeColor
    myPass.stripeScale = stripeScale
    myPass.stripes = stripiness
    myPass.enableStripes = enableStripes
  }
}
