import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {findComponentInChildren} from "SpectaclesInteractionKit.lspkg/Utils/SceneObjectUtils"

export enum ArrowType {
  None,
  FigureEightYZ,
  FigureEightXY,
  FigureEightXZ
}

export class ArrowAnimator {
  private arrowTransform: Transform | null = null
  private arrowStartPos: vec3 | null = null
  private arrowStartRot: quat | null = null
  private arrowRmv: RenderMeshVisual | null = null
  private cancelSet = new CancelSet()

  constructor(private arrow: SceneObject) {
    if (this.arrow) {
      this.arrowTransform = this.arrow.getTransform()
      this.arrowStartPos = this.arrowTransform.getLocalPosition()
      this.arrowStartRot = this.arrowTransform.getLocalRotation()
      this.arrowRmv = findComponentInChildren(this.arrow, "Component.RenderMeshVisual")
    }
    this.setEnabled(false)
  }

  setEnabled(enabled: boolean): void {
    if (this.arrow) {
      this.arrow.enabled = enabled
    }
  }

  stop(): void {
    this.cancelSet.cancel()
  }

  play(type: ArrowType, displayTimeMs: number): void {
    this.cancelSet.cancel()
    if (type === ArrowType.None || !this.arrowTransform) {
      return
    }
    const duration = Math.max(0.01, displayTimeMs / 1000)
    if (type === ArrowType.FigureEightXY) {
      this.animateFigureEight(duration, /*plane*/ "xy")
    } else if (type === ArrowType.FigureEightXZ) {
      this.animateFigureEight(duration, /*plane*/ "xz")
    } else if (type === ArrowType.FigureEightYZ) {
      this.animateFigureEight(duration, /*plane*/ "yz")
    }
  }

  private animateFigureEight(durationSeconds: number, plane: "xy" | "xz" | "yz"): void {
    const transform = this.arrowTransform!
    const amplitude = 7.0
    const speed = 0.75

    const updatePosition = (t: number) => {
      // Absolute (non-incremental) figure-8 with analytic tangent for rotation

      const theta = t * durationSeconds * speed // absolute parameter
      const cosT = Math.cos(theta)
      const sinT = Math.sin(theta)
      const cos2 = Math.cos(2 * theta)
      const sin2 = Math.sin(2 * theta)

      // Lemniscate of Bernoulli (scaled): x = s cos θ, y = (s sin 2θ)/2,   s = 2A / (3 - cos 2θ)
      const D = 3 - cos2
      const s = (2 * amplitude) / D

      // Absolute position in its local plane (before mapping to XY/XZ/YZ)
      const X = s * cosT
      const Y = (s * sin2) / 2

      // Map to the requested plane + choose an up-vector perpendicular to that plane
      const pos = new vec3(0, 0, 0)
      let upVec = null
      if (plane === "xy") {
        pos.x = X
        pos.y = Y
        upVec = vec3.up() // +Y (Not the plane normal, for better visibility)
      } else if (plane === "xz") {
        pos.x = X
        pos.z = Y
        upVec = vec3.up() // +Y up out of the plane
      } else {
        // "yz"
        pos.y = X
        pos.z = Y
        upVec = vec3.right() // +X up out of the plane
      }

      // ---- Analytic tangent (derivative) for orientation ----
      // s = 2A / (3 - cos 2θ)  =>  s' = ds/dθ = -4A sin 2θ / (3 - cos 2θ)^2
      const sPrime = (-4 * amplitude * sin2) / (D * D)

      // x(θ) = s cos θ, y(θ) = (s sin 2θ)/2
      // x'(θ) = s' cos θ - s sin θ
      // y'(θ) = (s' sin 2θ)/2 + s cos 2θ
      const dX = sPrime * cosT - s * sinT
      const dY = (sPrime * sin2) / 2 + s * cos2

      // Map derivative to the plane (no need to scale by dθ/dt for direction)
      const tangent = new vec3(0, 0, 0)
      if (plane === "xy") {
        tangent.x = dX
        tangent.y = dY
        tangent.z = 0
      } else if (plane === "xz") {
        tangent.x = dX
        tangent.z = dY
        tangent.y = 0
      } else {
        // "yz"
        tangent.y = dX
        tangent.z = dY
        tangent.x = 0
      }

      transform.setLocalPosition(pos)

      const forward = tangent.normalize()
      const rot = quat.lookAt(forward, upVec)
      transform.setLocalRotation(rot)
    }

    updatePosition(0)
    this.arrow.enabled = true

    animate({
      update: updatePosition,
      duration: durationSeconds,
      cancelSet: this.cancelSet
    })
  }
}
