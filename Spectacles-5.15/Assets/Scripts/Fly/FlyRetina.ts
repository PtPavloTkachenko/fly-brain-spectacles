/**
 * FlyRetina — the fly's own compound eye, sampled the way a fly's eye samples (ADR 54).
 *
 * The old `retina` channel handed the brain an 8x16 picture. It was inert: the model's 3,335
 * R1-R6 cells hold only 825 distinct viewing directions and at 8x16 they collapse into 81
 * pixels, the photoreceptor drive `30*lum/(0.02+lum)` is already saturated at the calibration
 * light (28.39 mV at grey 160; the whole range 160..255 moves it by 1.03 mV, against a ~7 mV
 * firing floor), and R1-R6 is purely inhibitory, so no picture can EXCITE anything. Measured:
 * the entire optic lobe (Mi1, Tm1/2/9, T4, T5, LC4, LPLC1/2, LC11, LC12) sat at 0.00 Hz under
 * every image we could draw.
 *
 * What this does instead, at the right biological level:
 *   1. ONE CAMERA PER EYE, aimed +-EYE_YAW (35 deg) from the head axis, on the private vision
 *      layer, so a threat on the right is IN the right eye's field and OUT of the left's.
 *   2. OMMATIDIA, not pixels: each of the model's own 1,767 optic-lobe columns (875 left eye,
 *      892 right) has a real viewing direction from its MaleCNS hex coordinate x the 5 deg
 *      interommatidial angle (FlyRetinaData.ts). Each is projected through the camera ONCE at
 *      build time into a fixed texel, so per sample it is one bilinear tap.
 *   3. PHOTORECEPTOR ADAPTATION: log luminance minus its own running mean per column - Weber
 *      contrast, so the fly answers CHANGE, not absolute brightness, and a dim room and a bright
 *      one look the same.
 *   4. LAMINA ON/OFF: the signed contrast is the LMC signal; the byte map it sends is split into
 *      ON (brightening) and OFF (darkening) inside the brain and injected on the connectome's
 *      own ON pathway (L5, Mi1 -> T4) and OFF pathway (L1, L2, Tm1/Tm2/Tm9 -> T5). Everything
 *      after that - direction selectivity, LPLC2/LC4 looming, LC11 small objects, the descending
 *      neurons - is the connectome computing for itself. Biology: Borst & Helmstaedter 2015
 *      (ON/OFF split), Klapoetke et al. 2017 (LPLC2), Ache et al. 2019 (LC4), Keles & Frye 2017
 *      (LC11 answers 8-30 deg objects and takes no T4/T5 input).
 *
 * Cost: one GPU->CPU readback per frame at most, staggered across every eye of every fly, at
 * RETINA_HZ. The per-column maths is a flat loop over a prebuilt table.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { TextureRead } from "./TextureRead"
import { ReadbackGate } from "./ReadbackGate"
import { EYE_AZ, EYE_EL, EYE_N, EYE_SIDE } from "./FlyRetinaData"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyRetina")
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const DEG = Math.PI / 180
/** hand-proxy world scale: the marker mesh sized to RETINA_HAND_CM. Two config constants, so it is
 *  a constant — set once per proxy in makeHands(), never per frame (16.09 perf). */
const HAND_SCALE = FlyConfig.RETINA_HAND_CM / Math.max(0.01, FlyConfig.MARKER_MESH_DIAMETER_CM)

interface OcelliCam {
  fly: number
  cam: Camera
  rt: Texture
  buf: Uint8Array
  mean: number // running mean of log dorsal luminance, SHARED by both halves (see below)
  primed: boolean
  primed2: boolean
  baseL: number // slow per-side baseline of the OUTPUT value (see OCELLI_BASE_TAU_S)
  baseR: number
  timer: number
  /** frames still owed before the render target may be read — see FlyRetina.tick */
  pending: number
  elapsed: number
}

