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
import { Source, SourceClass, SourceProps, WorldSources } from "./WorldSources"
import { TextBatch } from "./TextBatch"
import { requestWorldCamera, worldDeviceCamera } from "./WorldCameraId"

const log = new NativeLogger("WorldScanner")

// 11.09 Pavlo: "Gemini must report everything, not only food — cats, plants, the litter box,
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
  "Skip walls, floor and ceiling; big furniture (sofa, table, cabinet, bed, lamp, radiator) counts as object. " +
  'label: 1-3 lowercase words; tell duplicates apart by colour or position ("red apple", "left mug"). ' +
  "box_2d: [ymin, xmin, ymax, xmax] normalised to 0-1000. Only objects within about 4 metres. " +
  // ADR 93/96 (21.09 Pavlo): everything smells to some degree, and a thing's physical fields are
  // part of what the fly senses -- a lamp is warm, a window cold and windy, a kettle humid.
  "For every object also give five numbers from 0 to 1. smell: how strongly it smells to a fruit fly - " +
  "food, fruit, plants, kitchen things, bins 1; wood, paper, fabric, leather, pet things 0.6; plastic, painted furniture 0.3; " +
  "glass, metal, screens 0. warm: gives off heat - radiator, heater, stove, oven, lamp that is on, laptop, TV, a sunlit spot (0.4-1). " +
  "cold: window, air conditioner, fridge, a fan blowing (0.3-1). humid: kettle, pot, sink, bathroom, shower, drinks, plants, wet cloth (0.3-1). " +
  "wind: fan, air conditioner vent, open window or door (0.5-1). Most things are 0 on warm, cold, humid and wind. " +
  // 11.09 Pavlo: "Gemini must not detect the same thing 300 times"
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
          smell: { type: "number" }, // ADR 93: how much it smells, 0..1
          warm: { type: "number" }, // ADR 96: physical fields, 0..1 each
          cold: { type: "number" },
          humid: { type: "number" },
          wind: { type: "number" },
        },
        required: ["label", "kind", "box_2d", "smell", "warm", "cold", "humid", "wind"],
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
  seen: number
  text: string // the label as it is drawn (upper case), without the arrow
  pos: vec3 // where the label sits: the anchor lifted by SCAN_LABEL_LIFT_CM
  right: vec3 // the plane it is drawn on, taken from the aim quaternion so the look is unchanged
  up: vec3
  color: vec4
  hidden: boolean // behind the board
  obj: SceneObject | null // only the Component.Text fallback (no MSDF material / metadata)
}

/**
 * WorldLabels — every found thing's floating name in ONE MSDF mesh (ADR 40, extended to world
 * space). It was one `Component.Text` per thing, i.e. one draw call each, up to SCAN_MAX_SOURCES
 * 24 of them on a 41-draw device frame — the last un-batched text in the lens.
 *
 * The board's TextBatch cannot serve here: it owns ONE transform and lays its labels out in that
 * object's local XY. A world label has its own position and its own aim, so the glyph quads are
 * built directly in world space from each label's `right`/`up` (taken from the very quaternion
 * `aimLabel` used to give the Text component, so nothing moves on screen).
 *
 * Rewritten only when a label is added, moved, re-aimed, renamed, hidden or forgotten — never per
 * frame. Between those it is one static mesh and one draw call.
 *
 * The arrow: the atlas is ASCII 0x20-0x7E (tools/text/build_atlas.py), so U+25BC is not in it.
 * It is drawn as geometry instead, with its own glyph's proportions out of ChakraPetch-SemiBold
 * (bbox 0.045..0.625 x -0.005..0.584 em, advance 0.67) and every corner sampling ONE texel deep
 * inside the atlas's 'M' (median 254/255 -> the shader's `fillEdge` is 1 and the triangle is
 * solid). A constant UV also means zero derivatives, so it never drops to a blurrier mip.
 */
/** Cap height of a world label, cm (FlyConfig.SCAN_LABEL_CAP_CM). */
const LABEL_CAP_CM = FlyConfig.SCAN_LABEL_CAP_CM
const ARROW_UV_X = 0.8329 // atlas texel centre (635.5, 294.5) of 763x773 — deepest MSDF pixel
const ARROW_UV_Y = 0.381
const ARROW_W_EM = 0.58 // U+25BC in ChakraPetch-SemiBold
const ARROW_TOP_EM = 0.584 // above the baseline
const ARROW_BOT_EM = -0.005

class WorldLabels {
  private obj: SceneObject
  private vis: RenderMeshVisual
  private face = TextBatch.face("ui")
  private empty = true

