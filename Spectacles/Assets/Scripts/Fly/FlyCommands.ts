/**
 * FlyCommands — voice "find" (ADR 27, implements ADR 14): "Fly, find the apple", "Nova, go to
 * my AirPods". The board's ASK button opens ONE on-device ASR phrase (AsrModule, device only; the
 * editor pretends it heard FIND_EDITOR_PHRASE). Gemini (RSG, same call as FlyNarrator/WorldScanner)
 * maps the phrase to one thing the room scan already knows + the fly the user named (default: the
 * selected fly); a local word-overlap match stands in when Gemini fails.
 * The thing becomes a LURE for that fly only: attractive odour + object drive in
 * WorldSources.compute (hunger gain applies). The brain still steers there, or refuses (ADR 01).
 * Landing on it = the PAM11 reward pulse (FlySwarm.onLanded). One lure at a time: a hand lure,
 * a treat or a new command replaces it; it ends FIND_LAND_HOLD_S after landing or after
 * FIND_TIMEOUT_S. Logs FIND_REQ / FIND_DONE / FIND_TIMEOUT / FIND_CANCEL.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Gemini } from "RemoteServiceGateway.lspkg/HostedExternal/Gemini"
import { GeminiTypes } from "RemoteServiceGateway.lspkg/HostedExternal/GeminiTypes"
import { FlyBoard } from "./FlyBoard"
import { FlyConfig } from "./FlyConfig"
import { Source, WorldSources } from "./WorldSources"

const log = new NativeLogger("FlyCommands")

const NOT_THINGS = ["user_head", "left_hand", "right_hand"]
const STOP = [
  "fly", "flies", "find", "go", "goto", "to", "the", "a", "an", "my", "me", "for", "please", "where", "is", "are",
  "get", "look", "at", "on", "in", "of", "and", "hey", "can", "you", "your", "it", "that", "this", "over", "there",
  "toward", "towards", "land", "show", "search", "some", "one", "number", "mr",
]
const NUM: { [w: string]: number } = { one: 1, two: 2, three: 3, four: 4, five: 5, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5 }

const PROMPT =
  "You route a voice command in an AR lens with giant hologram fruit flies. The user asks a fly to find a thing " +
  "in the room. You get: phrase (speech-to-text, may contain mistakes), known_things (labels a room scan found) and " +
  "flies (number + name). label: the ONE known_things label the user means - synonyms, brands, plurals and " +
  'misheard words count ("my pods" -> "airpods case"); copy it exactly; null if none fits. fly: the number of the ' +
  "fly the user addressed by name or number, else null. " +
  'Answer as JSON {"label": string or null, "fly": number or null}. Never use code fences.'

const SCHEMA: GeminiTypes.Common.Schema = {
  type: "object",
  properties: {
    label: { type: "string", nullable: true },
    fly: { type: "integer", nullable: true },
  },
  required: ["label", "fly"],
}

/** What FlyCommands needs from FlySwarm (the owner of the one lure slot). */
export interface FindHost {
  flyCount(): number
  selected(): number
  flyHead(fly: number): vec3
  lure(): Source | null
  /** THE lure slot: replacing removes the old lure from WorldSources; null clears it. */
  setLure(s: Source | null): void
}

