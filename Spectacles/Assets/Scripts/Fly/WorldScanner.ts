/**
 * WorldScanner — Gemini as the flies' slow perception (ADR 04/16). Every SCAN_EVERY_S one camera
 * frame goes to Gemini (Remote Service Gateway), which labels what a fruit fly cares about —
 * food / bad / threat — with 2D boxes. Each box becomes a world position and a WorldSources
 * source the brains smell and see. Gemini only says WHAT is WHERE, never what a fly should do
 * (ADR 01): approach, landing and feeding still come from the brains' odour/taste responses.
 *
 * 2D -> 3D (port of Snap's Depth Cache sample): on device the depth frame paired with the capture
 * (DepthModule, experimental); where no depth arrives (editor preview) a World Query hit test
 * along the capture camera's ray against the (emulated) world mesh.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/Gemini"
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GeminiTypes"
import { FlyConfig } from "./FlyConfig"
import { Source, SourceClass, WorldSources } from "./WorldSources"

const log = new NativeLogger("WorldScanner")

// 11.09 the user: "Gemini must report everything, not only food — cats, plants, the litter box,
// a phone, AirPods, keys..." — a room inventory, each thing classified by what it means to a fly
const PROMPT =
  "You are the eyes of a fruit fly (Drosophila) in this room, seen through AR glasses. " +
  "List up to 20 distinct real objects and classify each by what it means to a fly. " +
  'kind "food": things a fruit fly eats - fruit (whole, cut, peels), sweets, cake, bread, jam, honey, juice, soda, ' +
  "wine, beer, sweet coffee or tea, pet food, open food packaging. " +
  'kind "scent": attractive smells a fly investigates but does not eat - plants, flowers, trash bins, compost, ' +
  "cat litter box, dirty dishes, sink drain. " +
  'kind "bad": smells a fly avoids - cleaning products, soap, detergent, bleach, insect spray, air freshener, candles, smoke. ' +
  'kind "threat": animals or things that hunt or swat flies - cat, dog, spider or web, fly swatter, bug zapper. ' +
  'kind "object": everything else worth remembering, especially small personal items - phone, AirPods or earbuds case, ' +
  "keys, wallet, glasses, remote, laptop, cup, bottle, book, bag, shoes. " +
  "Skip walls, floor, ceiling and big furniture itself; name what is on them instead. " +
  'label: 1-3 lowercase words; tell duplicates apart by colour or position ("red apple", "left mug"). ' +
  "box_2d: [ymin, xmin, ymax, xmax] normalised to 0-1000. Only objects within about 4 metres. " +
  // 11.09 the user: "Gemini must not detect the same thing 300 times"
  "You also get known_in_view: things already mapped in this view. Do NOT list them again - list only NEW " +
  "objects (an empty list is fine). Put every known_in_view label you can no longer see into gone. " +
  'Answer as JSON {"objects": [{"label", "kind", "box_2d"}], "gone": [labels]}. Never use code fences.'

const SCHEMA: GeminiTypes.Common.Schema = {
  type: "object",
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          kind: { type: "string" },
          box_2d: { type: "array", items: { type: "number" } },
        },
        required: ["label", "kind", "box_2d"],
      },
    },
    gone: { type: "array", items: { type: "string" } },
  },
  required: ["objects"],
}

const LABEL_COLOR: { [cls: string]: vec4 } = {
  food: new vec4(0.35, 1.0, 0.55, 1),
  bad: new vec4(0.75, 0.45, 1.0, 1),
  threat: new vec4(1.0, 0.4, 0.4, 1),
  scent: new vec4(1.0, 0.6, 0.85, 1),
  object: new vec4(0.8, 0.92, 1.0, 1),
}

interface DepthSnap {
  data: Float32Array
  cam: DeviceCamera
  pose: mat4
}

interface Capture {
  tex: Texture
  depth: DepthSnap | null
  camWorld: mat4 // render camera at capture time (World Query fallback)
  known: Found[] // already-mapped things inside this view (told to Gemini)
}

interface Found {
  src: Source
  label: SceneObject
  seen: number
}

export class WorldScanner {
  /** Every captured frame + the camera pose it came from (WorldColorBake bakes room colours). */
  onFrame: (tex: Texture, camWorld: mat4) => void = () => {}
  private root: SceneObject
  private cam: Camera
  private camTex: Texture | null = null
  private depthSession: DepthFrameSession | null = null // kept so it can be started per capture
  private depthOn = false
  private depthWarm = false // the next depth frame is this session's first since start(): discard it
  // 12.09: it does not leave a camera callback
  // subscribed while it is not streaming, it removes the registration and adds it back. The colour
  // stream itself cannot be closed in 5.15, so dropping the callback is the only part we control.
  private camProv: CameraTextureProvider | null = null
  private camReg: EventRegistration | null = null
  private onCamFrame = (frame: CameraFrame) => {
    this.camFrames++
    // While a capture is armed, keep the last few colour frames with their timestamps so the
    // depth frame can be paired with the CLOSEST one (Depth Cache sample: colour runs 2-3
    // frames behind depth; pairing with "now" put markers off while the head moves)
    if (!this.armed) return
    this.history.push({ tex: this.camTex!.copyFrame(), ts: frame.timestampSeconds })
    if (this.history.length > 6) this.history.shift()
  }
  private colorCam: DeviceCamera | null = null
  private hit: HitTestSession | null = null
  private found: Found[] = []
  private timer = FlyConfig.SCAN_FIRST_S
  private every = FlyConfig.SCAN_EVERY_S
  private now = 0
  private busy = false
  private armed = false
  private armT = 0
  private camFrames = 0
  private depthFrames = 0
  private scans = 0
  private lastCount = 0
  private lastErr = ""
  private lastLabels = ""
  private history: { tex: Texture; ts: number }[] = []
  private pairDtMs = -1 // colour/depth timestamp gap of the last depth capture
  private depthScans = 0
  // The colour camera's intrinsics are only real on device; the editor preview renders through the
  // scene camera (11.09: colour-intrinsic rays in the editor collapsed every find onto one spot)
  private useColorRays = !global.deviceInfoSystem.isEditor()
  private placed = 0 // boxes that got a world position (depth or World Query hit)
  private asked = 0 // boxes sent to resolve
  private misses = 0 // boxes with no surface hit
  private merged = 0 // placements folded into an already-known object
  private lastBox = ""
  private meshPlaced = 0 // placements that came from the world mesh raycast
  private skipped = 0 // passes skipped because the view hadn't changed
  private lastScanPos: vec3 | null = null
  private lastScanFwd: vec3 | null = null
  private lastScanT = -999
  private tracking: DeviceTracking | null = null
  /** true = this world point is behind the board as seen from the user (set by FlySwarm) */
  occluder: ((p: vec3) => boolean) | null = null

  constructor(private sources: WorldSources, private cameraObject: SceneObject, private font: Font | null) {
    this.root = global.scene.createSceneObject("WorldScan")
    this.cam = cameraObject.getComponent("Component.Camera") as Camera
    this.tracking = (cameraObject.getComponent("Component.DeviceTracking") as DeviceTracking) || null
    try {
      const cameraModule = require("LensStudio:CameraModule") as CameraModule
      const req = CameraModule.createCameraRequest()
      req.cameraId = CameraModule.CameraId.Left_Color
      this.camTex = cameraModule.requestCamera(req)
      this.camProv = this.camTex.control as CameraTextureProvider
      // subscribed only while a capture is armed (SCAN_DEPTH_GATED), like the depth session
      if (!FlyConfig.SCAN_DEPTH_GATED) this.camReg = this.camProv.onNewFrame.add(this.onCamFrame)
      this.colorCam = global.deviceInfoSystem.getTrackingCameraForId(CameraModule.CameraId.Left_Color)
    } catch (e) {
      this.lastErr = "camera: " + e
    }
    try {
      const depthModule = require("LensStudio:DepthModule") as DepthModule
      const session = depthModule.createDepthFrameSession()
      this.depthSession = session
      session.onNewFrame.add((d: DepthFrameData) => {
        this.depthFrames++
        if (!this.armed || this.history.length === 0) return
        // A session started a moment ago hands back a stale first frame (12.09 device: pairDt went
        // 33 ms -> 4.8 s once the session was gated). Drop it and wait for the next one.
        if (this.depthWarm) {
          this.depthWarm = false
          return
        }
        let best = this.history[0]
        for (const h of this.history) if (Math.abs(h.ts - d.timestampSeconds) < Math.abs(best.ts - d.timestampSeconds)) best = h
        this.pairDtMs = Math.round(Math.abs(best.ts - d.timestampSeconds) * 1000)
        // too far apart to trust: the pose would place the marker where the head used to be, so
        // fall through to the World Query path instead (the armT timeout does it)
        if (this.pairDtMs > FlyConfig.SCAN_PAIR_MAX_MS) return
        const m = d.toWorldTrackingOriginFromDeviceRef
        this.capture({ data: d.depthFrame.slice(), cam: d.deviceCamera, pose: mat4.fromColumns(m.column0, m.column1, m.column2, m.column3) }, best.tex)
      })
      // 12.09: depth estimation used to run for the whole session for the sake of one frame every
      // few seconds. It now starts with the capture window and stops with it (SCAN_DEPTH_GATED).
      if (!FlyConfig.SCAN_DEPTH_GATED) {
        session.start()
        this.depthOn = true
      }
    } catch (e) {
      log.w("SCAN no depth module (" + e + ") -> World Query only")
    }
    try {
      const wq = require("LensStudio:WorldQueryModule") as WorldQueryModule
      const opt = HitTestSessionOptions.create()
      opt.filter = true
      this.hit = wq.createHitTestSessionWithOptions(opt)
      const h: any = this.hit
      if (typeof h.start === "function") h.start()
    } catch (e) {
      log.w("SCAN no world query (" + e + ")")
    }
  }

  status(): string {
    return "cam=" + this.camFrames + " depth=" + this.depthFrames + " scans=" + this.scans +
      " depthScans=" + this.depthScans + (this.pairDtMs >= 0 ? " pairDt=" + this.pairDtMs + "ms" : "") + " found=" + this.lastCount +
      " placed=" + this.placed + "/" + this.asked + " mesh=" + this.meshPlaced + " miss=" + this.misses + " merged=" + this.merged + " skip=" + this.skipped +
      " live=" + this.found.length + (this.busy ? " busy" : "") + (this.lastBox ? " box=" + this.lastBox.substring(0, 50) : "") +
      (this.lastErr ? " err=" + this.lastErr.substring(0, 80) : "") + (this.lastLabels ? " last=" + this.lastLabels.substring(0, 140) : "")
  }

  // 12.09 perf audit: aiming every label at the camera (and asking whether it is behind the board)
  // every frame cost a transform write + a matrix inverse per label, and grew with the room scan.
  // The labels sit on static things, so ~8 Hz is indistinguishable.
  private labelT = 0
  private aimPos: vec3 | null = null // camera pose at the last label re-aim
  private aimFwd: vec3 | null = null
  private static LIFT = new vec3(0, FlyConfig.SCAN_LABEL_LIFT_CM, 0)
  private static UP = new vec3(0, 1, 0)

  tick(dt: number) {
    this.now += dt
    this.labelT += dt
    // 12.09: the 8 Hz tick only decides when to LOOK; a still head re-aims nothing. Two vector ops
    // replace a setWorldPosition + quat.lookAt + setWorldRotation per label per tick.
    let aim = this.labelT >= 0.12
    const camT = this.cameraObject.getTransform() // NOT `ct`: that name is taken later in this method
    let camPos: vec3 | null = null
    if (aim) {
      this.labelT = 0
      camPos = camT.getWorldPosition()
      const fwd = camT.back
      if (this.aimPos && this.aimFwd &&
          camPos.distance(this.aimPos) < FlyConfig.SCAN_LABEL_AIM_CM && fwd.dot(this.aimFwd) > 0.9995) {
        aim = false
        camPos = null
      } else {
        this.aimPos = camPos
        this.aimFwd = fwd
      }
    }
    // expire what Gemini hasn't confirmed for a while; labels face the user
    for (let i = this.found.length - 1; i >= 0; i--) {
      const f = this.found[i]
      // 12.09: a find expires when Gemini stops re-confirming it — but when scanning is OFF (the
      // editor after the intro, and the bench) nothing CAN re-confirm it, so the whole room map
      // emptied itself 150 s after the scan. No scanner, no expiry.
      if (this.every < 1e5 && this.now - f.seen > FlyConfig.SCAN_TTL_S) {
        this.forget(f)
        continue
      }
      if (!aim || !camPos) continue
      const p = f.src.pos.add(WorldScanner.LIFT)
      const t = f.label.getTransform()
      t.setWorldPosition(p)
      t.setWorldRotation(quat.lookAt(camPos.sub(p).normalize(), WorldScanner.UP))
      // hidden while it sits behind the board: the additive board can't occlude it ("TV" printed
      // over the NEURAL rows, 11.09 device screenshot)
      const hide = this.occluder ? this.occluder(p) : false
      if (f.label.enabled === hide) f.label.enabled = !hide
    }
    if (!this.camTex) return
    if (this.armed) {
      this.armT += dt
      if (this.armT > FlyConfig.SCAN_DEPTH_WAIT_S) this.capture(null) // no depth frame: World Query path
      return
    }
    if (this.busy) return
    this.timer -= dt
    if (this.timer > 0) return
    // same view as the last pass -> nothing new to see; re-check it only every SCAN_SAME_VIEW_S
    const ct = this.cameraObject.getTransform()
    if (this.lastScanPos && this.lastScanFwd && this.now - this.lastScanT < FlyConfig.SCAN_SAME_VIEW_S &&
        ct.getWorldPosition().distance(this.lastScanPos) < FlyConfig.SCAN_MOVE_CM &&
        ct.back.dot(this.lastScanFwd) > Math.cos(FlyConfig.SCAN_TURN_DEG * Math.PI / 180)) {
      this.timer = 0.5
      this.skipped++
      return
    }
    this.busy = true
    this.armed = true
    this.armT = 0
    this.setCapture(true) // depth + colour frames only need to run while we wait for a pair
  }

  /** Depth estimation AND the colour-frame callback run only around a capture (SCAN_DEPTH_GATED).
   *  A no-op when it is not gated — then both stay on for the whole session, as before. */
  private setCapture(on: boolean) {
    if (!FlyConfig.SCAN_DEPTH_GATED || this.depthOn === on) return
    this.depthOn = on
    try {
      if (this.depthSession) {
        if (on) {
          this.depthWarm = true // its first frame after a start is stale
          this.depthSession.start()
        } else this.depthSession.stop()
      }
      if (this.camProv) {
        if (on && !this.camReg) this.camReg = this.camProv.onNewFrame.add(this.onCamFrame)
        else if (!on && this.camReg) {
          this.camProv.onNewFrame.remove(this.camReg)
          this.camReg = null
        }
      }
    } catch (e) {
      this.lastErr = "capture " + (on ? "on" : "off") + ": " + e
    }
  }

  private capture(depth: DepthSnap | null, tex: Texture | null = null) {
    this.armed = false
    this.history = []
    this.scans++
    if (depth) this.depthScans++
    const ct = this.cameraObject.getTransform()
    this.lastScanPos = ct.getWorldPosition()
    this.lastScanFwd = ct.back
    this.lastScanT = this.now
    const c: Capture = { tex: tex || this.camTex!.copyFrame(), depth: depth, camWorld: ct.getWorldTransform(), known: this.knownInView() }
    // only now: the copyFrame above is the last thing that needs the colour stream's callback alive
    this.setCapture(false)
    // 12.09 the user, before recording: DEBUG_TELEMETRY_S is the one switch for logging, so the lines
    // that recur during a session hang off it too — not just the `dbg` frame and the perf probe.
    if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
      log.i("SCAN_CAPTURE #" + this.scans + (depth ? " with depth, colour/depth dt " + this.pairDtMs + " ms" : " (world query)"))
    }
    try {
      this.onFrame(c.tex, c.camWorld)
    } catch (e) {
      log.w("SCAN_FRAME_HOOK " + e)
    }
    Base64.encodeTextureAsync(
      c.tex,
      (b64: string) => this.ask(c, b64),
      () => this.finish("encode failed"),
      CompressionQuality.HighQuality,
      EncodingType.Jpg, // 11.09 perf: a full-res PNG per scan stalled frames; JPEG is far cheaper
    )
  }

  private ask(c: Capture, b64: string) {
    const req: GeminiTypes.Models.GenerateContentRequest = {
      model: FlyConfig.GEMINI_MODEL,
      type: "generateContent",
      body: {
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: b64 } },
            { text: JSON.stringify({ task: "Scan this view for the fly.", known_in_view: c.known.map((f) => f.src.label) }) },
          ],
        }],
        systemInstruction: { parts: [{ text: PROMPT }] },
        // no "thinking" pass: boxes come back faster (continuous scan) and never run out of tokens
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", response_schema: SCHEMA, thinkingConfig: { thinkingBudget: 0 } } as any,
      },
    }
    Gemini.models(req)
      .then((r) => {
        const cand: any = r && r.candidates ? r.candidates[0] : null
        const part: any = cand && cand.content && cand.content.parts ? cand.content.parts[0] : null
        if (!part || !part.text) {
          this.finish("no text (finish=" + (cand ? cand.finishReason : "none") + ")")
          return
        }
        const answer = JSON.parse(part.text)
        const objs = answer.objects || []
        // known things Gemini says are gone -> forget; the rest were confirmed by not being re-listed
        const gone: string[] = (answer.gone || []).map((g: any) => String(g).toLowerCase())
        for (const f of c.known) {
          if (gone.indexOf(f.src.label.toLowerCase()) >= 0) this.forget(f)
          else f.seen = this.now
        }
        this.lastCount = objs.length
        this.lastLabels = objs.map((o: any) => o.kind + ":" + o.label).join(",")
        if (FlyConfig.DEBUG_TELEMETRY_S > 0) log.i("SCAN_RESULT #" + this.scans + " " + this.lastLabels)
        let pending = 0
        for (const o of objs) {
          const cls = o.kind as SourceClass
          if (!LABEL_COLOR[cls] || !o.box_2d || o.box_2d.length !== 4) continue
          // boxes must be 0..1000; some answers come back 0..1 -> every ray went to the top-left
          // corner and all finds merged into one (11.09) — normalise whatever scale arrives
          let box: number[] = o.box_2d.map((v: any) => Number(v))
          if (Math.max(box[0], box[1], box[2], box[3]) <= 1.0) box = box.map((v) => v * 1000)
          box = box.map((v) => Math.max(0, Math.min(1000, v)))
          this.lastBox = o.label + "[" + o.box_2d.join(",") + "]"
          pending++
          this.asked++
          this.resolve(c, box, (pos: vec3 | null, size: number) => {
            if (!pos) this.misses++
            if (pos) {
              this.placed++
              this.upsert(String(o.label), cls, pos, size)
            }
            if (--pending === 0) this.finish("")
          })
        }
        if (pending === 0) this.finish("")
      })
      .catch((e) => this.finish("gemini: " + e))
  }

  /** Box [ymin, xmin, ymax, xmax] 0..1000 -> world centre + width (cm). */
  private resolve(c: Capture, box: number[], done: (pos: vec3 | null, size: number) => void) {
    const n = new vec2((box[1] + box[3]) / 2000, (box[0] + box[2]) / 2000)
    const halfW = Math.abs(box[3] - box[1]) / 2000
    if (c.depth && this.colorCam) {
      const r = this.fromDepth(c.depth, n)
      if (r) {
        const a = this.colorCam.unproject(new vec2(n.x - halfW, n.y), r.dist)
        const b = this.colorCam.unproject(new vec2(n.x + halfW, n.y), r.dist)
        done(r.pos, a.distance(b))
        return
      }
    }
    // World Query along the capture's ray. The ray must come from the COLOUR camera's own
    // intrinsics (the image Gemini saw), not the render camera — different FOV/aspect put the
    // markers off (11.09). Device-reference points -> world via the pose at capture time.
    const inv = this.cameraObject.getTransform().getWorldTransform().inverse()
    const toCapture = (p: vec3) => c.camWorld.multiplyPoint(inv.multiplyPoint(p))
    const ray = (q: vec2, dist: number): vec3 =>
      this.colorCam && this.useColorRays
        ? c.camWorld.multiplyPoint(this.colorCam.unproject(q, dist))
        : toCapture(this.cam.screenSpaceToWorldSpace(q, dist))
    const start = ray(n, 5)
    const end = ray(n, FlyConfig.SCAN_RANGE_CM)
    const origin = c.camWorld.multiplyPoint(vec3.zero())
    const widthAt = (d: number) => ray(new vec2(n.x - halfW, n.y), d).distance(ray(new vec2(n.x + halfW, n.y), d))
    // 1st: the tracked world mesh (any angle, sync) — World Query answered null for 70 % of
    // Gemini's rays in the preview (11.09: 58 misses of 82)
    if (this.tracking) {
      const hits = this.tracking.raycastWorldMesh(start, end)
      if (hits && hits.length) {
        let best = hits[0].position
        for (const h of hits) if (h.position.distance(start) < best.distance(start)) best = h.position
        this.meshPlaced++
        done(best, widthAt(best.distance(origin)))
        return
      }
    }
    if (!this.hit) {
      done(null, 0)
      return
    }
    this.hit.hitTest(start, end, (res: WorldQueryHitTestResult) => {
      if (!res) {
        done(null, 0)
        return
      }
      done(res.position, widthAt(res.position.distance(origin)))
    })
  }

  private fromDepth(d: DepthSnap, n: vec2): { pos: vec3; dist: number } | null {
    // the depth frame is a cropped, downscaled copy of the left colour frame: remap through 3D
    const dn = d.cam.project(this.colorCam!.unproject(n, 100))
    if (dn.x < 0 || dn.x > 1 || dn.y < 0 || dn.y > 1) return null
    const w = d.cam.resolution.x
    const h = d.cam.resolution.y
    const cx = Math.floor(dn.x * w)
    const cy = Math.floor(dn.y * h)
    const samples: number[] = []
    for (let y = cy - 2; y <= cy + 2; y++) {
      for (let x = cx - 2; x <= cx + 2; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const v = d.data[x + y * w]
        if (v > 0) samples.push(v)
      }
    }
    if (!samples.length) return null
    samples.sort((a, b) => a - b)
    const dist = samples[Math.floor(samples.length / 2)]
    return { pos: d.pose.multiplyPoint(d.cam.unproject(dn, dist)), dist: dist }
  }

  private forget(f: Found) {
    this.sources.remove(f.src)
    f.label.destroy()
    this.found = this.found.filter((x) => x !== f)
  }

  /** Mapped things whose anchor lies inside the current camera view (told to Gemini as known). */
  private knownInView(): Found[] {
    const ct = this.cameraObject.getTransform()
    const cp = ct.getWorldPosition()
    const fwd = ct.back
    const out: Found[] = []
    for (const f of this.found) {
      if (f.src.pos.sub(cp).dot(fwd) <= 0) continue // behind the user
      const s = this.cam.worldSpaceToScreenSpace(f.src.pos)
      if (s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1) out.push(f)
    }
    return out.slice(0, 20)
  }

  /** The same object seen again (same class within SCAN_MERGE_CM, or the same label within
   *  SCAN_LABEL_MERGE_CM): move it, refresh its TTL — never a duplicate. */
  private upsert(label: string, cls: SourceClass, pos: vec3, width: number) {
    const size = Math.max(4, Math.min(60, width))
    for (const f of this.found) {
      const d = f.src.pos.distance(pos)
      const sameLabel = f.src.label.toLowerCase() === label.toLowerCase() && d < FlyConfig.SCAN_LABEL_MERGE_CM
      if ((f.src.cls === cls && d < FlyConfig.SCAN_MERGE_CM) || sameLabel) {
        this.merged++
        this.sources.move(f.src, vec3.lerp(f.src.pos, pos, 0.5))
        f.src.label = label
        ;(f.label.getComponent("Component.Text") as Text).text = label.toUpperCase() + "\n▼"
        f.seen = this.now
        return
      }
    }
    if (this.found.length >= FlyConfig.SCAN_MAX_SOURCES) return
    // no debug sphere/odour shell (a 1.8 m food shell read as a misplaced marker) — the label's
    // arrow points at the exact anchor instead
    const src = this.sources.add(label, cls, pos, size, -1, false)
    this.found.push({ src: src, label: this.makeLabel(label, cls), seen: this.now })
    if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
      log.i("SCAN_SOURCE " + cls + " '" + label + "' size=" + size.toFixed(0) + " at " + pos.x.toFixed(0) + "," + pos.y.toFixed(0) + "," + pos.z.toFixed(0))
    }
  }

  private makeLabel(text: string, cls: SourceClass): SceneObject {
    const so = global.scene.createSceneObject("ScanLabel")
    so.setParent(this.root)
    const t = so.createComponent("Component.Text") as Text
    if (this.font) t.font = this.font
    t.text = text.toUpperCase() + "\n▼" // the arrow tip marks the anchor
    t.size = 48
    t.horizontalAlignment = HorizontalAlignment.Center
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.worldSpaceRect = Rect.create(-100, 100, -10, 10)
    t.textFill.color = LABEL_COLOR[cls]
    so.getTransform().setWorldScale(vec3.one().uniformScale(FlyConfig.SCAN_LABEL_SCALE))
    return so
  }

  private finish(err: string) {
    if (err) {
      this.lastErr = err
      log.w("SCAN_FAIL #" + this.scans + " " + err)
    } else this.lastErr = ""
    this.busy = false
    this.timer = this.every
  }

  /** Pause between a Gemini answer and the next capture (intro: back-to-back, then non-stop). */
  setInterval(s: number) {
    this.every = s
    if (this.timer > s) this.timer = s
  }

  get liveCount(): number {
    return this.found.length
  }
}
