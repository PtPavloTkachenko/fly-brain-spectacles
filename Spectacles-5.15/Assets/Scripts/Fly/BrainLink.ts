/**
 * BrainLink — WebSocket to the Mac brain server (brain_server/server.py, port 8790).
 * JSON frames with discriminator `t`. Reconnect with backoff, app-level ping/pong.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("BrainLink")

export interface BrainAct {
  turn: number
  orient: number
  steer: number
  escape_L: number
  escape_R: number
  stop: number
  back: number
  feed: number
  appetite: number
  forward: number
  // 12.09 audit: both were already read by FlySwarm (`a.avoid`, `a.thrust`) but missing from the
  // contract, so FlyBody's `for (const k in this.act)` smoothing loop could never copy them either
  avoid: number
  thrust: number
  sacc: number // 12.09: DNa15 - DNb01 per side, suppressed by VES041 — "flick now, this way"
  // 12.09 Pavlo: "hook as much as possible up to the brain". The rest of the body, read straight
  // off its motor pools instead of the timers and sine waves that used to drive those bones.
  groom: number // DNg12 (21 cells/side): the fly decides to clean itself
  neck: number // neck MN left-right difference: head turn, + = right
  ant: number // antennal MN pool: antennal sweep
  prob: number // proboscis MN pool (33 cells; MN9 is one of them): extension
  abd: number // abdominal MN pool (107/side): pump depth
  legs: number // all six leg pools together (the board's summary number)
  // ...and each leg on its own pool: front/middle/hind x left/right, in LEGS order
  legf_L: number
  legm_L: number
  legh_L: number
  legf_R: number
  legm_R: number
  legh_R: number
}

export interface BrainMsg {
  t: "brain"
  fly: number
  sim_ms: number
  wall_ms: number
  act: BrainAct
  neural: { [k: string]: number }
  hz: { [k: string]: number }
  cloud?: string
  engine?: string // "web" = the C++ core on a page (WASM/WebGPU); "native" = the same core behind server.py --engine native
  // the optional fields below come from the page or the Mac core, whichever is the brain
  thr?: number // native core: kernel threads in use
  duty?: number // native core: share of its step time it is allowed to run (1 = flat out)
  gpu?: number // native core: fraction of chunks on the Vulkan kernel (ADR 52)
  gpu_on?: boolean // native core: the live state is in the GPU buffers right now
  gpu_ms?: number // native core: wall ms the GPU spent on the WHOLE hop (since 17.09; it used to be the last chunk, which is what made twelve seconds look unaccounted for)
  gpu_chunk_ms?: number // native core: wall ms of the last GPU chunk (10 ms of brain time) - the old meaning of gpu_ms
  core?: any // native core: the per-hop phase table {gpu,busy,drive,counts,push,pull,cpu,sense,plast,read,msg,gc,cc,step} in ms, summing to the step; `busy` is the GPU's own timestamps, so busy << gpu means queued behind the renderer
  gpu_err?: string // native core: why the GPU backend stopped (it falls back to the CPU for good)
  gpu_check?: any // native core: once, the CPU-vs-GPU self-check result
  // the native core with plasticity data. `since_ms` is brain time since a weight last moved (-1 = never)
  // `eff_on` / `n_on` (ADR 67): the efficacy of only those plastic synapses whose presynaptic
  // Kenyon cell fired in this step — the memory OF THE CUE THAT IS ON, which `mean_efficacy` hides
  memory?: { learning: boolean; mean_efficacy: number; changed: number; edges: number; rewards?: number; punishes?: number; since_ms?: number; eff_on?: number; n_on?: number }
}

/** The plastic state as a portable blob (ADR 62): the answer to `{t:"memory", op:"get"|"set"|"clear"|"echo"}`. */
export interface MemoryMsg {
  t: "memory"
  fly: number
  op: "get" | "set" | "clear" | "echo"
  ok: boolean
  err?: string
  edges: number
  mean_efficacy: number
  changed: number
  rewards: number
  punishes: number
  sim_ms: number
  bytes?: number
  data?: string // `get` only: base64, deflated, self-describing (magic FMEM / FMEZ)
}

