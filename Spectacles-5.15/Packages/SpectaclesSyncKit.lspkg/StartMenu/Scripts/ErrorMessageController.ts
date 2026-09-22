import {LSTween} from "LSTween.lspkg/LSTween"
import Easing from "LSTween.lspkg/TweenJS/Easing"
import {Singleton} from "SpectaclesInteractionKit.lspkg/Decorators/Singleton"
import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import {SyncKitLogger} from "../../Utils/SyncKitLogger"

const TAG = "ErrorMessageController"

// Constants for error display timing
export const TWEEN_DURATION_MILLISECONDS = 300

export enum ErrorType {
  NoInternet = "no_internet",
  ConnectionFailed = "connection_failed"
}

/**
 * Component that manages error message configuration and scene object references
 */
@component
export class ErrorMessageControllerComponent extends BaseScriptComponent {
  @input
  private readonly noInternetErrorObject: SceneObject

  @input
  private readonly connectionFailedErrorObject: SceneObject

  @input
  private readonly errorDisplayContainer: SceneObject

  @input("float", "150.0")
  private readonly defaultDistanceFromUser: number = 150.0

  onAwake() {
    // Register this component with the singleton controller
    ErrorMessageController.getInstance().registerComponent(this)
  }

  public getNoInternetErrorObject(): SceneObject {
    return this.noInternetErrorObject
  }

  public getConnectionFailedErrorObject(): SceneObject {
    return this.connectionFailedErrorObject
  }

  public getErrorDisplayContainer(): SceneObject {
    return this.errorDisplayContainer
  }

  public getDefaultDistanceFromUser(): number {
    return this.defaultDistanceFromUser
  }
}

/**
 * Singleton that handles error message logic and state management
 */
@Singleton
export class ErrorMessageController {
  public static getInstance: () => ErrorMessageController

  private component: ErrorMessageControllerComponent | null = null
  private readonly log = new SyncKitLogger(TAG)
  private worldCamera: WorldCameraFinderProvider
  private activeErrors: Map<ErrorType, SceneObject> = new Map()

  // Animation settings
  private readonly alertScale: vec3 = new vec3(32, 32, 32) // scale when fully visible

  constructor() {
    this.worldCamera = WorldCameraFinderProvider.getInstance()
  }

  /**
   * Register the component instance with this singleton
   */
  public registerComponent(component: ErrorMessageControllerComponent) {
    if (this.component !== null) {
      throw new Error(
        "ErrorMessageController: Attempted to register a second component. Only one ErrorMessageControllerComponent should exist in the scene."
      )
    }
    this.component = component
    this.log.i("ErrorMessageController component registered")
  }

  /**
   * Show an error message
   * @param errorType - The type of error to show
   * @param parentObject - Optional parent object to attach the error to. If null, appears in front of user
   * @param timeout - Optional timeout in seconds. If null or undefined, shows indefinitely
   */
  public showError(errorType: ErrorType, parentObject?: SceneObject, timeout?: number) {
    this.log.i(`Showing error: ${errorType}`)

    // If this error is already showing, don't hide it or re-animate
    if (this.activeErrors.has(errorType)) {
      this.log.i(`Error ${errorType} is already showing, keeping it up`)
      return
    }

    // Get the appropriate object
    const errorObject = this.getObjectForError(errorType)
    if (isNull(errorObject)) {
      this.log.e(`No object configured for error type: ${errorType}`)
      return
    }

    // Hide all other existing errors before showing this one
    this.hideErrors()

    // Store the original parent for restoration later
    const originalParent = errorObject.getParent()

    // Position the error
    if (parentObject) {
      errorObject.setParent(parentObject)
      // Keep local position/rotation from the source object
    } else {
      // Use the error display container which has Headlock and Billboard components
      const errorContainer = this.component.getErrorDisplayContainer()
      if (errorContainer) {
        errorObject.setParent(errorContainer)
        // Reset to local origin since the container handles positioning
        errorObject.getTransform().setLocalPosition(vec3.zero())
        errorObject.getTransform().setLocalRotation(quat.quatIdentity())
      } else {
        // Fallback to original positioning if container is not available
        if (originalParent && this.component) {
          errorObject.setParent(this.component.getSceneObject())
        }
        this.positionInFrontOfUser(errorObject)
      }
    }

    // Store reference
    this.activeErrors.set(errorType, errorObject)

    // Animate in
    this.animateErrorIn(errorObject)

    // Schedule auto-hide if timeout is specified
    if (timeout !== undefined && timeout !== null) {
      this.scheduleAutoHide(errorType, timeout)
    }
  }

  /**
   * Hide all currently visible error messages
   */
  public hideErrors() {
    this.log.i("Hiding all errors")

    // Create a copy of the keys to avoid modification during iteration
    const errorTypes = Array.from(this.activeErrors.keys())

    for (const errorType of errorTypes) {
      const errorObject = this.activeErrors.get(errorType)
      if (errorObject) {
        // Animate out and disable
        this.animateErrorOut(errorObject, () => {
          errorObject.enabled = false

          // Remove from tracking
          this.activeErrors.delete(errorType)
        })
      }
    }
  }

  /**
   * Hide all currently visible errors (alias for hideErrors)
   */
  public hideAllErrors() {
    this.hideErrors()
  }

  /**
   * Check if a specific error is currently visible
   */
  public isErrorVisible(errorType: ErrorType): boolean {
    return this.activeErrors.has(errorType)
  }

  private getObjectForError(errorType: ErrorType): SceneObject | null {
    if (!this.component) {
      this.log.e("Component not registered")
      return null
    }

    switch (errorType) {
      case ErrorType.NoInternet:
        return this.component.getNoInternetErrorObject()
      case ErrorType.ConnectionFailed:
        return this.component.getConnectionFailedErrorObject()
      default:
        this.log.e(`Unknown error type: ${errorType}`)
        return null
    }
  }

  private positionInFrontOfUser(errorObject: SceneObject) {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    const head = this.worldCamera.getTransform().getWorldPosition()
    const forward = this.worldCamera.getTransform().forward
    forward.y = 0 // Keep on same vertical level as user
    const position = forward.normalize().uniformScale(-this.component.getDefaultDistanceFromUser())

    const errorTransform = errorObject.getTransform()
    errorTransform.setWorldPosition(head.add(position))
    errorTransform.setWorldRotation(quat.lookAt(position.uniformScale(-1), vec3.up()))
  }

  private animateErrorIn(errorObject: SceneObject) {
    const errorTransform = errorObject.getTransform()

    // Start at scale 1 and animate to alert scale
    errorTransform.setLocalScale(vec3.one())
    errorObject.enabled = true

    LSTween.scaleToLocal(errorTransform, this.alertScale, TWEEN_DURATION_MILLISECONDS)
      .easing(Easing.Cubic.InOut)
      .start()
  }

  private animateErrorOut(errorObject: SceneObject, onComplete: () => void) {
    const errorTransform = errorObject.getTransform()

    LSTween.scaleToLocal(errorTransform, vec3.zero(), TWEEN_DURATION_MILLISECONDS)
      .easing(Easing.Cubic.InOut)
      .onComplete(() => {
        errorObject.enabled = false
        onComplete()
      })
      .start()
  }

  private scheduleAutoHide(errorType: ErrorType, timeout: number) {
    if (!this.component) {
      this.log.e("Component not registered")
      return
    }

    const delayEvent = this.component.createEvent("DelayedCallbackEvent")
    delayEvent.bind(() => {
      this.hideErrors()
    })
    delayEvent.reset(timeout)
  }
}

// Export for JavaScript compatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(global as any).errorMessageController = ErrorMessageController.getInstance()
