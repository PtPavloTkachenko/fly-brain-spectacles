/**
 * FlyEyes — each fly's own view of the room (11.09 Pavlo: "the fly can have its own world
 * reconstruction for its brain"). A compound-eye fan of rays from the fly's head against the
 * world mesh (`DeviceTracking.raycastWorldMesh` works from any point — World Query only sees the
 * device camera's FOV). The view is reduced to what the fly's optic-lobe detectors compute
 * (ADR 10: inject features, not pixels): a surface closing in on one side = looming on that side
 * (LPLC2/LC4 -> the escape suite turns away). The brain still decides.
 * The selected fly's ray hits glow in its colour: what it "sees".
 */
import { FlyConfig } from "./FlyConfig"
import { QuadSink } from "./UIBatch"
import { FlyPose } from "./WorldSources"

export interface EyeView {
  loomL: number
  loomR: number
  // translational optic flow per eye (rad/s, front-to-back while flying forward): speed x
  // sin(azimuth) / distance, averaged over that eye's horizontal rays (misses count as far)
  transL: number
  transR: number
  hits: number
  nearest: number // cm, -1 = nothing in range
}

// [azimuth deg (+ = fly's left), elevation deg] — ~330 deg horizontal, a band below, one up, one down
const RAYS: [number, number][] = [
  [0, 0], [25, 0], [-25, 0], [60, 0], [-60, 0], [110, 0], [-110, 0],
  [0, -35], [40, -35], [-40, -35], [0, 30], [0, -90],
]
const D2R = Math.PI / 180
const HIDE = { visible: false } // the one "nothing to show" spec, shared by every dot

export class FlyEyes {
  private tracking: DeviceTracking | null = null
  // Fallback when the world mesh isn't tracked (the editor preview: raycastWorldMesh = 0 hits):
  // World Query hit tests, async — each ray uses its previous answer (one sense tick late)
  private hit: HitTestSession | null = null
  private cache: { [key: string]: vec3 | null } = {}
  private meshHits = 0
  private queryHits = 0
  // the selected fly's ray hits: 12 camera-facing quads in ONE batch (11.09 perf: was 12 draws)
  // `sx/sy/sz/sv/si` = what was last HANDED to the sink for this dot. The batch already compares
  // field by field, but it had to be given a fresh 6-field literal per dot per frame to do it
  // (12 literals + ~72 compares a frame, all garbage once the 0.05 cm gate has settled the dot).
  // Keeping the last write here means the settled dot costs one float compare and no call at all.
  private dots: { q: number; target: vec3 | null; pos: vec3 | null; sx: number; sy: number; sz: number; sv: boolean; si: number }[] = []
  private sink: QuadSink | null = null
  private err = ""
  private lastHits = 0
  private lastNear = -1
  // hits the API returned OFF the queried segment (behind the start or past the end), dropped
  private beyond = 0

  constructor(cameraObject: SceneObject, sink: QuadSink | null) {
    this.sink = sink
    try {
      this.tracking = cameraObject.getComponent("Component.DeviceTracking") as DeviceTracking
      this.tracking.worldOptions.enableWorldMeshesTracking = true
      // Nothing in this lens ever reads mesh classification, so do not make the tracker compute it.
      this.tracking.worldOptions.enableWorldMeshesClassificationTracking = false
    } catch (e) {
      this.err = "" + e
    }
    // No World Query session of our own: a second HitTestSession starved the WorldScanner's
    // (Gemini markers placed ~1 per scan instead of ~5, 11.09). raycastWorldMesh covers the eyes.
    if (sink) {
      // every fly's hits (11.09 device test "not all flies show their rays"): 12 per fly, one batch
      for (let i = 0; i < RAYS.length * FlyConfig.FLY_COUNT; i++) {
        const q = sink.add(0, 0, 0, FlyConfig.EYE_DOT_CM, FlyConfig.EYE_DOT_CM, FlyConfig.FLY_COLORS[0], 1, 1)
        sink.set(q, { visible: false })
        this.dots.push({ q: q, target: null, pos: null, sx: NaN, sy: NaN, sz: NaN, sv: false, si: NaN })
      }
      sink.flush()
    }
  }

  /** Stop (or resume) the tracker rebuilding the room. The mesh already gathered stays queryable,
   *  so `raycastWorldMesh` keeps working — watch `hits=` and `mesh=` in the telemetry to confirm. */
  setMeshTracking(on: boolean) {
    if (!this.tracking) return
    try {
      this.tracking.worldOptions.enableWorldMeshesTracking = on
    } catch (e) {
      this.err = "meshTracking: " + e
    }
  }

