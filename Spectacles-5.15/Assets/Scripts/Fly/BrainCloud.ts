/**
 * BrainCloud v3 — the selected fly's brain as a live hologram on the board's holo stage:
 * 16,000 MaleCNS neurons at their real positions (BrainCloudData.ts — same sample + order the
 * brain server streams), one MeshBuilder mesh (4 verts per neuron) = one draw call.
 *
 * Placement (11.09): the mesh object lives at the SCENE ROOT with an identity transform, so
 * object space == world space whatever the graph's Object->World node does (the v1/v2 streaks
 * and the "sparks on the floor" came from that ambiguity). An invisible anchor on the board
 * gives origin + axes, fed to the BrainDots shader as world-space uniforms each frame.
 * Activity: the spike bitset of every `brain` message -> 128x128 texture (R), decay 0.5/step.
 */
import { BrainMsg } from "./BrainLink"
import { CLOUD_GROUP, CLOUD_GROUP_KEYS, CLOUD_HUE, CLOUD_N, CLOUD_XYZ } from "./BrainCloudData"
import { FlyConfig } from "./FlyConfig"

const TEX = 128
const BIG = 100000
// reused unit axes: these were three fresh vec3 per frame just to be rotated (12.09 audit)
const CX = new vec3(1, 0, 0)
const CY = new vec3(0, 1, 0)
const CZ = new vec3(0, 0, 1)
// 15.09 perf pass: the upright flip is a constant and was rebuilt (quat + vec3) every frame.
const UPRIGHT = quat.angleAxis(Math.PI / 2, CX)

export class BrainCloud {
  /** Last construction step reached (reported by the board when the build throws). */
  static stage = "none"
  private root: SceneObject
  private anchor: SceneObject
  private mat: Material
  private provider: ProceduralTextureProvider
  private pixels: Uint8Array
  private level: Float32Array
  // 12.09 device trace: only the dots that still have something to fade are worth touching.
  private active: Int32Array
  private activeN = 0
  private lastSim = -1
  private sinceUpdate = 99
  private spin = 0
  private updates = 0
  private lastLit = 0
  private verts = 0
  private highlight = -1
  private camDist = -1

  status(): string {
    // ps read-back with float32 rounding (0.31999…) proves the uniform is bound
    const p: any = this.mat ? this.mat.mainPass : null
    return "verts=" + this.verts + " upd=" + this.updates + " lit=" + this.lastLit + " dcam=" + this.camDist.toFixed(0) +
      (p ? " ps=" + p.pointSize + " fc=" + p.frustumCullMode + " on=" + this.root.enabled : "")
  }

