/**
 * ReadbackGate — at most ONE GPU->CPU readback per frame, across every camera in the lens.
 *
 * ADR 45 staggered the ommatidia and the ocelli into one queue, and 12.09 staggered FlyVision's
 * eyes into another — but the two queues never knew about each other, so a frame where both were
 * due paid two `getPixels` stalls at once. This is the shared token: the first caller of a frame
 * takes it, everyone else waits a frame (their `armed` state simply persists — a deferred read is
 * later, never lost).
 *
 * `getTime()` is the FRAME clock: it does not advance inside a frame (the same property FlyVision
 * relied on when it moved to `getRealTimeNanos()` for sub-frame timing), so it identifies the
 * frame without anyone having to call a per-frame `begin()`.
 */
export class ReadbackGate {
  private static t = -1

  /** true = this caller owns the one readback of this frame. */
  /** 17.09, from the glasses: OFF. With the gate on, a camera that lost it waited whole frames
   *  before its read, and then `createFromTexture` threw `'from' texture should be loaded` on every
   *  single sample - 18 throws per 2 s window, n=0 successful reads, i.e. the fly really was blind.
   *  The one window all day that read successfully (01:29:28, n=13 mean 7.5 ms) was the one where a
   *  9.3 s frame gave the GPU all the time in the world. Before this gate existed the same schedule
   *  read fine on device (16.09: read=4.58/7.68/7.44 ms, moved=2). One stall per frame is still
   *  worth having - but not at the price of the eyes, and not before we understand which frame a
   *  render target is actually readable in. Flip this back on only with a device run to prove it. */
  static enabled = false

  static take(): boolean {
    if (!ReadbackGate.enabled) return true
    const now = getTime()
    if (now === ReadbackGate.t) return false
    ReadbackGate.t = now
    return true
  }
}
