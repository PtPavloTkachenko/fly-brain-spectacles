/**
 * FlyMemory — YOUR fly, and what it still knows tomorrow (ADR 63).
 *
 * The brain's learning (ADR 48) lives in 7,835 KC->MBON07/11 synapses. The core hands that state
 * over as one blob (`{t:"memory", op:"get"}`) and takes it back (`op:"set"`), so this class is the
 * custodian: it keeps the blob and the fly's identity where the user will find them again, gives
 * them to whichever engine is the brain right now, and (optionally) mirrors them to a backend so
 * the fly follows its owner to another pair of glasses.
 *
 * Four things worth knowing:
 *
 *  - THE KEY IS THE USER, NOT THE DEVICE. Sync Kit's `UserInfo.userId` is "unique per lens for each
 *    user", so the same person on other glasses is the same fly. It only exists once a session is
 *    ready, so we poll for it and fall back to a random per-device id; `status().keySource` says
 *    which one is in use, and the short form is all that is ever logged.
 *  - THE MEMORY KEEPS FADING WHILE THE GLASSES ARE OFF. The rule's trace has tau 10800 s (3 h), and that is
 *    biology, not a bug. A save carries a timestamp and a load carries `elapsed_s`; the core applies
 *    the rule's own decay over the gap in closed form. Half an hour away = ~37 % left, a night = none.
 *  - THE LENS HOLDS THE CANONICAL COPY. The brain may be a web page (ADR 55) or the Mac socket
 *    (editor); both speak the same `memory` message, and the blob is re-pushed whenever
 *    the engine changes. While a page thinks, a fresh copy is pulled every MEMORY_PULL_S, because a
 *    page can vanish without warning.
 *  - NOTHING HERE DRIVES BEHAVIOUR. It moves bytes. Every behavioural change comes from the rule.
 *
 * For a session flow (FlyTrainer): `save()` after a session, `reset()` for a RESET key,
 * `noteTraining(label, kind)` per US delivered, `status()` / `line()` for the board (diff-cached).
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { BrainLink, BrainMsg, MemoryMsg } from "./BrainLink"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("FlyMemory")

const K_DEV = "fly.dev" // the per-device fallback id
const K_KEY = "fly.key" // the id this record belongs to
const K_SRC = "fly.keysrc"
const K_VER = "fly.mem.v"
const K_BLOB = "fly.mem.b"
const K_AT = "fly.mem.at"
const K_EFF = "fly.mem.eff"
const K_CHG = "fly.mem.chg"
const K_REW = "fly.mem.rew"
const K_PUN = "fly.mem.pun"
const K_IDN = "fly.idn"
const FORMAT = 1
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** What the fly IS, as opposed to what it has learned. Travels with the memory. */
export type FlyIdentity = {
  nameIx: number // index into FlyConfig.FLY_NAMES — chosen once, kept for ever
  colorIx: number // index into FlyConfig.FLY_COLORS
  born: number // Date.now() of the first run
  sessions: number // finished training sessions
  trained: { [label: string]: { rew: number; pun: number; last: number } }
  /** ADR 68: the last few teaching sessions — the evidence pack's headline plus Gemini's reading.
   *  A TRANSFER session quotes them, and a brain version carries them to the next pair of glasses. */
  history?: any[]
}

export type FlyMemoryState = "off" | "empty" | "restored" | "learning" | "error"

export type FlyMemoryStatus = {
  // the shape the board and the web page read
  keySource: "user" | "device"
  keyShort: string // four characters, never the whole id
  synced: boolean // the backend has this exact blob
  bytes: number
  savedAt: number // Date.now() at the last save (0 = never)
  changedSinceSave: number // synapses that moved since then
  mean_efficacy: number
  meanEfficacy: number // the same number under the camelCase name the board uses
  changed: number
  // the rest
  state: FlyMemoryState
  learning: boolean
  edges: number
  rewards: number
  punishes: number
  sinceS: number // wall seconds since a synapse last moved (-1 = never)
  storedAgeS: number // how old the stored blob is (-1 = nothing stored)
  restoredAgeS: number // how long the memory loaded at start had been off (-1 = none)
  backend: string // "" = off, else "ok" / "sync" / the error
  sessions: number
  name: string
}