  /** null = no MSDF material or no metadata in this project: the caller keeps the old Text path. */
  static make(base: Material | null): WorldLabels | null {
    if (!base) return null
    const w = new WorldLabels(base)
    return w.face ? w : null
  }

  private constructor(base: Material) {
    this.obj = global.scene.createSceneObject("ScanLabels") // a scene ROOT: its transform is identity
    this.vis = this.obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    this.vis.mainMaterial = base.clone()
    this.obj.enabled = false
    this.uniforms()
  }

  /** a 5.15/5.23 clone takes the .mat defaults and a mesh swap re-instantiates the pass: set both */
  private uniforms() {
    const p: any = (this.vis as any).mainPass
    if (!p) return
    const atlas = this.face ? this.face.atlas : null
    if (atlas) p.atlas = atlas // else the .mat carries it (ADR 40 trap 1)
    p.tint = new vec4(1, 1, 1, 1) // the colour is per-vertex, one batch for every class
    p.gain = 1
    p.blendMode = BlendMode.Add
    p.depthWrite = false
    p.twoSided = true
  }

  /** Rebuild the whole mesh from the live finds. Called only when one of them changed. */
  build(found: Found[], capCm: number) {
    const f = this.face
    if (!f) return
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture1", components: 2 }, // index 0 is the engine's auto UV and cannot be written
      { name: "texture2", components: 2 }, // colour r,g
      { name: "texture3", components: 2 }, // colour b,a
    ])
    mb.topology = MeshTopology.Triangles
    mb.indexType = MeshIndexType.UInt16
    let base = 0
    const v: number[] = new Array(36)
    for (const it of found) {
      if (it.hidden) continue
      const laid = f.laid(it.text)
      const em = capCm / f.capEm // cm per EM
      const lineCm = laid.lineHeight * em // the font's own line height
      const cr = it.color.x
      const cg = it.color.y
      const cb = it.color.z
      const ca = it.color.w
      const rx = it.right
      const uy = it.up
      const o = it.pos
      // two lines, centred on the origin exactly as the Component.Text box was: the name on top,
      // the arrow under it, its tip on the anchor
      const quad = (x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, bx: number) => {
        // (x0,y0) top-left .. (x1,y1) bottom-right in the label's own plane, cm; bx collapses the
        // bottom edge toward the centre (bx = 0 keeps the rectangle, bx = 1 makes a triangle)
        const bl = x0 + (x1 - x0) * 0.5 * bx
        const br = x1 - (x1 - x0) * 0.5 * bx
        const pt = (x: number, y: number, k: number) => {
          v[k] = o.x + rx.x * x + uy.x * y
          v[k + 1] = o.y + rx.y * x + uy.y * y
          v[k + 2] = o.z + rx.z * x + uy.z * y
        }
        pt(x0, y0, 0)
        v[3] = u0; v[4] = v0; v[5] = cr; v[6] = cg; v[7] = cb; v[8] = ca
        pt(x1, y0, 9)
        v[12] = u1; v[13] = v0; v[14] = cr; v[15] = cg; v[16] = cb; v[17] = ca
        pt(br, y1, 18)
        v[21] = u1; v[22] = v1; v[23] = cr; v[24] = cg; v[25] = cb; v[26] = ca
        pt(bl, y1, 27)
        v[30] = u0; v[31] = v1; v[32] = cr; v[33] = cg; v[34] = cb; v[35] = ca
        mb.appendVerticesInterleaved(v)
        mb.appendIndices([base, base + 2, base + 1, base, base + 3, base + 2])
        base += 4
      }
      // line 0: the name, centred. Its line box top sits at +lineCm (block = 2 lines about 0).
      const w = laid.width * em
      const x = -w / 2
      const top0 = lineCm // line 0's box top; the glyph rects carry their own offsets from it
      for (const g of laid.glyphs) {
        if (base > 16000) break
        quad(x + g.x * em, top0 - g.y * em, x + (g.x + g.width) * em, top0 - (g.y + g.height) * em, g.u0, g.v0, g.u1, g.v1, 0)
      }
      // line 1: the arrow. Line 1's box top is 0, and its baseline sits cap-top + cap below that
      // (the font's own `base`: 0.2917 + 0.698 = 0.9896 em, i.e. 95/96).
      const yBase = -(f.capTopEm + f.capEm) * em
      const hw = (ARROW_W_EM * em) / 2
      quad(-hw, yBase + ARROW_TOP_EM * em, hw, yBase + ARROW_BOT_EM * em, ARROW_UV_X, ARROW_UV_Y, ARROW_UV_X, ARROW_UV_Y, 1)
      if (base > 16000) break
    }
    if (base === 0 || !mb.isValid()) {
      if (!this.empty) {
        this.obj.enabled = false
        this.empty = true
      }
      return
    }
    this.vis.mesh = mb.getMesh()
    mb.updateMesh()
    this.uniforms() // the mesh swap re-instantiated the pass (ADR 40 trap 2)
    this.obj.enabled = true
    this.empty = false
  }
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
  // 12.09, the pattern of a camera dataset streamer: it does not leave a camera callback
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

  constructor(private sources: WorldSources, private cameraObject: SceneObject, private font: Font | null, cameraModuleAsset: CameraModule | null = null) {
    this.root = global.scene.createSceneObject("WorldScan")
    // ADR 40, extended to the room: 24 possible labels in ONE mesh instead of 24 Component.Texts.
    // A null result (no BoardText.mat, no font metadata) falls back to the old one-Text-each path.
    try {
      this.labels = WorldLabels.make(TextBatch.material())
    } catch (e) {
      this.labels = null
    }
    log.i("SCAN_LABELS " + (this.labels ? "batched (1 draw)" : "per-Text fallback"))
    this.cam = cameraObject.getComponent("Component.Camera") as Camera
    this.tracking = (cameraObject.getComponent("Component.DeviceTracking") as DeviceTracking) || null
    try {
      // a bound CameraModule asset declares the Camera capability for certain; require() is the fallback
      const cameraModule = cameraModuleAsset || (require("LensStudio:CameraModule") as CameraModule)
      // a CameraId the runtime does not report throws: open the first world camera that opens
      this.camTex = requestWorldCamera(cameraModule, FlyConfig.SCAN_CAMERA_SMALLER_PX)
      if (!this.camTex) throw new Error("no world colour camera")
      this.camProv = this.camTex.control as CameraTextureProvider
      // subscribed only while a capture is armed (SCAN_DEPTH_GATED), like the depth session
      if (!FlyConfig.SCAN_DEPTH_GATED) this.camReg = this.camProv.onNewFrame.add(this.onCamFrame)
      this.colorCam = worldDeviceCamera() // same id as the texture, or the pair is off by the stereo baseline
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
  private static LIFT = new vec3(0, FlyConfig.SCAN_LABEL_LIFT_CM, 0)
  private static UP = new vec3(0, 1, 0)
  private static RIGHT = new vec3(1, 0, 0)
  private labels: WorldLabels | null = null
  private labelsDirty = false

  /** the label's one and only aim: above its object, facing where the user stands now */
  private aimLabel(f: Found) {
    const p = f.src.pos.add(WorldScanner.LIFT)
    const camPos = this.cameraObject.getTransform().getWorldPosition()
    const rot = quat.lookAt(camPos.sub(p).normalize(), WorldScanner.UP)
    f.pos = p
    // the batch draws in world space, so the aim quaternion becomes the label's own plane. Taken
    // from the SAME quaternion the Text component used to be given, so nothing moves on screen.
    f.right = rot.multiplyVec3(WorldScanner.RIGHT)
    f.up = rot.multiplyVec3(WorldScanner.UP)
    this.labelsDirty = true
    if (f.obj) {
      const t = f.obj.getTransform()
      t.setWorldPosition(p)
      t.setWorldRotation(rot)
    }
  }

  tick(dt: number) {
    this.now += dt
    this.labelT += dt
    // 15.09 Pavlo, "optimisation above all": a label is aimed at the user ONCE, when it spawns or
    // moves (aimLabel); nothing re-aims it per tick. The 2 Hz pass here only expires finds and hides
    // labels that sit behind the board.
    const pass = this.labelT >= 0.5
    if (pass) this.labelT = 0
    // expire what Gemini hasn't confirmed for a while
    for (let i = this.found.length - 1; i >= 0; i--) {
      const f = this.found[i]
      // 12.09: a find expires when Gemini stops re-confirming it — but when scanning is OFF (the
      // editor after the intro, and the bench) nothing CAN re-confirm it, so the whole room map
      // emptied itself 150 s after the scan. No scanner, no expiry.
      if (this.every < 1e5 && this.now - f.seen > FlyConfig.SCAN_TTL_S) {
        this.forget(f)
        continue
      }
      if (!pass) continue
      // hidden while it sits behind the board: the additive board can't occlude it ("TV" printed
      // over the NEURAL rows, 11.09 device screenshot)
      const hide = this.occluder ? this.occluder(f.pos) : false
      if (f.hidden !== hide) {
        f.hidden = hide
        this.labelsDirty = true
        if (f.obj) f.obj.enabled = !hide
      }
    }
    // the batched mesh is rewritten only here, and only after something actually changed: a label
    // spawned, moved, was renamed, slipped behind the board or expired. Never per frame.
    if (this.labelsDirty && this.labels) {
      this.labelsDirty = false
      this.labels.build(this.found, LABEL_CAP_CM)
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
    // 12.09 Pavlo, before recording: DEBUG_TELEMETRY_S is the one switch for logging, so the lines
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
          // ADR 93/96: the five 0..1 numbers; anything missing or not a number is left to the class default
          const num = (v: any): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined)
          const props: SourceProps = { smell: num(o.smell), warm: num(o.warm), cold: num(o.cold), humid: num(o.humid), wind: num(o.wind) }
          this.resolve(c, box, (pos: vec3 | null, size: number) => {
            if (!pos) this.misses++
            if (pos) {
              this.placed++
              this.upsert(String(o.label), cls, pos, size, props)
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
    if (f.obj) f.obj.destroy()
    this.found = this.found.filter((x) => x !== f)
    this.labelsDirty = true
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
  private upsert(label: string, cls: SourceClass, pos: vec3, width: number, props?: SourceProps) {
    const size = Math.max(4, Math.min(60, width))
    for (const f of this.found) {
      const d = f.src.pos.distance(pos)
      const sameLabel = f.src.label.toLowerCase() === label.toLowerCase() && d < FlyConfig.SCAN_LABEL_MERGE_CM
      if ((f.src.cls === cls && d < FlyConfig.SCAN_MERGE_CM) || sameLabel) {
        this.merged++
        this.sources.move(f.src, vec3.lerp(f.src.pos, pos, 0.5))
        if (props) this.sources.setProps(f.src, props) // a second look refines the smell and the fields
        f.src.label = label
        f.text = label.toUpperCase()
        if (f.obj) (f.obj.getComponent("Component.Text") as Text).text = f.text + "\n▼"
        this.aimLabel(f) // also marks the batch dirty
        f.seen = this.now
        return
      }
    }
    if (this.found.length >= FlyConfig.SCAN_MAX_SOURCES) return
    // no debug sphere/odour shell (a 1.8 m food shell read as a misplaced marker) — the label's
    // arrow points at the exact anchor instead
    const src = this.sources.add(label, cls, pos, size, -1, false, props)
    const text = label.toUpperCase()
    const found: Found = {
      src: src, seen: this.now, text: text, pos: pos, right: WorldScanner.RIGHT, up: WorldScanner.UP,
      color: LABEL_COLOR[cls], hidden: false,
      obj: this.labels ? null : this.makeLabel(text, cls), // batched, or the old one-Text-each path
    }
    this.found.push(found)
    this.aimLabel(found)
    if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
      log.i("SCAN_SOURCE " + cls + " '" + label + "' size=" + size.toFixed(0) + " at " + pos.x.toFixed(0) + "," + pos.y.toFixed(0) + "," + pos.z.toFixed(0) +
        " smell=" + src.smell.toFixed(1) + " reach=" + src.sigma.toFixed(0) + " str=" + src.strength.toFixed(2) +
        (src.field ? " warm=" + src.warm.toFixed(1) + " cold=" + src.cold.toFixed(1) + " humid=" + src.humid.toFixed(1) + " wind=" + src.wind.toFixed(1) : ""))
    }
  }

  /** Fallback only: one Component.Text per thing (= one draw call each), used when the MSDF
   *  material or the font metadata is missing. The batch is the normal path. */
  private makeLabel(text: string, cls: SourceClass): SceneObject {
    const so = global.scene.createSceneObject("ScanLabel")
    so.setParent(this.root)
    const t = so.createComponent("Component.Text") as Text
    if (this.font) t.font = this.font
    t.text = text + "\n▼" // the arrow tip marks the anchor
    t.size = 48
    t.horizontalAlignment = HorizontalAlignment.Center
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.layoutRect = Rect.create(-100, 100, -10, 10)
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

  /** Pause between a Gemini answer and the next capture (intro: back-to-back, then non-stop).
   *  16.09: a huge interval means OFF, and OFF has to push the pending capture out too — the
   *  countdown was already running toward the old rate, so `setInterval(1e6)` alone still fired
   *  one more pass (SCAN_FIRST_S) before going quiet. Resuming keeps the old clamp: the next pass
   *  comes within `s`. */
  setInterval(s: number) {
    this.every = s
    if (s >= 1e5) this.timer = s
    else if (this.timer > s) this.timer = s
  }

  get liveCount(): number {
    return this.found.length
  }
}
