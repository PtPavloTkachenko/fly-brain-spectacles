/**
 * FlySceneFeed — the room, the flies and the user, streamed to the web page (ADR 61).
 *
 * The page (web/app.html) is already the brain (ADR 55): it produces the `brain` messages and it
 * receives the `senses`, so it already knows every firing rate, the decoded action and the fly's
 * compound-eye contrast bytes (`senses.ch.eye`). What it cannot know is the BODY and the ROOM —
 * where the fly is, where the user is, what Gemini found and what the world mesh looks like. That
 * is all this sends, as one `scene` broadcast on the existing relay socket, at WEB_SCENE_HZ.
 *
 * Nothing here is computed for the page: every number is something the lens already has this frame
 * (FlyBody.packNet, WorldSources.items, WorldColorBake.pos). The two big things — the Gemini
 * inventory and the world-mesh point set — are diff-cached behind a version counter and sent only
 * when they change, so the steady cost is one small JSON object four times a second.
 *
 * Cost, measured in the preview (1 fly): the whole tick is under the 1 ms probe resolution; the
 * steady packet is ~0.6 KB (3 flies ~1.1 KB), the inventory ~0.6 KB on change, the mesh ~9 KB once
 * per change during the scan and never again after it (WorldColorBake stops re-reading vertices).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyBody } from "./FlyBody"
import { FlyConfig } from "./FlyConfig"
import { Source, WorldSources } from "./WorldSources"
import { WebBrainLink } from "./WebBrainLink"

const log = new NativeLogger("SceneFeed")
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
// what the page draws as room furniture; "fly" bodies and the hands come through the fly/head
// blocks instead, and an inactive source is not sensed at all so it is not shown
const INV_CLASSES: { [cls: string]: number } = { food: 1, lure: 1, threat: 1, bad: 1, scent: 1, object: 1 }

export interface FeedGhost {
  name: string
  pos: vec3
  rot: quat
  a: number[]
}

export class FlySceneFeed {
  private t = 0
  private seq = 0
  private invVer = 0
  private invKey = ""
  private invPending = true
  private thought = ""
  /** set by FlySwarm: the compound eye, for the page's IMAGE map */
  retina: { image(fly: number): Uint8Array | null } | null = null
  private eyeAt = -1e9
  private eyeSent = ""
  private meshVer = 0
  private meshAt = -1e9
  private meshN = 0
  private meshPending = true
  private surf: string[] = []
  private surfPart = 0
  private surfVer = 0
  private surfHead: any = null
  private surfPending = true
  private surfSx = 0 // the axis signs the sent surface was built with (WorldColorBake.sx/sz)
  private surfSz = 0
  private surfVerts: number[] = [] // the sent surface's vertices (cm, world), for the colour pass
  private colTexels = -1 // bake.texelCount when the colours last went out (-1 = never)
  private colAt = -1e9
  private surfWaitFrom = -1 // when triangles first existed while the bake's frame was still unverified
  private tSec = 0
  bytes = 0 // last packet size, for the telemetry row
  /** The teaching session, for the page's twin of the guide card (ADR 66). FlySwarm writes it every
   *  frame; like `th` it goes out only when it changed, so a page sees each phase exactly once. */
  train: any = null
  private trainSent = ""
  /** ADR 68: the finished session's evidence pack + Gemini's reading. Sent once, when it appears. */
  summary: any = null
  private summarySent = ""
  /** ADR 68: the room's labels, exactly as the trainer matches them, so the page can offer a cue */
  things: string[] = []
  private thingsSent = ""
  sent = 0
  /** what the fly remembers (ADR 63); set by FlySwarm, sent only when it changes */
  memory: { lineVersion(): number; status(): any; fullKey(): string } | null = null
  private memVer = -1

  constructor(
    private link: WebBrainLink,
    private sources: WorldSources,
    private cameraObject: SceneObject,
  ) {}

  /** True only while a page is really listening — the exact condition `tick` returns on below.
   *  FlySwarm asks it before BUILDING what it writes here (`things`, `train`): with no page on,
   *  every one of those was assembled at the frame rate and then dropped on line 90. */
  get active(): boolean {
    return FlyConfig.WEB_SCENE_FEED && this.link.webActive
  }

  /** Called every frame from FlySwarm; sends at most WEB_SCENE_HZ, and only while a page is on. */
  tick(dt: number, flies: FlyBody[], ghosts: { [k: string]: FeedGhost }, selected: number, bake: any, thought: string) {
    this.tSec += dt
    if (!FlyConfig.WEB_SCENE_FEED || !this.link.webActive) return
    this.t += dt
    if (this.t < 1 / Math.max(0.5, FlyConfig.WEB_SCENE_HZ)) return
    this.t = 0
    this.seq++

    const camT = this.cameraObject.getTransform()
    const hp = camT.getWorldPosition()
    const hq = camT.getWorldRotation()
    const r0 = (x: number) => Math.round(x)
    const r2 = (x: number) => Math.round(x * 100) / 100
    const r3 = (x: number) => Math.round(x * 1000) / 1000

    const f: any[] = []
    for (let i = 0; i < flies.length; i++) {
      const b = flies[i]
      const p = b.pos
      const q = b.worldRotation()
      const row: any[] = [i, FlyConfig.FLY_NAMES[i % FlyConfig.FLY_NAMES.length], r0(p.x), r0(p.y), r0(p.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w)]
      for (const v of b.packNet()) row.push(r2(v))
      f.push(row)
    }
    let gi = -1
    for (const conn in ghosts) {
      const g = ghosts[conn]
      const row: any[] = [gi--, g.name || "guest", r0(g.pos.x), r0(g.pos.y), r0(g.pos.z), r3(g.rot.x), r3(g.rot.y), r3(g.rot.z), r3(g.rot.w)]
      for (const v of g.a) row.push(r2(v))
      f.push(row)
    }

    const msg: any = {
      t: "scene",
      n: this.seq,
      hz: FlyConfig.WEB_SCENE_HZ,
      h: [r0(hp.x), r0(hp.y), r0(hp.z), r3(hq.x), r3(hq.y), r3(hq.z), r3(hq.w)],
      s: selected,
      f: f,
    }

    // the eyes: the same three maps the board draws — the image the columns sampled, and the
    // ON/OFF contrast the brain is injected with (that one already rides in `senses`)
    if (this.retina && this.tSec - this.eyeAt >= 1 / Math.max(0.5, FlyConfig.WEB_SCENE_EYE_HZ)) {
      this.eyeAt = this.tSec
      const img = this.retina.image(selected)
      if (img) {
        const enc = this.b64(img)
        if (enc !== this.eyeSent) {
          this.eyeSent = enc
          msg.eyeimg = enc
        }
      }
    }
    if (thought && thought !== this.thought) {
      this.thought = thought
      msg.th = thought // Gemini's inner voice, as the board shows it: sent only when it changes
    }
    if (this.train) {
      const t = JSON.stringify(this.train)
      if (t !== this.trainSent) {
        this.trainSent = t
        msg.train = this.train
      }
    } else if (this.trainSent) {
      this.trainSent = ""
      msg.train = null // the session ended: the page clears its card
    }
    if (this.summary) {
      const t = JSON.stringify(this.summary)
      if (t !== this.summarySent) {
        this.summarySent = t
        msg.train_summary = this.summary
      }
    }
    if (this.things.length) {
      const t = this.things.join("\u0001")
      if (t !== this.thingsSent) {
        this.thingsSent = t
        msg.things = this.things // the exact labels FlyTrainer matches a `cmd` cue against
      }
    }
    const inv = this.inventory()
    if (inv) msg.inv = inv
    msg.iv = this.invVer
    // the room, as a surface: built once the bake's vertex frame is VERIFIED (WorldColorBake
    // calibrates the mesh's axis signs against real hits: `cal=flipZ!`), then handed over a chunk
    // per tick. Sent before the lock, the room arrived mirrored while the flies and the head were
    // true (16.09: the fly by the flower sat on the opposite wall on the page). If the signs change
    // after the send, the surface is rebuilt and resent under a new version. Where no frame can be
    // verified (the editor has no tracking), WEB_SCENE_CAL_WAIT_S after the first triangles is the
    // deadline: unverified is better than no room at all.
    if (bake) {
      const bsx = bake.sx || 1, bsz = bake.sz || 1
      if (!this.surfPending && this.surf.length && (bsx !== this.surfSx || bsz !== this.surfSz)) this.surfPending = true
      if (this.surfPending) {
        if (bake.frameOk) this.buildSurface(bake)
        else if (bake.pos && bake.pos.length > 24) {
          if (this.surfWaitFrom < 0) this.surfWaitFrom = this.tSec
          else if (this.tSec - this.surfWaitFrom > FlyConfig.WEB_SCENE_CAL_WAIT_S) this.buildSurface(bake)
        }
      }
    }
    const chunk = this.nextChunk()
    if (chunk) msg.surf = chunk
    // the room's own colours (16.09 Pavlo: "load the world mesh the way the scan painted it"): one
    // RGBA per surface vertex from the bake's voxel-hash texture, alpha 0 where the camera never
    // looked. Sent after the geometry, then again every WEB_SCENE_MESH_S while the bake keeps
    // filling (the scan paints the room voxel by voxel), never more than that.
    if (bake && this.surfVerts.length && !chunk && typeof bake.colorAtCm === "function") {
      const tx = bake.texelCount | 0
      if ((this.colTexels < 0 || tx > this.colTexels * 1.05 + 20) && this.tSec - this.colAt > FlyConfig.WEB_SCENE_MESH_S) {
        this.colTexels = tx
        this.colAt = this.tSec
        msg.surfc = { v: this.surfVer, c: this.surfaceColors(bake) }
      }
    }
    const mesh = this.surf.length ? null : this.meshPoints(bake) // points only until there are triangles
    if (mesh) msg.mesh = mesh
    msg.mv = this.meshVer
    // the memory card (ADR 63): a few numbers, diff-cached like the inventory
    if (this.memory && this.memory.lineVersion() !== this.memVer) {
      this.memVer = this.memory.lineVersion()
      const st = this.memory.status()
      msg.mem = { keySource: st.keySource, keyShort: st.keyShort, synced: st.synced, bytes: st.bytes,
        savedAt: st.savedAt, changedSinceSave: st.changedSinceSave, mean_efficacy: st.mean_efficacy,
        changed: st.changed, edges: st.edges, learning: st.learning, rewards: st.rewards,
        punishes: st.punishes, name: st.name, sessions: st.sessions,
        // ADR 68: the row id of the brain-versions table. The page reads and writes versions under
        // it and never displays it; the lens shows `keyShort` and never logs the whole thing.
        key: this.memory.fullKey() }
    }

    const text = JSON.stringify(msg)
    this.bytes = text.length
    this.sent++
    this.link.sendScene(msg)
    if (this.sent === 1) log.i("SCENE_FEED on, first packet " + this.bytes + " B")
  }

  /** `name=bytes` for the telemetry row. */
  status(): string {
    return "scene n=" + this.sent + " B=" + this.bytes + " inv=" + this.invVer + " mesh=" + this.meshVer
  }

  /** The scanned world mesh as a decimated, vertex-merged TRIANGLE surface (ADR 61 follow-up).
   *  Runs once, off the frozen mesh; the result is handed to the page one chunk per tick. */
  private buildSurface(bake: any) {
    const src = bake.src
    if (!src || !bake.pos || !bake.pos.length) return
    let idx: any = null
    try {
      idx = typeof src.getIndexBuffer === "function" ? src.getIndexBuffer() : null
    } catch (e) {
      idx = null
    }
    const pos = bake.pos as Float32Array
    const nv = (pos.length / 3) | 0
    const triN = idx && idx.length >= 3 ? (idx.length / 3) | 0 : (nv / 3) | 0
    if (triN < 8) return // nothing worth a surface yet; the point fallback keeps running
    this.surfPending = false
    this.surfVer++
    this.surfSx = bake.sx || 1
    this.surfSz = bake.sz || 1
    this.surfPart = 0 // a new version starts from its first chunk
    const want = Math.max(64, FlyConfig.WEB_SCENE_TRIS | 0)
    const step = Math.max(1, Math.floor(triN / want))
    const k = FlyConfig.BAKE_POS_SCALE // the raw mesh is in metres, the scene in cm
    const sx = bake.sx || 1
    const sz = bake.sz || 1
    const vox = Math.max(0.5, FlyConfig.WEB_SCENE_VOXEL_CM)
    // vertex merge on a voxel grid: the same corner shared by many triangles is sent once, and
    // the whole room then fits in uint16 indices
    const map: { [key: string]: number } = {}
    const vx: number[] = []
    const tri: number[] = []
    let dropped = 0
    const vertOf = (v: number): number => {
      const x = Math.round((pos[3 * v] * k * sx) / vox)
      const y = Math.round((pos[3 * v + 1] * k) / vox)
      const z = Math.round((pos[3 * v + 2] * k * sz) / vox)
      const key = x + "," + y + "," + z
      let id = map[key]
      if (id === undefined) {
        id = vx.length / 3
        map[key] = id
        vx.push(x * vox, y * vox, z * vox)
      }
      return id
    }
    for (let t = 0; t < triN; t += step) {
      if (vx.length / 3 > 65000) break // uint16 indices: stop before they overflow
      const a0 = idx ? idx[3 * t] : 3 * t
      const b0 = idx ? idx[3 * t + 1] : 3 * t + 1
      const c0 = idx ? idx[3 * t + 2] : 3 * t + 2
      if (c0 >= nv) break
      const ia = vertOf(a0)
      const ib = vertOf(b0)
      const ic = vertOf(c0)
      if (ia === ib || ib === ic || ia === ic) { dropped++; continue } // the merge collapsed it
      tri.push(ia, ib, ic)
    }
    const nVert = vx.length / 3
    this.surfVerts = vx
    this.colTexels = -1 // a new geometry: its colours go out again
    const qv = new Int16Array(nVert * 3)
    for (let i = 0; i < qv.length; i++) qv[i] = Math.max(-32767, Math.min(32767, Math.round(vx[i])))
    const qi = new Uint16Array(tri.length)
    for (let i = 0; i < tri.length; i++) qi[i] = tri[i]
    const b = bake.bounds
    const payload = this.b64(new Uint8Array(qv.buffer)) + "|" + this.b64(new Uint8Array(qi.buffer))
    const cap = Math.max(4000, FlyConfig.WEB_SCENE_CHUNK | 0)
    this.surf = []
    for (let o = 0; o < payload.length; o += cap) this.surf.push(payload.substring(o, o + cap))
    this.surfPart = 0
    this.surfHead = {
      v: this.surfVer, n: nVert, t: tri.length / 3, parts: this.surf.length,
      b: b ? [Math.round(b.min.x), Math.round(b.min.y), Math.round(b.min.z), Math.round(b.max.x), Math.round(b.max.y), Math.round(b.max.z)] : null,
    }
    log.i("SURFACE tris=" + (tri.length / 3) + "/" + triN + " verts=" + nVert + " collapsed=" + dropped +
      " bytes=" + payload.length + " parts=" + this.surf.length)
  }

  /** one chunk of the surface per tick, so a single broadcast stays small */
  private nextChunk(): any {
    if (!this.surf.length || this.surfPart >= this.surf.length) return null
    const part = this.surfPart++
    return Object.assign({ part: part, s: this.surf[part] }, this.surfHead)
  }

  /** RGBA per sent surface vertex, base64: the bake's colour of that voxel, alpha 255 = seen. */
  private surfaceColors(bake: any): string {
    const vx = this.surfVerts
    const n = (vx.length / 3) | 0
    const rgba = new Uint8Array(n * 4)
    let seen = 0
    for (let i = 0; i < n; i++) {
      const o = 4 * i
      if (bake.colorAtCm(vx[3 * i], vx[3 * i + 1], vx[3 * i + 2], rgba, o)) {
        rgba[o + 3] = 255
        seen++
      }
    }
    log.i("SCENE_COLORS v=" + this.surfVer + " seen=" + seen + "/" + n + " texels=" + this.colTexels)
    return this.b64(rgba)
  }

  /** A page that joins late has missed every diff: resend the room on the next tick. */
  resend() {
    this.summarySent = ""
    this.thingsSent = ""
    this.trainSent = ""
    this.invPending = true
    this.eyeSent = ""
    this.surfPart = 0 // a fresh page needs every chunk again
    this.colTexels = -1 // and the colours after the geometry
    this.thought = ""
    this.meshPending = true
    this.memVer = -1
  }

  /** Gemini's room inventory, only when it changed (label / class / position / alive). */
  private inventory(): any[] | null {
    const items = this.sources.items
    let key = ""
    const out: any[] = []
    for (const s of items) {
      if (!INV_CLASSES[s.cls] || !s.seen) continue
      key += s.id + "|" + Math.round(s.pos.x) + "," + Math.round(s.pos.y) + "," + Math.round(s.pos.z) + (s.active ? "+" : "-") + ";"
      out.push([s.id, s.label, s.cls, Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z), Math.round(s.sizeCm), s.active ? 1 : 0])
    }
    if (key === this.invKey && !this.invPending) return null
    this.invKey = key
    this.invPending = false
    this.invVer++
    return out
  }

  /** A coarse point set of the scanned world mesh, in cm, at most WEB_SCENE_MESH_PTS points.
   *  The mesh only grows while the room is scanned and is frozen afterwards (ADR 39), so this
   *  fires a handful of times per session and then never again. */
  private meshPoints(bake: any): any {
    if (!bake || !bake.pos || !bake.pos.length) return null
    const n = (bake.pos.length / 3) | 0
    const grown = n > this.meshN * 1.05 + 200
    if (!grown && !this.meshPending) return null
    if (this.tSec - this.meshAt < FlyConfig.WEB_SCENE_MESH_S) return null
    this.meshAt = this.tSec
    this.meshN = n
    this.meshPending = false
    this.meshVer++
    const cap = Math.max(64, FlyConfig.WEB_SCENE_MESH_PTS | 0)
    const step = Math.max(1, Math.floor(n / cap))
    const k = FlyConfig.BAKE_POS_SCALE // the raw mesh is in metres, the scene in cm
    const sx = bake.sx || 1
    const sz = bake.sz || 1
    const pos = bake.pos
    const m = Math.floor(n / step)
    const q = new Int16Array(m * 3)
    const bytes = new Uint8Array(q.buffer)
    let w = 0
    // plain-number maths, no vec3 per vertex (the bake's own rule): int16 cm holds +-327 m
    for (let v = 0; v < n && w + 2 < q.length; v += step) {
      q[w++] = Math.max(-32767, Math.min(32767, (pos[3 * v] * k * sx) | 0))
      q[w++] = Math.max(-32767, Math.min(32767, (pos[3 * v + 1] * k) | 0))
      q[w++] = Math.max(-32767, Math.min(32767, (pos[3 * v + 2] * k * sz) | 0))
    }
    const b = bake.bounds
    return {
      v: this.meshVer,
      p: this.b64(bytes.subarray(0, w * 2)),
      b: b ? [Math.round(b.min.x), Math.round(b.min.y), Math.round(b.min.z), Math.round(b.max.x), Math.round(b.max.y), Math.round(b.max.z)] : null,
    }
  }

  private b64(b: Uint8Array): string {
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