export class FlyMemory {
  private store: GeneralDataStore | null = null
  private internet: InternetModule | null = null
  private blob = "" // the newest base64 blob we hold (the canonical copy)
  private blobAtMs = 0
  private pushedTo = "" // which engine already has our memory ("" = nobody yet)
  private pending = false
  private savedChanged = -1
  private lastSaveT = 0
  private lastPullT = 0
  private userPollT = 1e9
  private mockSeen = false
  private t = 0
  private wasLearning = false
  private lastLine = ""
  private lineN = 0
  private resetShowUntil = -1

  /** a memory was found and handed to the brain at start */
  armed = false
  /** who the fly is. Written here, read by whoever names and colours it. */
  identity: FlyIdentity = { nameIx: -1, colorIx: -1, born: 0, sessions: 0, trained: {} }

  private st: FlyMemoryStatus = {
    keySource: "device", keyShort: "----", synced: false, bytes: 0, savedAt: 0, changedSinceSave: 0,
    mean_efficacy: 1, meanEfficacy: 1, changed: 0, state: "off", learning: false, edges: 0, rewards: 0, punishes: 0,
    sinceS: -1, storedAgeS: -1, restoredAgeS: -1, backend: "", sessions: 0, name: "",
  }
  private key = ""

  constructor(private link: BrainLink, private fly: number = 0) {
    if (!FlyConfig.MEMORY_ENABLED) return
    try {
      this.store = global.persistentStorageSystem.store
    } catch (e) {
      log.w("MEMORY_NO_STORE " + e)
      this.st.state = "error"
      return
    }
    this.key = this.readKey()
    this.readIdentity()
    this.readStored()
    this.link.onMemory = (m: MemoryMsg) => this.onMemory(m)
    log.i("MEMORY_INIT key=" + this.st.keySource + ":" + this.st.keyShort + " fly=" + this.st.name +
      " stored=" + this.st.bytes + "B age=" + Math.round(this.st.storedAgeS) + "s limit=" + this.maxBytes() + "B")
    this.userPollT = 0 // ask Sync Kit for the real user id as soon as a session exists
    if (FlyConfig.MEMORY_BACKEND) this.backendPull()
  }

  // ------------------------------------------------------------------ who this fly belongs to ----

  /**
   * Sync Kit's `UserInfo.userId` is documented as "unique per lens for each user", which is exactly
   * the key we want: the same person on another pair of glasses is the same fly. It only exists once
   * a session is ready (including the mocked single-player one), so this is polled, not awaited.
   */
  private pollUserId() {
    if (this.st.keySource === "user" || !this.store) return
    let id = ""
    try {
      const mod = require("SpectaclesSyncKit.lspkg/Core/SessionController")
      const sc = mod && mod.SessionController ? mod.SessionController.getInstance() : null
      const me = sc ? sc.getLocalUserInfo() : null
      id = me && me.userId ? String(me.userId) : ""
    } catch (e) {
      id = "" // no Sync Kit in the scene: the device id stays the key
    }
    // The editor's mocked single-player session answers with a placeholder ("mock..."), which would
    // be the SAME id for everyone: never let that become the key. Verified in the preview, 15.09.
    if (FlyMemory.mocked(id)) {
      if (id && !this.mockSeen) {
        this.mockSeen = true
        log.i("MEMORY_KEY mocked user id (len=" + id.length + ", '" + id.substr(0, 4) + "...'): staying on the device id")
      }
      return
    }
    const was = this.st.keySource + ":" + this.key.substr(0, 4)
    this.key = id
    this.st.keySource = "user"
    this.st.keyShort = id.substr(0, 4)
    try {
      this.store.putString(K_KEY, id)
      this.store.putString(K_SRC, "user")
    } catch (e) {
      /* the record stays under the old key; nothing is lost */
    }
    log.i("MEMORY_KEY user:" + this.st.keyShort + " (was " + was + ")")
    // the record on this device belongs to whoever is wearing it now; the backend row moves with it
    if (FlyConfig.MEMORY_BACKEND) {
      if (this.blob) this.backendPush()
      else this.backendPull()
    }
  }