interface Find {
  src: Source // the lure (forFly = fly)
  target: Source // the room thing it sits on (followed while it moves)
  label: string
  fly: number
  age: number
  landedT: number // >= 0 once the fly landed on it
  wasFor: number // the target's own `forFly` before the errand claimed it (restored in end())
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
const stem = (w: string) => (w.length > 3 && w.charAt(w.length - 1) === "s" && w.charAt(w.length - 2) !== "s" ? w.substring(0, w.length - 1) : w)
const quote = (s: string) => '"' + (s.length > 30 ? s.substring(0, 29) + "…" : s).toUpperCase() + '"'

/** Gemini text -> object, tolerant of code fences and stray prose. */
function parseAnswer(t: string): any {
  try {
    const s = t.replace(/```(?:json)?/g, "").trim()
    const a = s.indexOf("{")
    const b = s.lastIndexOf("}")
    if (a < 0 || b <= a) return null
    const o = JSON.parse(s.substring(a, b + 1))
    return o && typeof o === "object" ? o : null
  } catch (e) {
    return null
  }
}

function asrError(c: AsrModule.AsrStatusCode): string {
  if (c === AsrModule.AsrStatusCode.NoInternet) return "no internet"
  if (c === AsrModule.AsrStatusCode.Unauthenticated) return "unauthenticated"
  if (c === AsrModule.AsrStatusCode.InternalError) return "internal error"
  return "code " + c
}

export class FlyCommands {
  private asr: AsrModule | null = null
  private editor = global.deviceInfoSystem.isEditor()
  private enabled = false
  private phase: "idle" | "listening" | "thinking" = "idle"
  private phaseT = 0
  private partial = ""
  private phrase = ""
  private req = 0 // id of the phrase in flight: a newer ASK makes an older answer stale
  private find: Find | null = null
  private bannerT = 0
  private shownLabel = ""
  /** Fires when ASK starts / stops listening — before ASR opens the mic (FlyEars pauses, ADR 29). */
  onListening: ((on: boolean) => void) | null = null

  constructor(private sources: WorldSources, private board: FlyBoard | null, private host: FindHost) {
    try {
      this.asr = require("LensStudio:AsrModule") as AsrModule
    } catch (e) {
      log.w("FIND no AsrModule (" + e + ")")
    }
    if (board) board.onAsk = () => this.ask()
  }

  /** ASK shows once the flies are out (after the room scan). */
  setEnabled(on: boolean) {
    this.enabled = on
    if (this.board) this.board.showAskButton(on)
    this.shownLabel = ""
    this.updateLabel()
  }

  /** Telemetry: the thing a fly is sent to, or none. */
  findLabel(): string {
    return this.find ? this.find.label.replace(/\s+/g, "_") : "none"
  }

  /** FlySwarm.onLanded: a fly touched down on something. */
  landed(fly: number, s: Source) {
    const f = this.find
    if (!f || s !== f.src || f.landedT >= 0) return
    f.landedT = 0
    log.i("FIND_DONE fly=" + fly + " '" + f.label + "' after " + f.age.toFixed(0) + "s -> reward pulse")
  }

  /** The ASK button: listen for one phrase (pressed again while listening = cancel). */
  ask() {
    if (!this.enabled) return
    if (this.phase === "listening") {
      this.stopAsr()
      this.setPhase("idle")
      this.banner("VOICE  //  CANCELLED")
      return
    }
    this.req++
    this.partial = ""
    if (!this.editor && !this.asr) {
      this.banner("VOICE UNAVAILABLE  //  NO ASR MODULE")
      return
    }
    this.setPhase("listening")
    this.banner("LISTENING…  SAY: FLY, FIND THE APPLE", 0)
    if (this.editor) return // ASR is device-only: tick hands over FIND_EDITOR_PHRASE
    const id = this.req
    const o = AsrModule.AsrTranscriptionOptions.create()
    o.mode = AsrModule.AsrMode.HighAccuracy
    o.silenceUntilTerminationMs = FlyConfig.FIND_SILENCE_MS
    o.onTranscriptionUpdateEvent.add((e: AsrModule.TranscriptionUpdateEvent) => {
      if (id !== this.req || this.phase !== "listening") return
      const t = (e.text || "").trim()
      if (!e.isFinal) {
        this.partial = t
        if (t) this.banner("LISTENING…  " + quote(t), 0)
        return
      }
      this.stopAsr()
      this.heard(t || this.partial)
    })
    o.onTranscriptionErrorEvent.add((code: AsrModule.AsrStatusCode) => {
      if (id !== this.req || code === AsrModule.AsrStatusCode.Success) return
      log.w("FIND_ASR_ERROR " + asrError(code))
      this.stopAsr()
      this.setPhase("idle")
      this.banner("VOICE ERROR  //  " + asrError(code).toUpperCase())
    })
    try {
      this.asr!.startTranscribing(o)
    } catch (e) {
      log.w("FIND_ASR_ERROR start: " + e)
      this.setPhase("idle")
      this.banner("VOICE UNAVAILABLE")
    }
  }

  tick(dt: number) {
    this.phaseT += dt
    if (this.phase === "listening") {
      if (this.editor && this.phaseT >= 1) this.heard(FlyConfig.FIND_EDITOR_PHRASE)
      else if (this.phaseT >= FlyConfig.FIND_LISTEN_S) {
        this.stopAsr()
        this.heard(this.partial)
      }
    } else if (this.phase === "thinking" && this.phaseT >= FlyConfig.FIND_GEMINI_TIMEOUT_S) {
      this.resolve(this.phrase, null, "local (gemini timeout)")
    }

    const f = this.find
    if (f) {
      if (this.host.lure() !== f.src) {
        // a hand lure, a treat or a debug lure took the one slot (FlySwarm already removed ours)
        this.find = null
        log.i("FIND_CANCEL fly=" + f.fly + " '" + f.label + "' replaced by another lure")
      } else {
        f.age += dt
        // follow the thing while the scan (or a hand) moves it; if the scan forgets it, stay put
        if (f.src.pos !== f.target.pos && this.sources.items.indexOf(f.target) >= 0) this.sources.move(f.src, f.target.pos)
        if (f.landedT >= 0) {
          f.landedT += dt
          if (f.landedT >= FlyConfig.FIND_LAND_HOLD_S) this.end(null)
        } else if (f.age >= FlyConfig.FIND_TIMEOUT_S) {
          this.end("FIND_TIMEOUT fly=" + f.fly + " '" + f.label + "' after " + FlyConfig.FIND_TIMEOUT_S + "s")
        }
      }
    }
    if (this.bannerT > 0) {
      this.bannerT -= dt
      if (this.bannerT <= 0 && this.board) this.board.setBanner(null)
    }
    this.updateLabel()
  }

  // ------------------------------------------------------------------------------ phrase -> find

  private heard(phrase: string) {
    this.phrase = (phrase || "").trim()
    if (!this.phrase) {
      this.setPhase("idle")
      this.banner("DIDN'T CATCH THAT  //  PRESS ASK AGAIN")
      return
    }
    const labels: string[] = []
    for (const s of this.things()) if (labels.indexOf(s.label) < 0) labels.push(s.label)
    if (!labels.length) {
      this.resolve(this.phrase, { label: null, fly: null }, "no things mapped yet")
      return
    }
    this.setPhase("thinking")
    this.banner("HEARD " + quote(this.phrase) + "  //  THINKING…", 0)
    const id = this.req
    const phraseNow = this.phrase
    const flies: any[] = []
    for (let i = 0; i < this.host.flyCount(); i++) flies.push({ number: i + 1, name: FlyConfig.FLY_NAMES[i % FlyConfig.FLY_NAMES.length] })
    const req: GeminiTypes.Models.GenerateContentRequest = {
      model: FlyConfig.GEMINI_MODEL,
      type: "generateContent",
      body: {
        contents: [{ role: "user", parts: [{ text: JSON.stringify({ phrase: phraseNow, known_things: labels, flies: flies }) }] }],
        systemInstruction: { parts: [{ text: PROMPT }] },
        // no "thinking" pass (2.5-flash spends the token budget on it otherwise, FlyNarrator 11.09)
        generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: "application/json", response_schema: SCHEMA, thinkingConfig: { thinkingBudget: 0 } } as any,
      },
    }
    Gemini.models(req)
      .then((r) => {
        if (id !== this.req || this.phase !== "thinking") return
        const cand: any = r && r.candidates ? r.candidates[0] : null
        const parts: any[] = cand && cand.content && cand.content.parts ? cand.content.parts : []
        const a = parseAnswer(parts.map((p: any) => p.text || "").join(""))
        if (!a) this.resolve(phraseNow, null, "local (no answer, finish=" + (cand ? cand.finishReason : "none") + ")")
        else this.resolve(phraseNow, { label: a.label == null || a.label === "" ? null : String(a.label), fly: a.fly }, "gemini")
      })
      .catch((e) => {
        if (id === this.req && this.phase === "thinking") this.resolve(phraseNow, null, "local (" + e + ")")
      })
  }

  /** Gemini's answer (null = it failed) -> the thing + the fly -> the lure. */
  private resolve(phrase: string, a: { label: string | null; fly: any } | null, via: string) {
    this.setPhase("idle")
    const things = this.things()
    let fly = a ? this.flyFrom(a.fly) : -1
    if (fly < 0) fly = this.flyInPhrase(phrase)
    if (fly < 0) fly = this.host.selected()
    let label: string | null = null
    if (a && a.label) {
      const want = a.label.toLowerCase()
      for (const s of things) if (s.label.toLowerCase() === want) label = s.label
      if (!label) via = "local (gemini said '" + a.label + "')"
    }
    if (!label && (!a || a.label)) label = this.localMatch(phrase, things, fly)
    const target = label ? this.nearest(things.filter((s) => s.label === label), fly) : null
    log.i('FIND_REQ "' + phrase + '" -> ' + (target ? target.label : "none") + " fly=" + fly + " via=" + via)
    if (!target) {
      this.banner("HEARD " + quote(phrase) + "  //  NOT IN THE ROOM MAP")
      return
    }
    this.start(target, fly)
    this.banner("HEARD " + quote(phrase) + "  ->  " + target.label.toUpperCase() + "  //  FLY " + (fly + 1))
  }

  private start(target: Source, fly: number) {
    if (this.find) this.end("FIND_CANCEL fly=" + this.find.fly + " '" + this.find.label + "' replaced by a new command")
    const size = Math.max(4, Math.min(FlyConfig.FIND_LURE_MAX_CM, target.sizeCm))
    const src = this.sources.add(target.label, "lure", target.pos, size, fly, false)
    this.host.setLure(src) // replaces a hand lure too: one lure at a time
    // 12.09 the user: "all the flies fly to my target". The lure was always private to the asked fly,
    // but the THING itself is a scanned room source that everybody may smell — so a hungry fly that
    // was never asked still heads for it. While the errand runs, the thing belongs to that one fly;
    // `end()` gives it back to the room. Engineered and disclosed: a smell is public in reality.
    const wasFor = target.forFly
    target.forFly = fly
    this.find = { src: src, target: target, label: target.label, fly: fly, age: 0, landedT: -1, wasFor: wasFor }
  }

  private end(line: string | null) {
    const f = this.find
    if (!f) return
    this.find = null
    if (f.target && f.wasFor !== undefined) f.target.forFly = f.wasFor // the thing is the room's again
    if (line) log.i(line)
    if (this.host.lure() === f.src) this.host.setLure(null)
    else this.sources.remove(f.src)
  }

  /** Room things a fly can be sent to: everything the scan (or a hand) placed, minus the user, lures
   *  and the other flies. */
  private things(): Source[] {
    return this.sources.items.filter((s) => s.active && s.cls !== "threat" && s.cls !== "lure" && (s.cls as string) !== "fly" &&
      NOT_THINGS.indexOf(s.label) < 0 && s.pos.y > -50000)
  }

  private nearest(list: Source[], fly: number): Source | null {
    const head = this.host.flyHead(fly)
    let best: Source | null = null
    for (const s of list) if (!best || s.pos.distance(head) < best.pos.distance(head)) best = s
    return best
  }

  /** Gemini's fly field: a 1-based number, or a name / "fly 2" string. */
  private flyFrom(v: any): number {
    if (v === null || v === undefined || v === "") return -1
    const n = typeof v === "number" ? v : parseInt(String(v), 10)
    if (!isNaN(n)) return n >= 1 && n <= this.host.flyCount() ? n - 1 : -1
    return this.flyInPhrase(String(v))
  }

  /** A fly named in the words themselves: its name ("nova") or "fly two". */
  private flyInPhrase(p: string): number {
    const s = " " + norm(p) + " "
    const flat = s.replace(/ /g, "")
    for (let i = 0; i < this.host.flyCount(); i++) {
      const name = norm(FlyConfig.FLY_NAMES[i % FlyConfig.FLY_NAMES.length])
      if (flat.indexOf(name.replace(/ /g, "")) >= 0) return i
      for (const w of name.split(" ")) if (w.length >= 5 && s.indexOf(" " + w + " ") >= 0) return i
    }
    const m = s.match(/ fly (?:number )?(one|two|three|four|five|1|2|3|4|5) /)
    const n = m ? NUM[m[1]] : 0
    return n >= 1 && n <= this.host.flyCount() ? n - 1 : -1
  }

  /** Fallback without Gemini: share of the label's words heard in the phrase (plural-tolerant). */
  private localMatch(phrase: string, things: Source[], fly: number): string | null {
    const skip = STOP.slice()
    for (const n of FlyConfig.FLY_NAMES) for (const w of norm(n).split(" ")) skip.push(w)
    const heard = norm(phrase).split(" ").filter((w) => w && skip.indexOf(w) < 0).map(stem)
    const flat = heard.join("")
    const head = this.host.flyHead(fly)
    let best: Source | null = null
    let bestScore = 0
    for (const s of things) {
      const words = norm(s.label).split(" ").filter((w) => w.length > 0)
      if (!words.length) continue
      let hit = 0
      for (const w of words) if (heard.indexOf(stem(w)) >= 0) hit++
      let score = hit / words.length
      const joined = words.map(stem).join("")
      if (score < 1 && joined.length >= 5 && flat.indexOf(joined) >= 0) score = 1 // "air pods" heard for "airpods"
      if (score > bestScore || (score > 0 && score === bestScore && best && s.pos.distance(head) < best.pos.distance(head))) {
        best = s
        bestScore = score
      }
    }
    return best ? best.label : null
  }

  // ------------------------------------------------------------------------------ board + ASR

  private setPhase(p: "idle" | "listening" | "thinking") {
    const was = this.phase === "listening"
    this.phase = p
    this.phaseT = 0
    if (this.onListening && was !== (p === "listening")) this.onListening(p === "listening")
  }

  private stopAsr() {
    if (this.editor || !this.asr) return
    try {
      this.asr.stopTranscribing().catch(() => {})
    } catch (e) {
      /* no session running */
    }
  }

  /** Board status line; hold 0 = stays until the next banner. */
  private banner(s: string, hold = FlyConfig.FIND_BANNER_S) {
    if (!this.board) return
    this.board.setBanner(s)
    this.bannerT = hold
  }

  private updateLabel() {
    if (!this.board || !this.enabled) return
    const s = this.phase === "listening" ? "LISTENING…" : this.phase === "thinking" ? "THINKING…"
      : this.find ? "FINDING " + this.find.label.toUpperCase().substring(0, 11) : "ASK A FLY  >"
    if (s === this.shownLabel) return
    this.shownLabel = s
    this.board.setAskLabel(s, this.phase !== "idle")
  }
}
