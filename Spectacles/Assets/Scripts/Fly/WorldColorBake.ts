/**
 * WorldColorBake — the room's colours for the flies' eye cameras (11.09 the user: "bake vertex colour
 * into the world mesh while it's built: that is the fly's colour input; not detailed, but
 * something"). The tracked mesh's positions can be read but its indices can't ("Unsupported mesh
 * index format") and it takes no colours, so colours live in a 256x256 VOXEL-HASH texture:
 *  - every WorldScanner frame (+ the camera pose it came from) projects the mesh vertices into
 *    that frame and averages their colour into their 8 cm voxel's texel;
 *  - the tracked world mesh itself (on the vision layer after the intro) wears `VisionHash`, which
 *    looks its voxel's texel up from its world position — no geometry copy.
 * Texel mapping (must match VisionHash.glsl): u = ix%64 + 64*(iz%4), v = iy%32 + 32*((iz/4)%8).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("WorldColorBake")
const TEX = 256
const mod = (a: number, n: number) => ((a % n) + n) % n

export class WorldColorBake {
  material: Material | null = null
  private src: RenderMesh | null = null
  private provider: ProceduralTextureProvider
  private tex: Texture
  private pixels: Uint8Array
  private count: Uint16Array // samples per texel (running mean)
  private pos: number[] = []
  private geomT = 0
  private bakes = 0
  private texels = 0
  private err = ""
  private lastStats = ""
  private sampleP = ""
  private sampleS = ""

  constructor(worldMeshSource: SceneObject | null, material: Material | null, private cameraObject: SceneObject) {
    const find = (so: SceneObject) => {
      const r = so.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
      if (r && r.mesh && !this.src) this.src = r.mesh
      for (let i = 0; i < so.getChildrenCount() && !this.src; i++) find(so.getChild(i))
    }
    if (worldMeshSource) find(worldMeshSource)
    const tex = ProceduralTextureProvider.createWithFormat(TEX, TEX, TextureFormat.RGBA8Unorm)
    this.tex = tex
    this.provider = tex.control as ProceduralTextureProvider
    this.pixels = new Uint8Array(TEX * TEX * 4) // alpha 0 = unbaked
    this.count = new Uint16Array(TEX * TEX)
    this.provider.setPixels(0, 0, TEX, TEX, this.pixels)
    if (material) {
      const m = material.clone()
      const p: any = m.mainPass
      p.colors = tex // (5.15: clones drop texture bindings — always re-bind)
      // 12.09 shader audit: this is a voxel HASH — neighbouring texels are unrelated voxels, so
      // Trilinear blended two different pieces of the room into every voxel edge
      try {
        ;(p as any).samplers.colors.filtering = FilteringMode.Nearest
      } catch (e) {
        /* older pass without a samplers accessor: the .mat default stands */
      }
      p.gain = FlyConfig.BAKE_GAIN
      p.blocky = FlyConfig.BAKE_TEXTURE
      p.voxel = FlyConfig.BAKE_VOXEL_CM
      p.depthWrite = true
      p.twoSided = true
      this.material = m
    } else this.err = "no VisionHash material"
    if (!this.src) this.err = "no world mesh"
  }

  /** The voxel-hash colour texture (also painted onto the intro scan grid, ScanPaint). */
  get texture(): Texture {
    return this.tex
  }

  get hasColor(): boolean {
    return this.texels > 0
  }

  status(): string {
    const b = this.bounds
    const room = b ? " room=" + (b.max.x - b.min.x).toFixed(0) + "x" + (b.max.y - b.min.y).toFixed(0) + "x" + (b.max.z - b.min.z).toFixed(0) : ""
    return "verts=" + this.pos.length / 3 + room + " " + this.calStr + " texels=" + this.texels + " bakes=" + this.bakes + " [" + this.lastStats + "]" + (this.err ? " err=" + this.err.substring(0, 60) : "")
  }

  // On the glasses the scan frame comes from the Left_Color camera, not the display camera, so the
  // vertices are projected through its own intrinsics there (11.09 "the scan isn't painted in colour");
  // the editor keeps the scene camera (its frames ARE the scene camera's view)
  private colorCam: DeviceCamera | null | undefined = undefined
  private colorCamera(): DeviceCamera | null {
    if (this.colorCam === undefined) {
      try {
        this.colorCam = global.deviceInfoSystem.isEditor() ? null : global.deviceInfoSystem.getTrackingCameraForId(CameraModule.CameraId.Left_Color)
      } catch (e) {
        this.colorCam = null
      }
    }
    return this.colorCam
  }

  // Extracted vertices vs the scene's world frame (11.09: in the editor the box came out mirrored —
  // x -158..490, z -8..493 cm while the camera stood at -233,24,-432). Checked against real
  // world-mesh raycast hits (the frame the camera, the flies and their eyes live in): the axis flip
  // whose vertices lie ON the hits is used for the room box and the colour bake.
  private sx = 1
  private sz = 1
  private calStr = "cal=none"
  private calLast = -1
  private calWins = 0
  private calLocked = false
  private tracking: DeviceTracking | null | undefined = undefined
  private calibrate() {
    if (this.tracking === undefined) {
      try {
        this.tracking = this.cameraObject.getComponent("Component.DeviceTracking") as DeviceTracking
      } catch (e) {
        this.tracking = null
      }
    }
    const tr = this.tracking
    const n = this.pos.length / 3
    if (!tr || n < 300) return
    const c = this.cameraObject.getTransform().getWorldPosition()
    const hits: vec3[] = []
    for (let j = 0; j < 10; j++) {
      const a = (j * Math.PI) / 4
      const dir = j < 8 ? new vec3(Math.cos(a), -0.35, Math.sin(a)) : new vec3(j === 8 ? 0.3 : -0.3, -1, 0)
      const dn = dir.normalize()
      const res = tr.raycastWorldMesh(c, c.add(dn.uniformScale(600)))
      if (!res || res.length === 0) continue
      // nearest hit IN FRONT, within the ray (the API also returns hits off the segment)
      let best: vec3 | null = null
      for (const hh of res) {
        const v = hh.position.sub(c)
        if (v.dot(dn) < 0 || v.length > 600) continue
        if (!best || v.length < best.distance(c)) best = hh.position
      }
      if (best) hits.push(best)
    }
    if (hits.length < 3) {
      this.calStr = "cal=hits" + hits.length
      return
    }
    const k = FlyConfig.BAKE_POS_SCALE
    const step = Math.max(1, Math.floor(n / 3000))
    const cands: number[][] = [[1, 1], [-1, -1], [1, -1], [-1, 1]]
    const errs: number[] = []
    for (const cd of cands) {
      const ds: number[] = []
      for (const hp of hits) {
        let b2 = 1e12
        for (let v = 0; v < n; v += step) {
          const dx = cd[0] * this.pos[3 * v] * k - hp.x
          const dy = this.pos[3 * v + 1] * k - hp.y
          const dz = cd[1] * this.pos[3 * v + 2] * k - hp.z
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < b2) b2 = d2
        }
        ds.push(Math.sqrt(b2))
      }
      ds.sort((x, y) => x - y)
      errs.push(ds[Math.floor(ds.length / 2)]) // median: a hit on a patch not extracted yet is an outlier
    }
    let bi = 0
    for (let i = 1; i < errs.length; i++) if (errs[i] < errs[bi]) bi = i
    this.calWins = bi === this.calLast ? this.calWins + 1 : 1
    this.calLast = bi
    // locked = the same flip 3 reads in a row, clearly better than the rest (sparse samples: the right
    // frame still reads ~40 cm, 11.09 editor: 43 vs 241-427)
    const second = Math.min(...errs.filter((_, i) => i !== bi))
    if (this.calWins >= 3 && errs[bi] < FlyConfig.BAKE_CAL_LOCK_CM && errs[bi] < 0.5 * second) this.calLocked = true
    this.sx = cands[bi][0]
    this.sz = cands[bi][1]
    this.calStr = "cal=" + ["id", "flipXZ", "flipZ", "flipX"][bi] + (this.calLocked ? "!" : "?") + " err=" + errs.map((e) => e.toFixed(0)).join("/")
  }

  /** The vertex frame is verified against real hits: only then may the box hold flies. */
  get frameOk(): boolean {
    return this.calLocked
  }

  /** The room box from the scanned mesh, cm (robust 2-98 % per axis: a window or a stray far
   *  triangle must not blow it up). Flies stay inside it (11.09 "flies fly out of the world mesh"). */
  bounds: { min: vec3; max: vec3 } | null = null
  private updateBounds() {
    const n = this.pos.length / 3
    if (n < 300) return
    const step = Math.max(1, Math.floor(n / 1500)) // 1.5k samples: enough for 2-98 %, cheap to sort on device (11.09: bake spike 87 ms)
    const k = FlyConfig.BAKE_POS_SCALE
    const ax: number[][] = [[], [], []]
    const sg = [this.sx, 1, this.sz]
    for (let v = 0; v < n; v += step) for (let c = 0; c < 3; c++) ax[c].push(this.pos[3 * v + c] * k * sg[c])
    const lo: number[] = []
    const hi: number[] = []
    for (const a of ax) {
      a.sort((x, y) => x - y)
      lo.push(a[Math.floor(0.02 * (a.length - 1))])
      hi.push(a[Math.floor(0.98 * (a.length - 1))])
    }
    // the box only GROWS (12.09: it froze at the partially scanned room and its z+ face sat 50 cm
    // from the flies -> 973 clamps in 25 s, the shoves the user saw as teleports)
    const b = this.bounds
    this.bounds = b
      ? { min: new vec3(Math.min(b.min.x, lo[0]), Math.min(b.min.y, lo[1]), Math.min(b.min.z, lo[2])),
          max: new vec3(Math.max(b.max.x, hi[0]), Math.max(b.max.y, hi[1]), Math.max(b.max.z, hi[2])) }
      : { min: new vec3(lo[0], lo[1], lo[2]), max: new vec3(hi[0], hi[1], hi[2]) }
  }

  tick(dt: number, every = FlyConfig.BAKE_GEOM_S) {
    if (!this.src) return
    this.geomT -= dt
    if (this.geomT > 0) return
    this.geomT = every
    try {
      // raw world-mesh vertices come back in METRES, the scene is in cm (11.09: every vertex read
      // as "too far" — camera at -357,37,-657 cm, first vertex at -2,1,-1)
      // kept in metres and scaled inside bake(): copying the whole array stalled 67-207 ms (11.09 perf)
      this.pos = this.src.extractVerticesForAttribute("position")
      if (!this.calLocked) this.calibrate()
      this.updateBounds()
    } catch (e) {
      this.err = "extract: " + e
    }
  }

  /** A scan frame + the camera pose it was taken from: project vertices, average their colour. */
  bake(tex: Texture, camWorld: mat4) {
    if (!this.pos.length) return
    try {
      const w = tex.getWidth()
      const h = tex.getHeight()
      const copy = ProceduralTextureProvider.createFromTexture(tex)
      const prov = copy.control as ProceduralTextureProvider
      // sparse readback: BAKE_ROWS full-width rows (a full-res read would be ~5 MB per frame)
      const rows = FlyConfig.BAKE_ROWS
      const rowBuf: Uint8Array[] = []
      for (let r = 0; r < rows; r++) {
        const b = new Uint8Array(w * 4)
        prov.getPixels(0, Math.min(h - 1, Math.floor(((r + 0.5) / rows) * h)), w, 1, b)
        rowBuf.push(b)
      }
      const ct = this.cameraObject.getTransform()
      const cam = this.cameraObject.getComponent("Component.Camera") as Camera
      const toNow = ct.getWorldTransform().mult(camWorld.inverse()) // capture pose -> current pose
      const camNow = ct.getWorldPosition()
      const fwdNow = ct.back
      const camPos = camWorld.multiplyPoint(vec3.zero())
      const n = this.pos.length / 3
      const step = Math.max(1, Math.floor(n / FlyConfig.BAKE_MAX_VERTS))
      const vx = FlyConfig.BAKE_VOXEL_CM
      const ps = FlyConfig.BAKE_POS_SCALE // metres -> cm
      // plain-number maths: no vec3 per vertex (11.09 perf, up to 20k vertices per bake = GC stalls)
      const c0 = toNow.column0
      const c1 = toNow.column1
      const c2 = toNow.column2
      const c3 = toNow.column3
      const cc = this.colorCamera()
      const inv = camWorld.inverse() // world -> device reference at capture (colour-camera path)
      const i0 = inv.column0
      const i1 = inv.column1
      const i2 = inv.column2
      const i3 = inv.column3
      const range2 = FlyConfig.SCAN_RANGE_CM * FlyConfig.SCAN_RANGE_CM
      let far = 0
      let behind = 0
      let off = 0
      let used = 0
      for (let v = 0; v < n; v += step) {
        const px = this.pos[3 * v] * ps * this.sx
        const py = this.pos[3 * v + 1] * ps
        const pz = this.pos[3 * v + 2] * ps * this.sz
        if (v === 0) this.sampleP = px.toFixed(0) + "," + py.toFixed(0) + "," + pz.toFixed(0)
        const dx = px - camPos.x
        const dy = py - camPos.y
        const dz = pz - camPos.z
        if (dx * dx + dy * dy + dz * dz > range2) {
          far++
          continue
        }
        let s: vec2
        if (cc) {
          const ex = i0.x * px + i1.x * py + i2.x * pz + i3.x
          const ey = i0.y * px + i1.y * py + i2.y * pz + i3.y
          const ez = i0.z * px + i1.z * py + i2.z * pz + i3.z
          if (ez >= 0) {
            behind++ // cameras look down -Z
            continue
          }
          s = cc.project(new vec3(ex, ey, ez))
        } else {
          // where p would be if the capture pose were the camera now (toNow * p, affine)
          const qx = c0.x * px + c1.x * py + c2.x * pz + c3.x
          const qy = c0.y * px + c1.y * py + c2.y * pz + c3.y
          const qz = c0.z * px + c1.z * py + c2.z * pz + c3.z
          if ((qx - camNow.x) * fwdNow.x + (qy - camNow.y) * fwdNow.y + (qz - camNow.z) * fwdNow.z <= 0) {
            behind++
            continue
          }
          s = cam.worldSpaceToScreenSpace(new vec3(qx, qy, qz))
        }
        if (used === 0 && off === 0) this.sampleS = s.x.toFixed(2) + "," + s.y.toFixed(2)
        if (s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1) {
          off++
          continue
        }
        used++
        // readback rows run bottom-up: screen y (top = 0) -> row from the bottom
        const row = rowBuf[Math.min(rows - 1, Math.floor((FlyConfig.BAKE_FLIP_Y ? 1 - s.y : s.y) * rows))]
        const x = Math.min(w - 1, Math.floor(s.x * w)) * 4
        const ix = Math.floor(px / vx)
        const iy = Math.floor(py / vx)
        const iz = Math.floor(pz / vx)
        const u = mod(ix, 64) + 64 * mod(iz, 4)
        const t = mod(iy, 32) + 32 * mod(Math.floor(iz / 4), 8)
        const k = t * TEX + u
        const c = this.count[k]
        const a = c < 8 ? 1 / (c + 1) : 0.12 // running mean, then slow update
        const o = 4 * k
        this.pixels[o] += (row[x] - this.pixels[o]) * a
        this.pixels[o + 1] += (row[x + 1] - this.pixels[o + 1]) * a
        this.pixels[o + 2] += (row[x + 2] - this.pixels[o + 2]) * a
        if (!c) this.texels++
        this.pixels[o + 3] = 255
        if (c < 65535) this.count[k] = c + 1
      }
      this.provider.setPixels(0, 0, TEX, TEX, this.pixels)
      this.bakes++
      this.lastStats = "proj=" + (cc ? "color" : "display") + " far=" + far +" behind=" + behind + " off=" + off + " used=" + used + " cam=" +
        camPos.x.toFixed(0) + "," + camPos.y.toFixed(0) + "," + camPos.z.toFixed(0) + " p0=" + this.sampleP + " s0=" + this.sampleS
    } catch (e) {
      this.err = "bake: " + e
      log.w("BAKE_FAIL " + e)
    }
  }
}
