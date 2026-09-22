import { BaseButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import { SessionController } from "../../Core/SessionController"
import { SyncKitLogger } from "../../Utils/SyncKitLogger"
import { ErrorMessageController, ErrorType } from "./ErrorMessageController"
import { StartModeController, StartMode } from "./StartModeController"

const TAG = "StartMenu"

const ERROR_DURATION_SECONDS = 4 // seconds

@component
export class StartMenu extends BaseScriptComponent {
  @input
  private readonly singlePlayerButton: BaseButton

  @input
  private readonly multiPlayerButton: BaseButton

  @input("float", "150.0")
  private readonly startMenuDistanceFromUser: number

  @input("string", "manual")
  @widget(
    new ComboBoxWidget([
      new ComboBoxItem("Manual", "manual"),
      new ComboBoxItem("Mocked Online (Automatic)", "mocked_online")
    ])
  )
  private readonly singlePlayerType: "manual" | "mocked_online" = "manual"

  @input
  private readonly enableOnSingleplayerNodes: SceneObject[]

  private worldCamera: WorldCameraFinderProvider

  private startMenuTransform: Transform

  private readonly log = new SyncKitLogger(TAG)

  constructor() {
    super()
    this.worldCamera = WorldCameraFinderProvider.getInstance()
    this.startMenuTransform = this.sceneObject.getTransform()

    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  private onStart() {
    // Re-enable the start menu if the connection fails
    SessionController.getInstance().onConnectionFailed.add((code: string, description: string) => {
      // Intentional cancellation and errors use the same callback, so we need to check the code
      if (code !== "CancelledByUser") {
        this.log.w(`Connection failed (${code}): ${description}, showing error alert`)
        ErrorMessageController.getInstance().showError(ErrorType.ConnectionFailed, this.getSceneObject(), ERROR_DURATION_SECONDS)
      } else {
        this.log.i("Connection cancelled by user, not showing error alert")
      }
      
      // Only re-enable the start menu if we're in Menu mode
      // Auto-start mode handles failures with retries, not by showing the menu
      const controller = StartModeController.getInstance()
      if (controller.getAutoStartMode() === StartMode.Menu) {
        this.getSceneObject().enabled = true
        this.setStartMenuInFrontOfUser()
      }
    })

    this.setStartMenuInFrontOfUser()
    
    // Connect to the new button events using BaseButton's onTriggerUp
    this.singlePlayerButton.onTriggerUp.add(() => this.onSinglePlayerPress())
    this.multiPlayerButton.onTriggerUp.add(() => this.onMultiPlayerPress())
  }

  /**
   * Handle multiplayer button press with internet connectivity check
   */
  private onMultiPlayerPress() {
    this.log.i("Multiplayer button pressed")
    
    if (!global.deviceInfoSystem.isInternetAvailable()) {
      this.log.w("No internet available, showing alert")
      ErrorMessageController.getInstance().showError(ErrorType.NoInternet, this.getSceneObject(), ERROR_DURATION_SECONDS)
    } else {
      this.startMultiplayerSession()
    }
  }

  /**
   * Start the game in single player mode by hiding this menu.
   */
  private onSinglePlayerPress() {
    switch (this.singlePlayerType) {
      case "mocked_online":
        SessionController.getInstance().prepareOfflineMode()

        this.enableOnSingleplayerNodes.forEach((node) => {
          node.enabled = true
        })

        this.startMultiplayerSession()
        break

      case "manual":
      default:
        this.enableOnSingleplayerNodes.forEach((node) => {
          node.enabled = true
        })

        this.getSceneObject().enabled = false
        break
    }
  }

  /**
   * Start the session by initializing the Spectacles Sync Kit, and hiding this menu.
   */
  private startMultiplayerSession() {
    this.log.i("Starting session")
    this.getSceneObject().enabled = false
    SessionController.getInstance().init()
  }

  /**
   * Public method to start multiplayer session (called by StartMenuController)
   */
  public startMultiplayer() {
    this.startMultiplayerSession()
  }

  /**
   * Public method to show the start menu (called by StartMenuController)
   */
  public show() {
    this.getSceneObject().enabled = true
    this.setStartMenuInFrontOfUser()
  }

  /**
   * Public method to hide the start menu (called by StartMenuController)
   */
  public hide() {
    this.getSceneObject().enabled = false
  }

  private setStartMenuInFrontOfUser() {
    const head = this.worldCamera.getTransform().getWorldPosition()
    const forward = this.worldCamera.getTransform().forward
    forward.y = 0
    const pos = forward.normalize().uniformScale(-this.startMenuDistanceFromUser)
    this.startMenuTransform.setWorldPosition(head.add(pos))

    this.startMenuTransform.setWorldRotation(quat.lookAt(pos.uniformScale(-1), vec3.up()))
  }
}
