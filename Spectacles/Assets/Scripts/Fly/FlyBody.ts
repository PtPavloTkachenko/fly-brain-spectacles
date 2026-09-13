/**
 * FlyBody — one giant fly: locomotion from the brain's decoded actions + bone animation.
 *
 * The brain decides WHAT (steer, escape side, stop, back, feed); this class only executes it.
 * Engineered, disclosed parts: forward speed scale, altitude (no altitude readout exists in
 * the brain), the arena leash, and landing when the head reaches a lure.
 *
 * Bone frames == MJCF body frames (tools/README.md "Fly body"), so joint
 * axes are the MJCF `axis_body` values. Model forward = local +X, up = +Y, left = -Z.
 */
import { BrainAct } from "./BrainLink"
import { FlyConfig } from "./FlyConfig"
import { FlyPose, Source } from "./WorldSources"

const AX = new vec3(1, 0, 0)
const AY = new vec3(0, 1, 0)
const AZ = new vec3(0, 0, 1)
const BACKZ = new vec3(0, 0, -1)
const UP = new vec3(0, 1, 0)

export const BONES = [
  "head", "rostrum", "haustellum", "antenna_left", "antenna_right", "wing_left", "wing_right", "abdomen",
  "coxa_T1_left", "femur_T1_left", "tibia_T1_left", "coxa_T2_left", "femur_T2_left", "tibia_T2_left",
  "coxa_T3_left", "femur_T3_left", "tibia_T3_left", "coxa_T1_right", "femur_T1_right", "tibia_T1_right",
  "coxa_T2_right", "femur_T2_right", "tibia_T2_right", "coxa_T3_right", "femur_T3_right", "tibia_T3_right",
]
const TRIPOD_A = ["T1_left", "T2_right", "T3_left"]
const LEGS = ["T1_left", "T2_left", "T3_left", "T1_right", "T2_right", "T3_right"]
// 12.09 perf audit: the animator rebuilt ~90 bone-name strings and ~200 throwaway arrays EVERY frame
// (3 flies + the 2 decoration bodies). Names and the tripod phase are constant — table them once.
const COXA = LEGS.map((l) => "coxa_" + l)
const FEMUR = LEGS.map((l) => "femur_" + l)
const TIBIA = LEGS.map((l) => "tibia_" + l)
const TRIPOD = LEGS.map((l) => TRIPOD_A.indexOf(l) >= 0)
// Each leg's own motor pool, in LEGS order (T1 = front, T2 = middle, T3 = hind): the brain sets
// how hard THAT leg pushes. 12.09 the user: "I thought the brain controlled the legs".
const LEG_ACT = ["legf_L", "legm_L", "legh_L", "legf_R", "legm_R", "legh_R"]

export type FlyState = "air" | "landed" | "escape"

interface Bone {
  t: Transform
  rest: quat
  // 12.09 device probe: `bodies` is 2.5 ms of EVERY frame, the biggest steady cost in the lens —
  // 19 bone writes per fly per frame, each allocating two or three quats. A large share of them
  // write the SAME value every frame (the six tibia at rest, the folded wings while landed, the
  // tucked femurs in cruise, and every leg of a fly that is standing still). The last write is
  // remembered so those become no-ops. Exact equality on purpose: the drivers are deterministic,
  // so a genuinely constant pose reproduces the identical number and a moving one always differs.
  mode: number // 0 = rest, 1 = one axis, 2 = two axes, -1 = never written
  ax: vec3 | null
  ax2: vec3 | null
  n1: number
  n2: number
}

function findByName(root: SceneObject, name: string): SceneObject | null {
  if (root.name === name) return root
  for (let i = 0; i < root.getChildrenCount(); i++) {
    const hit = findByName(root.getChild(i), name)
    if (hit) return hit
  }
  return null
}

