/**
 * FlyScenarios — the editor's closed-loop test bench (ADR 34; 11.09 the user: "auto debug start in the
 * editor, run lots of scenarios, auto-spawned food included, in a closed loop until the result is
 * stable"). Editor only: the intro ends by itself (FlySwarm), then a playlist of seeded situations
 * runs forever. Each ends with one `SCN_END` note in the next telemetry row (brain-server log): the
 * measured behaviour and PASS/FAIL against what a real fly would do.
 * It only SEEDS situations (hunger, food, a looming threat, a lure, a wall ahead); what the flies do
 * about them stays their brains' call.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { FlyBody } from "./FlyBody"
import { FlyConfig } from "./FlyConfig"
import { Source, SourceClass } from "./WorldSources"

const log = new NativeLogger("FlyScenarios")
const FAR = new vec3(0, -100000, 0)

export interface ScenarioHost {
  flies: FlyBody[]
  cam(): Transform
  place(): void // flies back in a row in front of the user
  settle(): void // forget sense histories after a teleport
  food(p: vec3): { src: Source; remove: () => void }
  source(label: string, cls: SourceClass, p: vec3, sizeCm: number, forFly: number): Source
  move(s: Source, p: vec3): void
  drop(s: Source): void
  lure(s: Source | null): void
  ray(from: vec3, to: vec3): { pos: vec3; normal: vec3 } | null
  counters(): { walls: number; mesh: number; floor: number; ceil: number; surf: number; escMealFly: number; escRestFly: number; escAirFly: number; escThreat: number }
  mesh(): boolean // is there a verified world mesh at all (else there is nothing to land on)
  act(i: number): any
}

interface Run {
  t: number
  food: Source[]
  threat: Source | null
  cleanup: (() => void)[]
}

interface Scenario {
  name: string
  dur: number
  energy: number // every fly starts with this much
  setup: (h: ScenarioHost, r: Run) => void
  tick?: (h: ScenarioHost, r: Run, dt: number) => void
}

/** A point ahead of the middle fly (cm ahead, cm below its head). */
function ahead(h: ScenarioHost, cm: number, down: number): vec3 {
  const p = h.flies[Math.floor(h.flies.length / 2)].pose()
  return p.head.add(p.fwd.uniformScale(cm)).add(new vec3(0, -down, 0))
}

/** The first surface under p (floor, table), else p itself. */
function under(h: ScenarioHost, p: vec3): vec3 {
  const hit = h.ray(p.add(new vec3(0, 60, 0)), p.sub(new vec3(0, 250, 0)))
  return hit ? hit.pos.add(new vec3(0, FlyConfig.TREAT_CM * 0.5, 0)) : p
}

function addFood(h: ScenarioHost, r: Run, p: vec3) {
  const f = h.food(p)
  r.food.push(f.src)
  r.cleanup.push(f.remove)
}

/** Flies in a row 80 cm from the nearest wall, facing it (no wall found = left where they are). */
function faceWall(h: ScenarioHost) {
  const c = h.cam().getWorldPosition().add(new vec3(0, -50, 0))
  let best: { pos: vec3; dir: vec3 } | null = null
  let bd = 1e9
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6
    const dir = new vec3(Math.cos(a), 0, Math.sin(a))
    const hit = h.ray(c, c.add(dir.uniformScale(600)))
    if (!hit || Math.abs(hit.normal.y) > 0.5) continue
    const d = hit.pos.distance(c)
    if (d > 130 && d < bd) {
      bd = d
      best = { pos: hit.pos, dir: dir }
    }
  }
  if (!best) return
  const b = best
  const yaw = Math.atan2(-b.dir.z, b.dir.x)
  const side = new vec3(-b.dir.z, 0, b.dir.x)
  const n = h.flies.length
  const homeY = h.cam().getWorldPosition().y
  h.flies.forEach((f, i) => f.respawn(b.pos.sub(b.dir.uniformScale(80)).add(side.uniformScale((i - (n - 1) / 2) * 40)), yaw, homeY))
}

