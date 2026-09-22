import { Singleton } from "SpectaclesInteractionKit.lspkg/Decorators/Singleton"
import { SessionController } from "../../Core/SessionController"
import { SyncKitLogger } from "../../Utils/SyncKitLogger"
import { ErrorMessageController, ErrorType } from "./ErrorMessageController"

const TAG = "AutoStartController"

// Retry configuration constants for server-side connection errors
const INITIAL_RETRY_DELAY = 5.0     // seconds - starting delay between retry attempts
const BACKOFF_MULTIPLIER = 2.0      // multiplier - exponential backoff factor (1s → 2s → 4s → 8s...)
const MAX_RETRY_DELAY = 30.0        // seconds - maximum delay between retry attempts
const MAX_RETRIES = 5               // count - maximum number of retry attempts before giving up

// Fast retry configuration for internet connectivity checks (local API, no server risk)
const INTERNET_CHECK_RETRY_DELAY = 0.5  // seconds - fast retry interval for internet checks

/**
 * Component that manages auto-start configuration
 */
@component
export class AutoStartControllerComponent extends BaseScriptComponent {
  onAwake() {
    // Register this component with the singleton controller
    AutoStartController.getInstance().registerComponent(this)
  }
}

/**
 * Singleton that handles auto-start logic with retry mechanisms
 */
@Singleton
export class AutoStartController {
  public static getInstance: () => AutoStartController

  private component: AutoStartControllerComponent | null = null
  private readonly log = new SyncKitLogger(TAG)
  private retryCount: number = 0
  private currentRetryDelay: number
  private retryTimeoutEvent: DelayedCallbackEvent | null = null
  private internetRetryTimeoutEvent: DelayedCallbackEvent | null = null
  private onStartMultiplayerCallback: (() => void) | null = null

  constructor() {
    this.currentRetryDelay = INITIAL_RETRY_DELAY
  }

  /**
   * Register the component instance with this singleton
   */
  public registerComponent(component: AutoStartControllerComponent) {
    if (this.component !== null) {
      throw new Error("AutoStartController: Attempted to register a second component. Only one AutoStartControllerComponent should exist in the scene.")
    }
    this.component = component

    // Set up connection failure handling for auto-reconnection
    this.setupConnectionHandlers()
    
    this.log.i("AutoStartController component registered")
  }

  /**
   * Set up connection event handlers for auto-retry logic
   */
  private setupConnectionHandlers() {
    // Subscribe to connection failures for auto-reconnection
    SessionController.getInstance().onConnectionFailed.add((code: string, description: string) => {
      if (code !== "CancelledByUser") {
        ErrorMessageController.getInstance().showError(ErrorType.ConnectionFailed) // Show indefinitely for auto-connect
        this.log.w(`Connection failed (${code}): ${description}, attempting auto-reconnect`)
        this.scheduleRetry()
      }
    })

    // Subscribe to successful connections to hide errors and reset retry state
    SessionController.getInstance().onConnected.add(() => {
      ErrorMessageController.getInstance().hideErrors()
      this.resetRetryState()
    })
  }

  /**
   * Set the callback function to be called when starting multiplayer
   */
  public setStartMultiplayerCallback(callback: () => void) {
    this.onStartMultiplayerCallback = callback
  }

  /**
   * Start multiplayer session directly with retry logic
   */
  public startMultiplayerWithRetry() {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    this.startMultiplayerWithBackoff()
  }

  /**
   * Start multiplayer with internet connectivity check and backoff
   */
  private startMultiplayerWithBackoff() {
    if (!global.deviceInfoSystem.isInternetAvailable()) {
      this.log.w("No internet available for auto-start, showing error and retrying quickly")
      ErrorMessageController.getInstance().showError(ErrorType.NoInternet) // Show indefinitely for auto-connect
      this.scheduleInternetRetry()
      return
    }

    // Hide any existing errors before starting multiplayer
    ErrorMessageController.getInstance().hideErrors()
    this.startMultiplayer()
  }

  /**
   * Start multiplayer session
   */
  private startMultiplayer() {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    this.log.i("Starting multiplayer session via auto-start")
    this.resetRetryState()
    
    // Call the callback if set, otherwise default to SessionController.init()
    if (this.onStartMultiplayerCallback) {
      this.onStartMultiplayerCallback()
    } else {
      SessionController.getInstance().init()
    }
  }

  /**
   * Schedule a retry attempt with exponential backoff
   */
  private scheduleRetry() {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    if (this.retryCount >= MAX_RETRIES) {
      this.log.e(`Max retries (${MAX_RETRIES}) reached, showing connection failed error`)
      ErrorMessageController.getInstance().showError(ErrorType.ConnectionFailed) // Show indefinitely for auto-connect
      return
    }

    this.retryCount++
    this.log.i(`Scheduling retry ${this.retryCount}/${MAX_RETRIES} in ${this.currentRetryDelay} seconds`)

    // Clear any existing retry timeout
    if (this.retryTimeoutEvent) {
      this.component.removeEvent(this.retryTimeoutEvent)
    }

    // Schedule the retry
    this.retryTimeoutEvent = this.component.createEvent("DelayedCallbackEvent")
    this.retryTimeoutEvent.bind(() => {
      this.log.i(`Attempting retry ${this.retryCount}/${MAX_RETRIES}`)
      this.startMultiplayerWithBackoff()
    })
    this.retryTimeoutEvent.reset(this.currentRetryDelay)

    // Calculate next retry delay with exponential backoff
    this.currentRetryDelay = Math.min(
      this.currentRetryDelay * BACKOFF_MULTIPLIER,
      MAX_RETRY_DELAY
    )
  }

  /**
   * Schedule a fast retry for internet connectivity checks (500ms interval)
   */
  private scheduleInternetRetry() {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    this.log.i(`Scheduling internet connectivity retry in ${INTERNET_CHECK_RETRY_DELAY} seconds`)

    // Clear any existing internet retry timeout
    if (this.internetRetryTimeoutEvent) {
      this.component.removeEvent(this.internetRetryTimeoutEvent)
    }

    // Schedule the fast internet retry
    this.internetRetryTimeoutEvent = this.component.createEvent("DelayedCallbackEvent")
    this.internetRetryTimeoutEvent.bind(() => {
      this.log.i("Checking internet connectivity again")
      this.startMultiplayerWithBackoff()
    })
    this.internetRetryTimeoutEvent.reset(INTERNET_CHECK_RETRY_DELAY)
  }

  /**
   * Reset retry state (called when connection succeeds)
   */
  private resetRetryState() {
    this.retryCount = 0
    this.currentRetryDelay = INITIAL_RETRY_DELAY
    
    // Clear both retry timers
    if (this.retryTimeoutEvent && this.component) {
      this.component.removeEvent(this.retryTimeoutEvent)
      this.retryTimeoutEvent = null
    }
    
    if (this.internetRetryTimeoutEvent && this.component) {
      this.component.removeEvent(this.internetRetryTimeoutEvent)
      this.internetRetryTimeoutEvent = null
    }
  }

  /**
   * Check if currently retrying connections (either type)
   */
  public isRetrying(): boolean {
    return this.retryCount > 0 || this.internetRetryTimeoutEvent !== null
  }

  /**
   * Get current retry count
   */
  public getRetryCount(): number {
    return this.retryCount
  }

  /**
   * Stop any ongoing retry attempts
   */
  public stopRetrying() {
    this.resetRetryState()
    ErrorMessageController.getInstance().hideErrors()
  }
}

// Export for JavaScript compatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).autoStartController = AutoStartController.getInstance()
