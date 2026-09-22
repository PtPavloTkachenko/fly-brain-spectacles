/**
 * WebBrainLink — the brain on a web page, joined by a PIN (ADR 55).
 *
 * The lens shows a 4-digit PIN. The page (web/app.html: the same C++ core in WASM, the same
 * kernel on WebGPU) types it in, joins the room `fly-<pin>` on a relay (Supabase Realtime in the
 * cloud, or web/relay.py on a LAN: the same Phoenix protocol), and from then on the page IS the
 * brain: the lens sends it senses / select / pulse / reset / learning and receives the server.py
 * `brain` messages, with `engine: "web"`. The page joined by PIN is the brain (ADR 84/86/87); the
 * plain socket to a Mac core (BrainLink) exists only for the editor bench and is off by default.
 *
 * Nothing about behaviour changes with the source: same model, same message contract.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { BrainLink, BrainMsg } from "./BrainLink"
import { FlyConfig } from "./FlyConfig"

const log = new NativeLogger("WebBrain")
const HEARTBEAT_S = 25
const PAGE_TIMEOUT_S = 6 // no message from the page for this long = it is gone

export class WebBrainLink extends BrainLink {
  // 15.09 Pavlo: "the lens dropped, the site did not update": every lens restart minted a new PIN, so a
  // page sat in a dead room. The PIN is now kept in the device store: the same glasses keep the same
  // room across restarts and the page simply sees the lens come back. Tests still override via setPin().
  pin = WebBrainLink.storedPin()
  private topic = "realtime:fly-" + this.pin

  private static storedPin(): string {
    try {
      const store = global.persistentStorageSystem.store
      const kept = store.getString("cf_web_pin")
      if (kept && /^\d{4}$/.test(kept)) return kept
      const fresh = String(1000 + Math.floor(Math.random() * 9000))
      store.putString("cf_web_pin", fresh)
      return fresh
    } catch (e) {
      return String(1000 + Math.floor(Math.random() * 9000))
    }
  }
  private relay: WebSocket | null = null
  private relayUp = false
  private joined = false
  private ref = 0
  private webT = 0
  private hbAt = 0
  private retryAt = 0
  private relayBackoffS = 2
  private pageSeenAt = -1e9
  private pageName = ""
  webActive = false
  webRx = 0
  webTx = 0

  /** Tests (`debugScenario pin=NNNN`, docs/knowledge/TESTING.md): a fixed PIN, so page_sim.py can join
   *  the room without reading the log. Only before the relay is up: the room is named at join time. */
  setPin(pin: string) {
    if (this.relay || this.relayUp) return
    this.pin = pin
    this.topic = "realtime:fly-" + pin
  }

  connect() {
    super.connect() // the socket link calls connect() again on every reconnect: the relay has its own retry
    if (FlyConfig.WEB_BRAIN && FlyConfig.WEB_RELAY_URL && !this.relay && !this.relayUp) this.relayConnect()
  }

  private relayUrl(): string {
    const u = FlyConfig.WEB_RELAY_URL
    if (!FlyConfig.WEB_RELAY_KEY) return u
    return u + (u.indexOf("?") >= 0 ? "&" : "?") + "apikey=" + FlyConfig.WEB_RELAY_KEY + "&vsn=1.0.0"
  }

  private relayConnect() {
    try {
      const internet = require("LensStudio:InternetModule") as InternetModule
      this.relay = internet.createWebSocket(this.relayUrl())
    } catch (e) {
      log.w("WEB_RELAY_FAIL " + e)
      this.retryAt = this.webT + this.relayBackoffS
      return
    }
    const sock = this.relay // callbacks of a replaced socket must not touch the live one
    this.relay.onopen = () => {
      if (this.relay !== sock) return
      this.relayUp = true
      this.relayBackoffS = 2
      log.i("WEB_RELAY_OPEN pin=" + this.pin)
      const payload: any = { config: { broadcast: { self: false, ack: false } } }
      if (FlyConfig.WEB_RELAY_KEY) payload.access_token = FlyConfig.WEB_RELAY_KEY
      this.phx(this.topic, "phx_join", payload)
    }
    this.relay.onmessage = (event: WebSocketMessageEvent) => {
      if (this.relay !== sock || typeof event.data !== "string") return
      let m: any
      try {
        m = JSON.parse(event.data)
      } catch (e) {
        return
      }
      this.onRelay(m)
    }
    this.relay.onclose = () => { if (this.relay === sock) this.relayDrop("closed") }
    this.relay.onerror = () => { if (this.relay === sock) this.relayDrop("error") }
  }

  private relayDrop(why: string) {
    if (this.relayUp) log.w("WEB_RELAY_DROP " + why)
    // a socket that never opened is refused at the handshake (Supabase: HTTP 401 without an apikey) and used to
    // die in silence; every refusal is named (ADR 61 follow-up), with the one cause a config can fix
    else log.w("WEB_RELAY_REFUSED " + why + " url=" + FlyConfig.WEB_RELAY_URL.split("?")[0] + (FlyConfig.WEB_RELAY_KEY ? "" : " key=EMPTY (a wss:// relay needs the project's anon key in WEB_RELAY_KEY)") + " retry=" + this.relayBackoffS + "s")
    this.relayUp = false
    this.joined = false
    this.relay = null
    this.setWeb(false)
    this.retryAt = this.webT + this.relayBackoffS
    this.relayBackoffS = Math.min(20, this.relayBackoffS * 2)
  }

  private phx(topic: string, event: string, payload: any) {
    if (!this.relay || !this.relayUp) return
    this.ref++
    try {
      this.relay.send(JSON.stringify({ topic: topic, event: event, payload: payload, ref: String(this.ref) }))
    } catch (e) {
      /* dropped */
    }
  }

  /** a message for the page: one Phoenix broadcast, event "lens" */
  private toPage(obj: any) {
    if (!this.joined) return
    this.phx(this.topic, "broadcast", { type: "broadcast", event: "lens", payload: obj })
    this.webTx++
  }

  private onRelay(m: any) {
    if (m.event === "phx_reply" && m.topic === this.topic && !this.joined) {
      this.joined = m.payload && m.payload.status === "ok"
      log.i("WEB_ROOM " + (this.joined ? "joined " : "refused ") + this.topic)
      return
    }
    if (m.event !== "broadcast" || !m.payload) return
    const ev = m.payload.event
    const p = m.payload.payload
    if (!p) return
    this.webRx++
    if (ev === "hello") {
      this.pageName = "" + (p.name || "page")
      this.pageSeenAt = this.webT
      this.setWeb(true)
      // the page needs our current settings and a fresh start
      // the LIVE state, not the boot config: a page that joined mid-session used to be told
      // `learning: false` and dutifully froze the rule, so the rest of the session measured a
      // frozen brain while the trainer thought it was teaching (ADR 68, found by the LEAF run)
      this.toPage({ t: "welcome", flies: 1, learning: this.learningOn })
      this.toPage({ t: "learning", fly: 0, on: this.learningOn }) // ...and again, so nothing rides on welcome
      this.onPageJoin()
      return
    }
    // ADR 68: the page drives a teaching session. Its own event on the same socket, so the brain
    // stream is untouched and a page that never sends one behaves exactly as before.
    if (ev === "cmd") {
      this.pageSeenAt = this.webT
      this.onCommand(p)
      return
    }
    if (ev !== "brain") return
    this.pageSeenAt = this.webT
    if (!this.webActive) this.setWeb(true)
    if (p.t === "brain") {
      p.engine = "web"
      this.latest[0] = p as BrainMsg
      this.onBrain(p as BrainMsg)
    } else if (p.t === "memory") {
      // ADR 62: the page's core answered a memory command. The canonical copy stays the lens's, so
      // this is what FlyMemory stores while a page is the brain.
      this.onMemory(p)
    } else if (p.t === "ready") {
      // 21.09: the page core measures its OWN resting rates and sends them in `ready` -- the same
      // field BrainLink reads on the socket path. But the socket is off (ADR 86), the page IS the
      // brain, and this branch never captured it, so `baseline` was empty on the glasses and every
      // "above its rest" readout silently fell back to the raw rate. This is the only path a real
      // session takes, so it is the one that had to do it.
      if (p.baseline && typeof p.baseline === "object") {
        this.baseline = p.baseline as { [k: string]: number }
        log.i("LINK_BASELINE cells=" + Object.keys(this.baseline).length + " (page)")
      }
      this.onReady(0)
    }
  }

  private setWeb(on: boolean) {
    if (on === this.webActive) return
    this.webActive = on
    this.muted = on // a Mac core on the socket (editor bench) keeps running, its messages are ignored
    log.i(on ? "WEB_BRAIN_ON page=" + this.pageName : "WEB_BRAIN_OFF")
    // 15.09 Pavlo: "when the web GPU connects the other brain must switch off completely": {"pause":true}
    // stops the stepping thread (zero CPU, state kept warm for the takeover); a core built before the
    // pause command ignores the key and rests at WEB_NATIVE_REST_DUTY instead
    const load = { duty: on ? FlyConfig.WEB_NATIVE_REST_DUTY : 1, pause: on && FlyConfig.WEB_NATIVE_PAUSE }
    // 20.09 (ADR 87): the page is the only brain on the glasses. The two keys keep their
    // names because they are about the brain the MAC runs (server.py --engine native).
    // the Mac core over the socket gets the same order (15.09 Pavlo: "do not run the brain on the
    // computer for nothing"): the server forwards `load` to its native worker, older servers ignore it
    super.send({ t: "load", fly: 0, duty: load.duty, pause: load.pause })
    // 16.09 (ADR 78 follow-up): a page LEAVING used to report a brain anyway. The truth is the
    // page, or the native core, or the socket -- and the fly's existence now hangs on it.
    this.onStatus(on || this.connected)
  }

  tick(dt: number) {
    this.webT += dt
    super.tick(dt)
    if (!FlyConfig.WEB_BRAIN || !FlyConfig.WEB_RELAY_URL) return
    if (!this.relayUp) {
      if (this.retryAt > 0 && this.webT >= this.retryAt) {
        this.retryAt = 0
        this.relayConnect()
      }
      return
    }
    if (this.webT - this.hbAt > HEARTBEAT_S) {
      this.hbAt = this.webT
      this.phx("phoenix", "heartbeat", {})
    }
    if (this.webActive && this.webT - this.pageSeenAt > PAGE_TIMEOUT_S) this.setWeb(false)
  }

  send(obj: any) {
    // the page gets what a brain needs; super.send() reaches the socket link (editor bench only), which
    // keeps its pings and telemetry
    if (this.webActive && obj && (obj.t === "senses" || obj.t === "select" || obj.t === "pulse" || obj.t === "reset" || obj.t === "learning" || obj.t === "memory")) this.toPage(obj)
    super.send(obj)
  }

  /** The room, the flies and the user, for the page's twin of the board (ADR 61). Not a brain
   *  message: it never reaches the core, and a page that ignores it is unaffected. */
  sendScene(obj: any) {
    if (this.webActive) this.toPage(obj)
  }

  /** A page that just said hello has missed every diff the scene feed already sent. */
  onPageJoin: () => void = () => {}

  /** ADR 68: `{t:"cmd", cmd:"train"|"train_stop"|"reset"|"memory_set", ...}` from the page. */
  onCommand: (c: any) => void = () => {}


  webStatus(): string {
    if (!FlyConfig.WEB_BRAIN || !FlyConfig.WEB_RELAY_URL) return ""
    return "web pin=" + this.pin + (this.webActive ? " page=" + this.pageName : this.joined ? " waiting" : this.relayUp ? " joining" : " relay down") + " rx=" + this.webRx + " tx=" + this.webTx
  }
}