  status(): string {
    return "hits=" + this.lastHits + "/" + RAYS.length + " near=" + this.lastNear.toFixed(0) +
      " mesh=" + this.meshHits + " wq=" + this.queryHits + " beyond=" + this.beyond + (this.err ? " err=" + this.err.substring(0, 60) : "")
  }

  /** One look (at the sense rate). `show` = this is the selected fly: move its hit dots. */
  look(fly: number, pose: FlyPose, vel: vec3, show: boolean): EyeView {
    const v: EyeView = { loomL: 0, loomR: 0, transL: 0, transR: 0, hits: 0, nearest: -1 }
    if (!this.tracking && !this.hit) return v
    const up = pose.fwd.cross(pose.left).normalize()
    const speed = vel.length
    let nL = 0
    let nR = 0
    for (let r = 0; r < RAYS.length; r++) {
      const az = RAYS[r][0] * D2R
      const el = RAYS[r][1] * D2R
      const dir = pose.fwd.uniformScale(Math.cos(az) * Math.cos(el))
        .add(pose.left.uniformScale(Math.sin(az) * Math.cos(el)))
        .add(up.uniformScale(Math.sin(el)))
      const end = pose.head.add(dir.uniformScale(FlyConfig.EYE_RANGE_CM))
      const hits = this.tracking ? this.tracking.raycastWorldMesh(pose.head, end) : null
      let d = -1
      let p: vec3 | null = null
      if (hits) {
        for (const h of hits) {
          const dd = h.position.distance(pose.head)
          if (dd > FlyConfig.EYE_RANGE_CM + 0.5 || h.position.sub(pose.head).dot(dir) < 0) {
            this.beyond++
            continue
          }
          if (d < 0 || dd < d) {
            d = dd
            p = h.position
          }
        }
      }
      if (p) this.meshHits++
      // World Query only while the world mesh gives nothing at all: per-ray fallback flooded the
      // module (up to 144 queries/s) and starved Gemini's marker placement (11.09)
      else if (this.hit && this.meshHits === 0) {
        const key = fly + "_" + r
        this.hit.hitTest(pose.head, end, (res: WorldQueryHitTestResult) => {
          this.cache[key] = res ? res.position : null
          if (res) this.queryHits++
        })
        const c = this.cache[key]
        if (c) {
          p = c
          d = c.distance(pose.head)
        }
      }
      const dot = this.dots[fly * RAYS.length + r]
      if (dot) dot.target = p
      // horizontal side rays -> that eye's translational flow (a miss = surface at max range)
      if (RAYS[r][1] === 0 && RAYS[r][0] !== 0) {
        const flow = (speed * Math.abs(Math.sin(az))) / Math.max(20, d < 0 ? FlyConfig.EYE_RANGE_CM : d)
        if (RAYS[r][0] > 0) {
          v.transL += flow
          nL++
        } else {
          v.transR += flow
          nR++
        }
      }
      if (d < 0) continue
      v.hits++
      if (v.nearest < 0 || d < v.nearest) v.nearest = d
      // time to contact along this ray from the fly's own motion (the straight-down ray is the
      // floor/landing surface, never a threat)
      const closing = vel.dot(dir)
      if (RAYS[r][1] > -60 && closing > 1) {
        const ttc = d / closing
        if (ttc < FlyConfig.EYE_TTC_S) {
          const l = Math.min(1, (1 - ttc / FlyConfig.EYE_TTC_S) * FlyConfig.EYE_LOOM_GAIN)
          if (RAYS[r][0] >= 0) v.loomL = Math.max(v.loomL, RAYS[r][0] === 0 ? 0.7 * l : l)
          if (RAYS[r][0] <= 0) v.loomR = Math.max(v.loomR, RAYS[r][0] === 0 ? 0.7 * l : l)
        }
      }
    }
    if (nL) v.transL /= nL
    if (nR) v.transR /= nR
    if (show) {
      this.lastHits = v.hits
      this.lastNear = v.nearest
    }
    return v
  }

