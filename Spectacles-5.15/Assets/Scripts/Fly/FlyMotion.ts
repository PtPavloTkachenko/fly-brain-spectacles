/**
 * FlyMotion — the ONE motion vocabulary of the lens's UI (ADR 58, polish playbook §2/§12).
 *
 * Ease: the house curves. Anim: a single ticked list of running animations (FlySwarm ticks it once per
 * frame; no per-animation UpdateEvents), every animation writes its exact end value on completion and
 * is interruptible (a new animation on the same key replaces the old one, which lands its end value
 * first). Helpers for the two things every card does: pop in (two-phase overshoot) and slip out.
 */
export const Ease = {
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inQuad: (t: number) => t * t,
  outBack: (t: number) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  bell: (t: number) => Math.sin(t * Math.PI),
  /** fps-independent follow: the fraction of the remaining gap closed in dt at `rate` 1/s */
  k: (dt: number, rate: number) => 1 - Math.exp(-dt * rate),
}

type Run = { key: string; t: number; dur: number; delay: number; fn: (t: number) => void; done?: () => void }

export class Anim {
  private static runs: Run[] = []

  /** `fn(t)` with t 0..1 over `dur` seconds after `delay`; `key` replaces a running one (it lands first) */
  static run(key: string, dur: number, fn: (t: number) => void, opt: { delay?: number; done?: () => void } = {}) {
    Anim.stop(key, true)
    Anim.runs.push({ key: key, t: 0, dur: Math.max(0.001, dur), delay: opt.delay || 0, fn: fn, done: opt.done })
  }

  static stop(key: string, land = false) {
    for (let i = Anim.runs.length - 1; i >= 0; i--) {
      const r = Anim.runs[i]
      if (r.key !== key) continue
      Anim.runs.splice(i, 1)
      if (land) {
        r.fn(1)
        if (r.done) r.done()
      }
    }
  }

  static tick(dtRaw: number) {
    const dt = Math.min(dtRaw, 0.1) // a hitch must not skip a whole entrance
    for (let i = 0; i < Anim.runs.length; i++) {
      const r = Anim.runs[i]
      if (r.delay > 0) {
        r.delay -= dt
        if (r.delay > 0) continue
      }
      r.t = Math.min(1, r.t + dt / r.dur)
      r.fn(r.t)
      if (r.t >= 1) {
        Anim.runs.splice(i, 1)
        i--
        if (r.done) r.done()
      }
    }
  }

  /** the house entrance: 0 -> overshoot over 60 %, overshoot -> 1 over 40 %, easeOutQuad both */
  static popIn(key: string, tr: Transform, dur = 0.4, overshoot = 1.15, delay = 0, done?: () => void) {
    tr.setLocalScale(vec3.zero())
    Anim.run(key, dur, (t) => {
      const s = t < 0.6 ? overshoot * Ease.outQuad(t / 0.6) : overshoot + (1 - overshoot) * Ease.outQuad((t - 0.6) / 0.4)
      tr.setLocalScale(vec3.one().uniformScale(Math.max(0.0001, s)))
    }, { delay: delay, done: done })
  }

  /** the exit: shrink to nothing on t^2, faster than any entrance */
  static slipOut(key: string, tr: Transform, dur = 0.25, done?: () => void) {
    Anim.run(key, dur, (t) => tr.setLocalScale(vec3.one().uniformScale(Math.max(0.0001, 1 - Ease.inQuad(t)))), { done: done })
  }

  /** a bell pulse on the scale: something changed here. Against the AUTHORED scale, never 1.0
   *  (polish playbook §4; 15.09: a pulsed mono counter came back at scale 1 = twice its size) */
  static pulse(key: string, tr: Transform, peak = 1.08, dur = 0.3) {
    Anim.stop(key, true) // a running pulse lands first, so the base read below is the authored one
    const base = tr.getLocalScale()
    Anim.run(key, dur, (t) => tr.setLocalScale(base.uniformScale(1 + (peak - 1) * Ease.bell(t))))
  }

  /** text colour crossfade (a step lighting up must not flip) */
  static tint(key: string, txt: Text, to: vec4, dur = 0.3) {
    const from = txt.textFill.color
    Anim.run(key, dur, (t) => {
      const k = Ease.outQuad(t)
      txt.textFill.color = new vec4(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k, from.w + (to.w - from.w) * k)
    })
  }
}
