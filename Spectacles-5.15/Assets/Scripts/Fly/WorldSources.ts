/**
 * WorldSources — everything a fly can sense, as markers in world space (ADR 16), and the
 * translation of those markers into the brain's sense channels for one fly.
 *
 * Channels (brain_server/channels.py): object / loom / odor / odor_bad / touch / wind are sided
 * {L, R}; sweet / hot / cold / dry / moist are global. Values 0..1 (1.0 = 20 mV into those cell
 * types). The climate baseline (FlyWeather, ADR 95) is added by FlySwarm; this file computes only
 * what is LOCAL to a thing: its smell and, since ADR 96, its warm / cold / humid / wind fields.
 */
import { FlyConfig } from "./FlyConfig"

// food = eats / lands on; scent = attractive smell only (plants, bins, litter box); bad = repellent
// smell; threat = looming/touch; object = neutral visual thing (phone, keys, AirPods — the room
// inventory voice commands will point at, ADR 14)
export type SourceClass = "food" | "lure" | "threat" | "bad" | "scent" | "object" | "fly"

export interface Source {
  id: string
  label: string
  cls: SourceClass
  pos: vec3
  sizeCm: number
  sigma: number // odour spread (1 sigma, cm)
  strength: number
  forFly: number // -1 = every fly, else only that fly smells/sees it
  owner?: number // a fly's own body (cls "fly"): every OTHER fly sees it, never itself
  // Inactive = not sensed at all (untracked hand). Reactivation resets the loom history, so a
  // hand entering view is not read as something approaching from infinity.
  active: boolean
  // Which of the four odour glomeruli this thing smells of (ADR 65), -1 = no identity, just the
  // generic attractive smell. Hashed from the label, so the same mug always smells the same; the
  // trainer may override it to keep a CS+ and its control apart.
  odourId: number
  /** ADR 70: how strongly this thing is being PRESENTED right now — 1 while a hand holds it, then
   *  fading over PRESENT_FADE_S because a smell lingers. A presented thing smells like a lure and
   *  counts as an attractive object however it is classed. ONLY a hand (FlySwarm.presentTick) or
   *  a test (CyberFlyTestKit.presentCue) writes it: pointing at a thing is an inspector and never
   *  changes its smell (ADR 101). */
  present: number
  /** ADR 102: the wearer's own body (head, hands). It smells of ONE glomerulus, `labelOdour("human")`,
   *  identity-only like a plain object, so the mushroom body has a cue to attach a threat to. */
  human?: boolean
  /** ADR 93: how much this thing smells on its own, 0..1 (Gemini: food and plants 1, wood 0.6,
   *  plastic 0.3, glass 0). Scales a plain `object`'s strength and reach; class values otherwise. */
  smell: number
  /** ADR 96: the thing's physical fields as Gemini read them, 0..1 each -- a lamp is warm, a window
   *  cold and windy, a kettle humid. Local gaussians around the thing, on top of the room's climate. */
  warm: number
  cold: number
  humid: number
  wind: number
  field: boolean // any of the four above > 0 (so the sense loop can skip the rest)
  // false = not a visual target (the user's head: looming when it rushes in, but flies must
  // not orient to it and fly into the user's face — 11.09 feedback)
  seen: boolean
  marker: SceneObject | null
  shell: SceneObject | null
}

export interface FlyPose {
  head: vec3
  body: vec3
  fwd: vec3
  left: vec3
}

const CLASS_COLOR: { [cls: string]: vec4 } = {
  food: new vec4(0.3, 1.0, 0.3, 0.9),
  lure: new vec4(1.0, 0.8, 0.2, 0.9),
  threat: new vec4(1.0, 0.25, 0.25, 0.6),
  bad: new vec4(0.7, 0.3, 1.0, 0.9),
  scent: new vec4(1.0, 0.55, 0.85, 0.9),
  object: new vec4(0.8, 0.92, 1.0, 0.7),
  fly: new vec4(0.6, 1.0, 0.9, 0.7),
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/** What Gemini says about a thing besides its class (ADR 93/96); every field optional, 0..1. */
export interface SourceProps {
  smell?: number
  warm?: number
  cold?: number
  humid?: number
  wind?: number
}

/** A stable smell for a label: the same thing is the same odour in every session (ADR 65). */
export function labelOdour(label: string): number {
  let h = 2166136261
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619)
  return Math.abs(h) % FlyConfig.ODOUR_IDS.length
}

