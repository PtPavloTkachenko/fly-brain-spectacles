/**
 * WorldCameraId — which colour camera exists on this device, resolved once and shared.
 *
 * A `CameraId` the runtime does not report throws when it is opened, which used to leave the
 * room scanner and the colour bake silently dead. Resolve the first camera the device
 * really opens and use the SAME id for the texture and for the intrinsics (a mismatched pair puts
 * every placed point off by the stereo baseline).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"

const log = new NativeLogger("WorldCameraId")

let resolvedId: CameraModule.CameraId | null = null
let resolvedTex: Texture | null = null

function candidates(): CameraModule.CameraId[] {
  const ids = CameraModule.CameraId as any
  const names = global.deviceInfoSystem.isEditor()
    ? ["Default_Color"]
    : ["Default_Color", "Right_Color", "Left_Color"]
  const out: CameraModule.CameraId[] = []
  for (const n of names) if (ids[n] !== undefined) out.push(ids[n] as CameraModule.CameraId)
  return out
}

/** Opens the world-facing colour camera (first one that works) and caches it. */
export function requestWorldCamera(cameraModule: CameraModule, smallerDimension?: number): Texture | null {
  if (resolvedTex) return resolvedTex
  for (const id of candidates()) {
    try {
      const req = CameraModule.createCameraRequest()
      req.cameraId = id
      if (smallerDimension !== undefined && !global.deviceInfoSystem.isEditor()) (req as any).imageSmallerDimension = smallerDimension
      const tex = cameraModule.requestCamera(req)
      if (tex) {
        resolvedId = id
        resolvedTex = tex
        log.i("CAMERA_RESOLVED id=" + id)
        return tex
      }
    } catch (e) {
      log.w("camera id " + id + " unavailable: " + e)
    }
  }
  return null
}

/** The id `requestWorldCamera` settled on (Default_Color until a camera was opened). */
export function worldCameraId(): CameraModule.CameraId {
  return resolvedId !== null ? resolvedId : CameraModule.CameraId.Default_Color
}

/** Intrinsics of the resolved camera, or null in the editor / when unavailable. */
export function worldDeviceCamera(): DeviceCamera | null {
  if (global.deviceInfoSystem.isEditor()) return null
  try {
    return global.deviceInfoSystem.getTrackingCameraForId(worldCameraId())
  } catch (e) {
    return null
  }
}