export class BrainLink {
  private internet = require("LensStudio:InternetModule") as InternetModule
  private socket: WebSocket | null = null
  private backoffS = 1.0
  private timeS = 0
  private lastPingAt = 0
  private lastPongAt = 0
  private reconnectAt = -1
  connected = false
  muted = false // another source is the brain right now (WebBrainLink): this one's messages are ignored
  msgMaxMs = 0 // worst message-handling time in the telemetry window (read + reset by FlySwarm)
  msgMaxChars = 0
  flyCount = 0
  latest: (BrainMsg | null)[] = []
  onBrain: (m: BrainMsg) => void = () => {}
  onMemory: (m: MemoryMsg) => void = () => {} // the brain answered a `memory` command (ADR 62)
  onReady: (fly: number) => void = () => {}
  /** the brain's own resting rate per named readout, from the `ready` message (ADR 89) */
  baseline: { [k: string]: number } = {}
  /** how far above its OWN rest a readout is, in Hz; 0 when we have no rest for it */
  above(name: string, hz: number): number {
    const rest = this.baseline[name]
    return rest === undefined ? 0 : Math.max(0, hz - rest)
  }
  onStatus: (connected: boolean) => void = () => {}

  connect() {
    if (!FlyConfig.BRAIN_SOCKET_ENABLED) {
      // no plain-ws LAN brain: nothing to dial, and nothing asking the project for EXPERIMENTAL_API
      log.i("LINK_SOCKET_OFF the Mac brain server is not used (BRAIN_SOCKET_ENABLED); the brain is a page by PIN")
      this.onStatus(false)
      return
    }
    log.i("LINK_CONNECT " + FlyConfig.WS_URL)
    try {
      this.socket = this.internet.createWebSocket(FlyConfig.WS_URL)
    } catch (e) {
      log.w("createWebSocket failed: " + e)
      this.scheduleReconnect()
      return
    }
    this.socket.onopen = () => {
      this.connected = true
      this.backoffS = 1.0
      this.lastPongAt = this.timeS
      log.i("LINK_OPEN")
      this.send({ t: "hello", role: "lens", proto: 1 })
      this.onStatus(true)
    }
    this.socket.onmessage = (event: WebSocketMessageEvent) => {
      if (typeof event.data !== "string") return
      // perf probe (11.09 stalls): message handling runs outside the frame tick, so it is timed here
      const t0 = getRealTimeNanos() // ns, not Date.now(): every probe in this lens is sub-ms now (15.09 perf pass)
      for (const msg of this.parseMany(event.data)) this.route(msg)
      const ms = (getRealTimeNanos() - t0) / 1e6
      if (ms > this.msgMaxMs) this.msgMaxMs = ms
      if (event.data.length > this.msgMaxChars) this.msgMaxChars = event.data.length
    }
    this.socket.onclose = () => this.drop("closed")
    this.socket.onerror = () => this.drop("error")
  }

  /** Frames may carry several concatenated JSON objects. */
  private parseMany(text: string): any[] {
    try {
      return [JSON.parse(text)]
    } catch (e) {
      const out: any[] = []
      for (const part of text.split(/}\s*{/)) {
        const fixed = (part.startsWith("{") ? "" : "{") + part + (part.endsWith("}") ? "" : "}")
        try {
          out.push(JSON.parse(fixed))
        } catch (err) {
          /* drop the broken fragment */
        }
      }
      return out
    }
  }