export class WorldSources {
  items: Source[] = []
  private nextId = 1

  constructor(
    private root: SceneObject,
    private mesh: RenderMesh | null,
    private material: Material | null,
    public showMarkers: boolean,
  ) {}

  add(label: string, cls: SourceClass, pos: vec3, sizeCm: number, forFly = -1, withMarker = true, props?: SourceProps): Source {
    const odor = FlyConfig.ODOR[cls]
    const s: Source = {
      id: cls + "_" + this.nextId++,
      label: label,
      cls: cls,
      pos: pos,
      sizeCm: sizeCm,
      sigma: odor.sigma,
      strength: odor.strength,
      forFly: forFly,
      active: true,
      odourId: cls !== "bad" ? labelOdour(label) : -1, // every thing has a smell it COULD have (ADR 70)
      present: 0,
      smell: cls === "object" ? FlyConfig.OBJECT_SMELL_DEFAULT : 1,
      warm: 0,
      cold: 0,
      humid: 0,
      wind: 0,
      field: false,
      seen: true,
      marker: null,
      shell: null,
    }
    this.setProps(s, props || {}) // a plain thing's smell is scaled from its class base even with no answer
    if (withMarker && this.showMarkers && this.mesh && this.material) {
      s.marker = this.makeSphere(s.id, CLASS_COLOR[cls], sizeCm)
      if (s.sigma > 0) {
        const c = CLASS_COLOR[cls]
        s.shell = this.makeSphere(s.id + "_shell", new vec4(c.x, c.y, c.z, 0.12), 2 * s.sigma)
      }
    }
    this.items.push(s)
    this.place(s)
    return s
  }

  move(s: Source, pos: vec3) {
    s.pos = pos
    this.place(s)
  }

  /** ADR 93/96: take what Gemini said about a thing. A missing field keeps its value; a plain
   *  `object`'s strength and reach are its class base scaled by `smell` (0.6 x smell, 35..70 cm).
   *  Food / scent / bad keep their calibrated class values (ADR 16/26) whatever `smell` says. */
  setProps(s: Source, p: SourceProps) {
    const c01 = (x: number | undefined, keep: number) => (typeof x === "number" && isFinite(x) ? clamp01(x) : keep)
    s.smell = c01(p.smell, s.smell)
    s.warm = c01(p.warm, s.warm)
    s.cold = c01(p.cold, s.cold)
    s.humid = c01(p.humid, s.humid)
    s.wind = c01(p.wind, s.wind)
    s.field = s.warm > 0 || s.cold > 0 || s.humid > 0 || s.wind > 0
    if (s.cls === "object") {
      const base = FlyConfig.ODOR.object
      s.strength = base.strength * s.smell
      // 21.09 Pavlo: 0.5+0.5*smell gave every object 35..70 cm and the rings all looked alike; a
      // plastic box now reaches ~20 cm and a fruit bowl the whole table (0.15..1 x ODOR.object.sigma)
      s.sigma = base.sigma * (0.15 + 0.85 * s.smell)
    }
  }

  remove(s: Source) {
    this.items = this.items.filter((x) => x !== s)
    if (s.marker) s.marker.destroy()
    if (s.shell) s.shell.destroy()
  }

  private place(s: Source) {
    if (s.marker) s.marker.getTransform().setWorldPosition(s.pos)
    if (s.shell) s.shell.getTransform().setWorldPosition(s.pos)
  }

  private makeSphere(name: string, color: vec4, diameterCm: number): SceneObject {
    const so = global.scene.createSceneObject(name)
    so.setParent(this.root)
    const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    rmv.mesh = this.mesh!
    const mat = this.material!.clone()
    try {
      mat.mainPass.baseColor = color
    } catch (e) {
      /* material without baseColor: keep its own colour */
    }
    rmv.mainMaterial = mat
    so.getTransform().setWorldScale(vec3.one().uniformScale(diameterCm / FlyConfig.MARKER_MESH_DIAMETER_CM))
    return so
  }
}