  constructor(anchorParent: SceneObject, base: Material, localPos: vec3, private radiusCm: number) {
    BrainCloud.stage = "anchor"
    this.anchor = global.scene.createSceneObject("BrainCloudAnchor")
    this.anchor.setParent(anchorParent)
    this.anchor.getTransform().setLocalPosition(localPos)
    this.root = global.scene.createSceneObject("BrainCloud") // scene root, identity transform

    BrainCloud.stage = "meshbuilder"
    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },
      { name: "texture1", components: 2 },
      { name: "texture2", components: 2 },
    ])
    mb.topology = MeshTopology.Triangles
    mb.indexType = MeshIndexType.UInt16
    const r = 1 / 32767 // unit positions; the shader scales them onto the stage
    // every Nth neuron is drawn (CLOUD_DRAW_EVERY): the fill cost is 16,000 overlapping additive
    // quads, and the silhouette survives thinning far better than the fill rate does
    const step = Math.max(1, Math.floor(FlyConfig.CLOUD_DRAW_EVERY))
    const drawn = Math.ceil(CLOUD_N / step)
    const verts: number[] = new Array(drawn * 4 * 9)
    const idx: number[] = new Array(drawn * 6)
    const corners = [0, 0, 1, 0, 1, 1, 0, 1]
    let v = 0
    let q = 0 // index of this dot among the DRAWN ones (i still indexes the neuron)
    for (let i = 0; i < CLOUD_N; i += step) {
      const x = CLOUD_XYZ[3 * i] * r
      const y = CLOUD_XYZ[3 * i + 1] * r
      const z = CLOUD_XYZ[3 * i + 2] * r
      const tu = ((i % TEX) + 0.5) / TEX
      const tv = (Math.floor(i / TEX) + 0.5) / TEX
      const h = CLOUD_HUE[i] / 255
      // group bits 6.. = the board's command rows (DNa02 L/R, escape, stop, feed, stress). Those are
      // 1-8 neurons each: the shader draws them as beacons, else the status is invisible in the cloud
      const cmd = CLOUD_GROUP[i] >> 6 ? 1 : 0
      for (let c = 0; c < 4; c++) {
        verts[v++] = x
        verts[v++] = y
        verts[v++] = z
        verts[v++] = corners[2 * c]
        verts[v++] = corners[2 * c + 1]
        verts[v++] = tu
        verts[v++] = tv
        verts[v++] = h
        verts[v++] = cmd
      }
      const b = 4 * q
      idx[6 * q] = b
      idx[6 * q + 1] = b + 1
      idx[6 * q + 2] = b + 2
      idx[6 * q + 3] = b
      idx[6 * q + 4] = b + 2
      idx[6 * q + 5] = b + 3
      q++
    }
    // Two unreferenced far vertices: the mesh AABB then spans the world, so the draw is never
    // frustum-culled around the world origin (the real dots are placed on the board by the shader).
    for (const s of [-BIG, BIG]) verts.push(s, s, s, 0, 0, 0, 0, 0, 0)
    BrainCloud.stage = "append"
    mb.appendVerticesInterleaved(verts)
    mb.appendIndices(idx)
    mb.updateMesh()
    this.verts = mb.getVerticesCount()

    BrainCloud.stage = "texture"
    const tex = ProceduralTextureProvider.createWithFormat(TEX, TEX, TextureFormat.RGBA8Unorm)
    this.provider = tex.control as ProceduralTextureProvider
    this.pixels = new Uint8Array(TEX * TEX * 4)
    this.level = new Float32Array(CLOUD_N)
    this.active = new Int32Array(CLOUD_N)
    for (let i = 0; i < CLOUD_N; i++) this.pixels[4 * i + 3] = 255 // alpha never changes: set it once
    this.provider.setPixels(0, 0, TEX, TEX, this.pixels)

    BrainCloud.stage = "visual"
    const rmv = this.root.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    rmv.mesh = mb.getMesh()
    BrainCloud.stage = "clone"
    this.mat = base.clone()
    // 5.15: a clone resets graph defaults and may drop texture bindings — set everything
    const pass: any = this.mat.mainPass
    BrainCloud.stage = "uniforms"
    pass.activity = tex
    // 12.09 shader audit: the activity texture is read at exact texel centres and has no mips, so
    // Trilinear only costs — one texel per neuron, nearest is the honest sample
    try {
      ;(pass as any).samplers.activity.filtering = FilteringMode.Nearest
    } catch (e) {
      /* older pass without a samplers accessor: the .mat default stands */
    }
    pass.tint = FlyConfig.FLY_COLORS[0]
    pass.pointSize = FlyConfig.CLOUD_POINT_CM
    pass.flash = 1.0
    pass.baseGlow = FlyConfig.CLOUD_BASE_GLOW
    pass.blendMode = BlendMode.Add
    pass.depthWrite = false
    pass.twoSided = true
    // vertices are displaced far from the mesh's own AABB — never frustum-cull this draw
    BrainCloud.stage = "frustum"
    pass.frustumCullMode = FrustumCullMode.UserDefinedAABB
    pass.frustumCullMin = new vec3(-BIG, -BIG, -BIG)
    pass.frustumCullMax = new vec3(BIG, BIG, BIG)
    BrainCloud.stage = "assign"
    rmv.mainMaterial = this.mat
    BrainCloud.stage = "done"
  }

  /** The real brain + VNC outline around the dots (11.09 Pavlo: "the silhouette should read").
   *  MaleCNS shell meshes (tools/anatomy, Janelia CC-BY) already in the cloud's unit space, so as
   *  children of the anchor at the cloud radius they sway/turn with it and overlay the dots exactly.
   *  A faint FlyHolo rim clone in the fly colour; no depth write, so the dots inside stay visible.
   *  Prefabs come in through FlySwarm's `brainShells` input: requireAsset can't see assets the
   *  scene doesn't reference ("Cannot find asset", 11.09). */
  private shellMats: Material[] = []
  private shellColor: vec4 | null = null
  addShells(prefabs: ObjectPrefab[], holo: Material | null) {
    if (!holo || !prefabs || prefabs.length === 0) return
    try {
      for (const prefab of prefabs) {
        if (!prefab) continue
        const so = prefab.instantiate(this.anchor)
        so.getTransform().setLocalScale(vec3.one().uniformScale(this.radiusCm))
        const visit = (o: SceneObject) => {
          for (const rmv of o.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]) {
            const m = holo.clone()
            const p: any = m.mainPass
            // multiply the material's own values (FlyHolo values stay Pavlo's, ADR 17)
            p.glow = (typeof p.glow === "number" ? p.glow : 1) * FlyConfig.CLOUD_SHELL_GLOW
            p.bodyGlow = (typeof p.bodyGlow === "number" ? p.bodyGlow : 0.06) * FlyConfig.CLOUD_SHELL_BODY
            p.depthWrite = false
            rmv.mainMaterial = m
            this.shellMats.push(m)
          }
          for (let c = 0; c < o.getChildrenCount(); c++) visit(o.getChild(c))
        }
        visit(so)
      }
    } catch (e) {
      print("BrainCloud shells unavailable: " + e)
    }
  }

  setVisible(on: boolean) {
    if (this.root.enabled !== on) this.root.enabled = on
  }

  /** Hovered board row (a CLOUD_GROUP_KEYS key) -> its neurons glow in the fly's colour (G),
   *  every other neuron dims (B). null = no highlight. Spikes keep flashing in R either way. */
  setHighlight(key: string | null) {
    const b = key ? CLOUD_GROUP_KEYS.indexOf(key) : -1
    if (b === this.highlight) return
    this.highlight = b
    const mask = b >= 0 ? 1 << b : 0
    const px = this.pixels
    for (let i = 0; i < CLOUD_N; i++) {
      const on = mask !== 0 && (CLOUD_GROUP[i] & mask) !== 0
      px[4 * i + 1] = on ? 255 : 0
      px[4 * i + 2] = mask !== 0 && !on ? 255 : 0
    }
    this.provider.setPixels(0, 0, TEX, TEX, px)
  }

  private camRx = NaN
  private camRy = NaN
  private camRz = NaN
  private camUx = NaN
  private camUy = NaN
  private camUz = NaN
  update(dt: number, msg: BrainMsg | null, color: vec4, cam: Transform) {
    this.sinceUpdate += dt
    this.spin += dt * FlyConfig.CLOUD_SPIN
    // Upright frontal view like connectome viewers: data z runs brain (-z) -> VNC (+z), so
    // +90 deg about X puts the brain on top and the VNC below; gentle sway about vertical.
    const at = this.anchor.getTransform()
    // ...then CLOUD_FACE_DEG about the vertical turns the side we look at (12.09 Pavlo: 180 deg to us)
    const face = FlyConfig.CLOUD_SWAY * Math.sin(this.spin) + (FlyConfig.CLOUD_FACE_DEG * Math.PI) / 180
    at.setLocalRotation(quat.angleAxis(face, CY).multiply(UPRIGHT))

    const rot = at.getWorldRotation()
    const k = this.radiusCm * at.getWorldScale().x
    const pass: any = this.mat.mainPass
    const origin = at.getWorldPosition()
    pass.origin = origin
    this.camDist = origin.distance(cam.getWorldPosition())
    pass.axisX = rot.multiplyVec3(CX).uniformScale(k)
    pass.axisY = rot.multiplyVec3(CY).uniformScale(k)
    pass.axisZ = rot.multiplyVec3(CZ).uniformScale(k)
    // The two billboard axes only change when the HEAD ROTATES, and a uniform write is the cost
    // (ADR 44 made the same fix for the eye dots). A still head now writes neither.
    const cr = cam.right
    const cu = cam.up
    if (cr.x !== this.camRx || cr.y !== this.camRy || cr.z !== this.camRz || cu.x !== this.camUx || cu.y !== this.camUy || cu.z !== this.camUz) {
      this.camRx = cr.x
      this.camRy = cr.y
      this.camRz = cr.z
      this.camUx = cu.x
      this.camUy = cu.y
      this.camUz = cu.z
      pass.camRight = cr
      pass.camUp = cu
    }
    // tint and point size only change when the selected fly does (pointSize is set in the ctor)
    if (color !== this.shellColor) {
      this.shellColor = color
      pass.tint = color
      for (const m of this.shellMats) m.mainPass.rimColor = color
    }
    // Spike gain (12.09): the per-step pulse now rides on CLOUD_FLASH, so a firing dot stands out
    // against a dim resting cloud instead of adding to an already saturated one.
    pass.flash = FlyConfig.CLOUD_FLASH * (0.82 + 0.18 * Math.exp(-this.sinceUpdate * 1.5))

    if (!msg || !msg.cloud || msg.sim_ms === this.lastSim) return
    this.lastSim = msg.sim_ms
    this.sinceUpdate = 0
    const bits = Base64.decode(msg.cloud)
    const px = this.pixels
    this.updates++
    this.lastLit = 0
    // 12.09 device trace (`b.cloud` = 5.2 ms of EVERY frame, ~15 ms on the frames it actually
    // runs): this used to walk all 16,000 dots. But only ~11 % spike in a step and the fading tail
    // is ~8 % more, so four fifths of the iterations wrote a zero over a zero. Now: fade the short
    // list of dots that still glow, then walk the bitset a BYTE at a time and skip the empty ones.
    const lvl = this.level
    const act = this.active
    const decay = FlyConfig.CLOUD_DECAY
    let n = 0
    for (let k = 0; k < this.activeN; k++) {
      const i = act[k]
      const l = lvl[i] * decay
      if (l < 0.02) {
        lvl[i] = 0
        px[4 * i] = 0
        continue
      }
      lvl[i] = l
      px[4 * i] = (l * 255) | 0
      act[n++] = i
    }
    const bytes = CLOUD_N >> 3
    for (let b = 0; b < bytes; b++) {
      const v = bits[b]
      if (v === 0) continue // numpy packbits: MSB first, and ~40 % of bytes are empty
      for (let j = 0; j < 8; j++) {
        if (((v >> (7 - j)) & 1) === 0) continue
        const i = (b << 3) + j
        this.lastLit++
        if (lvl[i] === 0) act[n++] = i // not already on the fading list
        lvl[i] = 1
        px[4 * i] = 255
      }
    }
    this.activeN = n
    this.provider.setPixels(0, 0, TEX, TEX, px)
  }
}