export class FlyBody {
  state: FlyState = "air"
  landedOn: Source | null = null
  onLanded: (s: Source) => void = () => {}
  speed = 0
  energy = FlyConfig.ENERGY_START[0] + Math.random() * (FlyConfig.ENERGY_START[1] - FlyConfig.ENERGY_START[0]) // BODY vital (simulated), its own per fly
  private bones: { [name: string]: Bone } = {}
  private act: BrainAct = {
    turn: 0, orient: 0, steer: 0, escape_L: 0, escape_R: 0, stop: 0, back: 0, feed: 0, appetite: 0, forward: 0.25,
    avoid: 0, thrust: 0, sacc: 0,
    groom: 0, neck: 0, ant: 0, prob: 0, abd: 0, legs: 0,
    legf_L: 0, legm_L: 0, legh_L: 0, legf_R: 0, legm_R: 0, legh_R: 0,
  }
  private escapeT = 0
  private escapeY = 0 // escape altitude, set once at its onset
  private escapeDir = 0
  private takeoffT = 0
  private wingPhase = 0
  private gaitPhase = 0
  // 12.09 audit: the two moments a viewer watches most were one-frame pose snaps, and a standing fly
  // was a statue for up to SURFACE_MAX_S. `poseMix` blends the flight pose in and out; the grooming
  // bouts are engineered and disclosed (no grooming DN exists in the atlas — ADR 41), but they only
  // run when the brain is standing still and not feeding.
  private prevFlying = true
  private poseMix = 1 // 1 = full flight pose, 0 = fully settled on the surface
  // (the grooming timer is gone: DNg12 decides now — see the grooming block in pose())
  private groomLeft = 0 // seconds left in the current bout
  private groomKind = 0 // 0 = front tarsi over the head, 1 = hind legs over the abdomen
  private proboscis = 0
  private time = 0
  private cruiseAlt: number
  private speedEased = 0
  private pitch = 0
  private dangle = 0 // 0 tucked .. 1 legs hanging (slow hover)
  private reach = 0 // 0 .. 1 legs reaching forward (landing response)
  private reachTarget = 0
  // on a surface (wall / ceiling / table, SURFACE_LANDING): the body's up = this normal
  surfaceNormal: vec3 | null = null
  private surfaceAnchor: vec3 | null = null // where the feet belong; the body eases onto it
  private pushLeft: vec3 | null = null // take-off push not yet applied (eased, not a pop)
  private offRot: quat | null = null // the surface orientation it left, blended out over TAKEOFF_ROT_S
  private offMix = 0
  private surfaceT = 0
  private wantOffT = 0
  forage = false // hungry and smelling food: a short surface stay, then off to look (FlySwarm sets it)
  nearFly = 1e9 // distance to the closest other fly (FlySwarm sets it): squeezing in, a fly slows down
  smellY: number | null = null // height of the nearest food this hungry fly smells (FlySwarm sets it)
  perch: vec3 | null = null // the surface this fly is heading for at the end of a flight bout
  airT = 0 // time in this flight bout
  boutS = 0 // this bout's length (FLIGHT_BOUT_S)

  constructor(
    public index: number,
    private root: SceneObject,
    instance: SceneObject,
    public pos: vec3,
    public yaw: number,
    private homeY: number,
  ) {
    for (const name of BONES) {
      const so = findByName(instance, name)
      if (so) {
        this.bones[name] = { t: so.getTransform(), rest: so.getTransform().getLocalRotation(),
          mode: -1, ax: null, ax2: null, n1: 0, n2: 0 }
      }
    }
    const band = FlyConfig.CRUISE_ALT_CM
    this.cruiseAlt = homeY + band[0] + Math.random() * (band[1] - band[0])
  }

  /** The fly's container (moves with it): attach per-fly audio / fx here. */
  get sceneObject(): SceneObject {
    return this.root
  }

  setVisible(on: boolean) {
    if (this.root.enabled !== on) this.root.enabled = on
  }

  /** A new flight bout starts (take-off, respawn). */
  newBout() {
    const b = FlyConfig.FLIGHT_BOUT_S
    this.airT = 0
    this.boutS = b[0] + Math.random() * (b[1] - b[0])
  }

  /** Re-place in front of the user's CURRENT view (end of the intro room scan). */
  respawn(pos: vec3, yaw: number, homeY: number) {
    this.pos = pos
    this.yaw = yaw
    this.homeY = homeY
    const band = FlyConfig.CRUISE_ALT_CM
    this.cruiseAlt = homeY + band[0] + Math.random() * (band[1] - band[0])
    this.state = "air"
    this.landedOn = null
    this.speed = 0
    this.speedEased = 0
    this.surfaceNormal = null // (a respawn from a wall kept it: the next lure landing walked instead)
    // 12.09 audit: a respawn taken mid-take-off used to carry the whole motion state into the new
    // spawn — an 8 cm push still easing out, a stale wall rotation, a surface anchor measured in the
    // OLD room (which `settled` then compared against), a half-finished saccade and grooming bout.
    this.pushLeft = null
    this.pushPending = null
    this.buzzT = 0
    this.saccT = 0
    this.offRot = null
    this.offMix = 0
    this.surfaceAnchor = null
    this.pitch = 0
    this.dangle = 0
    this.reach = 0
    this.reachTarget = 0
    this.surfaceT = 0
    this.wantOffT = 0
    this.poseMix = 1
    this.groomLeft = 0
    this.escapeT = 0
    this.newBout()
  }

  /** Current local rotation of one animated bone (the board's mini hologram mirrors it). */
  boneRotation(name: string): quat | null {
    const b = this.bones[name]
    return b ? b.t.getLocalRotation() : null
  }

  get boneCount(): number {
    return Object.keys(this.bones).length
  }

  /** Body orientation on a surface: up = the surface normal, the heading turns in its plane. */
  private surfaceRot(): quat {
    return quat.rotationFromTo(UP, this.surfaceNormal!).multiply(quat.angleAxis(this.yaw, UP))
  }

  /** Touch down on any surface (FlySwarm finds the spot with the eyes' rays). */
  landOnSurface(point: vec3, normal: vec3) {
    this.surfaceNormal = normal.normalize()
    this.state = "landed"
    this.landedOn = null
    this.surfaceAnchor = point.add(this.surfaceNormal.uniformScale(FlyConfig.LANDED_LIFT_CM))
    this.surfaceT = 0
    this.wantOffT = 0
    this.speedEased = 0
  }