  private route(msg: any) {
    switch (msg.t) {
      case "welcome":
        this.flyCount = msg.flies
        this.latest = new Array(msg.flies).fill(null)
        log.i("LINK_WELCOME flies=" + msg.flies + " cloud=" + msg.cloud)
        break
      case "ready":
        // 21.09: the brain measures its OWN resting rates at start and publishes them, and the lens
        // had never read them. Without a rest to compare against, no number on any panel can be
        // read: PPL101 idles at 71 Hz in this model, and we were showing that raw figure under the
        // word STRESS -- and handing it to Gemini, which then had the fly say it felt stressed
        // while nothing whatever was happening to it. A rate means something only next to its rest.
        if (msg.baseline && typeof msg.baseline === "object") {
          this.baseline = msg.baseline as { [k: string]: number }
          log.i("LINK_BASELINE cells=" + Object.keys(this.baseline).length)
        }
        this.onReady(msg.fly)
        break
      case "brain":
        if (this.muted) break
        this.latest[msg.fly] = msg as BrainMsg
        this.onBrain(msg as BrainMsg)
        break
      case "memory":
        this.onMemory(msg as MemoryMsg)
        break
      case "pong":
        this.lastPongAt = this.timeS
        break
      case "dead":
        log.w("fly brain died: " + msg.fly)
        break
    }
  }

  private drop(reason: string) {
    const was = this.connected
    this.connected = false
    this.socket = null
    if (was) {
      log.w("LINK_DROP " + reason)
      this.onStatus(false)
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.reconnectAt >= 0) return
    this.reconnectAt = this.timeS + this.backoffS
    this.backoffS = Math.min(5.0, this.backoffS * 2)
  }

  /** Call every frame. */
  tick(dt: number) {
    this.timeS += dt
    if (!this.connected) {
      if (this.reconnectAt >= 0 && this.timeS >= this.reconnectAt) {
        this.reconnectAt = -1
        this.connect()
      }
      return
    }
    if (this.timeS - this.lastPingAt > FlyConfig.PING_INTERVAL_S) {
      this.lastPingAt = this.timeS
      this.send({ t: "ping", ts: this.timeS })
    }
    if (this.timeS - this.lastPongAt > FlyConfig.PONG_TIMEOUT_S) {
      try {
        this.socket?.close()
      } catch (e) {
        /* noop */
      }
      this.drop("pong timeout")
    }
  }

  send(obj: any) {
    if (!this.connected || !this.socket) return
    try {
      this.socket.send(JSON.stringify(obj))
    } catch (e) {
      log.w("send failed: " + e)
    }
  }

  sendSenses(fly: number, ch: any) {
    this.send({ t: "senses", fly: fly, ch: ch })
  }

  select(fly: number) {
    this.send({ t: "select", fly: fly })
  }

  pulse(fly: number, kind: "reward" | "punish") {
    this.send({ t: "pulse", fly: fly, kind: kind })
  }

  /** the live plasticity state, so a new brain can be told what it is (ADR 68 bug: `welcome`
   *  carried the boot-time CONFIG, so every page that joined switched learning back off) */
  learningOn = FlyConfig.NATIVE_LEARNING

  /** Dopamine learning on/off (KC->MBON plasticity in the brain; memories fade over ~3 h). */
  setLearning(fly: number, on: boolean) {
    this.learningOn = on
    this.send({ t: "learning", fly: fly, on: on })
  }

  /**
   * The plastic state (ADR 62). `get` -> a MemoryMsg with `data`; `set` loads one (`elapsed_s` =
   * how long the glasses were off, so the rule's own tau-10800 s (3 h) decay is applied); `clear` makes
   * the fly naive again; `echo` is the core's self-check (save + load back in the same instant).
   * `compact` on a `get` leaves out the two 1 s traces: use it for anything stored between sessions.
   */
  memory(fly: number, op: "get" | "set" | "clear" | "echo", data?: string, elapsedS?: number, compact?: boolean) {
    const m: any = { t: "memory", fly: fly, op: op }
    if (data !== undefined) m.data = data
    if (elapsedS !== undefined) m.elapsed_s = elapsedS
    if (compact !== undefined) m.compact = compact
    this.send(m)
  }
}