interface EyeCam {
  fly: number
  side: number // 0 = the fly's left eye, 1 = its right
  cam: Camera
  rt: Texture
  buf: Uint8Array
  cols: Int32Array // column index of every ommatidium this camera can see
  tx: Int32Array // its texel, precomputed (x + y * PX), readback rows are bottom-up
  mean: Float32Array // per-ommatidium running mean of log luminance (the adaptation state)
  primed: boolean
  dead: number // per-eye contrast deadzone, raised until the column count is under the cap
  moved: number // columns off 128 at the last sample
  timer: number
  /** frames still owed before the render target may be read — see FlyRetina.tick */
  pending: number
  elapsed: number
}

export class FlyRetina {
  /** Bumped once per ommatidial sample. Anything that draws the eye (the board's panel, the web
   *  feed) can compare it and skip a byte-identical upload without hashing 5 kB — the panel used
   *  to repaint at EYE_PANEL_HZ 10 while this only changes at RETINA_HZ 4 (16.09 perf). */
  static stamp = 0
  private static live: FlyRetina | null = null
  /** The `moved` count this map already carries, without rescanning its 1,767 columns. -1 = this
   *  buffer is not one of ours (then the caller must count). */
  static movedOf(map: Uint8Array | null): number {
    const r = FlyRetina.live
    if (!r || !map) return -1
    for (let f = 0; f < r.bytes.length; f++) if (r.bytes[f] === map) return r.moved[f]
    return -1
  }

  private cams: EyeCam[] = []
  private bytes: Uint8Array[] = [] // per fly: EYE_N contrast bytes, 128 = no change
  // The ommatidial IMAGE: what each column actually sees, EYE_N x RGB (15.09 Pavlo: "show what the
  // fly actually sees"). The brain gets the contrast; this is the same sample kept for the panel,
  // so the picture on the board and the drive into the lamina come from ONE read of the texel.
  private rgb: Uint8Array[] = []
  private payloads: (string | null)[] = []
  private dirty: boolean[] = []
  private moved: number[] = [] // per fly: how many columns are off 128 (telemetry + the panel)
  private samples = 0
  private err = ""
  private errN = 0 // throws since the last telemetry line; `err` alone was sticky and read as "always broken"
  private readMs = 0
  private mathMs = 0
  private nTimed = 0
  private px = 0
  // What the eyes can SEE besides the room (15.09 Pavlo: "the eyes must also see the user's hands
  // and the other flies, so the fly reacts accordingly"). The room already reaches them: FlySwarm
  // moves the tracked world mesh onto this same vision layer wearing the baked room colours. The
  // rest are layers the MAIN camera never renders, or layers added to what it already renders:
  //   bodyLayer[i]  — fly i's own body, ADDED to its existing layer so the user still sees it.
  //                   Eye camera i renders every bodyLayer EXCEPT its own, so a fly never sees
  //                   the inside of its own thorax.
  //   ghostLayer    — the multiplayer ghosts (ADR 53); never "self", so every eye sees them.
  //   handLayer     — our own hand proxies, on a unique layer, so nothing appears in the main view.
  private bodyLayer: LayerSet[] = []
  private ghostLayer: LayerSet
  private handLayer: LayerSet
  private hands: { so: SceneObject; t: Transform }[] = []
  private handsOn = 0
  private debugT = 0
  // The OCELLI (ADR 70): one small upward camera per fly. The three simple eyes on the fly's head
  // are brightness-gradient detectors looking at the dorsal field, not image formers, so 8x8 px is
  // plenty: all we read is how bright the sky/ceiling is on the LEFT versus the RIGHT of the head.
  // The compound eye cannot do this job - its cameras are 100 deg at 0 deg pitch, so their top row
  // only reaches ~+50 deg elevation, which is dorsolateral and would confound roll with yaw.
  private ocelli: OcelliCam[] = []
  private ocelliV: { L: number; R: number }[] = []
  // 16.09 perf probe. `status()` resets its own accumulators and its only consumer is the `dbg`
  // row, which the editor DROPS whenever no brain server is up (the 16.09 perf note §0) — so the one
  // number this file exists to defend, the GPU->CPU stall, could not be read in the preview at
  // all. These counters are cumulative, nothing else resets them, and the line is printed on the
  // telemetry clock: inert on the glasses while recording (DEBUG_TELEMETRY_S 0).
  private readSum = 0
  private readWorst = 0
  private readN = 0
  private probeT = 0

