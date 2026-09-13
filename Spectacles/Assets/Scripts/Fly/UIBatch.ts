/**
 * NeonBatch — many neon quads in ONE draw call (11.09 perf pass: the board alone was ~48 draws).
 * Same look as NeonQuad (bar / radial glow, fadeX), but every quad's colour, intensity, glow mode
 * and fade live in its vertices (NeonBatch shader: uv1 = r,g · uv2 = b,intensity · uv3 = glow,fade).
 * Quads are axis-aligned rectangles in the parent's local space (or world space for a root batch);
 * `set()` rewrites only that quad's 4 vertices in place, `flush()` uploads once per frame.
 */
export interface NeonQuadSpec {
  x: number
  y: number
  z: number
  w: number
  h: number
  color: vec4
  intensity: number
  glow: number // 0 bar, 1 radial
  fade: number // fade along uv.x (0 = none)
  visible: boolean
}

/** What the board / eye dots draw into: one batched mesh, or (no NeonBatch material wired) the old
 *  one-object-per-quad path with the same API. */
export interface QuadSink {
  so: SceneObject
  add(x: number, y: number, z: number, w: number, h: number, color: vec4, intensity?: number, glow?: number, fade?: number): number
  get(i: number): NeonQuadSpec
  set(i: number, spec: Partial<NeonQuadSpec>): void
  setBillboard(right: vec3, up: vec3): void
  flush(): void
}

/** Fallback: one NeonQuad object per quad (the pre-batch behaviour, ~1 draw each). */
export class NeonQuadSet implements QuadSink {
  so: SceneObject
  private quads: NeonQuadSpec[] = []
  private objs: { so: SceneObject; mat: Material }[] = []
  private rot = quat.quatIdentity()

  constructor(parent: SceneObject | null, private mesh: RenderMesh, private base: Material, name: string) {
    this.so = global.scene.createSceneObject(name)
    if (parent) this.so.setParent(parent)
  }

  add(x: number, y: number, z: number, w: number, h: number, color: vec4, intensity = 1, glow = 0, fade = 0): number {
    const so = global.scene.createSceneObject("Q")
    so.setParent(this.so)
    const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    rmv.mesh = this.mesh
    const mat = this.base.clone()
    const p: any = mat.mainPass
    p.glowMode = glow
    p.fadeX = fade
    p.alpha = 1
    rmv.mainMaterial = mat
    this.objs.push({ so: so, mat: mat })
    this.quads.push({ x: x, y: y, z: z, w: w, h: h, color: color, intensity: intensity, glow: glow, fade: fade, visible: true })
    this.apply(this.quads.length - 1)
    return this.quads.length - 1
  }

  get(i: number): NeonQuadSpec {
    return this.quads[i]
  }

  set(i: number, spec: Partial<NeonQuadSpec>) {
    Object.assign(this.quads[i], spec)
    this.apply(i)
  }

  setBillboard(right: vec3, up: vec3) {
    this.rot = quat.lookAt(right.cross(up), up)
    for (let i = 0; i < this.quads.length; i++) this.apply(i)
  }

  private apply(i: number) {
    const q = this.quads[i]
    const o = this.objs[i]
    o.so.enabled = q.visible
    const t = o.so.getTransform()
    t.setLocalPosition(new vec3(q.x, q.y, q.z))
    t.setLocalRotation(this.rot)
    t.setLocalScale(new vec3(Math.max(0.001, q.w), Math.max(0.001, q.h), 1))
    const p: any = o.mat.mainPass
    p.tint = q.color // NeonGlow input (was NeonQuad `color`, rejected by the device compiler)
    p.intensity = q.intensity
  }

  flush() {}
}

const STRIDE = 11 // position 3 + texture0 2 + texture1 2 + texture2 2 + texture3 2
const CORNERS = [
  [-0.5, -0.5, 0, 0],
  [0.5, -0.5, 1, 0],
  [0.5, 0.5, 1, 1],
  [-0.5, 0.5, 0, 1],
]

export class NeonBatch implements QuadSink {
  so: SceneObject
  private mb: MeshBuilder
  private rmv: RenderMeshVisual
  private quads: NeonQuadSpec[] = []
  private dirty: boolean[] = []
  private built = false
  private anyDirty = false
  // camera-facing quads (world-space batches such as the fly-eye dots): right/up axes per quad
  private right = new vec3(1, 0, 0)
  private up = new vec3(0, 1, 0)