  /** Solid room (11.09 "flies still fly out of the world mesh"): the nearest world-mesh hit on the
   *  segment from -> to (cm, world), or null. One sync ray per moving fly per frame. */
  blocked(from: vec3, to: vec3): { pos: vec3; normal: vec3 } | null {
    if (!this.tracking) return null
    const hits = this.tracking.raycastWorldMesh(from, to)
    if (!hits || hits.length === 0) return null
    const seg = to.sub(from)
    const len = seg.length
    let best: { pos: vec3; normal: vec3 } | null = null
    let bd = 1e9
    for (const h of hits) {
      const v = h.position.sub(from)
      const d = v.length
      // only ON the segment: the API returns hits along the whole line (11.09 bench: a landed fly
      // "stuck" to the far wall 224 cm away = the wall-to-wall teleports, and every move "hit"
      // whatever wall lay ahead = ~85 slides/s)
      if (d > len + 0.5 || v.dot(seg) < 0) {
        this.beyond++
        continue
      }
      if (d < bd) {
        bd = d
        best = { pos: h.position, normal: h.normal }
      }
    }
    return best
  }

  /** Nearest thing this fly's own rays hit (world cm), for a fly that wants to land. */
  nearestHit(fly: number, from: vec3): vec3 | null {
    let best: vec3 | null = null
    let bd = 1e9
    for (let r = 0; r < RAYS.length; r++) {
      const d = this.dots[fly * RAYS.length + r]
      if (!d || !d.target) continue
      const dist = d.target.distance(from)
      if (dist < bd) {
        bd = dist
        best = d.target
      }
    }
    return best
  }

  /** A landed fly doesn't look: hide its dots instead of leaving stale ones in the air. */
  clear(fly: number) {
    for (let r = 0; r < RAYS.length; r++) {
      const dot = this.dots[fly * RAYS.length + r]
      if (dot) dot.target = null
    }
  }

  /** Per frame: hit dots ease to their targets and face the user (no twitching at 4 Hz); each fly's
   *  in its own colour, the selected fly's brighter. */
  private bx = NaN // camera right at the last billboard update
  private by = NaN
  private bz = NaN
  // one reused spec for every dot write (the sink copies out of it immediately, in both sinks)
  private spec: any = { x: 0, y: 0, z: 0, visible: true, color: FlyConfig.FLY_COLORS[0], intensity: 1 }

  tick(dt: number, cam: Transform, selected: number) {
    const sink = this.sink
    if (!sink) return
    // 12.09 device trace (`eyedots` = 7.6 ms): setBillboard marks EVERY quad dirty, so the batch
    // rebuilt its whole mesh on every single frame whatever the dots did. The billboard only needs
    // redoing when the head actually turns.
    const r = cam.right
    if (Math.abs(r.x - this.bx) + Math.abs(r.y - this.by) + Math.abs(r.z - this.bz) > 0.004) {
      this.bx = r.x
      this.by = r.y
      this.bz = r.z
      sink.setBillboard(r, cam.up)
    }
    const k = 1 - Math.exp(-dt * 8)
    const spec = this.spec
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i]
      if (!d.target) {
        // 16.09 perf: only say it once. The batch diffed this to nothing anyway, but it was still
        // handed a fresh literal every frame for every dot that has nothing to show.
        if (d.sv) {
          sink.set(d.q, HIDE)
          d.sv = false
        }
        d.pos = null
        continue
      }
      const fly = Math.floor(i / RAYS.length)
      // ...and a dot that has arrived stops moving, so its quad stops being dirty too
      if (d.pos) {
        const t = d.target
        if (Math.abs(d.pos.x - t.x) + Math.abs(d.pos.y - t.y) + Math.abs(d.pos.z - t.z) > 0.05) {
          d.pos = vec3.lerp(d.pos, t, k)
        }
      } else d.pos = d.target
      const p = d.pos
      const inten = fly === selected ? 1 : 0.55
      // exactly what the batch would have concluded, reached without the allocation: the colour is
      // fixed per dot (its fly never changes), so position, visibility and intensity are the state
      if (!d.sv || p.x !== d.sx || p.y !== d.sy || p.z !== d.sz || inten !== d.si) {
        spec.x = p.x
        spec.y = p.y
        spec.z = p.z
        spec.visible = true
        spec.color = FlyConfig.FLY_COLORS[fly % FlyConfig.FLY_COLORS.length]
        spec.intensity = inten
        sink.set(d.q, spec)
        d.sx = p.x
        d.sy = p.y
        d.sz = p.z
        d.sv = true
        d.si = inten
      }
    }
    sink.flush()
  }
}
