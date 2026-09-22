/**
 * FlyNet — other people's flies in the same room (ADR 53).
 *
 * Every device runs its OWN fly with its own brain (a page by PIN, or a Mac in the editor); the network carries
 * only the BODY: position, rotation, state and the few eased action values the animation reads,
 * ~8 times a second. On the other devices that fly is a "ghost": the same prefab, material and
 * animation, but driven by the received packet instead of a brain. So N users = N brains, each on
 * its own device, and the network cost is one small packet per user, whatever the brain does.
 *
 * Transport: one unowned Sync Kit RealtimeStore ("CyberFlyNet"); each user writes its own key
 * `<connectionId>:fly` (a compact JSON array, FlyBody.packNet) and everybody reads everybody's.
 * Coordinates go through the colocated frame (the LocatedAtComponent's object), so two people who
 * mapped the same room see the fly in the same place. Late joiners read every existing slice once
 * on attach; a user leaving removes its ghost. Nothing here touches the brain (ADR 22).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { SessionController } from "SpectaclesSyncKit.lspkg/Core/SessionController"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyNet")
const STORE_ID = "CyberFlyNet"
const KEY = "fly"

export interface GhostPacket {
  pos: vec3 // world (this device's frame)
  rot: quat
  a: number[] // FlyBody.packNet payload after the transform block
}

export class FlyNet {
  ready = false
  users = 0
  private store: GeneralDataStore | null = null
  private session: MultiplayerSession | null = null
  private localId = ""
  private localName = ""
  private sendT = 0
  private tx = 0
  private rx = 0
  private seq = 0
  private failed = ""
  onSession: () => void = () => {} // the session is up (Solo or Multiplayer chosen, mapping done)
  onGhost: (conn: string, name: string, p: GhostPacket) => void = () => {}
  onGhostGone: (conn: string) => void = () => {}

  /** false = no Sync Kit in the scene (the lens runs alone, as before) */
  start(): boolean {
    let sc: SessionController
    try {
      sc = SessionController.getInstance()
    } catch (e) {
      this.failed = "no session controller"
      return false
    }
    if (!sc) {
      this.failed = "no session controller"
      return false
    }
    sc.notifyOnReady(() => this.setup())
    return true
  }

  private setup() {
    this.onSession()
    const sc = SessionController.getInstance()
    this.session = sc.getSession()
    if (!this.session) {
      this.failed = "no session"
      return
    }
    const me = sc.getLocalUserInfo()
    this.localId = me ? me.connectionId || "" : ""
    this.localName = me ? me.displayName || "" : ""
    sc.onRealtimeStoreUpdated.add((_s: MultiplayerSession, store: GeneralDataStore, key: string, info: ConnectedLensModule.RealtimeStoreUpdateInfo) => {
      const si = _s.getRealtimeStoreInfo(store)
      if (!si || si.storeId !== STORE_ID) return
      if (!this.store) this.store = store // late bind (the create race, see the Sync Kit recipe)
      const updater = info && info.updaterInfo ? info.updaterInfo.connectionId : ""
      if (this.localId && updater === this.localId) return // our own write
      this.receive(key, store.has(key) ? store.getString(key) : "")
    })
    sc.onUserLeftSession.add((_s: MultiplayerSession, u: ConnectedLensModule.UserInfo) => {
      this.onGhostGone(u.connectionId)
      this.users = sc.getUsers().length
      // the departed user's slice would sit in the store for the rest of the session (validator, 15.09)
      const k = u.connectionId + ":" + KEY
      try {
        if (this.store && this.store.has(k)) this.store.remove(k)
      } catch (e) {
        /* another device may have removed it first */
      }
    })
    sc.onUserJoinedSession.add(() => {
      this.users = sc.getUsers().length
    })
    this.users = sc.getUsers().length
    this.createOrFind()
  }

  private createOrFind() {
    const s = this.session!
    if (this.find(s)) {
      this.attached()
      return
    }
    const opts = RealtimeStoreCreateOptions.create()
    opts.persistence = RealtimeStoreCreateOptions.Persistence.Session
    opts.ownership = RealtimeStoreCreateOptions.Ownership.Unowned
    opts.storeId = STORE_ID
    s.createRealtimeStore(
      opts,
      (store: GeneralDataStore) => {
        this.store = store
        this.attached()
      },
      (err: string) => {
        // several devices joined at once and raced to create the same store: attach to the winner's
        if (this.find(s)) this.attached()
        else this.failed = "store: " + err
      },
    )
  }

  private find(s: MultiplayerSession): boolean {
    for (const st of s.allRealtimeStores) {
      const info = s.getRealtimeStoreInfo(st)
      if (info && info.storeId === STORE_ID) {
        this.store = st
        return true
      }
    }
    return false
  }

  private attached() {
    this.ready = true
    log.i("NET_READY conn=" + this.localId + " users=" + this.users)
    // late joiner: everybody's current slice, once
    const s = this.session!
    for (const u of s.activeUsersInfo) {
      if (u.connectionId === this.localId) continue
      const k = u.connectionId + ":" + KEY
      if (this.store!.has(k)) this.receive(k, this.store!.getString(k))
    }
  }

  private receive(key: string, value: string) {
    const c = key.indexOf(":")
    if (c < 0 || key.substring(c + 1) !== KEY || !value) return
    const conn = key.substring(0, c)
    let a: any
    try {
      a = JSON.parse(value)
    } catch (e) {
      return
    }
    if (!a || a.length < 9) return
    this.rx++
    // [name, px, py, pz, qx, qy, qz, qw, ...body]: the transform is in the colocated frame
    const t = this.frame()
    if (!t && !this.solo()) return // colocation not resolved here: a packet in someone else's frame is noise
    const lp = new vec3(a[1], a[2], a[3])
    const lq = new quat(a[7], a[4], a[5], a[6])
    const pos = t ? t.getWorldTransform().multiplyPoint(lp) : lp
    const rot = t ? t.getWorldRotation().multiply(lq) : lq
    this.onGhost(conn, "" + a[0], { pos: pos, rot: rot, a: a.slice(8) })
  }

  /** the colocated root's transform (null before mapping / without Sync Kit) */
  private frame(): Transform | null {
    try {
      const la = SessionController.getInstance().getLocatedAtComponent()
      return la ? la.getSceneObject().getTransform() : null
    } catch (e) {
      return null
    }
  }

  private solo(): boolean {
    try {
      return SessionController.getInstance().isSingleplayer()
    } catch (e) {
      return true
    }
  }

  /** the rate that keeps the whole room under the session's message budget (350 per 5 s) */
  private rateHz(): number {
    return Math.min(FlyConfig.NET_RATE_HZ, Math.max(2, FlyConfig.NET_ROOM_MSGS_PER_S / Math.max(1, this.users)))
  }

  /**
   * 16.09 perf: the caller runs `publish(dt, f.pos, f.worldRotation(), f.packNet())` every frame,
   * so a native `getWorldRotation()` and a 25-element array (16 dictionary reads) are built every
   * frame — and six of every seven are thrown away right here, behind the NET_RATE_HZ gate. `due()`
   * answers that question BEFORE the arguments exist, so the caller can build nothing on the other
   * six frames. The accumulator stays in this class: one clock owner. `due()` advances it, `send()`
   * spends it, and the old `publish()` is the two of them in a row (unchanged behaviour for any
   * caller that has not moved yet).
   *
   *   FlySwarm.netTick:  if (f && this.introT <= 0 && this.net.due(dt)) this.net.send(f.pos, f.worldRotation(), f.packNet())
   */
  due(dt: number): boolean {
    if (!this.ready || !this.store) return false
    this.sendT += dt
    return this.sendT >= 1 / this.rateHz()
  }

  /** called every frame with the local fly's body; sends at NET_RATE_HZ (less in a crowded room) */
  publish(dt: number, pos: vec3, rot: quat, body: number[]) {
    if (!this.due(dt)) return
    this.send(pos, rot, body)
  }

  /** the local fly's body, in the colocated frame; only ever called on a frame `due()` allowed */
  send(pos: vec3, rot: quat, body: number[]) {
    if (!this.ready || !this.store) return
    this.sendT = 0
    const t = this.frame()
    if (!t && !this.solo()) return // not localised in the shared map yet: nothing to say in its frame
    const lp = t ? t.getInvertedWorldTransform().multiplyPoint(pos) : pos
    const lq = t ? t.getWorldRotation().invert().multiply(rot) : rot
    const r1 = (x: number) => Math.round(x * 10) / 10
    const r3 = (x: number) => Math.round(x * 1000) / 1000
    const a: any[] = [this.localName.substring(0, 12) || "FLY", r1(lp.x), r1(lp.y), r1(lp.z), r3(lq.x), r3(lq.y), r3(lq.z), r3(lq.w)]
    for (const v of body) a.push(Math.round(v * 100) / 100)
    this.seq++
    this.store.putString(this.localId + ":" + KEY, JSON.stringify(a))
    this.tx++
  }

  status(): string {
    if (this.failed) return "net off (" + this.failed + ")"
    if (!this.ready) return "net joining"
    return "net users=" + this.users + " hz=" + this.rateHz().toFixed(1) + " tx=" + this.tx + " rx=" + this.rx
  }
}
