/**
 * FlyFx — runtime neon geometry: a shared unit quad (MeshBuilder, no preset guessing), a long
 * flight trail behind EVERY fly (the user 11.09), and a glow under the selected fly.
 * Trails are camera-facing MeshBuilder ribbons — live input dictates their shape, so this is
 * the one MeshBuilder case the perf playbook allows. All render with NeonQuad
 * (color, intensity, glowMode, fadeX, alpha).
 */
import { FlyConfig } from "./FlyConfig"

const UP = new vec3(0, 1, 0)
const FWD = new vec3(0, 0, 1) // fallback facing when the glow plane sits exactly under the camera

/** Unit quad in XY, centred, facing +Z, UV 0..1. */
export function makeQuadMesh(): RenderMesh {
  const mb = new MeshBuilder([
    { name: "position", components: 3 },
    { name: "normal", components: 3 },
    { name: "texture0", components: 2 },
  ])
  mb.topology = MeshTopology.Triangles
  mb.indexType = MeshIndexType.UInt16
  mb.appendVerticesInterleaved([
    -0.5, -0.5, 0, 0, 0, 1, 0, 0,
    0.5, -0.5, 0, 0, 0, 1, 1, 0,
    0.5, 0.5, 0, 0, 0, 1, 1, 1,
    -0.5, 0.5, 0, 0, 0, 1, 0, 1,
  ])
  mb.appendIndices([0, 1, 2, 0, 2, 3])
  mb.updateMesh()
  return mb.getMesh()
}

/** A neon quad scene object with its own material clone. */
export function neonQuad(name: string, parent: SceneObject, mesh: RenderMesh, base: Material, color: vec4, glowMode = 0): { so: SceneObject; mat: Material } {
  const so = global.scene.createSceneObject(name)
  so.setParent(parent)
  const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
  rmv.mesh = mesh
  const mat = base.clone()
  mat.mainPass.tint = color
  mat.mainPass.glowMode = glowMode
  mat.mainPass.intensity = 1.0
  mat.mainPass.fadeX = 0.0
  mat.mainPass.alpha = 1.0
  fxPass(mat)
  rmv.mainMaterial = mat
  rmv.setRenderOrder(FlyConfig.RENDER_ORDER_FX)
  return { so: so, mat: mat }
}

/** Additive glow state, set explicitly: a 5.15 clone takes the .mat defaults, and the generated
 *  NeonGlow.mat is Normal + depth write (11.09: halos/trails occluded each other and the flies). */
function fxPass(mat: Material) {
  const p: any = mat.mainPass
  p.blendMode = BlendMode.Add
  p.depthWrite = false
  p.depthTest = true
  p.twoSided = true
}

/** One fly's trail: fixed vertex budget, rewritten in place (uv.x 0 = tail, 1 = head). */
class Trail {
  mat: Material
  private mb: MeshBuilder
  private points: vec3[] = []
  private sampleT = 0
  private n = FlyConfig.TRAIL_POINTS

  constructor(root: SceneObject, base: Material, color: vec4, index: number) {
    this.mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
    ])
    this.mb.topology = MeshTopology.Triangles
    this.mb.indexType = MeshIndexType.UInt16
    const verts: number[] = []
    for (let i = 0; i < this.n; i++) {
      const u = i / (this.n - 1)
      verts.push(0, 0, 0, 0, 0, 1, u, 0, 0, 0, 0, 0, 0, 1, u, 1)
    }
    this.mb.appendVerticesInterleaved(verts)
    const idx: number[] = []
    for (let i = 0; i < this.n - 1; i++) {
      const a = 2 * i
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
    }
    this.mb.appendIndices(idx)
    this.mb.updateMesh()
    const so = global.scene.createSceneObject("Trail_" + index)
    so.setParent(root)
    const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    rmv.mesh = this.mb.getMesh()
    this.mat = base.clone()
    this.mat.mainPass.tint = color
    this.mat.mainPass.glowMode = 0
    this.mat.mainPass.fadeX = 1.0
    this.mat.mainPass.intensity = FlyConfig.TRAIL_INTENSITY_IDLE
    this.mat.mainPass.alpha = 1.0
    fxPass(this.mat)
    this.sampleT = ((index * 0.37) % 1) * FlyConfig.TRAIL_SAMPLE_S // flies rebuild on different frames
    rmv.mainMaterial = this.mat
    rmv.setRenderOrder(FlyConfig.RENDER_ORDER_FX)
  }

  // 11.09 device perf (fx 30-48 ms/frame with 180 points x 3 flies, every vertex rewritten every
  // frame): the ribbon is rebuilt only when a sample lands (~8 Hz, staggered per fly); between
  // samples only the head vertex follows the fly. Plain-number maths, reused vertex arrays.
  private lastW = -1
  private va = [0, 0, 0, 0, 0, 1, 0, 0]
  private vb = [0, 0, 0, 0, 0, 1, 0, 1]

  update(dt: number, flyPos: vec3, camPos: vec3, widthCm: number) {
    this.sampleT += dt
    let full = widthCm !== this.lastW
    if (this.sampleT >= FlyConfig.TRAIL_SAMPLE_S || this.points.length === 0) {
      this.sampleT = 0
      this.points.push(flyPos)
      if (this.points.length > this.n) this.points.shift()
      full = true
    }
    this.lastW = widthCm
    // 12.09 the user ("let it be less smooth but optimised"): the whole vertex buffer was re-uploaded
    // every frame just so the head vertex could follow the fly. Upload on a sample, or once the head
    // has actually moved TRAIL_HEAD_CM. A hovering fly now costs nothing here.
    const still = Math.abs(flyPos.x - this.hx) + Math.abs(flyPos.y - this.hy) + Math.abs(flyPos.z - this.hz) <= FlyConfig.TRAIL_HEAD_CM
    if (!full && still) return
    if (full) for (let i = 0; i < this.n - 1; i++) this.writePoint(i, flyPos, camPos, widthCm)
    this.writePoint(this.n - 1, flyPos, camPos, widthCm)
    this.hx = flyPos.x
    this.hy = flyPos.y
    this.hz = flyPos.z
    this.mb.updateMesh()
  }

  private hx = NaN // head position at the last upload (NaN = never uploaded)
  private hy = NaN
  private hz = NaN

  private writePoint(i: number, flyPos: vec3, camPos: vec3, widthCm: number) {
    const n = this.n
    const pts = this.points
    const k = Math.min(pts.length - 1, Math.max(0, i - (n - pts.length)))
    const p = i === n - 1 ? flyPos : pts[k]
    const q = pts[Math.min(pts.length - 1, k + 1)]
    let tx = q.x - p.x
    let ty = q.y - p.y
    let tz = q.z - p.z
    if (tx * tx + ty * ty + tz * tz < 1e-6) {
      tx = 0
      ty = 1
      tz = 0
    }
    const cx = camPos.x - p.x
    const cy = camPos.y - p.y
    const cz = camPos.z - p.z
    let sx = ty * cz - tz * cy
    let sy = tz * cx - tx * cz
    let sz = tx * cy - ty * cx
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz)
    if (sl > 1e-3) {
      sx /= sl
      sy /= sl
      sz /= sl
    } else {
      sx = 1
      sy = 0
      sz = 0
    }
    const u = i / (n - 1)
    const w = widthCm * u * u * (3 - 2 * u) // tapers to a fine point at the tail (11.09 the user: "thin end")
    const a = this.va
    const b = this.vb
    a[0] = p.x + sx * w
    a[1] = p.y + sy * w
    a[2] = p.z + sz * w
    a[6] = u
    b[0] = p.x - sx * w
    b[1] = p.y - sy * w
    b[2] = p.z - sz * w
    b[6] = u
    this.mb.setVertexInterleaved(2 * i, a)
    this.mb.setVertexInterleaved(2 * i + 1, b)
  }
}