/** Per-fly sense translator. Keeps the previous distance to each source for looming. */
export class FlySenses {
  private prevDist: { [id: string]: number } = {}
  private prevPos: { [id: string]: vec3 } = {} // source positions at the last tick (its OWN motion)
  odorLevel = 0 // for antenna twitch
  loomBy = "" // telemetry: the source that loomed most at the last tick (why an escape fired)
  loomMax = 0
  recentBy = "" // ...and over the last ~1 s: the brain answers a loom 0.3-0.5 s later
  recent = 0
  recentD = 0 // distance (cm) and closing speed (cm/s) of that loom
  recentV = 0
  private loomD = 0
  private loomV = 0
  // ADR 96: the LOCAL physical fields at this fly after the last tick -- the sum over things of
  // Gemini's warm / cold / humid / wind, each a gaussian with the thing's own reach. Hot, cold and
  // moist are read at the head (the brain's cells are global); wind by antenna, so it has a side.
  // FlySwarm adds the room's climate baseline (FlyWeather) and clamps at injection.
  fieldHot = 0
  fieldCold = 0
  fieldMoist = 0
  fieldWindL = 0
  fieldWindR = 0
  // ADR 102: what the lesson needs to know about the last tick. `humanSmell` = the wearer's own
  // odour at this fly's nearer antenna (0..1, telemetry and the lesson's log line); `loomHuman` =
  // the thing that loomed most was the wearer (head or a hand); `touchHuman` = a hand is on the fly.
  humanSmell = 0
  loomHuman = false
  touchHuman = false
  // reused, never reallocated: this runs per fly at SENSE_HZ
  private idL: number[] = FlyConfig.ODOUR_IDS.map(() => 0)
  private idR: number[] = FlyConfig.ODOUR_IDS.map(() => 0)

  /** Forget the distance history: a teleport (bench reset, respawn) is not something rushing in. */
  reset() {
    this.prevDist = {}
    this.prevPos = {}
    this.recent = 0
  }