  constructor(flyRoots: SceneObject[], private layer: LayerSet,
              private handMesh: RenderMesh | null = null, handMat: Material | null = null) {
    FlyRetina.live = this
    this.px = Math.max(8, FlyConfig.RETINA_PX | 0)
    this.ghostLayer = LayerSet.makeUnique()
    this.handLayer = LayerSet.makeUnique()
    for (let f = 0; f < flyRoots.length; f++) this.bodyLayer.push(LayerSet.makeUnique())
    for (let f = 0; f < flyRoots.length; f++) this.addToLayer(flyRoots[f], this.bodyLayer[f])
    if (handMesh && handMat && FlyConfig.RETINA_SEE_HANDS) this.makeHands(handMesh, handMat)
    for (let f = 0; f < flyRoots.length; f++) {
      this.ocelliV.push({ L: 0, R: 0 })
      if (!FlyConfig.OCELLI_ENABLED) continue
      try {
        this.ocelli.push(this.makeOcelli(flyRoots[f], f))
      } catch (e) {
        this.err = "" + e
      }
    }
    for (let f = 0; f < flyRoots.length; f++) {
      this.bytes.push(new Uint8Array(EYE_N).fill(128))
      this.rgb.push(new Uint8Array(EYE_N * 3))
      this.payloads.push(null)
      this.dirty.push(false)
      this.moved.push(0)
      for (let side = 0; side < 2; side++) {
        try {
          this.cams.push(this.makeEye(flyRoots[f], f, side))
        } catch (e) {
          this.err = "" + e
        }
      }
    }
    // One readback per frame at most, so start every camera's clock a slice apart (ADR 45).
    const period = 1 / Math.max(0.5, FlyConfig.RETINA_HZ)
    for (let i = 0; i < this.cams.length; i++) this.cams[i].timer = (i * period) / Math.max(1, this.cams.length)
  }

  /** The `eye` sense for this fly: base64 of EYE_N bytes, or null while nothing has changed. */
  payload(fly: number): string | null {
    if (fly < 0 || fly >= this.bytes.length) return null
    if (this.dirty[fly]) {
      this.dirty[fly] = false
      this.payloads[fly] = this.moved[fly] > 0 ? this.encode(this.bytes[fly]) : null
    }
    return this.payloads[fly]
  }

  /** The raw contrast map (128 = no change) for the board's eye panel. */
  /** The ommatidial image, EYE_N x RGB as the columns sampled it (achromatic drive, colour shown). */
  image(fly: number): Uint8Array | null {
    return fly >= 0 && fly < this.rgb.length ? this.rgb[fly] : null
  }

  map(fly: number): Uint8Array | null {
    return fly >= 0 && fly < this.bytes.length ? this.bytes[fly] : null
  }

  movedColumns(fly: number): number {
    return fly >= 0 && fly < this.moved.length ? this.moved[fly] : 0
  }

  status(): string {
    const n = Math.max(1, this.nTimed)
    const s =
      "cams=" + this.cams.length + " cols=" + EYE_N + "/" + this.cams[0].cols.length + " px=" + this.px +
      " samples=" + this.samples + " read=" + (this.readMs / n).toFixed(2) + " map=" + (this.mathMs / n).toFixed(2) +
      " moved=" + this.moved.join("/") + (this.ocelliV.length ? " oc=" + this.ocelliV[0].L.toFixed(2) + "/" + this.ocelliV[0].R.toFixed(2) : "") + " hands=" + this.handsOn + " ghosts=" + (this.ghostLayer.isEmpty() ? 0 : 1) + (this.err ? " err=" + this.err.substring(0, 60) : "")
    this.readMs = 0
    this.mathMs = 0
    this.nTimed = 0
    return s
  }

  /** One GPU->CPU stall, measured on the ns clock (Date.now's 1 ms cannot resolve it, ADR 69). */
  private noteRead(ms: number) {
    this.readSum += ms
    this.readN++
    if (ms > this.readWorst) this.readWorst = ms
  }