  /** Still easing onto the surface anchor? (the edge check must wait: its 18 cm ray would miss) */
  get settled(): boolean {
    return !this.surfaceAnchor || this.pos.distance(this.surfaceAnchor) < FlyConfig.LAND_SETTLED_CM
  }

  /** Keep the feet on a (possibly curved) surface while walking — FlySwarm re-casts the normal. */
  stickTo(point: vec3, normal: vec3) {
    this.surfaceNormal = normal.normalize()
    this.surfaceAnchor = point.add(this.surfaceNormal.uniformScale(FlyConfig.LANDED_LIFT_CM))
  }

  /** Leave the surface: push off along its normal and start flying. */
  takeOff() {
    const n = this.surfaceNormal
    if (n) {
      this.offRot = this.surfaceRot() // leave the wall frame smoothly, not with a snap
      this.offMix = 1
    }
    this.state = "air"
    this.surfaceNormal = null
    this.landedOn = null
    this.surfaceAnchor = null
    // 12.09 audit: the fly used to leave on the same frame its wings unfolded. A real take-off is
    // wings unfold and buzz, legs extend and push, THEN the body goes. The push is held back for
    // TAKEOFF_BUZZ_S while `poseMix` ramps the stroke up from nothing.
    if (n) this.pushPending = n.uniformScale(FlyConfig.SURFACE_JUMP_CM)
    this.buzzT = FlyConfig.TAKEOFF_BUZZ_S
    this.speedEased = 0
    this.newBout()
  }

  private pushPending: vec3 | null = null
  private buzzT = 0
  // the saccade in flight: time left, which way, how far (the brain says when, the template is ours)
  private saccT = 0
  private saccDir = 1
  private saccAmp = 0

  /** What the body is doing right now, for the board (derived from state + decoded act). */
  actionLabel(): string {
    const a = this.act
    if (this.state === "escape") return "ESCAPE " + (this.escapeDir > 0 ? "RIGHT" : "LEFT")
    if (this.state === "landed" && this.surfaceNormal) {
      if (this.groomLeft > 0) return "GROOMING" // 12.09: so a bout is visible on the board, not guessed
      if (this.speed > 1) return "WALKING"
      const ny = this.surfaceNormal.y
      return ny < -0.5 ? "ON CEILING" : ny < 0.5 ? "ON WALL" : "LANDED"
    }
    if (this.state === "landed") return a.feed > 0.4 ? "FEEDING" : "LANDED"
    if (a.stop > 0.5) return "STOP"
    if (Math.abs(a.steer) > 0.3 && a.forward > 0.4) return a.steer > 0 ? "APPROACH >" : "< APPROACH"
    if (a.forward > 0.3) return "CRUISE"
    return "HOVER"
  }

  // 12.09 audit: pose() was rebuilt 10-15 times a frame per fly from unchanged inputs, ~8 allocations
  // each. It is now cached until the body actually moves, turns, lands or changes surface.
  private pc: FlyPose | null = null
  private pcX = NaN
  private pcY = NaN
  private pcZ = NaN
  private pcYaw = NaN
  private pcState = ""
  private pcNormal: vec3 | null = null

  pose(): FlyPose {
    const p = this.pos
    if (this.pc && p.x === this.pcX && p.y === this.pcY && p.z === this.pcZ && this.yaw === this.pcYaw &&
      this.state === this.pcState && this.surfaceNormal === this.pcNormal) return this.pc
    // on a wall the head (eyes, senses) points along the surface, not along the horizon
    const rot = this.state === "landed" && this.surfaceNormal ? this.surfaceRot() : quat.angleAxis(this.yaw, UP)
    const fwd = rot.multiplyVec3(AX)
    const left = rot.multiplyVec3(BACKZ)
    this.pc = { head: p.add(fwd.uniformScale(FlyConfig.HEAD_OFFSET_CM)), body: p, fwd: fwd, left: left }
    this.pcX = p.x
    this.pcY = p.y
    this.pcZ = p.z
    this.pcYaw = this.yaw
    this.pcState = this.state
    this.pcNormal = this.surfaceNormal
    return this.pc
  }

  // 12.09 the user: "attach as many bones to the brain as possible". The wing stroke was a constant;
  // it is now the fly's OWN wing motor neurons — `wing` (all 67 MNs: DLM/DVM power + b1/b2/i1/i2/hg
  // steering) sets the amplitude, and the left/right steering MNs tilt it per side. Rates are Hz, so
  // each body auto-ranges them against its own recent peak (the board does the same for its bars).
  private wingDrive = 0 // 0..1 stroke amplitude from the brain
  private wingBias = 0 // -1..1, + = left wing beats harder (turns right)
  private gaze = 0 // eased `orient`, the decoded gaze command (was never read by the body)
  private peakWing = 20
  private peakSteerMN = 10