const SCENARIOS: Scenario[] = [
  // no stimulus: does it fly in bouts and rest like a fly, or cruise/hover forever?
  { name: "baseline", dur: 40, energy: 0.8, setup: () => {} },
  // hungry, a treat hanging in the air 55 cm ahead: smell + see -> approach -> land -> feed
  { name: "food_air", dur: 60, energy: 0.2, setup: (h, r) => addFood(h, r, ahead(h, 55, 10)) },
  // hungry, a treat on the floor/table below: food is usually on a surface
  { name: "food_surface", dur: 60, energy: 0.2, setup: (h, r) => addFood(h, r, under(h, ahead(h, 70, 0))) },
  // something rushing at fly 0 every 4 s: the escape suite must fire
  {
    name: "threat", dur: 25, energy: 0.8,
    setup: (h, r) => {
      const s = h.source("scn_threat", "threat", FAR, 20, -1)
      r.threat = s
      r.cleanup.push(() => h.drop(s))
    },
    tick: (h, r) => {
      const f = h.flies[0].pose()
      const k = (r.t % 4) / 1.5
      if (r.threat) h.move(r.threat, f.head.add(f.fwd.uniformScale(k < 1 ? 150 - 130 * k : 150)))
    },
  },
  // full: the same treat must matter much less
  { name: "food_sated", dur: 40, energy: 1.0, setup: (h, r) => addFood(h, r, ahead(h, 55, 10)) },
  // a wall 80 cm ahead: turn along/away (LPLC1 -> DNp03), no escape loop, never through it
  { name: "wall_face", dur: 30, energy: 0.8, setup: (h) => faceWall(h) },
  // the voice-find lure for fly 0, off to its side: reach it, land, reward
  {
    name: "find_lure", dur: 45, energy: 0.8,
    setup: (h, r) => {
      const p = h.flies[0].pose()
      const s = h.source("scn_lure", "lure", p.head.add(p.left.uniformScale(70)).add(p.fwd.uniformScale(50)), 6, 0)
      h.lure(s)
      r.cleanup.push(() => h.lure(null))
    },
  },
]

class Metrics {
  t = 0
  land = 0
  food = 0
  lure = 0
  ttf = -1 // time to the first food/lure landing
  esc = 0
  airT = 0
  landT = 0
  escT = 0
  stuckT = 0
  vSum = 0
  vN = 0
  stop = 0
  fwd = 0
  actN = 0
  minFood = -1
  e0 = 0
  c0 = { walls: 0, mesh: 0, floor: 0, ceil: 0, surf: 0, escMealFly: 0, escRestFly: 0, escAirFly: 0, escThreat: 0 }
  prev: string[] = []
}

export class FlyScenarios {
  private idx = -1
  private runN = 0
  private run: Run | null = null
  private m = new Metrics()
  private notes: string[] = []
  private score: { [name: string]: [number, number] } = {} // passes, runs

  constructor(private h: ScenarioHost) {}

  /** Start the playlist (end of the intro). */
  begin() {
    if (!this.run) this.next()
  }

  status(): string {
    if (!this.run) return "scn=idle"
    const s = SCENARIOS[this.idx]
    return "scn=" + s.name + " " + this.run.t.toFixed(0) + "/" + s.dur + " r" + this.runN
  }

  /** SCN_END lines for the next telemetry row, then cleared. */
  takeNotes(): string {
    const s = this.notes.join(" | ")
    this.notes = []
    return s
  }

  tick(dt: number) {
    const r = this.run
    if (!r) return
    const s = SCENARIOS[this.idx]
    r.t += dt
    if (s.tick) s.tick(this.h, r, dt)
    this.measure(r, dt)
    if (r.t >= s.dur) {
      this.finish(s, r)
      this.next()
    }
  }

  private next() {
    this.idx = (this.idx + 1) % SCENARIOS.length
    if (this.idx === 0) this.runN++
    const s = SCENARIOS[this.idx]
    const h = this.h
    h.place()
    for (const f of h.flies) f.energy = s.energy
    const r: Run = { t: 0, food: [], threat: null, cleanup: [] }
    s.setup(h, r)
    h.settle()
    this.run = r
    const m = new Metrics()
    m.e0 = s.energy
    m.c0 = h.counters()
    m.prev = h.flies.map((f) => f.state)
    this.m = m
    log.i("SCN_START " + s.name + " run=" + this.runN)
  }

  private measure(r: Run, dt: number) {
    const m = this.m
    m.t += dt
    this.h.flies.forEach((f, i) => {
      const st = f.state
      if (st !== m.prev[i]) {
        if (st === "escape") m.esc++
        if (st === "landed") {
          m.land++
          const cls = f.landedOn ? f.landedOn.cls : "surface"
          if (cls === "food") m.food++
          if (cls === "lure") m.lure++
          if ((cls === "food" || cls === "lure") && m.ttf < 0) m.ttf = m.t
        }
        m.prev[i] = st
      }
      if (st === "air") {
        m.airT += dt
        m.vSum += Math.abs(f.speed)
        m.vN++
        if (Math.abs(f.speed) < FlyConfig.SCN_STUCK_CM_S) m.stuckT += dt
      } else if (st === "landed") m.landT += dt
      else m.escT += dt
      const a = this.h.act(i)
      if (a) {
        m.stop += a.stop || 0
        m.fwd += a.forward || 0
        m.actN++
      }
      if (r.food.length) {
        const head = f.pose().head
        for (const s of r.food) {
          const d = head.distance(s.pos)
          if (m.minFood < 0 || d < m.minFood) m.minFood = d
        }
      }
    })
  }

