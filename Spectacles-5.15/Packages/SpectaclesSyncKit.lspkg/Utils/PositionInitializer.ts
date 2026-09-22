import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {SessionController} from "../Core/SessionController"

@component
export class PositionInitializer extends BaseScriptComponent {
  @input("vec3", "{0, 0, -110}")
  private readonly positionInFrontOfCamera: vec3

  @input("boolean", "false")
  private readonly shouldFaceCamera: boolean

  @input("boolean", "true")
  private readonly triggerOnlyForFirstPlayer: boolean

  private worldCamera: WorldCameraFinderProvider

  private objectTransform: Transform

  private onAwake(): void {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  onStart()
  { 
    if (this.triggerOnlyForFirstPlayer && !SessionController.getInstance().getIsConnectionFirstJoiner()) {
      return
    }
    this.worldCamera = WorldCameraFinderProvider.getInstance()
    this.objectTransform = this.sceneObject.getTransform()
    this.setObjectPosition()
  }

  private setObjectPosition(): void {
    const head = this.worldCamera.getTransform().getWorldPosition()
    const right = this.worldCamera.getTransform().right
    right.y = 0
    const posX = right.normalize().uniformScale(this.positionInFrontOfCamera.x)

    const up = vec3.up()
    const posY = up.normalize().uniformScale(this.positionInFrontOfCamera.y)

    const forward = this.worldCamera.getTransform().forward
    forward.y = 0
    const posZ = forward.normalize().uniformScale(this.positionInFrontOfCamera.z)
    const pos = posX.add(posY).add(posZ)
    this.objectTransform.setWorldPosition(head.add(pos))

    if (this.shouldFaceCamera) {
      this.objectTransform.setWorldRotation(quat.lookAt(pos.uniformScale(-1), vec3.up()))
    }
  }
}