  /** Ease toward the newest decoded actions (the brain updates at ~2 Hz). */
  setBrain(target: BrainAct | null, dt: number, hz?: { [k: string]: number } | null) {
    if (hz) {
      const wing = hz.wing || 0
      this.peakWing = Math.max(8, this.peakWing * Math.exp(-dt / 20), wing)
      this.wingDrive = Math.min(1, wing / this.peakWing)
      const l = hz.steermn_L || 0
      const r = hz.steermn_R || 0
      this.peakSteerMN = Math.max(5, this.peakSteerMN * Math.exp(-dt / 20), l, r)
      this.wingBias = Math.max(-1, Math.min(1, (l - r) / this.peakSteerMN))
    }
    if (!target) return
    const a = 1 - Math.exp(-dt * FlyConfig.ACT_SMOOTH_RATE)
    for (const k in this.act) {
      const cur = (this.act as any)[k] as number
      const tgt = (target as any)[k]
      if (typeof tgt !== "number") continue
      // reflexes go straight through (12.09 the user, reaction speed): the escape suite and the stop
      // neuron are a fly's hard-wired paths, easing them cost ~125 ms before the body even moved.
      // Cruising, steering and thrust stay eased so flight still looks smooth.
      const reflex = k === "escape_L" || k === "escape_R" || k === "stop"
      ;(this.act as any)[k] = reflex ? (tgt > cur ? tgt : cur + a * (tgt - cur)) : cur + a * (tgt - cur)
    }
  }