  private finish(s: Scenario, r: Run) {
    for (const c of r.cleanup) c()
    const m = this.m
    const h = this.h
    const c = h.counters()
    const n = h.flies.length
    const tt = Math.max(0.001, m.t * n)
    const pct = (x: number) => Math.round((100 * x) / tt) + "%"
    const eMean = h.flies.reduce((a, f) => a + f.energy, 0) / n
    const walls = c.walls - m.c0.walls
    // what a real fly would do in that situation
    const fails: string[] = []
    const hungry = s.name === "food_air" || s.name === "food_surface"
    if (hungry && m.food < 1) fails.push("no food landing")
    if (s.name === "food_sated" && m.food > 1) fails.push("sated fed x" + m.food)
    // escapes are judged by WHO caused them (12.09): a fly bounced off its meal is the pathology,
    // airborne avoidance between flies is normal up to about one per fly per run
    const eMeal = c.escMealFly - m.c0.escMealFly
    const eRest = c.escRestFly - m.c0.escRestFly
    const eAir = c.escAirFly - m.c0.escAirFly + eRest // a startled rest counts with ordinary avoidance
    if (s.name === "threat" && m.esc < 2) fails.push("escapes " + m.esc)
    if (eMeal > 0) fails.push("bounced off a meal x" + eMeal)
    if (eAir > n) fails.push("fly near-misses " + eAir)
    if (s.name === "find_lure" && m.lure < 1) fails.push("lure missed")
    // without a world mesh there is nothing to land on: that measures the editor session, not the fly
    if (s.name === "baseline" && m.land < 1 && h.mesh()) fails.push("never rests")
    // the box is a backstop 30 cm outside the scanned mesh: the odd clamp means a fly slipped out
    // through an unscanned opening and was caught, which is fine. Hundreds per run was the bug.
    if (walls > n * FlyConfig.SCN_CLAMPS_PER_FLY) fails.push("box clamps " + walls)
    if (m.stuckT / tt > FlyConfig.SCN_STUCK_MAX) fails.push("stuck " + pct(m.stuckT))
    const ok = fails.length === 0
    const sc: [number, number] = this.score[s.name] || [0, 0]
    this.score[s.name] = [sc[0] + (ok ? 1 : 0), sc[1] + 1]
    const board = SCENARIOS.filter((x) => this.score[x.name]).map((x) => x.name + " " + this.score[x.name][0] + "/" + this.score[x.name][1]).join(" ")
    const avg = (x: number) => (m.actN ? (x / m.actN).toFixed(2) : "-")
    const line = "SCN_END r" + this.runN + " " + s.name + " " + s.dur + "s " + (ok ? "PASS" : "FAIL(" + fails.join(", ") + ")") + (h.mesh() ? "" : " [no mesh]") +
      " land=" + m.land + "(food" + m.food + " lure" + m.lure + " surf" + (c.surf - m.c0.surf) + ")" +
      " ttf=" + (m.ttf < 0 ? "-" : m.ttf.toFixed(0)) + " esc=" + m.esc + "(air" + (eAir - eRest) + " rest" + eRest + " meal" + eMeal + " threat" + (c.escThreat - m.c0.escThreat) + ")" +
      " air=" + pct(m.airT) + " landed=" + pct(m.landT) + " escT=" + pct(m.escT) + " stuck=" + pct(m.stuckT) +
      " v=" + (m.vN ? (m.vSum / m.vN).toFixed(0) : "-") + " e=" + Math.round(m.e0 * 100) + "->" + Math.round(eMean * 100) +
      " minFood=" + (m.minFood < 0 ? "-" : m.minFood.toFixed(0)) + " walls=+" + walls +
      " mesh=+" + (c.mesh - m.c0.mesh) + "(floor+" + (c.floor - m.c0.floor) + " ceil+" + (c.ceil - m.c0.ceil) + ")" +
      " stop=" + avg(m.stop) + " fwd=" + avg(m.fwd) + " || " + board
    this.notes.push(line)
    log.i(line)
  }
}
