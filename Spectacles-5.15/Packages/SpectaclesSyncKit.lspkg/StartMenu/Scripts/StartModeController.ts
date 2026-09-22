import { Singleton } from "SpectaclesInteractionKit.lspkg/Decorators/Singleton"
import { SessionController } from "../../Core/SessionController"
import { SyncKitLogger } from "../../Utils/SyncKitLogger"
import { AutoStartController, AutoStartControllerComponent } from "./AutoStartController"
import { StartMenu } from "./StartMenu"
import { ErrorMessageController } from "./ErrorMessageController"

const TAG = "StartModeController"

export enum StartMode {
  Menu = "START_MENU",
  Multiplayer = "MULTIPLAYER", 
  Off = "OFF"
}

/**
 * Component that manages start mode configuration
 */
@component
export class StartModeControllerComponent extends BaseScriptComponent {
  @input
  startMenu: StartMenu

  @input
  autoStartController: AutoStartControllerComponent
  
  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.onStart())
  }

  onStart() {
    // Register this component with the singleton controller
    StartModeController.getInstance().registerComponent(this)
  }
}

/**
 * Singleton that handles start mode logic and state management
 */
@Singleton
export class StartModeController {
  public static getInstance: () => StartModeController

  private component: StartModeControllerComponent | null = null
  private readonly log = new SyncKitLogger(TAG)

  /**
   * Register the component instance with this singleton
   */
  public registerComponent(component: StartModeControllerComponent) {
    if (this.component !== null) {
      throw new Error("StartModeController: Attempted to register a second component. Only one StartModeControllerComponent should exist in the scene.")
    }
    this.component = component
    this.log.i("StartModeController component registered")

    const sessionController = SessionController.getInstance()
    const startMode = sessionController.getStartMode()
    
    this.log.i(`Start Mode Controller initialized with mode: ${startMode}`)

    // Check if started as multiplayer via launch params - this overrides the configured mode
    if (this.checkIfStartedAsMultiplayer()) {
      this.startMultiplayer()
      return
    }

    // Handle the different auto-start modes
    switch (startMode) {
      case StartMode.Menu:
        this.startWithMenu()
        break
      case StartMode.Multiplayer:
        this.startMultiplayer()
        break
      case StartMode.Off:
        this.log.i("Auto-start disabled.")
        break
    }
  }

  /**
   * Show the start menu
   */
  public startWithMenu() {
    ErrorMessageController.getInstance().hideAllErrors()

    this.log.i("Showing start menu")
    this.component.startMenu.show()
  }

  /**
   * Start without menu using AutoStartController for retry logic
   */
  public startMultiplayer() {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    this.log.i("Starting without menu - using AutoStartController for retry logic")
    
    this.component.startMenu.hide()

    // Set up the callback for the AutoStartController
    const autoStartController = AutoStartController.getInstance()
    autoStartController.setStartMultiplayerCallback(() => {
      SessionController.getInstance().init()
    })

    // Start multiplayer with retry logic
    autoStartController.startMultiplayerWithRetry()
  }

  /**
   * If the systemUI has requested that the lens launch directly into multiplayer mode,
   * immediately dismiss this menu and initialize the Spectacles Sync Kit.
   */
  private checkIfStartedAsMultiplayer(): boolean {
    const shouldStartMultiplayer = global.launchParams.getBool("StartMultiplayer")
    this.log.i(`Lens started as multiplayer: ${shouldStartMultiplayer}`)
    return shouldStartMultiplayer
  }

  /**
   * Get the current auto-start mode
   */
  public getAutoStartMode(): StartMode {
    const sessionController = SessionController.getInstance()
    const startMode = sessionController.getStartMode()

    // If started as multiplayer via launch params, always behave like AutoStart mode
    if (this.checkIfStartedAsMultiplayer()) {
      return StartMode.Multiplayer
    }

    return startMode as StartMode
  }

  /**
   * Check if the start mode should be shown based on current mode and conditions
   */
  public shouldShowStartMenu(): boolean {
    const sessionController = SessionController.getInstance()
    const startMode = sessionController.getStartMode()

    return startMode == StartMode.Menu
  }
}

// Export for JavaScript compatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).startMenuController = StartModeController.getInstance()
