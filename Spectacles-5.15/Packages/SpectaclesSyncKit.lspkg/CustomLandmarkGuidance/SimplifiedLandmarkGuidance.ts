import WorldCameraFinderProvider from "SpectaclesInteractionKit.lspkg/Providers/CameraProvider/WorldCameraFinderProvider"
import animate, {CancelFunction, CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {clearTimeout, setTimeout} from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import {lerp} from "SpectaclesInteractionKit.lspkg/Utils/mathUtils"
import {findComponentInChildren} from "SpectaclesInteractionKit.lspkg/Utils/SceneObjectUtils"
import {ArrowAnimator, ArrowType} from "./ArrowAnimator"

import {BaseButton} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"
import {SessionController} from "../Core/SessionController"

export type TimerToken = {cancelled: boolean}

export type TimerFunctions = {
  setTimeout: (fn: () => void, ms: number) => TimerToken
  clearTimeout: (token: TimerToken | null) => void
}

export type GuidanceHint = {text: string; arrows?: ArrowType}

export type GuidanceCopy = {
  guidance: {displayTimeSeconds: number; hints: GuidanceHint[]; fadeInTimeSeconds: number}
  troubleshooting: {title: string; bullets: {title: string; description: string}[]; button: string}
  success: {text: string}
}

export type ViewRefs = {
  // Guidance
  guidanceRoot: SceneObject
  guidanceText: Text
  arrow?: SceneObject

  // Troubleshooting
  troubleshootingRoot: SceneObject
  titleText: Text
  bullet1Title: Text
  bullet1Copy: Text
  bullet2Title: Text
  bullet2Copy: Text
  bullet3Title: Text
  bullet3Copy: Text
  bullet4Title?: Text
  bullet4Copy?: Text
  keepLookingButton: BaseButton

  // Success
  successRoot: SceneObject
  successText: Text
}

export type Config = {
  copy: GuidanceCopy
  guidanceTimeoutMs?: number
  successVisibleMs?: number
  initialGuidanceHoldMs?: number
}

export enum SimpleState {
  None = "None",
  Guidance = "Guidance",
  Troubleshooting = "Troubleshooting",
  Success = "Success"
}

export class SimplifiedLandmarkGuidanceController {
  private state: SimpleState = SimpleState.None
  private hintIndex = 0
  private guidanceTimeout: TimerToken | null = null
  private hintRotationTimeout: TimerToken | null = null
  private successTimeout: TimerToken | null = null
  private initialHoldTimeout: TimerToken | null = null
  private isInitialHoldActive: boolean = false

  private isLocationFound: boolean = false

  private readonly guidanceTimeoutMs: number
  private readonly successVisibleMs: number
  private readonly initialGuidanceHoldMs: number

  // UI animation helpers
  private textAnimationCancelFunction: CancelFunction | null = null
  private arrowCancelSet = new CancelSet()

  // Arrow transforms/cache
  private arrow1Transform: Transform | null = null
  private arrow1StartRot: quat | null = null
  private arrowTargetRot: quat = quat.quatIdentity()
  private arrow1StartPos: vec3 | null = null
  private arrow1Rmv: RenderMeshVisual | null = null
  private currentHintArrows: ArrowType = ArrowType.None

  // Troubleshooting placement helpers
  private worldCamera: WorldCameraFinderProvider | null = null

  // Single arrow animator facade
  private singleArrow: ArrowAnimator | null = null

  constructor(
    private views: ViewRefs,
    private config: Config
  ) {
    this.guidanceTimeoutMs = config.guidanceTimeoutMs ?? 30000
    this.successVisibleMs = config.successVisibleMs ?? 1000
    this.initialGuidanceHoldMs = config.initialGuidanceHoldMs ?? 2000
    this.views.keepLookingButton.onTriggerUp.add(() => this.onKeepLooking())
    this.hideAll()
  }

  start(): void {
    this.isLocationFound = false

    SessionController.getInstance().notifyOnLocatedAtFound(() => {
      this.isLocationFound = true
      this.updateIsLocated()
    })

    // Always start with guidance and hold for at least initialGuidanceHoldMs
    this.isInitialHoldActive = true
    this.transitionTo(SimpleState.Guidance)
    this.initialHoldTimeout = setTimeout(() => {
      this.isInitialHoldActive = false
      this.updateIsLocated()
    }, this.initialGuidanceHoldMs)
  }

  updateIsLocated(): void {
    // Gate success until initial hold completes
    if (!this.isInitialHoldActive && this.isLocationFound) {
      this.transitionTo(SimpleState.Success)
      return
    }
  }

  stop(): void {
    this.transitionTo(SimpleState.None)
  }

  onSuccessComplete: (() => void) | null = null

  private transitionTo(next: SimpleState): void {
    if (this.state === next) {
      return
    }
    this.cancelTimers()
    this.hideAll()

    this.state = next
    switch (next) {
      case SimpleState.None:
        break
      case SimpleState.Guidance:
        this.enterGuidance()
        break
      case SimpleState.Troubleshooting:
        this.enterTroubleshooting()
        break
      case SimpleState.Success:
        this.enterSuccess()
        break
    }
  }

  private enterGuidance(): void {
    // Initialize arrow refs lazily
    this.tryInitArrows()

    // Show first hint with animation
    this.hintIndex = 0
    this.views.guidanceRoot.enabled = true
    this.showHint(this.hintIndex)

    // If it takes too long to find the landmark, show troubleshooting
    this.guidanceTimeout = setTimeout(() => {
      this.transitionTo(SimpleState.Troubleshooting)
    }, this.guidanceTimeoutMs)
  }

  private enterTroubleshooting(): void {
    const copy = this.config.copy.troubleshooting
    this.views.troubleshootingRoot.enabled = true
    // Ensure it appears in front of the user
    this.resetTroubleshootingPosition()
    this.views.titleText.text = copy.title
    this.views.bullet1Title.text = copy.bullets[0]?.title ?? ""
    this.views.bullet1Copy.text = copy.bullets[0]?.description ?? ""
    this.views.bullet2Title.text = copy.bullets[1]?.title ?? ""
    this.views.bullet2Copy.text = copy.bullets[1]?.description ?? ""
    this.views.bullet3Title.text = copy.bullets[2]?.title ?? ""
    this.views.bullet3Copy.text = copy.bullets[2]?.description ?? ""
    this.views.bullet4Title.text = copy.bullets[3]?.title ?? ""
    this.views.bullet4Copy.text = copy.bullets[3]?.description ?? ""
    this.views.keepLookingButton.enabled = true
  }

  private enterSuccess(): void {
    const copy = this.config.copy.success
    this.views.successRoot.enabled = true
    this.views.successText.text = copy.text
    // Fade in
    this.textAnimationCancelFunction?.()
    this.textAnimationCancelFunction = animate({
      update: (t: number) => {
        const a = lerp(0, 1, t)
        this.setTextAlpha(this.views.successText, a)
      },
      start: 0,
      end: 1,
      duration: 1,
      ended: () => {
        // Hold visible, then fade out
        this.successTimeout = setTimeout(() => {
          this.textAnimationCancelFunction = animate({
            update: (tt: number) => {
              const a2 = lerp(1, 0, tt)
              this.setTextAlpha(this.views.successText, a2)
            },
            start: 1,
            end: 0,
            duration: 1,
            ended: () => {
              this.views.successRoot.enabled = false
              this.transitionTo(SimpleState.None)
              this.onSuccessComplete?.()
            }
          })
        }, this.successVisibleMs)
      }
    })
  }

  private onKeepLooking(): void {
    if (this.state === SimpleState.Troubleshooting) {
      this.transitionTo(SimpleState.Guidance)
    }
  }

  private showHint(index: number): void {
    const hints = this.config.copy.guidance.hints
    const hint = hints[index]
    const text = hint?.text ?? ""
    const arrows = hint?.arrows ?? ArrowType.None
    this.currentHintArrows = arrows

    // Play arrows
    this.arrowCancelSet.cancel()
    this.playArrow(
      arrows,
      (this.config.copy.guidance.displayTimeSeconds + this.config.copy.guidance.fadeInTimeSeconds * 2) * 1000
    )

    // Fade in text + arrows
    this.textAnimationCancelFunction?.()
    this.textAnimationCancelFunction = this.animateToAlpha(
      0,
      1,
      this.config.copy.guidance.fadeInTimeSeconds,
      () => {
        // Queue next hint
        this.queueNextHint(index, this.config.copy.guidance.displayTimeSeconds * 1000)
      },
      text
    )
  }

  private queueNextHint(id: number, displayTimeMs: number): void {
    if (this.hintRotationTimeout) {
      clearTimeout(this.hintRotationTimeout)
    }
    this.hintRotationTimeout = setTimeout(() => {
      this.arrowCancelSet.cancel()
      this.textAnimationCancelFunction?.()
      this.textAnimationCancelFunction = this.animateToAlpha(1, 0, 0.6, () => {
        const hints = this.config.copy.guidance.hints
        if (!hints || hints.length === 0) {
          return
        }
        this.hintIndex = (id + 1) % hints.length
        this.showHint(this.hintIndex)
      })
    }, displayTimeMs)
  }

  private hideAll(): void {
    this.views.guidanceRoot.enabled = false
    this.views.troubleshootingRoot.enabled = false
    this.views.successRoot.enabled = false
    if (this.views.arrow) this.views.arrow.enabled = false
  }

  private cancelTimers(): void {
    if (this.guidanceTimeout) {
      clearTimeout(this.guidanceTimeout)
      this.guidanceTimeout = null
    }

    if (this.hintRotationTimeout) {
      clearTimeout(this.hintRotationTimeout)
      this.hintRotationTimeout = null
    }

    if (this.successTimeout) {
      clearTimeout(this.successTimeout)
      this.successTimeout = null
    }

    if (this.initialHoldTimeout) {
      clearTimeout(this.initialHoldTimeout)
      this.initialHoldTimeout = null
    }
  }

  private tryInitArrows(): void {
    if (!this.views.arrow) {
      return
    }
    if (!this.arrow1Transform) {
      this.arrow1Transform = this.views.arrow.getTransform()
      this.arrow1StartRot = this.arrow1Transform.getLocalRotation()
      this.arrow1StartPos = this.arrow1Transform.getLocalPosition()
      this.arrow1Rmv = findComponentInChildren(this.views.arrow, "Component.RenderMeshVisual")
    }
    if (!this.singleArrow) {
      this.singleArrow = new ArrowAnimator(this.views.arrow)
    }
  }

  private setTextAlpha(text: Text, alpha: number): void {
    const c = text.textFill.color
    text.textFill.color = new vec4(c.x, c.y, c.z, alpha)
  }

  private setRmvAlpha(rmv: RenderMeshVisual, alpha: number): void {
    rmv.mainPass.alpha = alpha
  }

  private animateToAlpha(
    from: number,
    to: number,
    duration: number,
    onComplete: () => void = () => {},
    nextText?: string
  ): CancelFunction {
    if (nextText !== undefined) {
      this.views.guidanceText.text = nextText
    }
    return animate({
      update: (t: number) => {
        const a = lerp(from, to, t)
        this.setTextAlpha(this.views.guidanceText, a)
        if (this.currentHintArrows !== ArrowType.None) {
          if (this.arrow1Rmv) this.setRmvAlpha(this.arrow1Rmv, a)
        }
      },
      start: 0,
      end: 1,
      duration: duration,
      ended: onComplete
    })
  }

  private playArrow(arrows: ArrowType, displayTimeMs: number): void {
    this.singleArrow.play(arrows, displayTimeMs)
  }

  private resetTroubleshootingPosition(): void {
    if (!this.worldCamera) {
      this.worldCamera = WorldCameraFinderProvider.getInstance()
    }
    const root = this.views.troubleshootingRoot
    const rootTransform = root.getTransform()
    const head = this.worldCamera.getTransform().getWorldPosition()
    const back = this.worldCamera.getTransform().back
    const distance = 160.0
    const pos = back.normalize().uniformScale(distance)
    rootTransform.setWorldPosition(head.add(pos))
    rootTransform.setWorldRotation(quat.lookAt(pos.uniformScale(-1), vec3.up()))
  }
}