  /** los = line of sight against the world mesh; flies behind a wall are neither seen nor loom
   *  (12.09 bench: a fly resting on a wall was startled by one flying 3 cm away on its other side). */
  compute(fly: number, pose: FlyPose, sources: Source[], dt: number, landedOn: Source | null, energy = 1, los?: (a: vec3, b: vec3) => boolean): any {
    // Hunger (11.09 "hungry but never eats"): an empty fly weighs food cues more (starved flies'
    // sweet/odour sensitivity rises). Stand-in for the internal state, engineered + disclosed (ADR).
    const hunger = 1 + FlyConfig.HUNGER_GAIN * (1 - Math.max(0, Math.min(1, energy)))
    let objL = 0, objR = 0, loomL = 0, loomR = 0
    this.loomBy = ""
    this.loomMax = 0
    let odL = 0, odR = 0, badL = 0, badR = 0, touchL = 0, touchR = 0, bitter = 0
    this.fieldHot = 0
    this.fieldCold = 0
    this.fieldMoist = 0
    this.fieldWindL = 0
    this.fieldWindR = 0
    this.humanSmell = 0
    this.loomHuman = false
    this.touchHuman = false
    const idL = this.idL
    const idR = this.idR
    for (let k = 0; k < idL.length; k++) {
      idL[k] = 0
      idR[k] = 0
    }
    const ant = FlyConfig.ANTENNA_OFFSET_CM
    const antL = pose.head.add(pose.left.uniformScale(ant))
    const antR = pose.head.sub(pose.left.uniformScale(ant))

    // 16.09 perf: `ODOR["lure"]` was read inside the loop, once per source per tick, for a table
    // that never changes. One read per tick instead.
    const lure = FlyConfig.ODOR["lure"]
    for (const s of sources) {
      if (!s.active) {
        // `delete` on a key that is not there still forces the object out of its hidden class, and
        // this ran for EVERY inactive source on EVERY sense tick (an untracked hand = both keys
        // absent, twice a tick, forever). Delete only what is actually there.
        if (this.prevDist[s.id] !== undefined) delete this.prevDist[s.id]
        if (this.prevPos[s.id] !== undefined) delete this.prevPos[s.id]
        continue
      }
      if (s.forFly >= 0 && s.forFly !== fly) continue
      if (s.owner === fly) continue // a fly does not see itself
      const v = s.pos.sub(pose.head)
      const d = Math.max(v.length, 1)
      const dir = v.uniformScale(1 / d)
      const lat = dir.dot(pose.left) // + = on the fly's left
      const fr = dir.dot(pose.fwd)
      const behind = fr < -0.85 // flies see ~330 deg; skip the blind cone behind

      // Object detectors (LC12/LC10) = small ATTRACTIVE things only: food, flowers/scent, the lure.
      // With Gemini's whole inventory (chairs, shelves) every source saturated both sides to 1 and
      // the brain got no direction to the food (11.09 device: object L=1 R=1). Furniture is
      // background — the fly gets it through optic flow and its eye rays.
      // other flies too (11.09 "flies should know about each other"): a moving fly is exactly what
      // LC10a/LC11 small-object detectors respond to; its own gain, no hunger boost
      const shown = s.present > 0.01 // ADR 70: held in a hand (or still lingering)
      const attractive = s.cls === "food" || s.cls === "scent" || s.cls === "lure" || shown
      const seenNow = s.cls !== "fly" || !los || los(pose.head, s.pos)
      if (!behind && s.seen && seenNow && (attractive || s.cls === "fly")) {
        const raw = (s.sizeCm / d) * FlyConfig.OBJECT_GAIN * (s.cls === "fly" ? FlyConfig.FLY_SEEN_GAIN : hunger)
        const o = clamp01(raw)
        if (Math.abs(lat) < 0.12 && fr > 0) {
          // straight ahead: both eyes at 0.6 — scaled BEFORE the clamp so hunger still reaches a
          // centred target (11.09 audit: it was capped at 0.6 whatever the hunger)
          // capped: at 1.5 the stop neuron DNpe007 builds up after ~3 s (audit sim)
          objL = Math.max(objL, Math.min(FlyConfig.OBJECT_CENTRE_MAX, 0.6 * raw))
          objR = Math.max(objR, Math.min(FlyConfig.OBJECT_CENTRE_MAX, 0.6 * raw))
        } else if (lat > 0) objL = Math.max(objL, o)
        else objR = Math.max(objR, o)
      }

      const prev = this.prevDist[s.id]
      this.prevDist[s.id] = d
      const prevP = this.prevPos[s.id]
      this.prevPos[s.id] = s.pos
      // Only things that MOVE loom (threat: hands, the head, a debug threat; other flies). Food, flowers,
      // the lure, furniture only grow because the fly flies at them, and a fly does not flee what it
      // approaches itself (11.09 bench: 23 escapes per food run, from the treat it was landing on).
      // Static surfaces still loom through the eye rays (-> LPLC1).
      const moves = s.cls === "threat" || s.cls === "fly"
      if (prev !== undefined && prevP && dt > 0 && !behind && moves && seenNow) {
        // LC4/LPLC2 -> escape answers something coming AT the fly: only the source's own motion toward
        // it counts. The fly's own flight toward a thing expands it too, but that is the landing /
        // avoidance system's (eye rays -> LPLC1), not a reason to flee (11.09 bench: flies converging on
        // one treat escaped from each other 12-21 times per run). Modelling choice, ADR 33.
        const closing = -s.pos.sub(prevP).dot(dir) / dt // cm/s toward the fly
        const expansion = (s.sizeCm * closing) / (d * d) // rad/s
        if (expansion > FlyConfig.LOOM_MIN) {
          // another fly closing in looms less than a threat (11.09 device: escapes jumped once
          // the flies saw each other) — they notice, they don't bolt from every neighbour
          const lg = s.cls === "fly" ? FlyConfig.FLY_LOOM_GAIN : 1
          const l = clamp01((expansion - FlyConfig.LOOM_MIN) * FlyConfig.LOOM_GAIN * lg)
          if (l > this.loomMax) {
            this.loomMax = l
            this.loomBy = s.cls === "fly" ? "fly" + (s.owner !== undefined ? s.owner : "") : s.label
            this.loomD = d
            this.loomV = closing
            this.loomHuman = !!s.human
          }
          if (lat >= 0) loomL = Math.max(loomL, l)
          else loomR = Math.max(loomR, l)
        }
      }

      // a presented thing borrows the lure's own smell, scaled by how strongly it is being shown
      const str = shown ? Math.max(s.strength, lure.strength * s.present) : s.strength
      const sig = shown ? Math.max(s.sigma, lure.sigma) : s.sigma
      if (str > 0 && sig > 0) {
        // was a closure allocated per source per tick, called exactly twice; inlined, same numbers
        const k2 = 2 * sig * sig // the divisor the closure rebuilt on both of its two calls
        const dL = s.pos.sub(antL).length
        const dR = s.pos.sub(antR).length
        const cL = str * Math.exp(-(dL * dL) / k2)
        const cR = str * Math.exp(-(dR * dR) / k2)
        if (s.cls === "bad") {
          badL += cL
          badR += cR
        } else if ((s.cls === "object" || s.cls === "threat") && !shown) {
          // ADR 93: a plain thing's own smell is IDENTITY only -- its glomerulus at its own strength,
          // no hunger gain, nothing into the appetitive `odor` sum or `odorLevel` (ADR 26 stands:
          // furniture is not food). What it gives the mushroom body is a cue it can learn about.
          // ADR 102: the wearer (class threat, `human`) smells the same way -- one glomerulus, no
          // appetite in it -- so a scare near the wearer has a smell to be attached to.
          if (FlyConfig.ODOUR_ID && s.odourId >= 0) {
            idL[s.odourId] += cL
            idR[s.odourId] += cR
          }
          if (s.human) this.humanSmell = Math.max(this.humanSmell, cL, cR)
        } else {
          odL += cL * hunger
          odR += cR * hunger
          // ...and, on top of the generic smell, this thing's OWN glomerulus (ADR 65)
          if (FlyConfig.ODOUR_ID && s.odourId >= 0) {
            idL[s.odourId] += cL * hunger * FlyConfig.ODOUR_ID_GAIN
            idR[s.odourId] += cR * hunger * FlyConfig.ODOUR_ID_GAIN
          }
        }
      }

      // ADR 96: the thing's physical fields. Reach = its smell reach, but at least FIELD_SIGMA_CM (a
      // radiator heats further than it smells). Hot / cold / moist at the head; wind per antenna.
      if (s.field) {
        const sigF = Math.max(s.sigma, FlyConfig.FIELD_SIGMA_CM)
        const kF = 2 * sigF * sigF
        const g = FlyConfig.FIELD_GAIN * Math.exp(-(d * d) / kF)
        this.fieldHot += s.warm * g
        this.fieldCold += s.cold * g
        this.fieldMoist += s.humid * g
        if (s.wind > 0) {
          const wL = s.pos.sub(antL).length
          const wR = s.pos.sub(antR).length
          this.fieldWindL += s.wind * FlyConfig.FIELD_GAIN * Math.exp(-(wL * wL) / kF)
          this.fieldWindR += s.wind * FlyConfig.FIELD_GAIN * Math.exp(-(wR * wR) / kF)
        }
      }

      // touch: hands only (the head is `seen=false`) — a fly drifting near the user's face was
      // read as touched -> stop + back, and hovered there (11.09)
      // (the hand a fly is sitting on is its ground, not something touching its back)
      if (s.cls === "threat" && s.seen && s !== landedOn && s.pos.sub(pose.body).length < FlyConfig.TOUCH_CM + 0.5 * s.sizeCm) {
        // both sides (11.09 input audit: right-side touch turned the fly TOWARD the hand; bilateral
        // = a flinch, thrust drops)
        touchL = 1
        touchR = 1
        if (s.human) this.touchHuman = true
      }
      // legs/proboscis on something repellent (soap, bleach) = bitter taste -> DNpe007 stop (+121 Hz)
      if (s.cls === "bad" && s.pos.sub(pose.body).length < FlyConfig.TOUCH_CM + 0.5 * s.sizeCm) bitter = 1
    }

    if (this.loomMax > this.recent) {
      this.recent = this.loomMax
      this.recentBy = this.loomBy
      this.recentD = this.loomD
      this.recentV = this.loomV
    } else this.recent *= Math.exp(-dt / 1.0)
    this.odorLevel = clamp01(Math.max(odL, odR))
    const ch: any = {
      object: { L: objL, R: objR },
      loom: { L: loomL, R: loomR },
      odor: { L: clamp01(odL), R: clamp01(odR) },
      odor_bad: { L: clamp01(badL), R: clamp01(badR) },
      touch: { L: touchL, R: touchR },
    }
    // one key per glomerulus that actually has something in it: an omitted channel is a zero, and
    // the sense dict is replaced wholesale every tick, so nothing lingers
    if (FlyConfig.ODOUR_ID) {
      for (let k = 0; k < idL.length; k++) {
        if (idL[k] > 0.001 || idR[k] > 0.001) ch[FlyConfig.ODOUR_IDS[k]] = { L: clamp01(idL[k]), R: clamp01(idR[k]) }
      }
    }
    if (landedOn && (landedOn.cls === "lure" || landedOn.cls === "food")) ch.sweet = 1.0
    if (bitter) ch.bitter = 1.0
    return ch
  }
}