  /** the editor's stand-in for a real user id, and anything else too short to be one */
  private static mocked(id: string): boolean {
    return !id || id.length < 8 || id.toLowerCase().indexOf("mock") === 0
  }

  private readKey(): string {
    let dev = ""
    try {
      dev = this.store!.getString(K_DEV)
    } catch (e) {
      dev = ""
    }
    if (dev.length !== 36) {
      const hex = "0123456789abcdef"
      dev = ""
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) dev += "-"
        else if (i === 14) dev += "4"
        else if (i === 19) dev += hex[8 + Math.floor(Math.random() * 4)]
        else dev += hex[Math.floor(Math.random() * 16)]
      }
      try {
        this.store!.putString(K_DEV, dev)
      } catch (e) {
        /* read-only store */
      }
    }
    let key = dev
    let src: "user" | "device" = "device"
    try {
      const stored = this.store!.getString(K_KEY)
      // a key written by an older build (or by the editor's mocked session) may be the shared
      // "mock..." placeholder: never keep one, it would be the same id for every user
      if (stored && !FlyMemory.mocked(stored)) {
        key = stored
        src = this.store!.getString(K_SRC) === "user" ? "user" : "device"
      } else if (stored) {
        this.store!.putString(K_KEY, dev)
        this.store!.putString(K_SRC, "device")
        log.i("MEMORY_KEY dropped a mocked key, back to the device id")
      }
    } catch (e) {
      /* first run */
    }
    this.st.keySource = src
    this.st.keyShort = key.substr(0, 4)
    return key
  }

  private readIdentity() {
    let raw = ""
    try {
      raw = this.store!.getString(K_IDN)
    } catch (e) {
      raw = ""
    }
    if (raw) {
      try {
        const p = JSON.parse(raw)
        if (p && typeof p.nameIx === "number") this.identity = { nameIx: p.nameIx, colorIx: p.colorIx, born: p.born || 0, sessions: p.sessions || 0, trained: p.trained || {} }
      } catch (e) {
        /* a broken identity is just a new fly */
      }
    }
    if (this.identity.nameIx < 0) {
      // a fly of one's own from the first run: the name and colour are drawn once and never again
      const n = FlyConfig.FLY_NAMES.length
      this.identity.nameIx = Math.floor(Math.random() * n)
      this.identity.colorIx = this.identity.nameIx % FlyConfig.FLY_COLORS.length
      this.identity.born = Date.now()
      this.writeIdentity()
    }
    this.st.sessions = this.identity.sessions
    this.st.name = this.flyName()
  }

  private writeIdentity() {
    try {
      this.store!.putString(K_IDN, JSON.stringify(this.identity))
    } catch (e) {
      /* nothing to do: the identity is regenerated next run */
    }
    this.st.sessions = this.identity.sessions
    this.st.name = this.flyName()
  }

  /** The name and colour THIS user's fly wears, wherever they put the glasses on. */
  flyName(): string {
    return FlyConfig.FLY_NAMES[this.identity.nameIx % FlyConfig.FLY_NAMES.length]
  }
  nameIndex(fly: number): number {
    return fly === this.fly && this.identity.nameIx >= 0 ? this.identity.nameIx : fly
  }
  colorIndex(fly: number): number {
    return fly === this.fly && this.identity.colorIx >= 0 ? this.identity.colorIx : fly
  }

  /** One US delivered to a named thing: the fly's training history, kept with its memory. */
  noteTraining(label: string, kind: "reward" | "punish") {
    if (!label) return
    const e = this.identity.trained[label] || { rew: 0, pun: 0, last: 0 }
    if (kind === "reward") e.rew++
    else e.pun++
    e.last = Date.now()
    this.identity.trained[label] = e
    this.writeIdentity()
  }

  /** A finished training session (FlyTrainer calls it with `save()`). */
  sessionDone() {
    this.identity.sessions++
    this.writeIdentity()
    this.save()
  }

  // ------------------------------------------------------------------ device persistence ----

  private maxBytes(): number {
    try {
      return this.store ? this.store.getMaxSizeInBytes() : 0
    } catch (e) {
      return 0
    }
  }

  // The store takes raw bytes, so the blob is kept as bytes: a third smaller than its base64, which
  // matters because the WHOLE store is only 100 KB on this device (measured, see the RUNBOOK).
  private static toBytes(b64: string): Uint8Array {
    const t = new Int16Array(128)
    for (let i = 0; i < 128; i++) t[i] = -1
    for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i
    const out = new Uint8Array(Math.floor((b64.length * 3) / 4) + 3)
    let acc = 0
    let bits = 0
    let n = 0
    for (let i = 0; i < b64.length; i++) {
      const c = b64.charCodeAt(i)
      if (c > 127) continue
      const v = t[c]
      if (v < 0) continue // '=' and whitespace
      acc = (acc << 6) | v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out[n++] = (acc >> bits) & 0xff
      }
    }
    return out.subarray(0, n)
  }

  private static toB64(b: Uint8Array): string {
    let s = ""
    let i = 0
    for (; i + 2 < b.length; i += 3) {
      const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
    }
    if (i < b.length) {
      let v = b[i] << 16
      if (i + 1 < b.length) v |= b[i + 1] << 8
      s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < b.length ? B64[(v >> 6) & 63] : "=") + "="
    }
    return s
  }

  private readStored() {
    if (!this.store) return
    try {
      if (this.store.getInt(K_VER) !== FORMAT) return
      const bytes = this.store.getUint8Array(K_BLOB)
      if (!bytes || !bytes.length) return
      this.blob = FlyMemory.toB64(bytes)
      this.blobAtMs = this.store.getDouble(K_AT)
      this.st.bytes = bytes.length
      this.st.savedAt = this.blobAtMs
      this.st.storedAgeS = this.ageS(this.blobAtMs)
      this.st.mean_efficacy = this.st.meanEfficacy = this.store.getDouble(K_EFF) || 1
      this.st.changed = this.store.getInt(K_CHG)
      this.st.rewards = this.store.getInt(K_REW)
      this.st.punishes = this.store.getInt(K_PUN)
      this.st.state = "restored"
    } catch (e) {
      log.w("MEMORY_READ_FAIL " + e)
      this.st.state = "error"
    }
  }

  private writeStored() {
    if (!this.store || !this.blob) return
    const bytes = FlyMemory.toBytes(this.blob)
    const max = this.maxBytes()
    if (max > 0 && bytes.length > max * FlyConfig.MEMORY_MAX_FRACTION) {
      // the compact blob is ~10 bytes per moved synapse, so the whole 7,835 would be ~74 KB: it fits
      // in this device's 100 KB, but say so loudly rather than half-write it if a store is smaller
      log.w("MEMORY_TOO_BIG " + bytes.length + "B of " + max + "B: not stored")
      this.st.state = "error"
      return
    }
    try {
      this.store.putUint8Array(K_BLOB, bytes)
      this.store.putInt(K_VER, FORMAT)
      this.store.putDouble(K_AT, this.blobAtMs)
      this.store.putDouble(K_EFF, this.st.mean_efficacy)
      this.store.putInt(K_CHG, this.st.changed)
      this.store.putInt(K_REW, this.st.rewards)
      this.store.putInt(K_PUN, this.st.punishes)
      this.st.bytes = bytes.length
      this.st.savedAt = this.blobAtMs
      this.st.storedAgeS = 0
      this.st.changedSinceSave = 0
      log.i("MEMORY_SAVE bytes=" + bytes.length + " changed=" + this.st.changed +
        " eff=" + this.st.mean_efficacy.toFixed(4) + " key=" + this.st.keySource + ":" + this.st.keyShort)
    } catch (e) {
      log.w("MEMORY_WRITE_FAIL " + e)
      this.st.state = "error"
    }
  }

  /** Date.now() is a real clock, but never trust it across a reboot or a time-zone change. */
  private ageS(atMs: number): number {
    if (!atMs) return -1
    const d = (Date.now() - atMs) / 1000
    return d < 0 || d > 366 * 24 * 3600 ? -1 : d
  }

  // ------------------------------------------------------------------ the brain ----

  /** Call every frame with the selected fly's newest brain message (FlySwarm.tick). */
  tick(dt: number, msg: BrainMsg | null) {
    if (!FlyConfig.MEMORY_ENABLED || !this.store) return
    this.t += dt
    if (this.st.keySource !== "user" && this.t >= this.userPollT) {
      this.userPollT = this.t + FlyConfig.MEMORY_USER_POLL_S
      this.pollUserId()
    }
    if (!msg || !msg.memory) return
    const m = msg.memory
    const engine = msg.engine || "native"
    this.st.learning = m.learning
    this.st.mean_efficacy = this.st.meanEfficacy = m.mean_efficacy
    this.st.changed = m.changed
    this.st.edges = m.edges
    if (m.rewards !== undefined) this.st.rewards = m.rewards
    if (m.punishes !== undefined) this.st.punishes = m.punishes
    if (m.since_ms !== undefined) this.st.sinceS = m.since_ms < 0 ? -1 : m.since_ms / 1000
    if (this.savedChanged >= 0) this.st.changedSinceSave = Math.max(0, m.changed - this.savedChanged)

    // 1. whoever is the brain right now must be holding our memory
    if (this.blob && this.pushedTo !== engine) {
      this.pushedTo = engine
      const age = this.ageS(this.blobAtMs)
      this.link.memory(this.fly, "set", this.blob, age < 0 ? 0 : age)
      this.st.restoredAgeS = age
      this.armed = true
      log.i("MEMORY_LOAD engine=" + engine + " bytes=" + this.st.bytes + " agedS=" + Math.round(age < 0 ? 0 : age))
    } else if (!this.blob) {
      this.pushedTo = engine
      if (this.st.state === "off") this.st.state = "empty"
    }

    // 2. save on every MEMORY_SAVE_CHANGES new synapses, and at most every MEMORY_SAVE_MIN_S
    if (m.learning && this.savedChanged < 0) this.savedChanged = m.changed
    const grew = this.savedChanged >= 0 && m.changed - this.savedChanged >= FlyConfig.MEMORY_SAVE_CHANGES
    if (m.learning && grew && this.t - this.lastSaveT > FlyConfig.MEMORY_SAVE_MIN_S) this.save("changes")

    // 3. learning just went off: that is the end of a lesson, take a copy
    if (this.wasLearning && !m.learning) this.save("learning off")
    this.wasLearning = m.learning
    if (m.learning) this.st.state = "learning"

    // 4. a web page is the brain and may vanish without warning: keep our copy fresh
    if (engine === "web" && this.t - this.lastPullT > FlyConfig.MEMORY_PULL_S && m.changed > 0) {
      this.lastPullT = this.t
      this.save("web pull")
    }
    if (this.blobAtMs) this.st.storedAgeS = this.ageS(this.blobAtMs)
  }

  /** Ask the brain for its plastic state and store it. The answer arrives in onMemory. */
  save(why: string = "asked") {
    if (!FlyConfig.MEMORY_ENABLED || this.pending) return
    this.pending = true
    this.lastSaveT = this.t
    this.link.memory(this.fly, "get", undefined, undefined, true) // compact: what a gap destroys anyway
    log.d("MEMORY_GET (" + why + ")")
  }

  /** End of a session / the lens is going away. */
  flush() {
    this.save("flush")
  }

  /**
   * Forget everything: the brain goes naive, the device drops the blob, the backend row is blanked.
   * The fly keeps its name and colour — it is the same fly, it just knows nothing again.
   */
  reset() {
    this.link.memory(this.fly, "clear")
    this.blob = ""
    this.blobAtMs = 0
    this.savedChanged = -1
    this.pushedTo = ""
    this.armed = false
    this.identity.trained = {}
    this.identity.sessions = 0
    this.writeIdentity()
    this.st.state = "empty"
    this.st.bytes = 0
    this.st.savedAt = 0
    this.st.changedSinceSave = 0
    this.st.storedAgeS = -1
    this.st.restoredAgeS = -1
    this.st.changed = 0
    this.st.mean_efficacy = this.st.meanEfficacy = 1
    this.st.rewards = 0
    this.st.punishes = 0
    this.st.synced = false
    if (this.store) {
      try {
        this.store.remove(K_BLOB)
        this.store.putInt(K_VER, 0)
        this.store.putDouble(K_AT, 0)
      } catch (e) {
        /* the in-memory copy is cleared either way */
      }
    }
    this.resetShowUntil = this.t + FlyConfig.MEMORY_RESET_SHOW_S
    log.i("MEMORY_RESET key=" + this.st.keySource + ":" + this.st.keyShort)
    if (FlyConfig.MEMORY_BACKEND) this.backendBlank()
  }

  /** the same thing under the name the trainer's RESET key uses */
  clear() {
    this.reset()
  }

  /**
   * ADR 68: the full key, for the page ONLY. It is the row id in the brain-versions table, so the
   * page needs it to read and write versions under this person. It goes out once in the scene feed
   * and is never displayed, never logged (`status().keyShort` is the four characters we show).
   */
  fullKey(): string {
    return this.key
  }

  /** ADR 68: the page loaded a brain version — install it as the canonical copy and keep it. */
  install(b64: string, why: string = "page") {
    if (!b64) return
    this.blob = b64
    this.blobAtMs = Date.now()
    this.pushedTo = "" // whoever is the brain will be handed it on the next brain message
    this.armed = true
    this.st.bytes = b64.length
    this.st.state = "restored"
    this.st.restoredAgeS = 0
    this.writeStored()
    log.i("MEMORY_INSTALL " + why + " bytes=" + b64.length)
  }

  /** ADR 68: what the last sessions concluded, newest first. */
  addSummary(entry: any) {
    const h = (this.identity.history || []).slice()
    h.unshift(entry)
    this.identity.history = h.slice(0, FlyConfig.TRAIN_SUMMARY_KEEP)
    this.identity.sessions = (this.identity.sessions || 0) + 1
    this.writeIdentity()
  }

  history(): any[] {
    return this.identity.history || []
  }

  /** true for MEMORY_RESET_SHOW_S after a reset: the board can say "FORGOTTEN". */
  get justReset(): boolean {
    return this.t < this.resetShowUntil
  }

  /** Ask the core to prove its blob is lossless (save + load back in one instant; nothing may move). */
  selfCheck() {
    this.link.memory(this.fly, "echo")
  }

  private onMemory(m: MemoryMsg) {
    if (m.op === "get") {
      this.pending = false
      if (!m.ok || !m.data) {
        log.w("MEMORY_GET_FAIL " + (m.err || "no data"))
        return
      }
      this.blob = m.data
      this.blobAtMs = Date.now()
      this.st.mean_efficacy = this.st.meanEfficacy = m.mean_efficacy
      this.st.changed = m.changed
      this.st.rewards = m.rewards
      this.st.punishes = m.punishes
      this.savedChanged = m.changed
      this.st.synced = false
      this.writeStored()
      if (FlyConfig.MEMORY_BACKEND) this.backendPush()
    } else if (m.op === "set") {
      if (!m.ok) {
        // a blob from another brain file, or a corrupt one: drop it rather than train on nonsense
        log.w("MEMORY_LOAD_FAIL " + (m.err || "?") + " -- dropping the stored memory")
        this.reset()
        this.st.state = "error"
      } else {
        log.i("MEMORY_LOAD ok changed=" + m.changed + " eff=" + m.mean_efficacy.toFixed(4))
        this.st.state = "restored"
      }
    } else if (m.op === "echo") {
      log.i("MEMORY_ECHO ok=" + m.ok + " bytes=" + (m.bytes || 0) + " changed=" + m.changed)
    }
  }

  // ------------------------------------------------------------------ the board / guide / page ----

  status(): FlyMemoryStatus {
    return this.st
  }

  /**
   * One line for the board, diff-cached: the string only changes when a number does, so a caller can
   * compare `lineVersion()` instead of the text.
   */
  line(): string {
    const s = this.st
    const parts = [
      this.justReset ? "FORGOTTEN" : s.learning ? "LEARNING" : s.changed > 0 ? "REMEMBERS" : "NAIVE",
      s.changed + "/" + s.edges,
      "x" + s.mean_efficacy.toFixed(3),
    ]
    if (s.rewards || s.punishes) parts.push("+" + s.rewards + " -" + s.punishes)
    if (s.sinceS >= 0) parts.push(Math.round(s.sinceS) + "s ago")
    if (s.bytes > 0) parts.push(Math.round(s.bytes / 1024) + "kB " + (s.synced ? "synced" : "saved"))
    const next = parts.join("  ")
    if (next !== this.lastLine) {
      this.lastLine = next
      this.lineN++
    }
    return this.lastLine
  }

  /** bumps whenever line() or status() would change what it shows; compare it instead of the string */
  lineVersion(): number {
    this.line()
    return this.lineN
  }

  // ------------------------------------------------------------------ optional backend ----
  // Supabase REST, one row per USER id, no accounts (see web/DEPLOY.md). Off unless a URL and an
  // anon key are set, and the lens never needs it: the device store is the primary copy.

  private net(): InternetModule | null {
    if (!this.internet) {
      try {
        this.internet = require("LensStudio:InternetModule") as InternetModule
      } catch (e) {
        return null
      }
    }
    return this.internet
  }

  private backendOn(): boolean {
    return !!(FlyConfig.MEMORY_BACKEND && FlyConfig.MEMORY_BACKEND_URL && FlyConfig.MEMORY_BACKEND_KEY && this.net())
  }

  private headers(): { [k: string]: string } {
    return {
      apikey: FlyConfig.MEMORY_BACKEND_KEY,
      Authorization: "Bearer " + FlyConfig.MEMORY_BACKEND_KEY,
      "Content-Type": "application/json",
    }
  }

  private async backendPush() {
    if (!this.backendOn() || !this.blob) return
    this.st.backend = "sync"
    try {
      const h = this.headers()
      h["Prefer"] = "resolution=merge-duplicates,return=minimal"
      const res = await this.net()!.fetch(FlyConfig.MEMORY_BACKEND_URL + "/rest/v1/fly_memory", {
        method: "POST",
        headers: h,
        body: JSON.stringify([{ fly_id: this.key, blob: this.blob, saved_at: this.blobAtMs, identity: this.identity }]),
      })
      this.st.backend = res.ok ? "ok" : "http " + res.status
      this.st.synced = res.ok
      log.i("MEMORY_BACKEND_PUSH " + this.st.backend + " " + this.st.bytes + "B key=" + this.st.keySource + ":" + this.st.keyShort)
    } catch (e) {
      this.st.backend = "" + e
      log.w("MEMORY_BACKEND_PUSH " + e)
    }
  }

  /** Only when the device has nothing (a second pair of glasses): the local copy is always fresher. */
  private async backendPull() {
    if (!this.backendOn() || this.blob) return
    try {
      const res = await this.net()!.fetch(
        FlyConfig.MEMORY_BACKEND_URL + "/rest/v1/fly_memory?select=blob,saved_at,identity&fly_id=eq." + this.key,
        { method: "GET", headers: this.headers() },
      )
      if (!res.ok) {
        this.st.backend = "http " + res.status
        return
      }
      const rows = JSON.parse(await res.text())
      if (!rows || !rows.length || !rows[0].blob) {
        this.st.backend = "ok (nothing there)"
        return
      }
      this.blob = rows[0].blob
      this.blobAtMs = Number(rows[0].saved_at) || Date.now()
      if (rows[0].identity && typeof rows[0].identity.nameIx === "number") {
        this.identity = rows[0].identity // THEIR fly, name and history included
        this.writeIdentity()
      }
      this.st.backend = "ok"
      this.st.synced = true
      this.pushedTo = "" // the next brain message hands it over
      this.writeStored()
      log.i("MEMORY_BACKEND_PULL " + this.st.bytes + "B age=" + Math.round(this.st.storedAgeS) + "s fly=" + this.st.name)
    } catch (e) {
      this.st.backend = "" + e
      log.w("MEMORY_BACKEND_PULL " + e)
    }
  }

  private async backendBlank() {
    if (!this.backendOn()) return
    try {
      const h = this.headers()
      h["Prefer"] = "return=minimal"
      await this.net()!.fetch(FlyConfig.MEMORY_BACKEND_URL + "/rest/v1/fly_memory?fly_id=eq." + this.key, {
        method: "DELETE",
        headers: h,
      })
      log.i("MEMORY_BACKEND_BLANK key=" + this.st.keySource + ":" + this.st.keyShort)
    } catch (e) {
      log.w("MEMORY_BACKEND_BLANK " + e)
    }
  }
}
