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
  // 12.09 the user: "hook as much as possible up to the brain". The rest of the body, read straight
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
  msgMaxMs = 0 // worst message-handling time in the telemetry window (read + reset by FlySwarm)
  msgMaxChars = 0
  flyCount = 0
  latest: (BrainMsg | null)[] = []
  onBrain: (m: BrainMsg) => void = () => {}
  onReady: (fly: number) => void = () => {}
  onStatus: (connected: boolean) => void = () => {}

  connect() {
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
      const t0 = Date.now()
      for (const msg of this.parseMany(event.data)) this.route(msg)
      const ms = Date.now() - t0
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
        this.onReady(msg.fly)
        break
      case "brain":
        this.latest[msg.fly] = msg as BrainMsg
        this.onBrain(msg as BrainMsg)
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
}
