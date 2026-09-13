/**
 * WorldSources — everything a fly can sense, as markers in world space (ADR 16), and the
 * translation of those markers into the brain's sense channels for one fly.
 *
 * Channels (brain_server/channels.py): object / loom / odor / odor_bad / touch are sided
 * {L, R}; sweet is global. Values 0..1 (1.0 = 20 mV into those cell types).
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

export class WorldSources {
  items: Source[] = []
  private nextId = 1

  constructor(
    private root: SceneObject,
    private mesh: RenderMesh | null,
    private material: Material | null,
    public showMarkers: boolean,
  ) {}

  add(label: string, cls: SourceClass, pos: vec3, sizeCm: number, forFly = -1, withMarker = true): Source {
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
      seen: true,
      marker: null,
      shell: null,
    }
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
    const ant = FlyConfig.ANTENNA_OFFSET_CM
    const antL = pose.head.add(pose.left.uniformScale(ant))
    const antR = pose.head.sub(pose.left.uniformScale(ant))

    for (const s of sources) {
      if (!s.active) {
        delete this.prevDist[s.id]
        delete this.prevPos[s.id]
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
      const attractive = s.cls === "food" || s.cls === "scent" || s.cls === "lure"
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
          }
          if (lat >= 0) loomL = Math.max(loomL, l)
          else loomR = Math.max(loomR, l)
        }
      }

      if (s.strength > 0 && s.sigma > 0) {
        const g = (x: number) => s.strength * Math.exp(-(x * x) / (2 * s.sigma * s.sigma))
        const cL = g(s.pos.sub(antL).length)
        const cR = g(s.pos.sub(antR).length)
        if (s.cls === "bad") {
          badL += cL
          badR += cR
        } else {
          odL += cL * hunger
          odR += cR * hunger
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
    if (landedOn && (landedOn.cls === "lure" || landedOn.cls === "food")) ch.sweet = 1.0
    if (bitter) ch.bitter = 1.0
    return ch
  }
}
