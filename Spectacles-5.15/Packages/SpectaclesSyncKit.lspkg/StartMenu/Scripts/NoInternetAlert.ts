import {LSTween} from "LSTween.lspkg/LSTween"
import Easing from "LSTween.lspkg/TweenJS/Easing"
import {BaseButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"

@component
export class NoInternetAlert extends BaseScriptComponent {
  @input
  alert: SceneObject

  @input
  multiplayerButton: BaseButton

  private alertTransform: Transform
  private showAlertDuration: number = 4 // seconds
  private tweenDuration: number = 300 // milliseconds

  onStart() {
    this.multiplayerButton.onTriggerUp.add(() => {
      print("Multiplayer button trigger up")

      if (!global.deviceInfoSystem.isInternetAvailable()) {
        this.showAlert()
        const delayEvent = this.createEvent("DelayedCallbackEvent")
        delayEvent.bind(() => this.hideAlert())
        delayEvent.reset(this.showAlertDuration)
      }
    })
  }

  onAwake() {
    this.alertTransform = this.alert.getTransform()
    this.alert.enabled = false

    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  hideAlert() {
    print("Hiding alert")

    LSTween.scaleToLocal(this.alertTransform, vec3.zero(), this.tweenDuration)
      .easing(Easing.Cubic.In)
      .onComplete(() => {
        this.alert.enabled = false
      })
      .start()
  }

  showAlert() {
    print("Showing alert")

    this.alertTransform.setLocalScale(vec3.one())
    this.alert.enabled = true

    LSTween.scaleToLocal(this.alertTransform, new vec3(32, 32, 32), this.tweenDuration)
      .easing(Easing.Cubic.In)
      .start()
  }
}