  tick(dt: number) {
    if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
      this.probeT += dt
      if (this.probeT >= FlyConfig.DEBUG_TELEMETRY_S) {
        this.probeT = 0
        log.i("RETINA_READ /window n=" + this.readN + " mean=" + (this.readSum / Math.max(1, this.readN)).toFixed(3) +
          "ms worst=" + this.readWorst.toFixed(2) + "ms cams=" + this.cams.length + " samples=" + this.samples +
          " path=" + TextureRead.path +
          (this.errN ? " throws=" + this.errN + " err=" + this.err.substring(0, 60) : ""))
        this.readSum = 0
        this.readN = 0
        this.readWorst = 0
        this.errN = 0
        this.err = ""
      }
    }
    if (FlyConfig.RETINA_HAND_DEBUG) this.debugT += dt / Math.max(0.2, FlyConfig.RETINA_DEBUG_S)
    const period = 1 / Math.max(0.5, FlyConfig.RETINA_HZ)
    // 17.09, from the device: the read must happen in the SAME tick that switches the camera off.
    // The 16.09 pass moved it one frame later (N renders, N+1 disables, N+2 reads) and the glasses
    // then threw `'from' texture should be loaded` on EVERY sample — a disabled camera's render
    // target stops being readable, so the fly went blind on the device. Back to: N renders, N+1 wins
    // the lens-wide ReadbackGate, disables the camera and reads it, which is what worked on the
    // glasses before (eye 8-16 ms/frame). The gate is the part worth keeping: FlyVision and the
    // ommatidia can no longer stall the same frame. In the LS 5.23 PREVIEW the call throws whatever
    // the timing, which is a preview limitation (RUNBOOK), not this schedule.
    for (const e of this.cams) {
      e.timer += dt
      if (e.pending > 0) {
        // the gate first: a camera that loses it keeps rendering and is read on a later frame,
        // never disabled-then-unread (that is the state whose target cannot be read at all)
        if (!ReadbackGate.take()) return
        e.pending = 0
        e.cam.enabled = false
        try {
          this.sample(e)
          this.samples++ // only a read that returned is a sample
        } catch (err) {
          this.err = "" + err
          this.errN++
        }
        return // never two GPU->CPU stalls on one frame
      }
      if (e.timer < period) continue
      e.elapsed = e.timer
      e.timer = 0
      e.cam.enabled = true
      e.pending = 1
      return
    }
    // the ocelli sit in the SAME queue, so there is still at most one GPU->CPU stall per frame
    for (const o of this.ocelli) {
      o.timer += dt
      if (o.pending > 0) {
        if (!ReadbackGate.take()) return
        o.pending = 0
        o.cam.enabled = false
        try {
          this.sampleOcelli(o)
          this.samples++ // only a read that returned is a sample
        } catch (err) {
          this.err = "" + err
          this.errN++
        }
        return
      }
      if (o.timer < period) continue
      o.elapsed = o.timer
      o.timer = 0
      o.cam.enabled = true
      o.pending = 1
      return
    }
  }

  /** The `ocelli` sense for this fly: {L, R} dorsal brightness, or null while it has no sample. */
  ocelliSense(fly: number): { L: number; R: number } | null {
    if (!FlyConfig.OCELLI_ENABLED || fly < 0 || fly >= this.ocelliV.length) return null
    const v = this.ocelliV[fly]
    return v.L > 0 || v.R > 0 ? v : null
  }

  /** Stop every eye camera (landed / intro / the fly is off). */
  setEnabled(on: boolean) {
    for (const e of this.cams) {
      if (!on && e.cam.enabled) e.cam.enabled = false
      if (!on) e.pending = 0 // a camera switched off mid-flight owes nothing
    }
  }

  /** ADD a layer to an object and everything under it; the layers it already had are kept, so
   *  whatever the main camera rendered it still renders. */
  private addToLayer(so: SceneObject, l: LayerSet) {
    so.layer = so.layer.union(l)
    for (let i = 0; i < so.getChildrenCount(); i++) this.addToLayer(so.getChild(i), l)
  }

  /** A multiplayer ghost's body (ADR 53): every eye sees it, it is never anyone's own body. */
  addGhost(root: SceneObject) {
    try {
      this.addToLayer(root, this.ghostLayer)
    } catch (e) {
      this.err = "" + e
    }
  }

  /** A fly body that appeared after construction (a respawn) — same rule as in the constructor. */
  addBody(root: SceneObject, fly: number) {
    if (fly < 0 || fly >= this.bodyLayer.length) return
    try {
      this.addToLayer(root, this.bodyLayer[fly])
    } catch (e) {
      this.err = "" + e
    }
  }

  /** Hand proxies: a few spheres on the tracked joints, on a layer only the eyes render. SIK's own
   *  hand visuals are not used — they are not guaranteed to exist (the editor has no hands) and
   *  re-layering someone else's prefab is fragile. A sphere at the palm and one at each fingertip
   *  is all a looming detector needs: what LPLC2/LC4 answer is an EXPANDING edge, not a shape. */
  private makeHands(mesh: RenderMesh, mat: Material) {
    const n = 2 * 3 // left/right x (palm, index, thumb)
    for (let i = 0; i < n; i++) {
      const so = global.scene.createSceneObject("FlyEyeHand" + i)
      so.layer = this.handLayer
      const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
      rmv.mesh = mesh
      const m = mat.clone()
      // Dark and opaque (15.09): a hand is normally DARKER than the wall behind it, so it should
      // drive the OFF pathway (L2 -> Tm1/Tm2 -> T5), which is the biologically typical case. An
      // additive clone would be invisible when black, so the pass is forced opaque first. If a
      // device test shows the room is darker than the hand, flip RETINA_HAND_DARK.
      try {
        const pp: any = m.mainPass
        if (FlyConfig.RETINA_HAND_DARK) {
          pp.blendMode = BlendMode.Normal
          pp.depthWrite = true
          pp.twoSided = true
        }
        const c = FlyConfig.RETINA_HAND_DARK ? new vec4(0.02, 0.02, 0.03, 1) : new vec4(0.9, 0.95, 1, 1)
        for (const key of ["baseColor", "tint", "mainColor"]) if (pp[key] !== undefined) pp[key] = c
      } catch (e) {
        /* the marker material's own look stands */
      }
      rmv.mainMaterial = m
      so.enabled = false
      const t = so.getTransform()
      // 16.09 perf: the proxy's scale is a ratio of two config constants, so it never changes — it
      // was being rebuilt (`new vec3`) and rewritten for all six proxies every frame in setHands().
      // The object is a scene ROOT, so this one write holds for the whole session.
      t.setWorldScale(new vec3(HAND_SCALE, HAND_SCALE, HAND_SCALE))
      this.hands.push({ so: so, t: t })
    }
  }

  /** World-space points of the tracked hand joints, in cm. Anything short of the full list hides
   *  the rest. Called from FlySwarm at the sense rate; the proxies do not move otherwise. */
  setHands(points: vec3[]) {
    // Seeder (the DebugHarness rule): the editor preview has no hands, so there is no way to see
    // whether a hand actually reaches the optic lobe. With RETINA_HAND_DEBUG on and nothing
    // tracked, one proxy walks straight down the FIRST eye's view axis from RETINA_DEBUG_FAR_CM to
    // RETINA_DEBUG_NEAR_CM and loops — a textbook looming stimulus, and the honest way to read
    // LC4 / LPLC2 / DNp01 on the board without a device. Never on by default.
    if (points.length === 0 && FlyConfig.RETINA_HAND_DEBUG && this.cams.length) {
      const t = this.cams[0].cam.getSceneObject().getTransform()
      const far = FlyConfig.RETINA_DEBUG_FAR_CM
      const near = FlyConfig.RETINA_DEBUG_NEAR_CM
      const p = (this.debugT % 1)
      points = [t.getWorldPosition().add(t.back.normalize().uniformScale(far + (near - far) * p))]
    }
    const n = Math.min(points.length, this.hands.length)
    for (let i = 0; i < this.hands.length; i++) {
      const h = this.hands[i]
      const on = i < n
      if (h.so.enabled !== on) h.so.enabled = on
      if (!on) continue
      h.t.setWorldPosition(points[i]) // scale is set once in makeHands(): it is a constant
    }
    this.handsOn = n
  }

  private makeOcelli(root: SceneObject, fly: number): OcelliCam {
    const PX = 8
    const so = global.scene.createSceneObject("FlyOcelli" + fly)
    so.setParent(root)
    const t = so.getTransform()
    t.setLocalPosition(new vec3(FlyConfig.HEAD_OFFSET_CM * 0.7, 3, 0))
    // camera -Z is its view axis; rotate it to look UP (+Y) along the fly's own dorsal axis, so a
    // roll of the body rolls this view exactly as it rolls the real ocelli
    t.setLocalRotation(quat.angleAxis(Math.PI / 2, new vec3(0, 0, 1)).multiply(quat.angleAxis(-Math.PI / 2, new vec3(0, 1, 0))))
    const rt = global.scene.createRenderTargetTexture()
    const rp = rt.control as RenderTargetProvider
    TextureRead.prepare(rt) // 17.09: no MSAA on a target we intend to read (see TextureRead)
    rp.useScreenResolution = false
    rp.resolution = new vec2(PX, PX)
    rp.clearColor = new vec4(0, 0, 0, 1)
    const cam = so.createComponent("Component.Camera") as Camera
    cam.type = Camera.Type.Perspective
    cam.devicePropertyUsage = Camera.DeviceProperty.None
    cam.aspect = 1
    cam.fov = FlyConfig.OCELLI_FOV_RAD
    cam.near = 2
    cam.far = 800
    cam.renderLayer = this.layer.union(this.ghostLayer).union(this.handLayer)
    cam.renderTarget = rt
    cam.renderOrder = -22
    cam.enabled = false
    return { fly: fly, cam: cam, rt: rt, buf: new Uint8Array(PX * PX * 4), mean: 0, primed: false, primed2: false, baseL: 0, baseR: 0, timer: 0, pending: 0, elapsed: 0 }
  }

  private sampleOcelli(o: OcelliCam) {
    const PX = 8
    const t0 = getRealTimeNanos() / 1e6
    TextureRead.read(o.rt, 0, 0, PX, PX, o.buf)
    const dtRead = getRealTimeNanos() / 1e6 - t0
    this.readMs += dtRead
    this.nTimed++
    this.noteRead(dtRead)
    const b = o.buf
    let sl = 0
    let sr = 0
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        const i = 4 * (x + y * PX)
        const v = b[i] * 0.2126 + b[i + 1] * 0.7152 + b[i + 2] * 0.0722
        if (x < PX / 2) sl += v
        else sr += v
      }
    }
    const n = (PX * PX) / 2
    const pl = Math.log(sl / n / 255 + 0.004)
    const pr = Math.log(sr / n / 255 + 0.004)
    const mid = (pl + pr) / 2
    if (!o.primed) {
      o.primed = true
      o.mean = mid
    }
    // ONE shared running mean, and a SLOW one (OCELLI_TAU_S ~ 4 s). That is the whole trick: a roll
    // moves the halves apart (the difference survives), a pitch moves both together (the common
    // mode survives because the mean lags), and the room simply being bright or dim is divided out.
    // A fast adaptation would erase the pitch signal with it.
    o.mean += (mid - o.mean) * (1 - Math.exp(-o.elapsed / Math.max(0.2, FlyConfig.OCELLI_TAU_S)))
    const g = FlyConfig.OCELLI_GAIN
    const base = FlyConfig.OCELLI_BASE
    const cl = (x: number) => (x < 0 ? 0 : x > FlyConfig.OCELLI_MAX ? FlyConfig.OCELLI_MAX : x)
    let rawL = g * (pl - o.mean)
    let rawR = g * (pr - o.mean)
    // Room asymmetry (ADR 70): a ceiling that is simply brighter on one side is a CONSTANT offset,
    // and in this editor room it was ~0.05 - larger than the +-0.04 a real roll modulates, so it
    // read as a permanent roll and the mirror test never flipped. Subtract a slow per-side baseline
    // of the OUTPUT so the channel reports DEPARTURE from whatever this room looks like.
    // The cost, stated plainly: a roll held longer than OCELLI_BASE_TAU_S fades out of the signal.
    // The reflex therefore corrects DISTURBANCES, it does not hold an absolute attitude - which is
    // what an ocellar reflex does anyway, and the same trade the retina's tau and the decoder's
    // 8 s habituation already make.
    if (!o.primed2) {
      o.primed2 = true
      o.baseL = rawL
      o.baseR = rawR
    }
    const kb = 1 - Math.exp(-o.elapsed / Math.max(1, FlyConfig.OCELLI_BASE_TAU_S))
    o.baseL += (rawL - o.baseL) * kb
    o.baseR += (rawR - o.baseR) * kb
    rawL -= o.baseL
    rawR -= o.baseR
    const v = this.ocelliV[o.fly]
    v.L = cl(base + rawL)
    v.R = cl(base + rawR)
  }

  // ---------------------------------------------------------------- build ----
  private makeEye(root: SceneObject, fly: number, side: number): EyeCam {
    const PX = this.px
    const so = global.scene.createSceneObject("FlyOmmatidia" + fly + (side === 0 ? "L" : "R"))
    so.setParent(root)
    const t = so.getTransform()
    t.setLocalPosition(new vec3(FlyConfig.HEAD_OFFSET_CM, 2, 0))
    // FlyVision's base rotation puts camera -Z on the fly's +X (forward) and camera +X on the
    // fly's +Z (its right). One more yaw about up turns each eye outward by EYE_YAW.
    const yaw = FlyConfig.RETINA_EYE_YAW_DEG * DEG * (side === 0 ? 1 : -1) // + = toward the fly's left
    t.setLocalRotation(quat.angleAxis(-Math.PI / 2 + yaw, new vec3(0, 1, 0)))
    const rt = global.scene.createRenderTargetTexture()
    const rp = rt.control as RenderTargetProvider
    TextureRead.prepare(rt) // 17.09: no MSAA on a target we intend to read (see TextureRead)
    rp.useScreenResolution = false
    rp.resolution = new vec2(PX, PX)
    rp.clearColor = new vec4(0, 0, 0, 1)
    const cam = so.createComponent("Component.Camera") as Camera
    cam.type = Camera.Type.Perspective
    cam.devicePropertyUsage = Camera.DeviceProperty.None
    cam.aspect = 1
    cam.fov = FlyConfig.RETINA_FOV_RAD
    cam.near = 2
    cam.far = 800
    // the room, plus every OTHER fly, plus the ghosts, plus our hand proxies — never its own body
    let seen = this.layer.union(this.ghostLayer).union(this.handLayer)
    for (let i = 0; i < this.bodyLayer.length; i++) if (i !== fly) seen = seen.union(this.bodyLayer[i])
    cam.renderLayer = seen
    cam.renderTarget = rt
    cam.renderOrder = -21
    cam.enabled = false

    // Project every column of THIS eye through the camera once. tan of the half-FOV, aspect 1.
    const tanH = Math.tan(FlyConfig.RETINA_FOV_RAD / 2)
    const cols: number[] = []
    const tx: number[] = []
    for (let c = 0; c < EYE_N; c++) {
      if (EYE_SIDE[c] !== side) continue
      const az = (EYE_AZ[c] / 100) * DEG - FlyConfig.RETINA_EYE_YAW_DEG * DEG * (side === 0 ? 1 : -1)
      const el = (EYE_EL[c] / 100) * DEG
      const ce = Math.cos(el)
      // camera space: -Z forward, +X the fly's right (so its left is -X), +Y up
      const vx = -ce * Math.sin(az)
      const vy = Math.sin(el)
      const vz = -ce * Math.cos(az)
      if (-vz <= 0.05) continue // behind this eye's camera
      const nx = vx / -vz / tanH
      const ny = vy / -vz / tanH
      if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue
      let x = Math.floor((nx * 0.5 + 0.5) * PX)
      let y = Math.floor((ny * 0.5 + 0.5) * PX) // readback rows are bottom-up, +y is up: no flip
      if (x < 0) x = 0
      else if (x >= PX) x = PX - 1
      if (y < 0) y = 0
      else if (y >= PX) y = PX - 1
      cols.push(c)
      tx.push(x + y * PX)
    }
    return {
      fly: fly, side: side, cam: cam, rt: rt, buf: new Uint8Array(PX * PX * 4),
      cols: new Int32Array(cols), tx: new Int32Array(tx), mean: new Float32Array(cols.length),
      primed: false, dead: 0, moved: 0, timer: 0, pending: 0, elapsed: 0,
    }
  }

  // --------------------------------------------------------------- sample ----
  private sample(e: EyeCam) {
    const PX = this.px
    const t0 = getRealTimeNanos() / 1e6
    TextureRead.read(e.rt, 0, 0, PX, PX, e.buf)
    const t1 = getRealTimeNanos() / 1e6
    this.readMs += t1 - t0
    this.nTimed++
    this.noteRead(t1 - t0)

    const buf = e.buf
    const cols = e.cols
    const tx = e.tx
    const mean = e.mean
    const bytes = this.bytes[e.fly]
    const rgb = this.rgb[e.fly]
    // A high-pass over the eye's OWN sampling interval. At RETINA_HZ 6 the interval (167 ms) is
    // already near RETINA_TAU_S, so alpha sits around 0.6-0.7: a step change keeps most of its
    // amplitude and a still scene decays back to zero within a few samples.
    const alpha = 1 - Math.exp(-e.elapsed / Math.max(0.01, FlyConfig.RETINA_TAU_S))
    const inv = 1 / Math.max(0.05, FlyConfig.RETINA_FULL)
    const prime = !e.primed
    // Every driven column costs the brain: compare.py measured a 50 ms step at 380 ms with a
    // still eye, 480-530 ms with a quarter of the columns moving and 750-830 ms with nine
    // tenths. So each eye holds its own deadzone and raises it until it is under
    // RETINA_MAX_COLUMNS - the strongest edges survive, the faint texture does not.
    const dead = e.dead
    let moved = 0
    for (let k = 0; k < cols.length; k++) {
      const o = tx[k] * 4
      // Rec.709 luminance of the texel, 0..1, then log: Weber contrast, not absolute brightness
      // ONE read of the texel feeds both the brain and the panel
      const cr = buf[o]
      const cg = buf[o + 1]
      const cb = buf[o + 2]
      const j = 3 * cols[k]
      rgb[j] = cr
      rgb[j + 1] = cg
      rgb[j + 2] = cb
      const lum = (cr * 0.2126 + cg * 0.7152 + cb * 0.0722) / 255
      const p = Math.log(lum + 0.004)
      if (prime) {
        mean[k] = p
        bytes[cols[k]] = 128
        continue
      }
      const m = mean[k] + (p - mean[k]) * alpha
      mean[k] = m
      let c = (p - m) * inv
      if (c > 1) c = 1
      else if (c < -1) c = -1
      if (c > -dead && c < dead) {
        bytes[cols[k]] = 128
        continue
      }
      const b = 128 + Math.round(127 * c)
      bytes[cols[k]] = b
      if (b !== 128) moved++
    }
    if (prime) e.primed = true
    const cap = Math.max(16, FlyConfig.RETINA_MAX_COLUMNS | 0) >> 1 // per eye
    if (moved > cap) e.dead = Math.min(0.8, e.dead + 0.05)
    else if (moved < cap * 0.6) e.dead = Math.max(0, e.dead - 0.02)
    e.moved = moved
    this.moved[e.fly] = this.cams[2 * e.fly].moved + this.cams[2 * e.fly + 1].moved
    this.dirty[e.fly] = true
    FlyRetina.stamp++ // a new ommatidial image exists (the eye panel's diff-cache, 16.09)
    this.mathMs += getRealTimeNanos() / 1e6 - t1
  }

  private encode(b: Uint8Array): string {
    const n = b.length
    const out: string[] = []
    let i = 0
    for (; i + 2 < n; i += 3) {
      const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
      out.push(B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63])
    }
    const rem = n - i
    if (rem === 1) {
      const v = b[i] << 16
      out.push(B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + "==")
    } else if (rem === 2) {
      const v = (b[i] << 16) | (b[i + 1] << 8)
      out.push(B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + "=")
    }
    return out.join("")
  }
}
