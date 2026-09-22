/**
 * TextureRead — getting the pixels of a render target on Spectacles, and finding out which way works.
 *
 * 16-17.09 cost us two wrong diagnoses, so this file states what is actually known.
 *
 * MEASURED ON THE GLASSES: `ProceduralTextureProvider.createFromTexture(rt)` throws
 * `Exception in HostFunction: 'from' texture should be loaded` on most frames. Not a stall, a THROW:
 * the read never happens and the eye keeps its last bytes. The one window all day that succeeded had
 * a 9.3 s frame, i.e. it worked exactly when the GPU had long since finished.
 *
 * TWO HYPOTHESES, both testable in one device run, which is what this helper is for:
 *
 *  A. THE TARGET IS MULTISAMPLED. `RenderTargetProvider` carries `antialiasingMode`, and we never set
 *     it on the fly's eye cameras. A multisampled attachment cannot be sampled or copied without a
 *     resolve in any graphics API, which is a fair reading of "should be loaded". `prepare()` sets
 *     `AntialiasingMode.Disabled` on every eye target.
 *  B. IT NEEDS A SNAPSHOT FIRST. `Texture.copyFrame()` is documented as "returns a Texture that
 *     captures the current state of this Texture Asset" and is what the official Depth Cache and
 *     SnapML samples use before they touch a frame's pixels. `read()` falls back to it when the
 *     direct call throws.
 *
 * `path` then says which one the device accepted, in the RETINA_READ / VISION_READ lines. Do not
 * guess from the editor: in the LS 5.23 preview every route throws, whatever the timing.
 */

/** the route that last returned pixels, for the telemetry line */
export type ReadPath = "none" | "direct" | "copyFrame"

export class TextureRead {
  static path: ReadPath = "none"

  /** Call once per render target, right after it is created. */
  static prepare(rt: Texture) {
    const rp = rt.control as RenderTargetProvider
    // hypothesis A: a multisampled attachment is not readable
    const aa = (RenderTargetProvider as any).AntialiasingMode
    if (aa && typeof aa.Disabled !== "undefined") rp.antialiasingMode = aa.Disabled
    ;(rp as any).mipmapsEnabled = false // a readback wants level 0 and nothing else (5.23 API; absent on 5.15, harmless)
  }

  /**
   * Pixels of `rt` into `buf`, or a throw if no route worked (the caller counts that).
   * Tries the direct route first because when it works it is one object instead of two.
   */
  static read(rt: Texture, x: number, y: number, w: number, h: number, buf: Uint8Array) {
    try {
      const direct = ProceduralTextureProvider.createFromTexture(rt)
      ;(direct.control as ProceduralTextureProvider).getPixels(x, y, w, h, buf)
      TextureRead.path = "direct"
      return
    } catch (e) {
      // hypothesis B: snapshot the target, then read the snapshot
      const snap = rt.copyFrame()
      const prov = ProceduralTextureProvider.createFromTexture(snap)
      ;(prov.control as ProceduralTextureProvider).getPixels(x, y, w, h, buf)
      TextureRead.path = "copyFrame"
    }
  }
}