export class FlyFx {
  private glows: { so: SceneObject; mat: Material }[] = []
  private trails: Trail[] = []
  private selected = 0
  private time = 0

  constructor(root: SceneObject, quad: RenderMesh, base: Material, flyCount: number) {
    // 11.09 the user: a halo behind EVERY fly (its own colour); the selected one bright
    for (let i = 0; i < flyCount; i++) {
      const color = FlyConfig.FLY_COLORS[i % FlyConfig.FLY_COLORS.length]
      const g = neonQuad("Glow_" + i, root, quad, base, color, 1)
      g.so.getTransform().setWorldScale(new vec3(FlyConfig.GLOW_DISC_CM, FlyConfig.GLOW_DISC_CM, 1))
      this.glows.push(g)
      this.trails.push(new Trail(root, base, color, i))
    }
  }

  select(index: number) {
    this.selected = index
    this.trails.forEach((t, i) => {
      t.mat.mainPass.intensity = i === index ? FlyConfig.TRAIL_INTENSITY_SELECTED : FlyConfig.TRAIL_INTENSITY_IDLE
    })
  }

  update(dt: number, flyPositions: vec3[], camPos: vec3) {
    this.time += dt
    // 12.09 device trace (`fx` = 3.4 ms of every frame): this ran a closure per fly per frame and
    // allocated five vec3/quat inside it. Plain loop, arithmetic instead of vector objects.
    for (let i = 0; i < flyPositions.length; i++) {
      const p = flyPositions[i]
      if (this.trails[i]) {
        const w = i === this.selected ? FlyConfig.TRAIL_WIDTH_CM * 1.4 : FlyConfig.TRAIL_WIDTH_CM
        this.trails[i].update(dt, p, camPos, w)
      }
      const g = this.glows[i]
      if (!g) continue
      // soft glow plane UNDER the fly (11.09 the user: "the glow plane under the fly, a general
      // soft one, stronger when selected"), turned toward the user so it never goes edge-on
      const gy = p.y - FlyConfig.GLOW_DROP_CM
      const dx = camPos.x - p.x
      const dy = camPos.y - gy
      const dz = camPos.z - p.z
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const gt = g.so.getTransform()
      gt.setWorldPosition(new vec3(p.x, gy, p.z))
      gt.setWorldRotation(quat.lookAt(len > 0.001 ? new vec3(dx / len, dy / len, dz / len) : FWD, UP))
      // 12.09 audit: the scale is a constant per fly and the intensity only animates on the SELECTED
      // one, yet both were written (and a vec3 allocated) every frame for every fly
      const size = i === this.selected ? FlyConfig.GLOW_DISC_SELECTED_CM : FlyConfig.GLOW_DISC_CM
      const gAny = g as any
      if (gAny.lastSize !== size) {
        gAny.lastSize = size
        gt.setWorldScale(new vec3(size, size, 1))
      }
      const gi = i === this.selected
        ? FlyConfig.GLOW_HALO_SELECTED + 0.35 * Math.sin(this.time * 3.0)
        : FlyConfig.GLOW_HALO_IDLE
      if (gAny.lastInt !== gi) {
        gAny.lastInt = gi
        g.mat.mainPass.intensity = gi
      }
    }
  }
}