  constructor(parent: SceneObject | null, material: Material, name: string) {
    this.so = global.scene.createSceneObject(name)
    if (parent) this.so.setParent(parent)
    this.rmv = this.so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    const m = material.clone()
    const p: any = m.mainPass
    // `alpha` and `gain` are gone from the shader body (12.09 audit): they were always 1 and cost a
    // multiply per pixel. Writing a property the pass no longer has is a silent no-op at best in
    // 5.15 and corrupts bindings at worst, so the writes go with them.
    p.blendMode = BlendMode.Add
    p.depthWrite = false
    p.twoSided = true
    this.rmv.mainMaterial = m
    this.mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture0", components: 2 },
      { name: "texture1", components: 2 },
      { name: "texture2", components: 2 },
      { name: "texture3", components: 2 },
    ])
    this.mb.topology = MeshTopology.Triangles
    this.mb.indexType = MeshIndexType.UInt16
  }

  get material(): Material {
    return this.rmv.mainMaterial
  }

  /** Add a quad; returns its handle. All quads must be added before the first flush(). */
  add(x: number, y: number, z: number, w: number, h: number, color: vec4, intensity = 1, glow = 0, fade = 0): number {
    this.quads.push({ x: x, y: y, z: z, w: w, h: h, color: color, intensity: intensity, glow: glow, fade: fade, visible: true })
    this.dirty.push(true)
    this.anyDirty = true
    return this.quads.length - 1
  }

  get(i: number): NeonQuadSpec {
    return this.quads[i]
  }

  /** Change any fields of quad i (only that quad is rewritten on the next flush). */
  set(i: number, spec: Partial<NeonQuadSpec>) {
    const q = this.quads[i]
    let changed = false
    for (const k in spec) {
      const v = (spec as any)[k]
      if ((q as any)[k] !== v) {
        ;(q as any)[k] = v
        changed = true
      }
    }
    if (changed) {
      this.dirty[i] = true
      this.anyDirty = true
    }
  }

  /** For world-space batches: quads face the camera (billboard axes shared by all quads). */
  setBillboard(right: vec3, up: vec3) {
    this.right = right
    this.up = up
    for (let i = 0; i < this.quads.length; i++) this.dirty[i] = true
    this.anyDirty = true
  }

  // 12.09 perf: one reused vertex buffer. The old verts() allocated a 44-number array per dirty quad
  // and four more through slice() — about 56 arrays + 224 slices every frame from the board alone.
  private vtx: number[] = new Array(STRIDE)

  /** Writes corner `ci` of quad `q` into the reused `vtx` buffer. */
  private corner(q: NeonQuadSpec, ci: number): number[] {
    const c = CORNERS[ci]
    const w = q.visible ? q.w : 0
    const h = q.visible ? q.h : 0
    const v = this.vtx
    v[0] = q.x + this.right.x * c[0] * w + this.up.x * c[1] * h
    v[1] = q.y + this.right.y * c[0] * w + this.up.y * c[1] * h
    v[2] = q.z + this.right.z * c[0] * w + this.up.z * c[1] * h
    v[3] = c[2]
    v[4] = c[3]
    v[5] = q.color.x
    v[6] = q.color.y
    v[7] = q.color.z
    v[8] = q.intensity
    v[9] = q.glow
    v[10] = q.fade
    return v
  }

  flush() {
    if (!this.anyDirty) return
    if (!this.built) {
      const all: number[] = []
      const idx: number[] = []
      for (let i = 0; i < this.quads.length; i++) {
        for (let c = 0; c < 4; c++) {
          const v = this.corner(this.quads[i], c)
          for (let k = 0; k < STRIDE; k++) all.push(v[k])
        }
        const b = 4 * i
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
      }
      this.mb.appendVerticesInterleaved(all)
      this.mb.appendIndices(idx)
      this.mb.updateMesh()
      this.rmv.mesh = this.mb.getMesh()
      this.built = true
    } else {
      for (let i = 0; i < this.quads.length; i++) {
        if (!this.dirty[i]) continue
        for (let c = 0; c < 4; c++) this.mb.setVertexInterleaved(4 * i + c, this.corner(this.quads[i], c))
      }
      this.mb.updateMesh()
    }
    for (let i = 0; i < this.dirty.length; i++) this.dirty[i] = false
    this.anyDirty = false
  }
}