  update(dtRaw: number, lure: Source | null, centre: vec3, userHead: vec3) {
    // a long frame must not teleport the fly: timers keep real time, motion integrates at most
    // STEP_MAX_S (12.09 the user saw jumps of 12 cm on hitched frames)
    const dt = Math.min(dtRaw, FlyConfig.STEP_MAX_S)
    this.time += dtRaw
    const act = this.act
    const p = this.pose()

    if (this.state !== "escape" && Math.max(act.escape_L, act.escape_R) > 0.5) {
      if (this.surfaceNormal) this.takeOff() // jump off the wall first
      this.state = "escape"
      this.escapeT = FlyConfig.ESCAPE_S
      // escape climbs ONCE, from where it got scared (11.09 preview: "pos.y + 40" re-evaluated every
      // frame climbed forever -> flies jammed under the ceiling, whose loom re-triggered the escape)
      this.escapeY = this.pos.y + FlyConfig.ESCAPE_CLIMB_CM
      // threat on the left -> turn right (+1). A head-on loom drives BOTH sides equally — and the
      // user's head is exactly that case — so the old `>=` always escaped to the right. Inside a
      // deadband the fly now alternates instead of having a favourite side (12.09 audit).
      const dEsc = act.escape_L - act.escape_R
      this.escapeDir = Math.abs(dEsc) > 0.05 ? (dEsc > 0 ? 1 : -1) : -this.escapeDir || 1
      this.landedOn = null
    }

    let steer = act.steer
    let speed = 0
    let targetY = lure ? lure.pos.y : this.cruiseAlt + 6 * Math.sin(this.time * 0.9 + this.index)
    // no landing target yet, but it smells food: drift toward its height (a fly follows a smell down
    // to the floor; our altitude is engineered anyway, ADR 26)
    if (!lure && this.smellY !== null) targetY += (this.smellY - targetY) * FlyConfig.SMELL_ALT_MIX
    // bout over: head for the surface its own eyes found instead of waiting for one to drift within
    // reach (12.09 bench: a fly could fly a whole 40 s run without ever passing close to anything)
    if (!lure && this.perch && this.state === "air") {
      const to = this.perch.sub(p.head)
      const dist = to.length
      if (dist > 1) {
        const side = to.uniformScale(1 / dist).dot(p.left) // + = on its left
        steer = steer * (1 - FlyConfig.PERCH_STEER) + (side > 0 ? -1 : 1) * FlyConfig.PERCH_STEER
        targetY = this.perch.y
      }
    }
    // landing response: a surface/target coming close -> legs reach forward (11.09 "legs never move")
    // ...for a wall or a perch too, not only a lure: most landings come from the flight bouts, and
    // those all happened with the legs still tucked (12.09 audit)
    const dTarget = lure ? p.head.distance(lure.pos) : this.perch && this.state === "air" ? p.head.distance(this.perch) : 1e9
    this.reachTarget = this.state === "air" && dTarget < FlyConfig.LAND_APPROACH_CM ? 1 - dTarget / FlyConfig.LAND_APPROACH_CM : 0

    if (this.state === "escape") {
      steer = this.escapeDir
      speed = FlyConfig.ESCAPE_CM_S
      targetY = this.escapeY
      this.escapeT -= dt
      if (this.escapeT <= 0) this.state = "air"
    } else if (this.state === "air") {
      speed = act.stop > 0.5 ? 0 : act.forward * FlyConfig.CRUISE_CM_S
      // Landing approach (van Breugel & Dickinson 2012): flies decelerate as a landing target nears,
      // roughly holding the time-to-contact, so the final approach is slow (and a fly landing next to
      // another no longer rushes at it). Engineered, disclosed (ADR 35).
      if (lure) speed = Math.min(speed, FlyConfig.LAND_DECEL_MIN_CM_S + FlyConfig.LAND_DECEL_RATE * dTarget)
      else if (this.perch) speed = Math.min(speed, FlyConfig.LAND_DECEL_MIN_CM_S + FlyConfig.LAND_DECEL_RATE * this.perch.distance(p.head))
      // the same brake for a neighbour: flies squeeze in next to each other slowly, they don't rush past
      if (this.nearFly < FlyConfig.NEIGHBOUR_SLOW_CM) {
        const room = Math.max(0, this.nearFly - FlyConfig.NEIGHBOUR_CLEAR_CM)
        speed = Math.min(speed, FlyConfig.LAND_DECEL_MIN_CM_S + FlyConfig.LAND_DECEL_RATE * room)
      }
      // Arena leash (controller override, disclosed): ease back toward home when too far.
      // (11.09 audit: it used to run BEFORE the line above, which overwrote its "fly home" speed.)
      const toC = centre.sub(this.pos)
      toC.y = 0
      const over = toC.length - FlyConfig.ARENA_RADIUS_CM
      if (over > 0) {
        const side = toC.normalize().dot(p.left) // + = centre on the left
        const pull = Math.min(1, over / 30)
        steer = steer * (1 - pull) + (side > 0 ? -1 : 1) * pull
        speed = Math.max(speed, FlyConfig.CRUISE_CM_S * 0.5 * pull) // actually fly home
      }
      // Comfort bubble (engineered, disclosed): don't hover in the user's face unless landing.
      const toHead = userHead.sub(this.pos)
      const dHead = toHead.length
      if (!lure && dHead < FlyConfig.COMFORT_CM) {
        const k = 1 - dHead / FlyConfig.COMFORT_CM
        const headLeft = toHead.normalize().dot(p.left) > 0
        steer = steer * (1 - k) + (headLeft ? 0.8 : -0.8) * k // turn away from the head
        speed = Math.max(speed, FlyConfig.CRUISE_CM_S * 0.6 * k)
        // ...and sink below eye level: turning alone never separates a fly hovering right
        // above/below the head (11.09 preview: a fly parked over the camera)
        targetY = Math.min(targetY, userHead.y - FlyConfig.COMFORT_BELOW_CM)
      }
      // MDN ("moonwalker") is the backward-WALK command: in flight it has no say (11.09 audit: it
      // is driven by the object channel LC10 and saturated with food dead ahead). Backward steps
      // belong to walking only.
      if (lure && p.head.sub(lure.pos).length < FlyConfig.LAND_CM) {
        this.state = "landed"
        this.landedOn = lure
        this.takeoffT = FlyConfig.LAND_TAKEOFF_S
        this.onLanded(lure)
      }
    } else if (this.surfaceNormal) {
      // on a surface (SURFACE_LANDING): the brain walks it — forward = walking drive, steer turns in
      // the surface plane; an escape or a sustained forward push (or a long dwell) takes it off
      this.surfaceT += dt
      // MDN is the backward-walk command and it finally has a say: `BACK_CM_S` was read by nothing
      // at all, so a fly with a brain-decided backward step could never take one (12.09 audit)
      speed = Math.max(0, act.forward - FlyConfig.SURFACE_WALK_DEAD) * FlyConfig.WALK_CM_S - act.back * FlyConfig.BACK_CM_S
      steer = act.steer
      const go = Math.max(act.escape_L, act.escape_R) > 0.5 || act.forward > FlyConfig.SURFACE_TAKEOFF_FWD
      this.wantOffT = go ? this.wantOffT + dt : 0
      const maxStay = this.forage ? FlyConfig.SURFACE_MAX_FORAGE_S : FlyConfig.SURFACE_MAX_S
      if (this.wantOffT > FlyConfig.SURFACE_TAKEOFF_S || this.surfaceT > maxStay) this.takeOff()
    } else {
      // landed: ride the lure (the user's hand); take off a moment after it disappears
      speed = 0
      steer = 0
      if (lure && lure === this.landedOn) {
        // touch-down EASES onto the spot (11.09 bench: the old one-frame snap moved the fly up to
        // LAND_CM in one sense tick, which a neighbour read as a fly rushing at it -> escape)
        const tgt = lure.pos.sub(p.fwd.uniformScale(FlyConfig.HEAD_OFFSET_CM)).add(new vec3(0, FlyConfig.LANDED_LIFT_CM, 0))
        this.pos = this.pos.add(tgt.sub(this.pos).uniformScale(1 - Math.exp(-dt * FlyConfig.LAND_SETTLE_RATE)))
        targetY = this.pos.y
        this.takeoffT = FlyConfig.LAND_TAKEOFF_S
      } else {
        this.takeoffT -= dt
        if (this.takeoffT <= 0) {
          this.state = "air"
          this.landedOn = null
          this.newBout()
        }
      }
    }

    if (this.state !== "landed") this.airT += dt
    // BODY vitals (simulated): moving and escaping drain energy, eating refills it
    const drain =
      FlyConfig.ENERGY_IDLE_DRAIN +
      (FlyConfig.ENERGY_MOVE_DRAIN * Math.abs(speed)) / FlyConfig.CRUISE_CM_S +
      (this.state === "escape" ? FlyConfig.ENERGY_ESCAPE_DRAIN : 0)
    const gain = this.state === "landed" ? FlyConfig.ENERGY_FEED_GAIN * act.feed : 0
    this.energy = Math.min(1, Math.max(0, this.energy + (gain - drain) * dt))

    // steer: +1 = right. A +yaw rotation about +Y turns +X toward -Z (= left), so right = -yaw.
    // SACCADES (ADR 22, 12.09): a real fly flies nearly straight and flicks ~90 deg in ~50 ms - the
    // continuous sweep was the strongest "this is a hologram" tell. The brain says WHEN and which
    // way (DNa15 excites, DNb01 inhibits, VES041 suppresses -> `sacc`); the template is ours and
    // disclosed. Between flicks the smooth steering stays, damped to SACC_CRUISE_TURN: it still
    // carries the engineered leash, comfort bubble and perch approach.
    if (this.saccT > 0) {
      this.saccT -= dt
      // half-sine rate profile: zero at both ends, and its integral is exactly saccAmp
      const done = 1 - Math.max(0, this.saccT) / FlyConfig.SACC_S
      const rate = this.saccAmp * (Math.PI / (2 * FlyConfig.SACC_S)) * Math.sin(Math.PI * done)
      this.yaw -= this.saccDir * rate * dt
    } else if (this.state === "air" && Math.abs(act.sacc) > FlyConfig.SACC_TRIGGER) {
      this.saccT = FlyConfig.SACC_S
      this.saccDir = act.sacc > 0 ? 1 : -1
      this.saccAmp = (FlyConfig.SACC_DEG * Math.PI) / 180 * Math.min(1, Math.abs(act.sacc))
    }
    this.yaw -= steer * FlyConfig.TURN_RATE * (this.saccT > 0 ? 0 : FlyConfig.SACC_CRUISE_TURN) * dt
    // speed eases (11.09 "they fly strangely": the brain's stop flipped speed 0 <-> cruise at once);
    // an escape is still an instant burst
    // wings first, body second: while the take-off buzz runs the fly stays where it is
    if (this.buzzT > 0) {
      this.buzzT -= dt
      speed = 0
      if (this.buzzT <= 0) {
        this.pushLeft = this.pushPending
        this.pushPending = null
        this.speedEased = 0.4 * FlyConfig.CRUISE_CM_S
      }
    }
    if (this.state === "landed" && !this.surfaceNormal) this.speedEased = 0
    else {
      const rate = this.state === "escape" ? 12 : FlyConfig.SPEED_EASE_RATE
      this.speedEased += (speed - this.speedEased) * (1 - Math.exp(-dt * rate))
    }
    this.speed = this.speedEased
    if (this.state !== "landed") {
      // 12.09 audit: `p` was captured BEFORE the yaw changed this frame, so the body flew along last
      // frame's heading while the transform already pointed at the new one — a visible sideslip in
      // every turn. pose() is cached on yaw, so this recomputes only when the heading really moved.
      this.pos = this.pos.add(this.pose().fwd.uniformScale(this.speed * dt))
      this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-dt * FlyConfig.ALT_RATE))
    } else if (this.surfaceNormal) {
      this.pos = this.pos.add(p.fwd.uniformScale(this.speed * dt)) // p.fwd lies in the surface plane
      // ease onto the surface instead of snapping to it (11.09 "they teleport": a touch-down from the
      // eye rays' 22 cm reach moved the fly that far in one frame; bench jump probe caught 4 per cycle)
      if (this.surfaceAnchor) this.pos = this.pos.add(this.surfaceAnchor.sub(this.pos).uniformScale(1 - Math.exp(-dt * FlyConfig.LAND_SETTLE_RATE)))
    }

    // the push-off is spread over ~0.4 s instead of one frame (12.09: the pop read as a teleport)
    if (this.pushLeft) {
      const step = this.pushLeft.uniformScale(1 - Math.exp(-dt * FlyConfig.TAKEOFF_EASE_RATE))
      this.pos = this.pos.add(step)
      this.pushLeft = this.pushLeft.sub(step)
      if (this.pushLeft.length < 0.2) this.pushLeft = null
    }
    // banks INTO the turn. The old sign rolled the fly outward — and unlike the wing and leg signs,
    // this one never carried a "verified by pose render" note (12.09 audit). Flip BANK if it reads
    // wrong on the glasses.
    const bank = this.state === "landed" ? 0 : steer * FlyConfig.BANK
    // pitch: nose down with forward speed, slightly up in a hover (model forward = +X, so a
    // negative rotation about +Z dips the nose)
    const sp = Math.min(1.5, this.speed / FlyConfig.CRUISE_CM_S)
    const pitchTarget = this.state === "landed" ? 0 : -FlyConfig.PITCH_FWD * sp + (sp < 0.2 ? FlyConfig.PITCH_HOVER : 0)
    this.pitch += (pitchTarget - this.pitch) * (1 - Math.exp(-dt * 3))
    let rot = this.state === "landed" && this.surfaceNormal
      ? this.surfaceRot()
      : quat.angleAxis(this.yaw, UP).multiply(quat.angleAxis(bank, AX)).multiply(quat.angleAxis(this.pitch, AZ))
    if (this.offMix > 0 && this.offRot) {
      rot = quat.slerp(rot, this.offRot, this.offMix)
      this.offMix = Math.max(0, this.offMix - dt / FlyConfig.TAKEOFF_ROT_S)
    }
    const t = this.root.getTransform()
    t.setWorldPosition(this.pos)
    t.setWorldRotation(rot)
    this.animate(dt)
  }

  /** Bone at its rest pose. */
  private setRest(name: string) {
    const b = this.bones[name]
    if (!b || b.mode === 0) return // already sitting at rest: nothing to write
    b.mode = 0
    b.t.setLocalRotation(b.rest)
  }

  /** One rotation off the rest pose — the shape every per-frame bone write actually needs. */
  private setBone1(name: string, axis: vec3, angle: number) {
    const b = this.bones[name]
    if (!b) return
    if (b.mode === 1 && b.ax === axis && b.n1 === angle) return // same pose as last frame
    b.mode = 1
    b.ax = axis
    b.n1 = angle
    b.t.setLocalRotation(b.rest.multiply(quat.angleAxis(angle, axis)))
  }

  private setBone2(name: string, a1: vec3, n1: number, a2: vec3, n2: number) {
    const b = this.bones[name]
    if (!b) return
    if (b.mode === 2 && b.ax === a1 && b.ax2 === a2 && b.n1 === n1 && b.n2 === n2) return
    b.mode = 2
    b.ax = a1
    b.ax2 = a2
    b.n1 = n1
    b.n2 = n2
    b.t.setLocalRotation(b.rest.multiply(quat.angleAxis(n1, a1)).multiply(quat.angleAxis(n2, a2)))
  }

  private animate(dt: number) {
    const act = this.act
    const flying = this.state !== "landed"

    // wings (verified by Blender pose renders, fly_model/build_glb.py --poses, 11.09):
    // the rest pose is already spread sideways; rotating Z by the SAME sign on both wings
    // is a symmetric up/down stroke (the right wing's frame is mirrored). Landed: no stroke.
    // the flight pose blends in and out over POSE_BLEND_S instead of snapping on the landing frame
    if (flying !== this.prevFlying) this.prevFlying = flying
    this.poseMix += ((flying ? 1 : 0) - this.poseMix) * (1 - Math.exp(-dt / FlyConfig.POSE_BLEND_S))
    this.wingPhase += dt * 2 * Math.PI * (flying ? FlyConfig.WING_HZ : 0)
    if (flying) {
      // amplitude from the brain's wing drive, tilted per side by the steering muscles: a turning
      // fly visibly beats harder on the outside wing (ADR 22 allows exactly this)
      const amp = FlyConfig.WING_FLAP * (FlyConfig.WING_BRAIN_MIN + (1 - FlyConfig.WING_BRAIN_MIN) * this.wingDrive) * this.poseMix
      const stroke = Math.sin(this.wingPhase) * amp
      this.setBone1("wing_left", AZ, stroke * (1 + FlyConfig.WING_STEER_MIX * this.wingBias))
      this.setBone1("wing_right", AZ, stroke * (1 - FlyConfig.WING_STEER_MIX * this.wingBias))
    } else {
      this.setBone2("wing_left", AX, FlyConfig.WING_FOLD_X, AZ, FlyConfig.WING_FOLD_Z)
      this.setBone2("wing_right", AX, FlyConfig.WING_FOLD_X, AZ, FlyConfig.WING_FOLD_Z)
    }

    // legs: tucked in cruise (femur -0.5, verified), dangling in a slow hover, reaching forward
    // just before touch-down (landing response); tripod gait on a surface
    // 12.09 the user: "they crawl along the wall oddly". The stride used to be scaled BY speed at a
    // FIXED step rate, so a slow fly barely moved its legs and skated along. Real legs are the
    // other way round: the step RATE follows speed and the stride keeps its size.
    const pace = Math.min(1, Math.abs(this.speed) / FlyConfig.WALK_CM_S)
    this.gaitPhase += dt * 2 * Math.PI * FlyConfig.GAIT_HZ * (FlyConfig.GAIT_MIN + (1 - FlyConfig.GAIT_MIN) * pace)
    const kk = 1 - Math.exp(-dt * 4)
    const hover = flying && this.speed < 0.3 * FlyConfig.CRUISE_CM_S ? 1 : 0
    this.dangle += (hover - this.dangle) * kk
    this.reach += (this.reachTarget - this.reach) * kk
    const loose = Math.max(this.dangle, this.reach)
    const femur = FlyConfig.LEG_TUCK * (1 - loose) + FlyConfig.LEG_DANGLE * this.dangle * (1 - this.reach) + FlyConfig.LEG_REACH * this.reach
    const walk = flying ? 0 : Math.min(1, Math.abs(this.speed) / (this.surfaceNormal ? FlyConfig.WALK_CM_S : FlyConfig.CRUISE_CM_S))
    // How hard the legs push comes from the leg motor pools (front/middle/hind, 58-68 cells each).
    // They only move +-1..3 Hz in this model, so they are a stride GAIN, not the gait: the tripod
    // rhythm stays ours and is disclosed as such.
    // A fly that is moving at all takes a proper step; a standing one keeps its feet still. Each
    // leg then scales that by its OWN motor pool (see LEG_ACT) inside the loop.
    const stride = walk > 0.03 ? FlyConfig.LEG_STRIDE_MIN + (1 - FlyConfig.LEG_STRIDE_MIN) * walk : 0
    for (let i = 0; i < LEGS.length; i++) {
      if (flying) {
        const sway = 0.08 * Math.sin(this.time * 2.2 + i)
        this.setBone1(COXA[i], AX, sway + FlyConfig.LEG_REACH_COXA * this.reach)
        this.setBone1(FEMUR[i], AX, femur)
      } else {
        const ph = this.gaitPhase + (TRIPOD[i] ? 0 : Math.PI)
        // a grooming leg leaves the gait: front pair sweeps over the head, hind pair over the abdomen
        const g = this.groomLeft > 0 && (this.groomKind === 0 ? i === 0 || i === 3 : i === 2 || i === 5)
          ? Math.sin(this.time * 2 * Math.PI * FlyConfig.GROOM_HZ) * FlyConfig.GROOM_SWEEP
          : 0
        const amp = stride * (1 + FlyConfig.LEG_BRAIN_MIX * ((act as any)[LEG_ACT[i]] || 0))
        this.setBone1(COXA[i], AX, FlyConfig.LEG_STRIDE * amp * Math.sin(ph) + g)
        this.setBone1(FEMUR[i], AX, FlyConfig.LEG_LIFT * amp * Math.max(0, Math.cos(ph)) + (this.groomKind === 0 ? -1.4 : 1.0) * Math.abs(g))
        if (g !== 0) {
          this.setBone1(TIBIA[i], AX, -0.8 * Math.abs(g))
          continue
        }
      }
      this.setRest(TIBIA[i])
    }
    // Grooming is the BRAIN's (12.09 the user: "surely the brain decides when to groom?"). DNg12 —
    // 21 cells a side, resting at ~1.4 Hz — rises +8..+15 Hz when the bristles are loaded and stays
    // at 0 on sweet contact, all measured in this model. FlySwarm feeds it the fly's dust load and
    // grooming discharges it, so a bout starts and ends on its own. Ours is only the mechanics:
    // which pair of legs sweeps, and that a leg cannot step and sweep at the same time.
    if (!flying && walk < FlyConfig.GROOM_WALK_MAX) {
      if (act.groom > FlyConfig.GROOM_ON) {
        if (this.groomLeft <= 0) this.groomKind = Math.random() < 0.6 ? 0 : 1
        this.groomLeft = FlyConfig.GROOM_HOLD_S // held up while the command fires, then decays out
      } else this.groomLeft = Math.max(0, this.groomLeft - dt)
    } else this.groomLeft = 0

    // The proboscis rides its whole motor pool (33 MNs, MN9 among them: +10 Hz at sweet contact),
    // so it extends by degrees; the single feeding cell stays as the floor that guarantees a full
    // extension while the fly is actually eating.
    const target = Math.max(act.prob, act.feed > 0.4 ? 1 : 0)
    this.proboscis += (target - this.proboscis) * (1 - Math.exp(-dt * FlyConfig.PROBOSCIS_RATE))
    this.setBone1("rostrum", AX, -1.0 * this.proboscis)
    this.setBone1("haustellum", AX, -1.2 * this.proboscis)

    // the head YAWS with the brain's gaze command (`orient`, decoded and until now never read by the
    // body) and pitches a little into the steer. The old code rotated about Z, which is the same axis
    // as the wing stroke — the fly nodded instead of looking (12.09 audit).
    // 12.09: the head now moves on its own neck motor neurons (22 a side, resting lopsided at
    // 9 / 13 Hz — read against their own baselines). `orient` stays as the aiming bias: the MN
    // difference alone is too coarse to hold a target.
    const look = Math.max(-1, Math.min(1, act.neck + 0.4 * act.orient))
    this.gaze += (look - this.gaze) * (1 - Math.exp(-dt * 6))
    this.setBone2("head", AY, FlyConfig.HEAD_YAW * this.gaze, AZ, 0.08 * act.steer)
    // the abdomen was bound and never moved: it pumps while the feeding neuron fires, breathes
    // slowly otherwise, and curls with the body's pitch
    // 107 abdominal MNs a side set how deep it pumps (wind took them +5 Hz); the feeding cell still
    // sets the fast rate while the fly eats.
    const depth = 0.03 + 0.1 * act.feed + 0.06 * Math.max(0, act.abd)
    const pump = Math.sin(this.time * Math.PI * 2 * (1.6 + 5.0 * act.feed)) * depth
    this.setBone1("abdomen", AZ, pump - 0.12 * this.pitch)
    // Antennae: the antennal motor pool (6-7 cells a side) sets the sweep — bristle contact drove
    // it +21 Hz in the probe, sweet dropped it 17. The flutter rate stays ours.
    const tw = (0.05 + 0.18 * Math.max(0, act.ant)) * Math.sin(this.time * 9 + this.index)
    this.setBone1("antenna_left", AX, tw)
    this.setBone1("antenna_right", AX, -tw)
  }
}
