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
  glow: number // 0 bar (soft top/bottom), 1 radial disc, 2 solid fill corner to corner (plates)
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
  /** ADR 97: where this batch sits in the draw order (the board's plates draw BEFORE the fly) */
  setRenderOrder(order: number): void
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
    // a clone takes the .mat defaults: every flag explicit (ADR 97 — nothing on a card writes depth)
    p.blendMode = BlendMode.Add
    p.depthWrite = false
    p.depthTest = true
    p.twoSided = true
    rmv.mainMaterial = mat
    rmv.setRenderOrder(this.order)
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

  private order = 0
  setRenderOrder(order: number) {
    this.order = order
    for (const o of this.objs) (o.so.getComponent("Component.RenderMeshVisual") as RenderMeshVisual).setRenderOrder(order)
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
    p.depthWrite = false // ADR 97: a plate never hides the fly; brightness is the plate's whole job
    p.depthTest = true
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

  /** ADR 97: the board and its cards draw at CARD_RENDER_ORDER (-1), under the fly (0) and the FX (1) */
  setRenderOrder(order: number) {
    this.rmv.setRenderOrder(order)
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

/** The device frame every plate wears (ADR 59, third cut, 15.09 Pavlo: "make the frame a proper
 *  cyberpunk design", "flat colour for the corners and lines": every quad here is glow mode 2, solid). No stubs: ONE continuous outer line on the plate's edge, a fainter inner line
 *  inset from it, and the accent colour laid ON the outer line as corner caps (they overlay the line,
 *  so nothing sticks out and nothing has a joint), a header tab at the top-left, its echo at the
 *  bottom-right, and a clip tick at the middle of each side. Twenty quads, all in the plate's batch.
 *  Returns the outer lines (they light when the board is held) and every accent quad (they take the
 *  selected fly's colour). */
export function addFrame(ui: QuadSink, cx: number, cy: number, w: number, h: number, frame: vec4, accent: vec4): { edges: number[]; brackets: number[] } {
  // 16.09 polish audit: the frame used the SAME centimetres on every plate, so the 10 cm header tab
  // was 20 % of the 50 cm board and 37 % of the 27 cm guide card, and the 4 cm corner caps ate a
  // third of the scan card's top edge. One visual language means the same PROPORTIONS. `k` is 1 on
  // the board (its short side is 46) and falls to 0.6 on the narrowest card, so nothing the board
  // draws moves.
  const k = Math.max(0.6, Math.min(1, Math.min(w, h) / 46))
  const lt = 0.18 // the outer line
  const it = 0.1 // the inner line
  const inset = 0.75
  const cap = 4.0 * k // the corner cap along each edge
  const ct = 0.34 // its thickness (a hair over the line: reads as a cap, not a bar)
  const edges: number[] = []
  const acc: number[] = []
  const x0 = cx - w / 2 + lt / 2, x1 = cx + w / 2 - lt / 2
  const y0 = cy - h / 2 + lt / 2, y1 = cy + h / 2 - lt / 2
  // outer line, continuous
  edges.push(ui.add(cx, y1, 0, w, lt, frame, 0.9, 2))
  edges.push(ui.add(cx, y0, 0, w, lt, frame, 0.9, 2))
  edges.push(ui.add(x0, cy, 0, lt, h, frame, 0.9, 2))
  edges.push(ui.add(x1, cy, 0, lt, h, frame, 0.9, 2))
  // inner line, faint, broken at the corners (an open frame inside the closed one)
  const iw = w - 2 * inset - 2 * cap, ih = h - 2 * inset - 2 * cap
  ui.add(cx, y1 - inset, 0, iw, it, frame, 0.3, 2)
  ui.add(cx, y0 + inset, 0, iw, it, frame, 0.3, 2)
  ui.add(x0 + inset, cy, 0, it, ih, frame, 0.3, 2)
  ui.add(x1 - inset, cy, 0, it, ih, frame, 0.3, 2)
  // corner caps ON the outer line: the horizontal arm owns the corner square, the vertical starts below it
  for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const ex = sx > 0 ? x1 : x0
    const ey = sy > 0 ? y1 : y0
    acc.push(ui.add(ex - sx * (cap / 2 - ct / 2), ey, 0.05, cap, ct, accent, 1.5, 2))
    acc.push(ui.add(ex, ey - sy * (ct / 2 + (cap - ct) / 2), 0.05, ct, cap - ct, accent, 1.5, 2))
  }
  // the header tab (top-left, inside the line) and its echo (bottom-right), the clip ticks mid-side
  const tab = 10 * k, echo = 6 * k, tick = 2.4 * k
  acc.push(ui.add(x0 + cap + 1.0 + tab / 2, y1 - lt / 2 - 0.3, 0.05, tab, 0.4, accent, 1.1, 2))
  acc.push(ui.add(x1 - cap - 1.0 - echo / 2, y0 + lt / 2 + 0.3, 0.05, echo, 0.4, accent, 0.7, 2))
  acc.push(ui.add(x0, cy, 0.05, ct, tick, accent, 1.2, 2))
  acc.push(ui.add(x1, cy, 0.05, ct, tick, accent, 1.2, 2))
  return { edges: edges, brackets: acc }
}
