/**
 * FlyVision — a real retina for every fly (11.09 Pavlo: "cameras on their heads, rendering into
 * their own render targets"). A tiny wide camera on each fly's head renders a PRIVATE layer (the
 * main camera never sees it): the tracked world mesh wearing a blotchy world-space texture, so
 * surfaces and their motion are visible. Sampled at VISION_HZ:
 *  - retina: the view downsampled to 16x8 RGB with mean brightness pinned to 160/255 (ADR 15: the
 *    network is bistable in light) -> the brain's R1-R8 photoreceptors instead of flat grey;
 *  - optic flow: frame-to-frame horizontal image motion per half (1-D gradient method) ->
 *    progressive (front-to-back) flow per eye for LLPC1. The analytic ray flow is the fallback.
 * The real room is not rendered — only its geometry — so the texture is synthetic, but the
 * motion it produces is the fly's true self-motion against the true surfaces.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { TextureRead } from "./TextureRead"
import { ReadbackGate } from "./ReadbackGate"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyVision")
const W = 32
const H = 16

interface Eye {
  cam: Camera
  rt: Texture
  prev: Float32Array | null
  buf: Uint8Array
  flowL: number // rad/s, progressive (front-to-back), eased
  flowR: number
  retina: number[] | null // 16x8x3 bytes, row-major, top row first
  valid: boolean
  // 12.09 device trace: scratch buffers, allocated once. `g` ping-pongs with `prev`.
  g: Float32Array
  out: number[]
  timer: number // its own sampling clock, started a fraction of a period after its neighbour
  pending: number // frames still owed before the render target may be read (see tick)
  elapsed: number // seconds since this eye's previous sample (for the flow maths)
}

export class FlyVision {
  private eyes: Eye[] = []
  private layer: LayerSet
  private world: SceneObject | null = null
  private samples = 0
  private err = ""
  private errN = 0 // throws since the last telemetry line; `err` alone was sticky and read as "always broken"
  private lastMean = -1 // mean brightness 0..255 of fly 0's last frame (diagnostics)
  private lastW = 0
  private lastH = 0

  constructor(flyRoots: SceneObject[], worldMeshSource: SceneObject | null, gridMaterial: Material | null) {
    this.layer = LayerSet.makeUnique()
    if (worldMeshSource && gridMaterial) this.makeWorld(worldMeshSource, gridMaterial)
    for (const root of flyRoots) {
      try {
        this.eyes.push(this.makeEye(root))
      } catch (e) {
        this.err = "" + e
      }
    }
    // Stagger the eyes' clocks so they never read back on the same frame (12.09 device trace).
    const period = 1 / FlyConfig.VISION_HZ
    for (let i = 0; i < this.eyes.length; i++) this.eyes[i].timer = (i * period) / Math.max(1, this.eyes.length)
  }

  /** A second visual of the SAME tracked world-mesh asset, on the vision layer only. */
  private makeWorld(source: SceneObject, grid: Material) {
    let mesh: RenderMesh | null = null
    const find = (so: SceneObject) => {
      const r = so.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
      if (r && r.mesh && !mesh) mesh = r.mesh
      for (let i = 0; i < so.getChildrenCount() && !mesh; i++) find(so.getChild(i))
    }
    find(source)
    if (!mesh) {
      this.err = "no world mesh"
      return
    }
    const so = global.scene.createSceneObject("FlyVisionWorld")
    this.world = so
    so.layer = this.layer
    const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    rmv.mesh = mesh
    const m = grid.clone()
    const p: any = m.mainPass
    // random half-cell blocks (the grid shader's dissolve pattern at 50 %) = texture a 32 px eye
    // can track; thin grid lines would be sub-pixel
    p.tint = new vec4(1, 1, 1, 1)
    p.intensity = FlyConfig.VISION_TEX_INTENSITY
    p.dissolve = 0.5
    p.cell = FlyConfig.VISION_TEX_CELL_CM
    p.blendMode = BlendMode.Add
    p.depthWrite = true
    p.twoSided = true
    rmv.mainMaterial = m
  }

  private makeEye(root: SceneObject): Eye {
    const so = global.scene.createSceneObject("FlyEyeCam")
    so.setParent(root)
    const t = so.getTransform()
    t.setLocalPosition(new vec3(FlyConfig.HEAD_OFFSET_CM, 2, 0))
    t.setLocalRotation(quat.angleAxis(-Math.PI / 2, new vec3(0, 1, 0))) // camera -Z -> fly forward (+X)
    const rt = global.scene.createRenderTargetTexture()
    const rp = rt.control as RenderTargetProvider
    TextureRead.prepare(rt) // 17.09: no MSAA on a target we intend to read (see TextureRead)
    rp.useScreenResolution = false // (a runtime RT follows the screen size unless told otherwise)
    rp.resolution = new vec2(W, H)
    rp.clearColor = new vec4(0, 0, 0, 1)
    const cam = so.createComponent("Component.Camera") as Camera
    cam.type = Camera.Type.Perspective
    cam.devicePropertyUsage = Camera.DeviceProperty.None // not the Spectacles display FOV
    cam.aspect = W / H
    cam.fov = FlyConfig.VISION_FOV_RAD
    cam.near = 2
    cam.far = 800
    cam.renderLayer = this.layer
    cam.renderTarget = rt
    cam.renderOrder = -20
    // 12.09 device trace: this camera was rendering on nearly EVERY frame (2,618 passes over 3,065
    // frames) although its picture is read three times a second. It is switched on for exactly the
    // one frame before each sample — 3 passes a second per eye instead of ~56.
    cam.enabled = false
    return { cam: cam, rt: rt, prev: null, buf: new Uint8Array(W * H * 4), flowL: 0, flowR: 0, retina: null, valid: false,
      g: new Float32Array(W * H), out: new Array(16 * 8 * 3), timer: 0, pending: 0, elapsed: 0 }
  }

  get visionLayer(): LayerSet {
    return this.layer
  }

  /** The synthetic block texture steps aside once the baked room colours exist. */
  setSyntheticWorld(on: boolean) {
    if (this.world && this.world.enabled !== on) this.world.enabled = on
  }

  status(): string {
    const e = this.eyes[0]
    // ms per eye-sample since the last telemetry line, then reset (12.09 readback vs maths split)
    const n = Math.max(1, this.nTimed)
    const split = " read=" + (this.readMs / n).toFixed(2) + " flow=" + (this.flowMs / n).toFixed(2)
    this.readMs = 0
    this.flowMs = 0
    this.nTimed = 0
    return "eyes=" + this.eyes.length + " samples=" + this.samples + split + " mean=" + this.lastMean.toFixed(1) +
      " px=" + this.lastW + "x" + this.lastH + " world=" + (this.world ? (this.world.enabled ? "on" : "off") : "none") +
      (e && e.valid ? " flowL=" + e.flowL.toFixed(2) + " flowR=" + e.flowR.toFixed(2) : "") + (this.err ? " err=" + this.err.substring(0, 60) : "")
  }

  /** Measured flow, or null when the eye sees nothing (a black frame reads as 0 flow and silenced
   *  LLPC1, 11.09) — the caller then falls back to the ray flow. */
  flow(i: number): { L: number; R: number } | null {
    const e = this.eyes[i]
    return e && e.valid && e.retina ? { L: e.flowL, R: e.flowR } : null
  }

  retina(i: number): number[] | null {
    const e = this.eyes[i]
    return e ? e.retina : null
  }

  // 16.09 perf probe — same reason as FlyRetina's: `status()` resets itself and its only consumer
  // is the `dbg` row, which the editor drops with no brain server up (the 16.09 perf note §0).
  // Cumulative, printed on the telemetry clock, inert when DEBUG_TELEMETRY_S is 0.
  private readSum = 0
  private readWorst = 0
  private readN = 0
  private probeT = 0

  tick(dt: number) {
    if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
      this.probeT += dt
      if (this.probeT >= FlyConfig.DEBUG_TELEMETRY_S) {
        this.probeT = 0
        log.i("VISION_READ /window n=" + this.readN + " mean=" + (this.readSum / Math.max(1, this.readN)).toFixed(3) +
          "ms worst=" + this.readWorst.toFixed(2) + "ms eyes=" + this.eyes.length + " samples=" + this.samples +
          " path=" + TextureRead.path +
          (this.errN ? " throws=" + this.errN + " err=" + this.err.substring(0, 60) : ""))
        this.readSum = 0
        this.readN = 0
        this.readWorst = 0
        this.errN = 0
        this.err = ""
      }
    }
    // 12.09 device trace: all three eyes read back on the SAME frame, so one frame in nine paid
    // three GPU->CPU stalls at once — which is exactly the p90 48 ms / max 153 ms jank in the
    // capture. Each eye now keeps its own clock, started a third of a period apart, and at most
    // one eye reads back per frame. Every eye still samples at VISION_HZ.
    const period = 1 / FlyConfig.VISION_HZ
    // 16.09: reading on the frame straight after the render met a target the GPU had not finished —
    // on LS 5.23 `createFromTexture` THROWS there ('from' texture should be loaded), so this eye was
    // blind in the preview. One more frame of slack: N renders, N+1 switches the camera off, N+2
    // reads. And the read must win the lens-wide ReadbackGate, so the ommatidia, the ocelli and this
    // eye can never stall the same frame between them.
    for (const e of this.eyes) {
      e.timer += dt
      if (e.pending > 0) {
        // 17.09: gate first, then disable AND read in the same tick. Reading a frame after the
        // camera was switched off throws `'from' texture should be loaded` on the glasses.
        if (!ReadbackGate.take()) return
        e.pending = 0
        e.cam.enabled = false
        try {
          this.sample(e, e.elapsed)
          this.samples++ // only a read that returned is a sample
        } catch (err) {
          this.err = "" + err
          this.errN++
        }
        return // one readback per frame, never three
      }
      if (e.timer < period) continue
      // due: let the camera draw ONE frame, and read it two ticks later
      e.elapsed = e.timer
      e.timer = 0
      e.cam.enabled = true
      e.pending = 1
      return
    }
  }

  private readMs = 0 // GPU -> CPU readback
  private flowMs = 0 // optic flow + retina maths
  private nTimed = 0

  private sample(e: Eye, dt: number) {
    // 12.09 device trace: `vision` cost 5.0 ms of EVERY frame. Time the two halves separately so
    // the next capture says which it is — the readback, or the maths on top of it.
    // `getRealTimeNanos()`, NOT getTime(): getTime() is the frame clock and never advances inside a
    // frame, so it measured a flat 0.00 (12.09). Date.now() was the 12.09 answer, but its 1 ms
    // resolution cannot resolve a sub-ms readback — the ns clock can (15.09 perf pass).
    const t0 = getRealTimeNanos() / 1e6
    if (e === this.eyes[0]) {
      this.lastW = W
      this.lastH = H
    }
    TextureRead.read(e.rt, 0, 0, W, H, e.buf)
    const t1 = getRealTimeNanos() / 1e6
    this.readMs += t1 - t0
    this.nTimed++
    this.readSum += t1 - t0
    this.readN++
    if (t1 - t0 > this.readWorst) this.readWorst = t1 - t0
    const g = e.g
    for (let i = 0; i < W * H; i++) g[i] = (e.buf[4 * i] + e.buf[4 * i + 1] + e.buf[4 * i + 2]) / 765
    if (e.prev) {
      // 1-D Lucas-Kanade per half: u = -sum(It*Ix) / sum(Ix^2)  (pixels per sample, +x = rightward)
      const half = (x0: number, x1: number): number => {
        let num = 0
        let den = 1e-4
        for (let y = 0; y < H; y++) {
          for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) {
            const i = y * W + x
            const ix = (g[i + 1] - g[i - 1] + e.prev![i + 1] - e.prev![i - 1]) * 0.25
            const it = g[i] - e.prev![i]
            num += it * ix
            den += ix * ix
          }
        }
        return -num / den
      }
      const radPerPx = (FlyConfig.VISION_FOV_RAD * (W / H)) / W // horizontal angle per pixel (approx.)
      const toRad = radPerPx / Math.max(1e-3, dt)
      // image left half = the fly's left eye: forward motion moves it LEFTWARD (-x) = progressive
      const pL = -half(0, W / 2) * toRad
      const pR = half(W / 2, W) * toRad
      const k = 1 - Math.exp(-dt * FlyConfig.VISION_FLOW_EASE)
      e.flowL += (pL - e.flowL) * k
      e.flowR += (pR - e.flowR) * k
      e.valid = true
    }
    // ping-pong the two buffers instead of allocating a new Float32Array every tick
    const old = e.prev
    e.prev = g
    e.g = old !== null ? old : new Float32Array(W * H)
    // retina 16x8 RGB, mean pinned to 160 (contrast kept); a black view -> flat grey.
    // 12.09: this built 384 closures and two arrays PER EYE PER TICK. Index straight into the
    // readback, reuse the buffer and scale in place — identical numbers, no garbage.
    let sum = 0
    const buf = e.buf
    const out = e.out
    for (let y = 0; y < 8; y++) {
      const r0 = 2 * y * W
      const r1 = r0 + W
      // readback rows are bottom-up: flip so the retina's first row is the top of the view
      const dst = (7 - y) * 48
      for (let x = 0; x < 16; x++) {
        const c0 = 4 * (r0 + 2 * x)
        const c1 = 4 * (r1 + 2 * x)
        const o = dst + x * 3
        for (let c = 0; c < 3; c++) {
          const v = (buf[c0 + c] + buf[c0 + 4 + c] + buf[c1 + c] + buf[c1 + 4 + c]) / 4
          out[o + c] = v
          sum += v
        }
      }
    }
    const mean = sum / out.length
    if (e === this.eyes[0]) this.lastMean = mean
    if (mean < 3) e.retina = null
    else {
      const s = 160 / mean
      for (let i = 0; i < out.length; i++) {
        const v = Math.round(out[i] * s)
        out[i] = v < 0 ? 0 : v > 255 ? 255 : v
      }
      e.retina = out
    }
    this.flowMs += getRealTimeNanos() / 1e6 - t1
  }
}
