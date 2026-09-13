/**
 * FlySwarm — the lens controller: spawns the giant flies, feeds each fly's brain its senses,
 * applies the brain's decisions to the bodies.
 *
 * Hands: LEFT pinch = a sweet lure at the pinch point for the selected fly (it may come and
 * land; landing = reward pulse, ADR 14). RIGHT pinch near a fly = select it.
 * User head and hands are also threat sources: approach fast and the flies see looming.
 *
 * Debug (editor preview has no hands): `debugScenario` seeds a state directly
 * (foundation playbook §3) and logs DEBUG_STATE_ENTER / DEBUG_STATE_READY.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { HandInputData } from "SpectaclesInteractionKit.lspkg/Providers/HandInputData/HandInputData"
import { BrainLink } from "./BrainLink"
import { FlyBoard } from "./FlyBoard"
import { FlyBody } from "./FlyBody"
import { FlyConfig } from "./FlyConfig"
import { FlyScenarios } from "./FlyScenarios"
import { FlyFx, makeQuadMesh } from "./FlyFx"
import { FlyPose, FlySenses, Source, WorldSources, SourceClass } from "./WorldSources"
import { WorldScanner } from "./WorldScanner"
import { FlyEyes } from "./FlyEyes"
import { FlyNarrator } from "./FlyNarrator"
import { FlyCommands } from "./FlyCommands"
import { FlySound } from "./FlySound"
import { FlyEars } from "./FlyEars"
import { FlyVision } from "./FlyVision"
import { WorldColorBake } from "./WorldColorBake"
import { NeonBatch, NeonQuadSet } from "./UIBatch"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { InteractableManipulation } from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation"
import { ContainerFrame } from "SpectaclesInteractionKit.lspkg/Components/UI/ContainerFrame/ContainerFrame"
import { SIK } from "SpectaclesInteractionKit.lspkg/SIK"

const log = new NativeLogger("FlySwarm")
const UP = new vec3(0, 1, 0)
const FAR = new vec3(0, -100000, 0)

@component
export class FlySwarm extends BaseScriptComponent {
  @input flyPrefab: ObjectPrefab
  @input cameraObject: SceneObject
  @input
  @allowUndefined
  @hint("FlyHolo material (neon rim hologram); cloned per fly")
  holoMaterial: Material
  @input
  @allowUndefined
  @hint("NeonQuad material: status board, selected-fly glow + trail")
  neonMaterial: Material
  @input
  @allowUndefined
  @hint("BrainCloud material: 16,000-neuron hologram of the selected fly's brain")
  brainMaterial: Material
  @input
  @allowUndefined
  @hint("fly_lod1 prefab: the mini hologram on the board that mirrors the selected fly")
  miniFlyPrefab: ObjectPrefab
  @input
  @allowUndefined
  @hint("Board words font (titles, labels): Chakra Petch SemiBold")
  uiFont: Font
  @input
  @allowUndefined
  @hint("Board numbers font (tabular digits, no jitter): Share Tech Mono")
  monoFont: Font
  @input
  @allowUndefined
  @hint("World Mesh object (preset): shown while the room is scanned at the start")
  worldMeshObject: SceneObject
  @input
  @allowUndefined
  @hint("WorldScanGrid material: light neon grid on the world mesh, dissolves after the scan")
  scanGridMaterial: Material
  @input
  @allowUndefined
  @hint("NeonBatch material: every board quad + the eye dots in one draw call each (perf)")
  neonBatchMaterial: Material
  @input
  @allowUndefined
  @hint("VisionColor material: baked room colours on the world-mesh copy the fly-eye cameras see")
  visionColorMaterial: Material
  @input
  @allowUndefined
  @hint("fly_buzz.wav: wingbeat loop (audio/gen_fly_sounds.py)")
  buzzTrack: AudioTrackAsset
  @input
  @allowUndefined
  @hint("fly_song.wav: courtship song loop, plays while pIP10 fires")
  songTrack: AudioTrackAsset
  @input
  @allowUndefined
  @hint("Fly/Audio/Microphone.micaudio: the Spectacles mic -> hearing (FlyEars, JO-A/B)")
  micTrack: AudioTrackAsset
  @input @allowUndefined markerMesh: RenderMesh
  @input @allowUndefined markerMaterial: Material
  @input
  @allowUndefined
  @hint("Treat prefab (Fly/Treats): a long LEFT pinch drops one — food the flies smell, land on and eat")
  treatPrefab: ObjectPrefab
  @input
  @allowUndefined
  @hint("MaleCNS brain outline mesh (Fly/Anatomy/brain_shell.glb) drawn around the live brain cloud")
  brainShell: ObjectPrefab
  @input
  @allowUndefined
  @hint("MaleCNS VNC outline mesh (Fly/Anatomy/vnc_shell.glb)")
  vncShell: ObjectPrefab
  @input showSourceMarkers: boolean = true
  @input flyCount: number = 5
  @input
  @hint("none | lure_front | food_left | food_right | threat_approach")
  debugScenario: string = "none"

  private link = new BrainLink()
  private sources: WorldSources
  private flies: FlyBody[] = []
  private senses: FlySenses[] = []
  private flySrc: Source[] = [] // each fly's own body as a source the OTHER flies see
  private hands: HandInputData
  private centre: vec3
  private senseT: number[] = [] // per-fly sense clocks (staggered: one fly per frame)
  private eyeT: number[] = [] // ...and a slower clock for the eye rays (EYE_HZ), whose view is cached
  private lastView: any[] = []
  private selected = 0
  private head: Source
  private leftHand: Source
  private rightHand: Source
  private lure: Source | null = null
  // treats (11.09): long left pinch spawns one at the pinch, release drops it; each is a food source
  private treats: { so: SceneObject; src: Source }[] = []
  private carried: { so: SceneObject; src: Source } | null = null
  private pinchHeldT = -1
  private treatN = 0
  private debugThreat: Source | null = null
  private debugT = 0
  private dbgTimer = 0
  private board: FlyBoard | null = null
  private fx: FlyFx | null = null
  private scanner: WorldScanner | null = null
  private eyes: FlyEyes | null = null
  private fxRoot: SceneObject | null = null
  private narrator: FlyNarrator | null = FlyConfig.NARRATE_ENABLED ? new FlyNarrator() : null
  private scn: FlyScenarios | null = null // editor closed-loop bench (ADR 34)
  private cmds: FlyCommands | null = null // voice find: ASK -> "find the apple" -> lure (ADR 27)
  private gridMat: Material | null = null
  private sound: FlySound | null = null
  private ears: FlyEars | null = null // hearing: mic onsets -> JO-A/B `sound` (ADR 29)
  private vision: FlyVision | null = null
  private bake: WorldColorBake | null = null
  private worldMeshOnVision = false
  private dissolveT = -1 // >= 0 while the scan grid burns away after the intro
  private introAge = 0
  private introT = FlyConfig.INTRO_SCAN_S // room scan first: flies appear after it

  onAwake() {
    this.hands = HandInputData.getInstance()
    this.createEvent("OnStartEvent").bind(() => this.start())
    this.createEvent("UpdateEvent").bind(() => this.tick(getDeltaTime()))
  }

  private start() {
    // Handedness check: right-handed +90 deg about +Y must turn +X into -Z (left of a +X
    // facing fly), which FlyBody's "steer right = -yaw" assumes.
    const q = quat.angleAxis(Math.PI / 2, UP).multiplyVec3(new vec3(1, 0, 0))
    log.w("QUAT_CHECK +90y*(+X) = " + q.x.toFixed(2) + "," + q.y.toFixed(2) + "," + q.z.toFixed(2) + " (expect 0,0,-1)")
    const camT = this.cameraObject.getTransform()
    const camPos = camT.getWorldPosition()
    let look = camT.back // the camera looks along its back vector
    look = new vec3(look.x, 0, look.z).normalize()
    const right = look.cross(UP).normalize()
    this.centre = camPos.add(look.uniformScale(FlyConfig.SPAWN_DIST_CM))

    const markers = global.scene.createSceneObject("FlySources")
    this.sources = new WorldSources(markers, this.markerMesh || null, this.markerMaterial || null, this.showSourceMarkers)
    this.head = this.sources.add("user_head", "threat", camPos, FlyConfig.HEAD_SIZE_CM, -1, false)
    this.head.seen = false
    this.leftHand = this.sources.add("left_hand", "threat", FAR, 12, -1, false)
    this.rightHand = this.sources.add("right_hand", "threat", FAR, 12, -1, false)
    if (FlyConfig.SCAN_ENABLED) this.scanner = new WorldScanner(this.sources, this.cameraObject, this.uiFont || null)

    const n = Math.max(1, Math.min(this.flyCount, FlyConfig.FLY_COUNT))
    const band = FlyConfig.CRUISE_ALT_CM
    for (let i = 0; i < n; i++) {
      const offset = (i - (n - 1) / 2) * FlyConfig.SPAWN_SPREAD_CM
      const pos = this.centre.add(right.uniformScale(offset)).add(new vec3(0, (band[0] + band[1]) / 2, 0))
      const want = look.uniformScale(-1) // face the user
      const yaw = Math.atan2(-want.z, want.x)
      const container = global.scene.createSceneObject("Fly_" + i)
      // the GLB is built MODEL_LENGTH_CM long; LENGTH_CM is the fly we want (11.09: the "2x smaller"
      // change never reached the model — nothing scaled it)
      container.getTransform().setLocalScale(vec3.one().uniformScale(FlyConfig.LENGTH_CM / FlyConfig.MODEL_LENGTH_CM))
      const instance = this.flyPrefab.instantiate(container)
      this.applyHolo(i, instance)
      const body = new FlyBody(i, container, instance, pos, yaw, camPos.y)
      body.onLanded = (s: Source) => {
        // reward = a commanded/lured target reached (ADR 14); real food rewards through taste
        if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
          log.i("FLY_LANDED fly=" + i + " on " + s.cls + " '" + s.label + "'" + (s.cls === "lure" ? " -> reward pulse" : ""))
        }
        if (s.cls === "lure") this.link.pulse(i, "reward")
        if (this.cmds) this.cmds.landed(i, s)
      }
      this.flies.push(body)
      this.senses.push(new FlySenses())
      // every fly is a moving object for the others (11.09 "flies should know about each other")
      const self = this.sources.add("fly " + FlyConfig.FLY_NAMES[i % FlyConfig.FLY_NAMES.length].toLowerCase(), "fly", pos, FlyConfig.LENGTH_CM, -1, false)
      self.owner = i
      this.flySrc.push(self)
      log.i("FLY_SPAWN fly=" + i + " bones=" + body.boneCount)
    }

    if (this.neonMaterial) {
      const ui = global.scene.createSceneObject("FlyUI")
      const quad = makeQuadMesh()
      // the board sits in a world-space ContainerFrame (fx stay under `ui` at the root: trails are
      // written in world coordinates and must not ride along with the frame)
      const frameObj = this.makeBoardFrame(camPos, look, right)
      this.board = new FlyBoard(
        frameObj || ui, quad, this.neonMaterial, this.neonBatchMaterial || null,
        this.miniFlyPrefab || null, this.holoMaterial || null, this.brainMaterial || null,
        { ui: this.uiFont || null, mono: this.monoFont || null },
      )
      this.board.framed = frameObj !== null
      this.board.addBrainShells([this.brainShell, this.vncShell].filter((p) => !!p), this.holoMaterial || null)
      if (this.scanner && frameObj) this.scanner.occluder = (p: vec3) => this.behindBoard(p)
      this.board.onTab = (fly: number) => this.selectFly(fly)
      this.fxRoot = global.scene.createSceneObject("FlyFxRoot")
      this.fxRoot.setParent(ui)
      this.fx = new FlyFx(this.fxRoot, quad, this.neonMaterial, this.flies.length)
      this.fx.select(this.selected)
      // eye-hit dots: one world-space batch at the scene root (fallback: one quad each)
      const dots = this.neonBatchMaterial ? new NeonBatch(null, this.neonBatchMaterial, "EyeDots") : new NeonQuadSet(ui, quad, this.neonMaterial, "EyeDots")
      this.eyes = new FlyEyes(this.cameraObject, dots)
    } else this.eyes = new FlyEyes(this.cameraObject, null)
    // voice find (ADR 27): FlyCommands owns ASR + Gemini matching; the one lure slot stays here
    this.cmds = new FlyCommands(this.sources, this.board, {
      flyCount: () => this.flies.length,
      selected: () => this.selected,
      flyHead: (i: number) => this.flies[i].pose().head,
      lure: () => this.lure,
      setLure: (s: Source | null) => {
        this.endLure()
        this.lure = s
        if (s) log.i("LURE_ON fly=" + s.forFly + " '" + s.label + "' (voice find)")
      },
    })
    // hearing (ADR 29): mic onsets -> JO-A/B; paused while ASK's ASR owns the mic
    if (FlyConfig.EAR_ENABLED && this.micTrack) this.ears = new FlyEars(this.micTrack, this.flies.length)
    if (this.ears) this.cmds.onListening = (on: boolean) => this.ears!.pause(on)

    if (FlyConfig.VISION_ENABLED) {
      this.vision = new FlyVision(this.flies.map((f) => f.sceneObject), this.worldMeshObject || null, this.scanGridMaterial || null)
      if (this.visionColorMaterial) {
        // the room's real colours, baked from every scan frame into a voxel-hash texture that the
        // tracked world mesh wears on the vision layer after the intro
        this.bake = new WorldColorBake(this.worldMeshObject || null, this.visionColorMaterial, this.cameraObject)
        // colours bake only while the room is being scanned (11.09: "after the scan we don't
        // generate it anymore") — no 260k-vertex reads or projections afterwards
        if (this.scanner) this.scanner.onFrame = (tex: Texture, camWorld: mat4) => {
          if (this.introT > 0) this.bake!.bake(tex, camWorld)
        }
      }
    }
    if (FlyConfig.SOUND_ENABLED && (this.buzzTrack || this.songTrack)) {
      this.sound = new FlySound(this.flies.map((f) => f.sceneObject), this.buzzTrack || null, this.songTrack || null, this.cameraObject)
    }
    // the editor bench runs quiet: Gemini Live's stream retries (RemoteStreamService start errors every ~9 s)
    // preceded both preview wedges on 11.09 — voice + narration are not needed to test behaviour
    const bench = FlyConfig.AUTO_DEBUG && global.deviceInfoSystem.isEditor()

    const left = this.hands.getHand("left")
    const rightHand = this.hands.getHand("right")
    left.onPinchDown.add(() => {
      this.pinchHeldT = 0 // held long enough -> a treat (tick)
      this.startLure()
    })
    left.onPinchUp.add(() => {
      this.pinchHeldT = -1
      if (this.carried) this.dropTreat()
      else if (this.lure && this.lure.label === "hand_lure") this.endLure() // a voice find stays
    })
    rightHand.onPinchDown.add(() => this.selectNear(this.pinchPoint("right")))

    // editor closed-loop bench (ADR 34): auto start + a scenario playlist; never on the glasses
    if (FlyConfig.AUTO_DEBUG && global.deviceInfoSystem.isEditor()) {
      this.scn = new FlyScenarios({
        flies: this.flies,
        cam: () => this.cameraObject.getTransform(),
        place: () => this.placeFlies(),
        settle: () => this.senses.forEach((s) => s.reset()),
        food: (p: vec3) => {
          const tr = this.makeTreat(p)
          if (tr) return { src: tr.src, remove: () => this.removeTreat(tr) }
          const s = this.sources.add("scn_food", "food", p, 6)
          return { src: s, remove: () => this.sources.remove(s) }
        },
        source: (label: string, cls: SourceClass, p: vec3, sizeCm: number, forFly: number) => this.sources.add(label, cls, p, sizeCm, forFly),
        move: (s: Source, p: vec3) => this.sources.move(s, p),
        drop: (s: Source) => this.sources.remove(s),
        lure: (s: Source | null) => {
          this.endLure()
          this.lure = s
        },
        ray: (a: vec3, b: vec3) => (this.eyes ? this.eyes.blocked(a, b) : null),
        counters: () => ({ walls: this.wallHits, mesh: this.meshHits, floor: this.meshFloor, ceil: this.meshCeil, surf: this.surfaceLandings,
          escMealFly: this.escKind.mealFly, escRestFly: this.escKind.restFly, escAirFly: this.escKind.airFly, escThreat: this.escKind.threat }),
        mesh: () => !!(this.bake && this.bake.frameOk),
        act: (i: number) => {
          const m: any = this.link.latest[i]
          return m && m.act ? m.act : null
        },
      })
    }

    this.link.onStatus = (ok: boolean) => {
      log.i("LINK_STATUS " + (ok ? "connected" : "offline"))
      if (ok) this.link.select(this.selected)
    }
    this.link.connect()
    if (this.debugScenario === "skip_intro") this.introT = 0 // dev runs without pressing DONE SCANNING
    // no intro -> the world mesh must leave OUR view straight away (it showed the preset's
    // normal-coloured triangles over the room in skip_intro runs, 11.09)
    if (this.introT <= 0) this.hideWorldMesh()
    if (this.introT > 0) {
      // intro room scan: the world mesh builds while the user looks around, Gemini runs back-to-back
      for (const f of this.flies) f.setVisible(false)
      if (this.fxRoot) this.fxRoot.enabled = false
      if (this.scanner) this.scanner.setInterval(FlyConfig.SCAN_INTRO_EVERY_S)
      if (this.worldMeshObject) {
        this.worldMeshObject.enabled = true // the mesh grows as you look around
        if (FlyConfig.SCAN_GRID_SHOW) this.gridMat = this.applyScanGrid(this.worldMeshObject)
        // 12.09 the user: "the world mesh is only for the flies". Without the grid it goes straight
        // onto the vision layer instead of staying unseen-but-enabled on the main camera — the user
        // never sees the room mesh, the fly eyes do. This line is load-bearing: hideWorldMesh()
        // only changes layer and material, it NEVER sets enabled, and the line above is the one
        // place the mesh is ever enabled. Gating that line (as I first did) left the mesh disabled
        // for good: blank retinas, and worldMeshOnVision true so even the synthetic fallback went.
        else this.hideWorldMesh()
      }
      if (this.board) {
        this.board.showScanButton(true)
        this.board.onScanDone = () => {
          if (this.introT > 0) this.endIntro()
        }
      }
      log.i("DEBUG_STATE_ENTER intro_scan " + FlyConfig.INTRO_SCAN_S + "s")
    } else this.seedDebug()
    if (this.introT <= 0 && this.cmds) this.cmds.setEnabled(true)
    log.i("DEBUG_STATE_READY swarm flies=" + n + " scenario=" + this.debugScenario)
  }

  /** Swap the GLB materials for per-fly clones of the hologram (body + wings). */
  private holoMats: Material[][] = []
  private applyHolo(fly: number, instance: SceneObject) {
    const mats: Material[] = []
    if (this.holoMaterial) {
      const color = FlyConfig.FLY_COLORS[fly % FlyConfig.FLY_COLORS.length]
      const accent = FlyConfig.FLY_ACCENTS[fly % FlyConfig.FLY_ACCENTS.length]
      const visit = (so: SceneObject) => {
        for (const rmv of so.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]) {
          const isWing = rmv.mainMaterial && rmv.mainMaterial.name.indexOf("wing") >= 0
          const m = this.holoMaterial.clone()
          m.mainPass.rimColor = color
          m.mainPass.bodyColor = accent
          // multiply the material's own values: Inspector tuning of FlyHolo stays live
          m.mainPass.glow = this.baseGlow() * (fly === this.selected ? FlyConfig.GLOW_SELECTED : FlyConfig.GLOW_IDLE)
          if (isWing) m.mainPass.bodyGlow = this.baseBodyGlow() * FlyConfig.WING_BODY_GLOW
          rmv.mainMaterial = m
          mats.push(m)
        }
        for (let c = 0; c < so.getChildrenCount(); c++) visit(so.getChild(c))
      }
      visit(instance)
    }
    this.holoMats[fly] = mats
  }

  private baseGlow(): number {
    const g = this.holoMaterial ? this.holoMaterial.mainPass.glow : 1
    return typeof g === "number" ? g : 1
  }

  private baseBodyGlow(): number {
    const g = this.holoMaterial ? this.holoMaterial.mainPass.bodyGlow : 0.06
    return typeof g === "number" ? g : 0.06
  }

  private setGlow(fly: number, factor: number) {
    for (const m of this.holoMats[fly] || []) m.mainPass.glow = this.baseGlow() * factor
  }

  private pinchPoint(side: "left" | "right"): vec3 | null {
    const h = this.hands.getHand(side)
    if (!h.isTracked()) return null
    return h.indexTip.position.add(h.thumbTip.position).uniformScale(0.5)
  }

  private startLure() {
    const p = this.pinchPoint("left")
    if (!p || (this.lure && this.lure.label === "hand_lure")) return
    this.endLure() // a hand lure replaces a voice find (one lure at a time, ADR 27)
    this.lure = this.sources.add("hand_lure", "lure", p, 6, this.selected)
    log.i("LURE_ON fly=" + this.selected)
  }

  private endLure() {
    if (!this.lure) return
    this.sources.remove(this.lure)
    this.lure = null
    log.i("LURE_OFF")
  }

  /** A treat at the left pinch: the generated prefab (1 cm mesh x prefab scale) at TREAT_CM, a
   *  collider + Interactable + InteractableManipulation so it can be picked up and moved later,
   *  and a food source the flies smell, land on and taste (sweet -> MN9 feeding -> energy). */
  private spawnTreat() {
    const p = this.pinchPoint("left")
    if (!p || !this.treatPrefab) return
    this.endLure() // the treat replaces the hand lure
    const tr = this.makeTreat(p)
    if (tr) this.carried = tr
  }

  /** A treat wears the same hologram shader as the flies (12.09 the user: "take the apple's material
   *  holographic, like the flies"), in its own colour pair so it still reads as food. This also
   *  settles the lighting: the scene has no lights any more, and the GLB's own pass is a LIT glTF
   *  one (`ENABLE_GLTF_LIGHTING`, emissive 0) that would have drawn black. Clones only — FlyHolo's
   *  material values stay the user's (ADR 17). */
  private holoTreat(root: SceneObject) {
    const holo = this.holoMaterial
    if (!holo) return
    const visit = (o: SceneObject) => {
      for (const rmv of o.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]) {
        const m = holo.clone()
        const p: any = m.mainPass
        p.rimColor = FlyConfig.TREAT_RIM
        p.bodyColor = FlyConfig.TREAT_BODY
        p.glow = this.baseGlow() * FlyConfig.GLOW_IDLE
        rmv.mainMaterial = m
      }
      for (let i = 0; i < o.getChildrenCount(); i++) visit(o.getChild(i))
    }
    visit(root)
  }

  private removeTreat(tr: { so: SceneObject; src: Source }) {
    this.treats = this.treats.filter((x) => x !== tr)
    if (this.carried === tr) this.carried = null
    this.sources.remove(tr.src)
    tr.so.destroy()
  }

  /** A treat object at p (also the editor bench's auto-spawned food). */
  private makeTreat(p: vec3): { so: SceneObject; src: Source } | null {
    if (!this.treatPrefab) return null
    if (this.treats.length >= FlyConfig.TREAT_MAX) this.removeTreat(this.treats[0])
    const so = global.scene.createSceneObject("Treat_" + this.treatN++)
    so.getTransform().setWorldPosition(p)
    const inst = this.treatPrefab.instantiate(so)
    inst.getTransform().setLocalScale(vec3.one().uniformScale(FlyConfig.TREAT_CM)) // generated mesh = 1 cm longest axis
    this.holoTreat(inst)
    const col = so.createComponent("Physics.ColliderComponent") as ColliderComponent
    const shape = Shape.createSphereShape()
    shape.radius = FlyConfig.TREAT_CM * 0.6
    col.shape = shape
    so.createComponent(Interactable.getTypeName())
    so.createComponent(InteractableManipulation.getTypeName())
    const tr = { so: so, src: this.sources.add("treat", "food", p, 6, -1, false) }
    this.treats.push(tr)
    log.i("TREAT_SPAWN #" + this.treatN + " live=" + this.treats.length)
    return tr
  }

  private dropTreat() {
    if (!this.carried) return
    const p = this.carried.so.getTransform().getWorldPosition()
    log.i("TREAT_DROP at " + p.x.toFixed(0) + "," + p.y.toFixed(0) + "," + p.z.toFixed(0))
    this.carried = null
  }

  /** The board in world space inside a SIK ContainerFrame: hover its edge and drag to move it
   *  anywhere in the room (11.09 "world-space UI I move with the UI kit tools; off the hand"). */
  private makeBoardFrame(camPos: vec3, look: vec3, right: vec3): SceneObject | null {
    if (!FlyConfig.BOARD_IN_FRAME) return null
    try {
      const so = global.scene.createSceneObject("BoardFrame")
      const pos = camPos.add(look.uniformScale(FlyConfig.BOARD_FRAME_DIST_CM))
        .add(right.uniformScale(FlyConfig.BOARD_FRAME_RIGHT_CM)).add(new vec3(0, -FlyConfig.BOARD_FRAME_DOWN_CM, 0))
      const t = so.getTransform()
      t.setWorldPosition(pos)
      t.setWorldRotation(quat.lookAt(camPos.sub(pos).normalize(), UP))
      const frame = so.createComponent(ContainerFrame.getTypeName()) as ContainerFrame
      frame.innerSize = new vec2(FlyConfig.BOARD_FRAME_W_CM, FlyConfig.BOARD_FRAME_H_CM)
      frame.showCloseButton = false
      frame.autoScaleContent = false
      // 11.09 device: hovering the board showed the frame's backing plate over our UI and the whole
      // plate dragged. Only the border stays: centre cut out, no interaction plane behind the content.
      try {
        const f: any = frame
        f.cutOutCenter = true
        f.enableInteractionPlane = false
      } catch (e) {
        log.w("BOARD_FRAME border-only unsupported: " + e)
      }
      // SIK counts hovering a child (our board rows) as hovering the frame, so its own auto show
      // lit the move frame over the parameters (11.09). We show it only on the border / drag.
      frame.autoShowHide = false
      this.boardFrame = frame
      this.boardFrameObj = so
      log.i("BOARD_FRAME at " + pos.x.toFixed(0) + "," + pos.y.toFixed(0) + "," + pos.z.toFixed(0))
      return so
    } catch (e) {
      log.w("BOARD_FRAME failed, hand board instead: " + e)
      return null
    }
  }

  private boardFrame: ContainerFrame | null = null
  private boardFrameObj: SceneObject | null = null
  private frameShown: boolean | null = null
  private frameEdgeT = 0
  private frameAge = 0
  private lastFramePos: vec3 | null = null
  private frameMoveT = 0

  /** Is world point p hidden behind the board from the user's eye? (eye->p ray crosses the board
   *  rectangle before reaching p) — Gemini's room labels behind the panel are hidden. */
  private retinaWhy = false // the one-shot "why is there no retina" diagnostic has been printed
  private dust: number[] = [] // bristle load per fly: picked up by contact and wind, cleaned by grooming
  private flyPosBuf: vec3[] = [] // reused: `this.flies.map(f => f.pos)` allocated an array EVERY frame
  private flyMsgBuf: any[] = [] // ...and so did the brain-message list the sound tick takes
  private invAt = -1
  private invM: mat4 | null = null
  private invCam: vec3 | null = null
  private behindBoard(p: vec3): boolean {
    const obj = this.boardFrameObj
    if (!obj || !this.board) return false
    // one matrix inverse + one camera read per FRAME, not per label: with a scanned room this ran up
    // to 24 times a frame (12.09 audit), and it grew as Gemini found more things
    const now = getTime()
    if (this.invAt !== now) {
      this.invAt = now
      this.invM = obj.getTransform().getInvertedWorldTransform()
      this.invCam = this.invM.multiplyPoint(this.cameraObject.getTransform().getWorldPosition())
    }
    const inv = this.invM!
    const c = this.invCam!
    const q = inv.multiplyPoint(p)
    if (c.z * q.z >= 0) return false // same side of the board plane
    const t = c.z / (c.z - q.z)
    const x = c.x + (q.x - c.x) * t
    const y = c.y + (q.y - c.y) * t
    return Math.abs(x) < FlyConfig.BOARD_FRAME_W_CM / 2 && Math.abs(y) < FlyConfig.BOARD_FRAME_H_CM / 2 + 8 // + the DONE button
  }

  /** The move frame shows only while a cursor is on its BORDER band (or it is being dragged),
   *  never while the cursor moves over the board's rows (11.09 device test). */
  private updateFrameVisibility(dt: number) {
    const frame = this.boardFrame
    const obj = this.boardFrameObj
    if (!frame || !obj) return
    this.frameAge += dt
    const inv = obj.getTransform().getInvertedWorldTransform()
    const hw = FlyConfig.BOARD_FRAME_W_CM / 2
    const hh = FlyConfig.BOARD_FRAME_H_CM / 2
    const e = FlyConfig.BOARD_FRAME_EDGE_CM
    const out = FlyConfig.BOARD_FRAME_BORDER_CM
    let onEdge = false
    let dragging = false
    for (const it of SIK.InteractionManager.getTargetingInteractors()) {
      const p = it.targetHitPosition
      if (p) {
        const l = inv.multiplyPoint(p)
        const ax = Math.abs(l.x)
        const ay = Math.abs(l.y)
        if (ax < hw + out && ay < hh + out && (ax > hw - e || ay > hh - e)) onEdge = true
      }
      if (this.frameShown && (it as any).currentTrigger) dragging = true // keep it while a drag runs
    }
    // Grabbed and moving -> turn to face the user (11.09 "when I grab the panel it should look at
    // me"). The frame's own billboard is set up only in its onAwake (before we configure it), so
    // we detect the move by position and slerp the frame towards the camera, a moment past the move.
    const ft = obj.getTransform()
    const fp = ft.getWorldPosition()
    if (this.lastFramePos && fp.distance(this.lastFramePos) > 0.05) this.frameMoveT = 0.3
    this.lastFramePos = fp
    if (this.frameMoveT > 0) {
      this.frameMoveT -= dt
      const cam = this.cameraObject.getTransform().getWorldPosition()
      const want = quat.lookAt(cam.sub(fp).normalize(), UP)
      ft.setWorldRotation(quat.slerp(ft.getWorldRotation(), want, 1 - Math.exp(-dt * 10)))
    }
    this.frameEdgeT = onEdge ? FlyConfig.BOARD_FRAME_LINGER_S : this.frameEdgeT - dt
    const want = this.frameEdgeT > 0 || dragging
    // the frame's own start shows its visual once: keep asserting for the first moments
    if (want !== this.frameShown || this.frameAge < 1.5) {
      if (want) frame.showVisual()
      else frame.hideVisual()
      this.frameShown = want
    }
  }

  // ---- Easter egg (11.09 the user): two flies mating in a corner of the room ----
  // Pure decoration, NO brains and not sensed by the real flies: two FlyBody rigs parked in the
  // "landed" state on fixed perches (real landed pose, folded wings), the male on the female's back
  // bobbing. Spawned when the room scan ends, in the scanned floor corner nearest the user.
  private meme: { body: FlyBody; perch: Source }[] = []
  private memeBase: vec3 | null = null
  private memeYaw = 0
  private memeT = 0

  private perchFor(bodyPos: vec3, yaw: number): vec3 {
    // FlyBody (landed) puts the body at perch - fwd * HEAD_OFFSET_CM + 3 cm up: invert that
    const fwd = new vec3(Math.cos(yaw), 0, -Math.sin(yaw))
    return bodyPos.add(fwd.uniformScale(FlyConfig.HEAD_OFFSET_CM)).sub(new vec3(0, FlyConfig.LANDED_LIFT_CM, 0))
  }

  private spawnMeme() {
    if (!FlyConfig.MEME_ENABLED || this.meme.length > 0 || !this.flyPrefab) return
    const cam = this.cameraObject.getTransform().getWorldPosition()
    // 12.09 the user: "let the meme flies spawn somewhere near me, they are all off-camera". They used
    // to take the nearest corner of the scanned room box, and the nearest corner is still a corner —
    // easily behind you. Now they always go in front, where the fallback branch already put them.
    // The room-box corner search went with it, and MEME_CORNER_INSET_CM with that.
    const t = this.cameraObject.getTransform()
    const look = new vec3(t.back.x, 0, t.back.z).normalize()
    const left = UP.cross(look).normalize()
    let spot = cam.add(look.uniformScale(150)).add(left.uniformScale(70)).add(new vec3(0, -130, 0))
    // settle on the real floor under that spot (world mesh), if it's scanned
    const floor = this.eyes ? this.eyes.blocked(spot.add(new vec3(0, 120, 0)), spot.sub(new vec3(0, 200, 0))) : null
    if (floor) spot = floor.pos
    const toCam = new vec3(cam.x - spot.x, 0, cam.z - spot.z)
    this.memeYaw = Math.atan2(-toCam.z, toCam.x) + 0.9 // three-quarter view from the user
    this.memeBase = spot.add(new vec3(0, FlyConfig.MEME_LIFT_CM, 0))
    for (let k = 0; k < 2; k++) {
      const container = global.scene.createSceneObject(k === 0 ? "Meme_Female" : "Meme_Male")
      container.getTransform().setLocalScale(vec3.one().uniformScale(FlyConfig.LENGTH_CM / FlyConfig.MODEL_LENGTH_CM))
      const instance = this.flyPrefab.instantiate(container)
      this.applyHolo(3 + k, instance) // the two unused fly colours (amber, violet)
      const body = new FlyBody(10 + k, container, instance, this.memeBase, this.memeYaw, spot.y)
      const perch: Source = {
        id: "meme_" + k, label: "meme", cls: "object", pos: this.perchFor(this.memeBase, this.memeYaw),
        sizeCm: 1, sigma: 0, strength: 0, forFly: -1, active: false, seen: false, marker: null, shell: null,
      }
      body.state = "landed"
      body.landedOn = perch
      this.meme.push({ body: body, perch: perch })
    }
    log.i("MEME_SPAWN at " + spot.x.toFixed(0) + "," + spot.y.toFixed(0) + "," + spot.z.toFixed(0))
  }

  // 12.09 audit: the easter-egg pair was 2 of the 5 fully animated bodies every frame (25 bone
  // writes each) for a decoration in a corner. It runs at 15 Hz on its own accumulated dt.
  private memeAnimT = 0
  private tickMeme(dt: number) {
    if (this.meme.length < 2 || !this.memeBase) return
    this.memeAnimT += dt
    if (this.memeAnimT < 1 / 15) return
    const mdt = this.memeAnimT
    this.memeAnimT = 0
    this.memeT += mdt
    const yaw = this.memeYaw
    const fwd = new vec3(Math.cos(yaw), 0, -Math.sin(yaw))
    const L = FlyConfig.LENGTH_CM
    const bob = FlyConfig.MEME_BOB_CM * Math.max(0, Math.sin(this.memeT * Math.PI * 2 * FlyConfig.MEME_BOB_HZ))
    const top = this.memeBase.add(new vec3(0, L * 0.22 + bob, 0)).sub(fwd.uniformScale(L * 0.14))
    this.meme[1].perch.pos = this.perchFor(top, yaw)
    for (const m of this.meme) {
      m.body.setBrain(null, mdt)
      m.body.update(mdt, m.perch, this.centre, this.head.pos)
    }
  }

  // ---- landing on any surface (SURFACE_LANDING, 11.09 "they can land on walls, on anything") ----
  // The model's landing DNs don't respond to loom (atlas), so the trigger is the brain wanting to
  // stop (DNpe007) or losing forward drive for a moment while a surface is within reach of its eye
  // rays: it settles on the nearest one. Walking + take-off are the brain's (FlyBody). Disclosed.
  private stillT: number[] = []
  private boutScanT: number[] = []
  private surfaceLandings = 0
  private surfaceLogic(f: FlyBody, i: number, dt: number) {
    if (!FlyConfig.SURFACE_LANDING || !this.eyes) return
    // hungry and smelling food -> a short stay on a surface, then off to look for it (ADR 35;
    // a starving fly used to sit out the full 40 s dwell)
    f.forage = f.energy < FlyConfig.FOOD_HUNGRY && this.senses[i].odorLevel > FlyConfig.FORAGE_ODOR
    if (f.state === "landed" && f.surfaceNormal) {
      // still easing onto the touch-down anchor: the edge ray would miss and read as 'walked off'
      // (12.09 bench: 10 landings per 40 s instead of 1-2, each under a second)
      if (!f.settled) return
      // ...and the same round-robin: a settled fly re-checks its perch on its own turn, not every
      // frame. Skipping the cast must skip the takeOff() below it too, or a fly would fall off its
      // surface on every frame that is not its turn.
      if (FlyConfig.WALL_RAY_STAGGER && f.index !== this.rayTurn) return
      // stay attached while walking: re-cast along the normal (curved surfaces, edges)
      const n = f.surfaceNormal
      const hit = this.eyes.blocked(f.pos.add(n.uniformScale(6)), f.pos.sub(n.uniformScale(12)))
      if (hit) {
        let hn = hit.normal.length > 0.01 ? hit.normal.normalize() : n
        if (hn.dot(n) < 0) hn = hn.uniformScale(-1)
        f.stickTo(hit.pos, hn)
      } else f.takeOff() // walked off an edge
      return
    }
    if (f.state !== "air") {
      this.stillT[i] = 0
      return
    }
    const m: any = this.link.latest[i]
    const a = m && m.act ? m.act : null
    // Landing response on a head-on approach (Tammero & Dickinson 2002: expansion centred ahead ->
    // land, off to one side -> saccade away). The saccade is the brain's (LPLC1 -> DNp03 `avoid`);
    // a fly whose brain does NOT turn from a surface right ahead touches down on it. Engineered
    // gate, disclosed (ADR 35).
    // Flight bout over (ADR 35): the fly commits to the next surface in reach — unless it is homing on
    // food, a lure or a palm (it lands there instead).
    const lureI = this.lure && (this.lure.forFly < 0 || this.lure.forFly === i) ? this.lure : null
    const tired = FlyConfig.FLIGHT_BOUT && f.airT > f.boutS && !(lureI || this.foodTarget(f) || this.palmTarget(f))
    if (FlyConfig.LAND_ON_APPROACH && a && (tired || Math.abs(a.avoid || 0) < FlyConfig.LAND_AVOID_MAX) && f.speed > 3) {
      const pa = f.pose()
      const reach = tired ? FlyConfig.SURFACE_LAND_CM : FlyConfig.LAND_REACH_CM
      const hit = this.eyes.blocked(pa.head, pa.head.add(pa.fwd.uniformScale(reach)))
      if (hit) {
        const out = pa.head.sub(hit.pos)
        let hn = hit.normal.length > 0.01 ? hit.normal.normalize() : out.normalize()
        if (hn.dot(out) < 0) hn = hn.uniformScale(-1)
        if (-hn.dot(pa.fwd) > FlyConfig.LAND_FRONTAL_COS) {
          f.landOnSurface(hit.pos, hn)
          this.stillT[i] = 0
          this.surfaceLandings++
          if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
            log.i("SURFACE_LAND fly=" + i + " head-on n=" + hn.x.toFixed(2) + "," + hn.y.toFixed(2) + "," + hn.z.toFixed(2))
          }
          return
        }
      }
    }
    const wants = a && (a.stop > FlyConfig.SURFACE_STOP || a.forward < FlyConfig.SURFACE_IDLE_FWD)
    this.stillT[i] = wants ? (this.stillT[i] || 0) + dt : 0
    f.perch = tired ? this.eyes.nearestHit(i, f.pos) : null
    if (tired) {
      // a tired fly looks around for a surface every BOUT_SCAN_S (5 short rays), not every frame
      this.boutScanT[i] = (this.boutScanT[i] || 0) + dt
      if (this.boutScanT[i] < FlyConfig.BOUT_SCAN_S) return
      this.boutScanT[i] = 0
    } else if (this.stillT[i] < FlyConfig.SURFACE_WANT_S) return
    const p = f.pose()
    const R = FlyConfig.SURFACE_LAND_CM
    let best: { pos: vec3; normal: vec3 } | null = null
    let bd = 1e9
    for (const dir of [p.fwd, UP.uniformScale(-1), p.left, p.left.uniformScale(-1), UP]) {
      const hit = this.eyes.blocked(p.head, p.head.add(dir.uniformScale(R)))
      if (!hit) continue
      const d = hit.pos.distance(p.head)
      if (d < bd) {
        bd = d
        best = hit
      }
    }
    if (!best) return
    const out = p.head.sub(best.pos)
    let n = best.normal.length > 0.01 ? best.normal.normalize() : out.normalize()
    if (n.dot(out) < 0) n = n.uniformScale(-1) // the side facing the fly
    f.landOnSurface(best.pos, n)
    this.stillT[i] = 0
    this.surfaceLandings++
    if (FlyConfig.DEBUG_TELEMETRY_S > 0) {
      log.i("SURFACE_LAND fly=" + i + " n=" + n.x.toFixed(2) + "," + n.y.toFixed(2) + "," + n.z.toFixed(2))
    }
  }

  private selectNear(p: vec3 | null) {
    if (!p) return
    let best = -1
    let bestD = 35
    this.flies.forEach((f, i) => {
      const d = f.pos.sub(p).length
      if (d < bestD) {
        best = i
        bestD = d
      }
    })
    if (best >= 0) this.selectFly(best)
  }

  /** One entry path for selection: right pinch near a fly, or a board tab (SIK). */
  private selectFly(fly: number) {
    if (fly === this.selected || fly < 0 || fly >= this.flies.length) return
    this.setGlow(this.selected, FlyConfig.GLOW_IDLE)
    this.setGlow(fly, FlyConfig.GLOW_SELECTED)
    this.selected = fly
    if (this.fx) this.fx.select(fly)
    this.link.select(fly)
    log.i("FLY_SELECT fly=" + fly)
  }

  private seedDebug() {
    const s = this.debugScenario
    if (s === "none" || !s) return
    log.i("DEBUG_STATE_ENTER " + s)
    const f0 = this.flies[0].pose()
    if (s === "lure_front") this.lure = this.sources.add("debug_lure", "lure", f0.head.add(f0.fwd.uniformScale(70)), 6, 0)
    if (s === "food_left") this.sources.add("debug_food", "food", f0.head.add(f0.fwd.uniformScale(60)).add(f0.left.uniformScale(60)), 15)
    if (s === "food_right") this.sources.add("debug_food", "food", f0.head.add(f0.fwd.uniformScale(60)).sub(f0.left.uniformScale(60)), 15)
    if (s === "threat_approach") this.debugThreat = this.sources.add("debug_threat", "threat", f0.head.add(f0.fwd.uniformScale(150)), 20)
  }

  /** After the scan the world mesh leaves OUR view but is never switched off: it moves onto the
   *  flies' vision layer (the main camera renders layer 1 only), so the tracked mesh keeps
   *  updating for the fly eyes, their cameras and the colour bake. */
  private hideWorldMesh() {
    const wm = this.worldMeshObject
    if (!wm || FlyConfig.WORLD_MESH_AFTER_INTRO) return
    if (this.vision) {
      const layer = this.vision.visionLayer
      const mat = this.bake ? this.bake.material : null
      const visit = (so: SceneObject) => {
        so.layer = layer
        // it now wears the baked room colours (VisionHash) for the fly eyes
        if (mat) for (const rmv of so.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]) rmv.mainMaterial = mat
        for (let i = 0; i < so.getChildrenCount(); i++) visit(so.getChild(i))
      }
      visit(wm)
      this.worldMeshOnVision = !!mat
    } else wm.enabled = false
  }

  /** Swap the world mesh visual's material for a clone of the neon scan grid. */
  private applyScanGrid(root: SceneObject): Material | null {
    if (!this.scanGridMaterial) return null
    const m = this.scanGridMaterial.clone()
    const p: any = m.mainPass
    // 5.15: a clone resets graph defaults — set everything
    p.tint = FlyConfig.FLY_COLORS[1] // RoomPaint: `tint`, a uniform named `color` fails the device compiler
    p.intensity = 0
    p.dissolve = 0
    p.cell = FlyConfig.SCAN_GRID_CELL_CM
    if (this.bake) {
      // ScanPaint: the grid takes the room's colours as they bake (11.09 "not blue — scan colours")
      p.colors = this.bake.texture
      p.voxel = FlyConfig.BAKE_VOXEL_CM
    }
    p.blendMode = BlendMode.Add
    p.depthWrite = false
    p.twoSided = true
    const visit = (so: SceneObject) => {
      for (const rmv of so.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]) {
        rmv.mainMaterial = m
        rmv.enabled = true // (11.09: the component itself had been switched off by mistake)
      }
      for (let i = 0; i < so.getChildrenCount(); i++) visit(so.getChild(i))
    }
    visit(root)
    return m
  }

  /** End of the room scan: flies appear in front of wherever the user looks now; scan goes non-stop. */
  private endIntro() {
    this.introT = 0
    this.placeFlies()
    if (this.fxRoot) this.fxRoot.enabled = true
    // the scan grid dissolves (tick) and then the visual is switched off — the DeviceTracking
    // world mesh stays: the flies' eyes cast their rays against it
    this.dissolveT = this.gridMat && FlyConfig.SCAN_GRID_DISSOLVE_S > 0 ? 0 : -1
    // 12.09 the user, watching Spectacles Monitor climb (Logic Touch 78 -> 93 % over 2.5 min): "the
    // world mesh has to be simplified, and stop reconstructing it". We switched reconstruction on
    // and never switched it off, and the room stops changing the moment the scan ends. Keep the
    // mesh we already have — the eye rays query it — and stop rebuilding it.
    if (this.eyes && !FlyConfig.MESH_TRACK_AFTER_SCAN) this.eyes.setMeshTracking(false)
    if (this.dissolveT < 0) this.hideWorldMesh() // no grid, or no dissolve wanted: drop it at once
    // bench: Gemini scanning pauses after the intro (network load + reproducible scenarios)
    if (this.scanner) {
      const every = !FlyConfig.SCAN_AFTER_INTRO ? 1e6 // the room is scanned; camera + depth go quiet
        : this.scn ? FlyConfig.BENCH_SCAN_EVERY_S
        : global.deviceInfoSystem.isEditor() ? FlyConfig.EDITOR_SCAN_EVERY_S
        : FlyConfig.SCAN_EVERY_S
      this.scanner.setInterval(every)
    }
    this.spawnMeme() // easter egg in the scanned room corner
    if (this.board) {
      this.board.setBanner(null)
      this.board.showScanButton(false)
    }
    if (this.cmds) this.cmds.setEnabled(true) // ASK takes the DONE SCANNING slot
    this.seedDebug()
    if (this.scn) this.scn.begin()
    log.i("DEBUG_STATE_READY intro_scan done, sources=" + (this.scanner ? this.scanner.liveCount : 0))
  }

  /** Flies in a row in front of wherever the user looks (end of the intro; bench scenario resets). */
  private placeFlies() {
    const camT = this.cameraObject.getTransform()
    const camPos = camT.getWorldPosition()
    let look = camT.back
    look = new vec3(look.x, 0, look.z).normalize()
    const right = look.cross(UP).normalize()
    this.centre = camPos.add(look.uniformScale(FlyConfig.SPAWN_DIST_CM))
    const n = this.flies.length
    const band = FlyConfig.CRUISE_ALT_CM
    const want = look.uniformScale(-1) // face the user
    const yaw = Math.atan2(-want.z, want.x)
    this.flies.forEach((f, i) => {
      const offset = (i - (n - 1) / 2) * FlyConfig.SPAWN_SPREAD_CM
      let q = this.centre.add(right.uniformScale(offset)).add(new vec3(0, (band[0] + band[1]) / 2, 0))
      // never behind a wall: the user may face one closer than SPAWN_DIST_CM
      const dir = q.sub(camPos).normalize()
      const hit = this.eyes ? this.eyes.blocked(camPos, q.add(dir.uniformScale(20))) : null
      if (hit) q = hit.pos.sub(dir.uniformScale(30))
      f.respawn(q, yaw, camPos.y)
      f.setVisible(true)
    })
    this.senses.forEach((s) => s.reset()) // a teleport is not something rushing at the fly (11.09 bench: an escape at every reset)
  }

  /** The selected fly's live state for its Gemini inner voice (compact JSON). */
  private flyState(i: number): any {
    const f = this.flies[i]
    const msg: any = this.link.latest[i]
    const hz = msg ? msg.hz : {}
    const r1 = (x: any) => (typeof x === "number" ? Math.round(x * 10) / 10 : null)
    const near = this.sources.items
      .filter((s) => s.active && s.pos.y > -50000)
      .map((s) => ({ what: s.label.replace("user_head", "the human").replace("_", " "), kind: s.cls, cm: Math.round(s.pos.distance(f.pos)) }))
      .sort((a, b) => a.cm - b.cm)
      .slice(0, 5)
    return {
      action: f.actionLabel(),
      energy_percent: Math.round(f.energy * 100),
      speed_cm_s: Math.round(f.speed),
      landed_on: f.landedOn ? f.landedOn.label : null,
      neurons_hz: {
        DNa02_left_steer: r1(hz.DNa02_L), DNa02_right_steer: r1(hz.DNa02_R),
        giant_fiber_escape: r1(((hz.esc_L || 0) + (hz.esc_R || 0)) / 2), DNpe007_stop: r1(hz.stop),
        MN9_feeding: r1(hz.feed), PPL101_stress_dopamine: r1(hz.stress), appetite_DNs: r1(hz.appetite),
        wing_motor_neurons: r1(hz.wing), pIP10_courtship_song: r1(hz.song),
      },
      regions_hz: msg ? msg.regions : null,
      nearby: near,
    }
  }

  /** Perf probe (11.09 "are draw calls a disaster?"): enabled visuals per layer, walked from the
   *  scene roots — "main" = what our camera renders (layer 1), "other" = fly-eye / hidden layers. */
  private countDraws(): string {
    let rmv = 0
    let txt = 0
    let other = 0
    const mainMask = this.cameraObject.getComponent("Component.Camera") as Camera
    const visit = (so: SceneObject) => {
      if (!so.enabled) return
      const onMain = mainMask ? mainMask.renderLayer.contains(so.layer) : true
      const nR = (so.getComponents("Component.RenderMeshVisual") as RenderMeshVisual[]).filter((c) => c.enabled).length
      const nT = (so.getComponents("Component.Text") as Text[]).filter((c) => c.enabled).length
      if (onMain) {
        rmv += nR
        txt += nT
      } else other += nR + nT
      for (let i = 0; i < so.getChildrenCount(); i++) visit(so.getChild(i))
    }
    for (let i = 0; i < global.scene.getRootObjectsCount(); i++) visit(global.scene.getRootObject(i))
    return "main=" + (rmv + txt) + " (mesh " + rmv + " + text " + txt + ") other=" + other
  }

  /** The fly's own landing spot at a food/scent source: a ring around it, one place per fly (flies
   *  feed side by side; one shared point stacked them head in head and every newcomer loomed
   *  at the fly already eating, 11.09 bench). Not sensed itself (active=false): the source is. */
  private spots: { [key: string]: Source } = {}
  private spotSlot: ({ food: string; slot: number } | null)[] = [] // which place on the ring each fly took
  private spotFor(food: Source, i: number): Source {
    const n = Math.max(1, this.flies.length)
    let held = this.spotSlot[i]
    if (!held || held.food !== food.id) {
      // take the FREE place nearest to the fly: it joins the patch from its own side instead of
      // crossing it (12.09 bench: a fly passing over the eaters at 9-14 cm and 31-38 cm/s startled
      // them off their meal three times in one run)
      const taken: { [s: number]: boolean } = {}
      for (let j = 0; j < this.flies.length; j++) {
        const o = this.spotSlot[j]
        if (j !== i && o && o.food === food.id) taken[o.slot] = true
      }
      const p = this.flies[i].pos
      let best = -1
      let bd = 1e9
      for (let s = 0; s < n; s++) {
        if (taken[s]) continue
        const d = this.spotPos(food, s, n).distance(p)
        if (d < bd) {
          bd = d
          best = s
        }
      }
      held = { food: food.id, slot: best >= 0 ? best : i % n }
      this.spotSlot[i] = held
    }
    const key = food.id + "_" + i
    let sp = this.spots[key]
    if (!sp) {
      sp = { id: key, label: food.label, cls: food.cls, pos: food.pos, sizeCm: food.sizeCm, sigma: 0, strength: 0,
        forFly: i, active: false, seen: false, marker: null, shell: null }
      this.spots[key] = sp
    }
    sp.pos = this.spotPos(food, held.slot, n)
    return sp
  }

  private spotPos(food: Source, slot: number, n: number): vec3 {
    const a = (2 * Math.PI * slot) / n + FlyConfig.FOOD_SPOT_PHASE
    return food.pos.add(new vec3(Math.cos(a), 0, Math.sin(a)).uniformScale(FlyConfig.FOOD_SPOT_CM))
  }

  private foodTarget(fly: FlyBody): Source | null {
    // hunger hysteresis (11.09 bench: a full fly counted as hungry again 8 s after eating): it seeks food
    // below FOOD_HUNGRY and, once on it, eats until FOOD_SATED
    const eating = !!fly.landedOn && (fly.landedOn.cls === "food" || fly.landedOn.cls === "scent")
    if (fly.energy >= FlyConfig.FOOD_SATED || (!eating && fly.energy >= FlyConfig.FOOD_HUNGRY)) {
      this.spotSlot[fly.index] = null // it lets its place go
      return null
    }
    const head = fly.pose().head
    let best: Source | null = null
    let bestD = FlyConfig.FOOD_ASSIST_CM
    for (const s of this.sources.items) {
      // food AND scent (flowers, plants, bins): flies land on those too (11.09 "why not on the flower?")
      if ((s.cls !== "food" && s.cls !== "scent") || !s.active) continue
      if (s.forFly >= 0 && s.forFly !== fly.index) continue // 12.09: honour the per-fly gate here too
      const d = s.pos.distance(head)
      if (d < bestD) {
        best = s
        bestD = d
      }
    }
    return best ? this.spotFor(best, fly.index) : null
  }

  private prevYaw: number[] = [0, 0, 0, 0, 0]
  private lastFlow: any[] = [null, null, null, null, null]
  private handPrev: { [side: string]: vec3 | null } = { left: null, right: null }
  private handVel: { [side: string]: vec3 } = { left: vec3.zero(), right: vec3.zero() }

  private trackHand(src: Source, side: "left" | "right", dt: number) {
    const h = this.hands.getHand(side)
    if (h.isTracked()) {
      const palm = h.getPalmCenter()
      const p = palm ? palm : h.wrist.position
      const prev = this.handPrev[side]
      if (prev && dt > 0) this.handVel[side] = vec3.lerp(this.handVel[side], p.sub(prev).uniformScale(1 / dt), 1 - Math.exp(-dt * 12))
      this.handPrev[side] = p
      this.sources.move(src, p)
      src.active = true
    } else {
      src.active = false
      this.handPrev[side] = null
      this.handVel[side] = vec3.zero()
    }
  }

  /** A still open palm near the fly = somewhere to land (11.09: "the hand is a surface too").
   *  Moving it fast makes the fly take off (looming does the rest). */
  private palmTarget(fly: FlyBody): Source | null {
    const head = fly.pose().head
    for (const [src, side] of [[this.leftHand, "left"], [this.rightHand, "right"]] as [Source, string][]) {
      if (!src.active || this.handVel[side].length > FlyConfig.HAND_STILL_CM_S) continue
      if (fly.landedOn === src || src.pos.distance(head) < FlyConfig.HAND_LAND_ASSIST_CM) return src
    }
    return null
  }

  /** Engineered room walls (11.09 "flies fly out of the world mesh"): the scanned mesh's robust box.
   *  The eyes already make surfaces loom; this only stops a fly passing THROUGH the room — it is
   *  held at the wall and the brain/eyes turn it. Ceilings are rarely scanned: top >= head + 40 cm. */
  private wallHits = 0
  private wallFace: { [k: string]: number } = {}
  private wallMax = 0
  private meshHits = 0
  private meshPerFly: number[] = []
  private meshFloor = 0 // of meshHits: surface facing up (floor/table) / down (ceiling)
  private meshCeil = 0
  /** Solid walls: the axis-aligned room box let flies through walls of a room turned against the
   *  world axes (11.09). A fly's move this frame is ray-tested against the world mesh (extended by
   *  the margin); a hit stops it in front of the surface — turning away stays with eyes + brain. */
  private solidWalls(f: FlyBody, before: vec3, dt: number) {
    if (!this.eyes || f.state === "landed") return
    if (FlyConfig.WALL_RAY_STAGGER && f.index !== this.rayTurn) return // one fly per frame casts
    const move = f.pos.sub(before)
    const len = move.length
    if (len < 0.3) return
    const dir = move.uniformScale(1 / len)
    const m = FlyConfig.WALL_MARGIN_CM
    const hit = this.eyes.blocked(before, f.pos.add(dir.uniformScale(m)))
    if (!hit) return
    // Slide, don't stop (11.09 preview: 80 blocks/s, flies pinned to the mesh "froze and glitched"):
    // drop only the part of the move that goes INTO the surface, keep the margin off its plane
    let n = hit.normal.length > 0.01 ? hit.normal.normalize() : dir.uniformScale(-1)
    if (n.dot(dir) > 0) n = n.uniformScale(-1) // the side facing the fly
    const slide = move.sub(n.uniformScale(move.dot(n)))
    let p = before.add(slide)
    const gap = p.sub(hit.pos).dot(n)
    if (gap < m) p = p.add(n.uniformScale(m - gap))
    f.pos = p
    // heading follows the wall (skimming it); head-on, it turns away from the surface.
    // Collision physics, engineered + disclosed; leaving the wall stays with eyes + brain.
    const flat = new vec3(slide.x, 0, slide.z)
    const aim = flat.length > 0.05 ? flat : new vec3(n.x, 0, n.z)
    if (aim.length > 0.01) {
      let dy = Math.atan2(-aim.z, aim.x) - f.yaw
      dy = Math.atan2(Math.sin(dy), Math.cos(dy))
      f.yaw += dy * (1 - Math.exp(-dt * FlyConfig.WALL_TURN_RATE))
    }
    this.meshHits++
    this.meshPerFly[f.index] = (this.meshPerFly[f.index] || 0) + 1
    if (n.y > 0.7) this.meshFloor++
    else if (n.y < -0.7) this.meshCeil++
  }
  /** Telemetry: what each brain commands while its fly is within landing reach of food —
   *  i:s<stop>b<back/MDN>f<forward>o<orient>. Settles WHY hungry flies hover before food
   *  (the MDN story was not confirmed by the atlas, 11.09). */
  private nearFoodActs(): string {
    const out: string[] = []
    this.flies.forEach((f, i) => {
      const d = this.nearestFoodCm(f)
      const m: any = this.link.latest[i]
      if (d < 0 || d > FlyConfig.FOOD_ASSIST_CM || !m || !m.act) return
      const a = m.act
      const r = (x: number) => (typeof x === "number" ? x.toFixed(1) : "?")
      out.push(i + ":s" + r(a.stop) + "b" + r(a.back) + "f" + r(a.forward) + "o" + r(a.orient))
    })
    return out.length ? out.join(",") : "none"
  }

  /** Telemetry: distance from a fly's head to the nearest food/scent source (-1 = none known). */
  private nearestFoodCm(f: FlyBody): number {
    const head = f.pose().head
    let d = -1
    for (const s of this.sources.items) {
      if ((s.cls !== "food" && s.cls !== "scent") || !s.active) continue
      const x = s.pos.distance(head)
      if (d < 0 || x < d) d = x
    }
    return Math.round(d)
  }
  private keepInRoom(f: FlyBody) {
    // no box before the vertex frame is verified (11.09: a mirrored box clamped flies ~50x/s)
    const b = this.bake && this.bake.frameOk ? this.bake.bounds : null
    if (!b || f.state === "landed") return
    const m = FlyConfig.ROOM_MARGIN_CM
    const top = Math.max(b.max.y, this.head.pos.y + 40)
    const clampAxis = (v: number, lo: number, hi: number) => (hi - lo < 2 * m + 10 ? v : Math.min(hi - m, Math.max(lo + m, v)))
    const p = f.pos
    // only a far backstop now (11.09 preview: the 2-98 % vertex box ends INSIDE the room, because the
    // walls ARE the extreme vertices; flies got pinned mid-room ~50x/s). Real walls = solidWalls.
    const P = FlyConfig.ROOM_PAD_CM
    const x = clampAxis(p.x, b.min.x - P, b.max.x + P)
    const y = clampAxis(p.y, b.min.y - P, top + P)
    const z = clampAxis(p.z, b.min.z - P, b.max.z + P)
    if (x === p.x && y === p.y && z === p.z) return
    // which face clamped (11.09: walls= still ~80/s with the padded box; debug from data)
    const face = x < p.x ? "x-" : x > p.x ? "x+" : y < p.y ? "y+" : y > p.y ? "y-" : z < p.z ? "z+" : "z-"
    this.wallFace[face] = (this.wallFace[face] || 0) + 1
    const shove = Math.abs(x - p.x) + Math.abs(y - p.y) + Math.abs(z - p.z)
    if (shove > this.wallMax) this.wallMax = shove // how far the box actually shoves a fly
    f.pos = new vec3(x, y, z)
    this.wallHits++
  }

  private jumps: { [k: string]: number } = {}
  private escBy: { [k: string]: number } = {}
  private escKind = { mealFly: 0, restFly: 0, airFly: 0, threat: 0 } // for the bench verdict
  private escLog: string[] = []
  private lastJump = "-"
  private jumpCheck(i: number, step: string, a: vec3, b: vec3) {
    if (FlyConfig.DEBUG_TELEMETRY_S <= 0) return // the jump probe only ever reports into a telemetry row
    const d = a.distance(b)
    if (d < FlyConfig.JUMP_CM) return
    this.jumps[step] = (this.jumps[step] || 0) + 1
    this.lastJump = i + ":" + step + ":" + d.toFixed(0) + "cm:" + this.flies[i].state
    log.w("FLY_JUMP fly=" + i + " " + step + " " + d.toFixed(0) + "cm")
  }

  /** Telemetry: the room box (world cm) vs the selected fly, so a clamp can be read off the log. */
  private boxStr(): string {
    const b = this.bake ? this.bake.bounds : null
    const f = this.flies[this.selected]
    const r = (v: vec3) => v.x.toFixed(0) + "," + v.y.toFixed(0) + "," + v.z.toFixed(0)
    // per fly: outside the scanned box (x/z; ceilings go unscanned) and its mesh contacts so far
    const out = b ? this.flies.map((q) => (q.pos.x < b.min.x || q.pos.x > b.max.x || q.pos.z < b.min.z || q.pos.z > b.max.z || q.pos.y < b.min.y ? "OUT" : "in")).join(",") : "?"
    return (b ? r(b.min) + ".." + r(b.max) : "none") + (f ? " fly=" + r(f.pos) : "") + " where=" + out + " hit=" + this.flies.map((q) => this.meshPerFly[q.index] || 0).join("/")
  }

  /** Bodies don't interpenetrate (11.09 bench: the last escapes came from flies 3-7 cm apart, i.e.
   *  overlapping 17.5 cm bodies, where the 1/d^2 loom fires even at 1 cm/s). A pair closer than
   *  FLY_SEPARATION_CM is pushed apart along the line between them; a landed fly is anchored and the
   *  flying one yields. Collision physics like the solid walls (disclosed), not behaviour. */
  private separateBodies() {
    const n = this.flies.length
    const S = FlyConfig.FLY_SEPARATION_CM
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const fa = this.flies[a]
        const fb = this.flies[b]
        const d = fb.pos.sub(fa.pos)
        const len = d.length
        if (len >= S || len < 1e-3) continue
        const over = Math.min(S - len, FlyConfig.SEPARATION_PUSH_MAX_CM)
        const push = d.uniformScale(over / len)
        const la = fa.state === "landed"
        const lb = fb.state === "landed"
        if (la && lb) continue // both anchored (food spots are FOOD_SPOT_CM apart)
        if (la) fb.pos = fb.pos.add(push)
        else if (lb) fa.pos = fa.pos.sub(push)
        else {
          fa.pos = fa.pos.sub(push.uniformScale(0.5))
          fb.pos = fb.pos.add(push.uniformScale(0.5))
        }
      }
    }
  }

  /** Collision course with another fly: time-to-contact loom by side, like the eye rays on walls. */
  private flyObstacle(i: number, pose: FlyPose, f: FlyBody): { L: number; R: number } {
    let L = 0
    let R = 0
    const vSelf = pose.fwd.uniformScale(f.speed)
    for (let j = 0; j < this.flies.length; j++) {
      if (j === i) continue
      const o = this.flies[j]
      const rel = o.pos.sub(pose.head)
      const dist = rel.length
      if (dist < 1 || dist > FlyConfig.EYE_RANGE_CM) continue
      const dir = rel.uniformScale(1 / dist)
      if (dir.dot(pose.fwd) < -0.85) continue // blind cone behind
      if (this.eyes && this.eyes.blocked(pose.head, o.pos)) continue // a wall between them
      const vo = o.state === "landed" ? vec3.zero() : o.pose().fwd.uniformScale(o.speed)
      const closing = vSelf.sub(vo).dot(dir) // both motions: a collision is a collision
      if (closing <= 1) continue
      const ttc = Math.max(0, dist - FlyConfig.FLY_OBSTACLE_R_CM) / closing
      if (ttc >= FlyConfig.EYE_TTC_S) continue
      const l = Math.min(1, (1 - ttc / FlyConfig.EYE_TTC_S) * FlyConfig.EYE_LOOM_GAIN)
      if (dir.dot(pose.left) >= 0) L = Math.max(L, l)
      else R = Math.max(R, l)
    }
    return { L: L, R: R }
  }

  /** Air a moving hand pushes onto a fly's antennae (JO), on the side the hand is on. */
  private handGust(pose: { head: vec3; left: vec3 }): { L: number; R: number } {
    let L = 0
    let R = 0
    for (const [src, side] of [[this.leftHand, "left"], [this.rightHand, "right"]] as [Source, string][]) {
      if (!src.active) continue
      const d = src.pos.distance(pose.head)
      if (d > FlyConfig.HAND_PUFF_CM) continue
      const g = Math.min(1, this.handVel[side].length / FlyConfig.HAND_PUFF_SPEED_CM_S) * (1 - d / FlyConfig.HAND_PUFF_CM)
      if (src.pos.sub(pose.head).dot(pose.left) >= 0) L = Math.max(L, g)
      else R = Math.max(R, g)
    }
    return { L: L, R: R }
  }

  private frameN = 0
  private rayTurn = 0 // whose turn it is to cast against the world mesh this frame (WALL_RAY_STAGGER)
  private frameSum = 0
  private frameMax = 0
  // perf attribution (11.09 "the fly glitches": 130-150 ms stalls, not the fly-eye cameras):
  // worst ms per subsystem within the telemetry window, AND the mean over the window's frames.
  // 12.09 the user, "CPU usage is still very high": the worst frame tells you where the SPIKES are,
  // which is what we fixed. What eats the budget every frame is the MEAN, and nothing reported it —
  // so the ranking we were optimising by was the wrong one for steady cost.
  private perfMax: { [k: string]: number } = {}
  private perfSum: { [k: string]: number } = {}
  private perfN = 0
  private timed<T>(name: string, fn: () => T): T {
    // 12.09: with telemetry off nothing ever reads perfMax, and this was ~26 Date.now() a frame
    if (FlyConfig.DEBUG_TELEMETRY_S <= 0) return fn()
    const t0 = Date.now()
    const r = fn()
    const ms = Date.now() - t0
    if (!(this.perfMax[name] >= ms)) this.perfMax[name] = ms
    this.perfSum[name] = (this.perfSum[name] || 0) + ms
    return r
  }
  /** `name=worst/mean` per subsystem, ranked by MEAN (the steady cost), worst kept for spikes. */
  private perfTop(): string {
    const n = Math.max(1, this.perfN)
    const top = Object.keys(this.perfSum).sort((a, b) => this.perfSum[b] - this.perfSum[a]).slice(0, 8)
    const s = top.map((k) => k + "=" + this.perfMax[k] + "/" + (this.perfSum[k] / n).toFixed(1)).join(" ")
    this.perfMax = {}
    this.perfSum = {}
    this.perfN = 0
    return s
  }

  private tick(dt: number) {
    this.frameN++
    this.perfN++ // frames in this telemetry window, so perfTop can report a mean
    if (this.flies.length > 0) this.rayTurn = (this.rayTurn + 1) % this.flies.length
    this.frameSum += dt
    if (dt > this.frameMax) this.frameMax = dt
    if (!this.sources) return
    this.link.tick(dt)

    // the head sits behind the eyes: the camera is where the user LOOKS from, not the centre of the head
    const camT0 = this.cameraObject.getTransform()
    this.sources.move(this.head, camT0.getWorldPosition().add(camT0.back.uniformScale(-FlyConfig.HEAD_BEHIND_CM)))
    if (this.scanner) this.timed("scan", () => this.scanner!.tick(dt))
    // vertex re-reads during the scan; afterwards only (slowly) until the vertex frame is verified
    if (this.bake && this.introT > 0) this.timed("bake", () => this.bake!.tick(dt))
    // 12.09 the user: "make sure the world mesh is not generated any more after the scan". It was: every
    // BAKE_GEOM_LATE_S the bake pulled the WHOLE mesh's vertices again (the 95 ms spike we measured,
    // and it grows with the room). After DONE SCANNING the room box is frozen at what was scanned;
    // the flies still avoid real walls by raycast, so the box is only the backstop it always was.
    else if (this.bake && FlyConfig.BAKE_AFTER_SCAN) this.timed("bake", () => this.bake!.tick(dt, FlyConfig.BAKE_GEOM_LATE_S))
    // the synthetic block world is only for when the real (coloured) world mesh isn't on the
    // vision layer yet — both at once would z-fight
    if (this.vision) this.vision.setSyntheticWorld(!this.worldMeshOnVision)
    if (this.vision && this.introT <= 0) this.timed("vision", () => this.vision!.tick(dt))
    if (this.gridMat) {
      const p: any = this.gridMat.mainPass
      if (this.introT > 0) {
        // 12.09 audit: constant after 0.6 s, but it was uploaded every frame for the whole scan
        if (this.introAge < 0.7) p.intensity = Math.min(1, this.introAge / 0.6) * FlyConfig.SCAN_GRID_INTENSITY // fade in, no pop
      } else if (this.dissolveT >= 0) {
        this.dissolveT += dt
        const k = Math.min(1, this.dissolveT / FlyConfig.SCAN_GRID_DISSOLVE_S)
        p.dissolve = k * k * (3 - 2 * k)
        if (k >= 1) {
          this.dissolveT = -1
          this.hideWorldMesh()
        }
      }
    }
    if (this.introT > 0) {
      // the scan ends on the board's DONE SCANNING button (11.09); the timer only without a board
      if (!this.board) this.introT -= dt
      this.introAge += dt
      const live = this.scanner ? this.scanner.liveCount : 0
      if (this.board) this.board.setBanner("SCANNING ROOM  //  LOOK AROUND  " + Math.floor(this.introAge) + " S  //  " + live + " FOUND")
      // only the BENCH ends the scan by itself (nobody is there to press DONE); 12.09 the user asked for
      // the auto-finish to be off while he watches the preview: the scan now waits for the button
      if (this.introAge >= FlyConfig.AUTO_INTRO_S && FlyConfig.AUTO_DEBUG && global.deviceInfoSystem.isEditor()) this.introT = 0
      if (this.introT <= 0) this.endIntro()
    }
    this.trackHand(this.leftHand, "left", dt)
    this.trackHand(this.rightHand, "right", dt)
    if (this.lure && this.lure.label === "hand_lure") {
      const p = this.pinchPoint("left")
      if (p) this.sources.move(this.lure, p)
      else this.endLure()
    }
    if (this.pinchHeldT >= 0) {
      this.pinchHeldT += dt
      if (!this.carried && this.pinchHeldT >= FlyConfig.TREAT_HOLD_S) this.spawnTreat()
      const p = this.carried ? this.pinchPoint("left") : null
      if (p && this.carried) this.carried.so.getTransform().setWorldPosition(p)
    }
    // a treat moved by hand (carried or manipulated later) takes its food source along
    for (const tr of this.treats) this.sources.move(tr.src, tr.so.getTransform().getWorldPosition())
    if (this.cmds && this.introT <= 0) this.timed("find", () => this.cmds!.tick(dt)) // before bodies: the lure follows its thing
    if (this.debugThreat) {
      // fly at fly 0 for 1.5 s, then reset: a repeatable looming stimulus
      this.debugT += dt
      const f0 = this.flies[0].pose()
      const k = (this.debugT % 4) / 1.5
      const dist = k < 1 ? 150 - 130 * k : 150
      this.sources.move(this.debugThreat, f0.head.add(f0.fwd.uniformScale(dist)))
    }

    this.timed("bodies", () => {
      for (let i = 0; i < this.flies.length && this.introT <= 0; i++) {
        const msg = this.link.latest[i]
        this.flies[i].setBrain(msg ? msg.act : null, dt, msg ? msg.hz : null) // hz: the wing motor neurons drive the stroke
        const lure = this.lure && (this.lure.forFly < 0 || this.lure.forFly === i) ? this.lure : null
        // Gemini food near the head = a landing target (altitude + touch-down). The brain's odour
        // steering brings the fly there; it leaves once sated (engineered, disclosed).
        const f = this.flies[i]
        const before = f.pos
        const st0 = f.state
        // height of the nearest food/scent a hungry fly can smell (altitude assist, ADR 26)
        f.smellY = null
        if (f.energy < FlyConfig.FOOD_HUNGRY) {
          let bd = FlyConfig.FOOD_SMELL_CM
          for (const s of this.sources.items) {
            if ((s.cls !== "food" && s.cls !== "scent") || !s.active) continue
            if (s.forFly >= 0 && s.forFly !== i) continue // a source meant for one fly (12.09: the
            // senses already gate on forFly, but the altitude assist did not — every fly followed it
            const d = s.pos.distance(f.pos)
            if (d < bd) {
              bd = d
              f.smellY = s.pos.y
            }
          }
        }
        f.nearFly = 1e9
        for (let j = 0; j < this.flies.length; j++) {
          if (j === i) continue
          const dj = this.flies[j].pos.distance(f.pos)
          if (dj < f.nearFly) f.nearFly = dj
        }
        f.update(dt, lure || this.foodTarget(f) || this.palmTarget(f), this.centre, this.head.pos)
        const p1 = f.pos
        this.solidWalls(f, before, dt)
        const p2 = f.pos
        this.keepInRoom(f)
        const p3 = f.pos
        this.surfaceLogic(f, i, dt)
        // jump probe (11.09 "they teleport from wall to wall instantly"): which step moved a fly > JUMP_CM in one frame
        if (st0 !== "escape" && f.state === "escape") {
          // why (11.09 bench: 12-21 escapes per food run): the source that loomed most at its last sense tick
          const sn = this.senses[i]
          const cause = sn.recent > 0.05 ? sn.recentBy : "noloom"
          const key = cause.indexOf("fly") === 0 ? "fly" : cause
          this.escBy[key] = (this.escBy[key] || 0) + 1
          // escape context: <fly>:<its state before> by <source>@<cm>/<closing cm/s>
          if (key === "fly") {
            // off a MEAL is the pathology; a rest on a wall/table is ordinary startling
            const cls = f.landedOn ? f.landedOn.cls : ""
            if (st0 !== "landed") this.escKind.airFly++
            else if (cls === "food" || cls === "lure" || cls === "scent") this.escKind.mealFly++
            else this.escKind.restFly++
          } else this.escKind.threat++
          this.escLog.push(i + ":" + st0 + "<" + cause + "@" + sn.recentD.toFixed(0) + "/" + sn.recentV.toFixed(0))
          if (this.escLog.length > 6) this.escLog.shift()
        }
        this.jumpCheck(i, "move", before, p1)
        this.jumpCheck(i, "wall", p1, p2)
        this.jumpCheck(i, "box", p2, p3)
        this.jumpCheck(i, "surf", p3, f.pos)
        if (this.flySrc[i]) this.sources.move(this.flySrc[i], this.flies[i].pos)
      }
      if (this.introT <= 0) this.separateBodies()
    })

    this.tickMeme(dt)
    if (this.scn && this.introT <= 0) this.timed("scn", () => this.scn!.tick(dt))
    const sel = this.flies[this.selected]
    const camT = this.cameraObject.getTransform()
    if (this.fx && this.introT <= 0) {
      for (let i = 0; i < this.flies.length; i++) this.flyPosBuf[i] = this.flies[i].pos
      this.timed("fx", () => this.fx!.update(dt, this.flyPosBuf, camT.getWorldPosition()))
    }
    if (this.eyes && this.introT <= 0) this.timed("eyedots", () => this.eyes!.tick(dt, camT, this.selected))
    if (this.ears) this.timed("ears", () => this.ears!.tick(dt))
    if (this.sound) {
      for (let i = 0; i < this.flies.length; i++) this.flyMsgBuf[i] = this.link.latest[i] || null
      this.timed("sound", () => this.sound!.tick(dt, this.flies, this.flyMsgBuf, this.introT > 0, camT.getWorldPosition()))
    }
    if (this.narrator && this.board && this.introT <= 0 && !this.scn) {
      const s = this.selected
      this.timed("voice", () => this.narrator!.tick(dt, s, FlyConfig.FLY_NAMES[s % FlyConfig.FLY_NAMES.length], () => this.flyState(s)))
      this.board.setThought(this.narrator.text)
    }
    this.updateFrameVisibility(dt)
    if (this.board && sel) {
      const rh = this.hands.getHand("right")
      const palm = rh.isTracked() && rh.isFacingCamera() ? rh.getPalmCenter() : null
      const seen = this.vision ? this.vision.retina(this.selected) : null
      this.board.setRetina(seen) // what the brain sees
      // one-shot diagnostic (12.09: the eye panel shows "no signal"): say WHY, once, with the
      // vision subsystem's own status — telemetry is off, so this goes straight to the logger
      if (!seen && !this.retinaWhy) {
        this.retinaWhy = true
        print("RETINA_NONE vision=" + (this.vision ? "on" : "OFF") + " intro=" + this.introT.toFixed(1) +
          " " + (this.vision ? this.vision.status() : ""))
      }
      this.timed("board", () => this.board!.update(dt, camT, palm, this.selected, sel, this.link.latest[this.selected] || null, this.link.connected))
    }

    // Debug channel: the editor window is often off-screen, so the lens reports where its
    // flies are to the brain server log (`dbg` rows) — distance/height vs the user's head.
    this.dbgTimer += dt
    if (FlyConfig.DEBUG_TELEMETRY_S > 0 && this.dbgTimer >= FlyConfig.DEBUG_TELEMETRY_S) {
      this.dbgTimer = 0
      const head = this.head.pos
      const at = this.flies.map((f) => f.pos.x.toFixed(0) + "," + f.pos.y.toFixed(0) + "," + f.pos.z.toFixed(0)).join(" ")
      const rows = this.flies.map((f) => ({
        d: Math.round(f.pos.sub(head).length),
        dy: Math.round(f.pos.y - head.y),
        st: f.state,
        v: Math.round(f.speed),
        a: f.actionLabel(),
        e: Math.round(f.energy * 100),
      }))
      // frame-time probe (11.09 "the fly glitches"): average fps and the worst frame of the window
      const fps = this.frameN > 0 ? (this.frameN / this.frameSum).toFixed(0) : "?"
      this.perfMax["msg"] = this.link.msgMaxMs // WebSocket parse + onBrain (cloud), outside the tick
      if (this.board) {
        for (const k in this.board.perf) this.perfMax["b." + k] = this.board.perf[k]
        this.board.perf = {}
      }
      const msgKb = (this.link.msgMaxChars / 1024).toFixed(0)
      this.link.msgMaxMs = 0
      this.link.msgMaxChars = 0
      // 12.09 device trace: `draws` cost 2.4 ms a frame — and it is PURE diagnostics. countDraws()
      // walks the whole scene graph and allocates two arrays per object (getComponents + filter).
      // Off by default now; turn DEBUG_DRAW_COUNT on when a draw-call audit is actually wanted.
      const cloud = (this.board ? this.board.cloudStatus() : "no board") +
        (FlyConfig.DEBUG_DRAW_COUNT ? " | draws " + this.timed("draws", () => this.countDraws()) : "") +
        " | fps " + fps + " worst " + (this.frameMax * 1000).toFixed(0) + "ms | perf " + this.perfTop() + " msgKB=" + msgKb
      this.frameN = 0
      this.frameSum = 0
      this.frameMax = 0
      const selMsg: any = this.link.latest[this.selected]
      const fl = this.lastFlow[this.selected]
      const flow = fl ? " | flow L=" + fl.L.toFixed(2) + " R=" + fl.R.toFixed(2) + (fl.src ? " " + fl.src : "") : ""
      const h: any = selMsg ? selMsg.hz : null
      const a: any = selMsg ? selMsg.act : null
      const mn = h ? " | DNg02=" + h.dng02 + " thrust=" + (a ? a.thrust : "?") + " fwd=" + (a ? a.forward : "?") + " stop=" + (a ? a.stop : "?") + " back=" + (a ? a.back : "?") +
        " MN power L/R=" + h.power_L + "/" + h.power_R + " DNa02 L/R=" + h.DNa02_L + "/" + h.DNa02_R +
        // 12.09 the user: "it falls off over time - maybe a new environment really is this state". The
        // curve is now in the log: sim seconds vs the rates that start high (ADR 38)
        " | hz@" + ((selMsg.sim_ms || 0) / 1000).toFixed(0) + "s stop=" + h.stop + " stress=" + h.stress +
        " esc=" + (((h.esc_L || 0) + (h.esc_R || 0)) / 2).toFixed(0) + " appetite=" + h.appetite : ""
      const notes = this.scn ? this.scn.takeNotes() : ""
      const scan = (this.scn ? this.scn.status() + " | " : "") + (notes ? notes + " | " : "") + (this.introT > 0 ? "INTRO " + this.introT.toFixed(1) + "s | " : "") +
        (this.scanner ? this.scanner.status() : "off") + " | eyes " + (this.eyes ? this.eyes.status() : "off") +
        " | vision " + (this.vision ? this.vision.status() : "off") + " bake " + (this.bake ? this.bake.status() : "off") +
        " | " + (this.sound ? this.sound.status() : "sound off") + flow + mn +
        " | food " + this.flies.map((f) => this.nearestFoodCm(f)).join("/") + "cm walls=" + this.wallHits + JSON.stringify(this.wallFace).replace(/["{}]/g, "") + " at=" + at + " shove=" + this.wallMax.toFixed(0) + " box=" + this.boxStr() + " escBy=" + (JSON.stringify(this.escBy).replace(/["{}]/g, "") || "0") + " escLog=" + (this.escLog.join(",") || "-") + " jumps=" + (JSON.stringify(this.jumps).replace(/["{}]/g, "") || "0") + " last=" + this.lastJump + " mesh=" + this.meshHits + "(floor" + this.meshFloor + " ceil" + this.meshCeil + ") surf=" + this.surfaceLandings + " treats=" + this.treats.length + " nearAct=" + this.nearFoodActs() + " find=" + (this.cmds ? this.cmds.findLabel() : "none") +
        " | " + (this.ears ? this.ears.status() : "ears off") +
        " | " + (this.narrator ? this.narrator.status() : "voice off")
      this.link.send({ t: "dbg", flies: rows, sel: this.selected, wall: selMsg ? selMsg.wall_ms : -1, cloud: cloud, scan: scan, board: this.board ? "ok" : "none" })
    }

    // One fly per frame (11.09 device perf: 3 flies x 12 world-mesh rays + senses in ONE frame
    // spiked eyerays to 33 ms): each fly keeps its own sense clock, the most overdue goes this frame.
    const interval = 1 / FlyConfig.SENSE_HZ
    let due = -1
    for (let j = 0; j < this.flies.length; j++) {
      this.senseT[j] = (this.senseT[j] || 0) + dt
      if (this.senseT[j] >= interval && (due < 0 || this.senseT[j] > this.senseT[due])) due = j
    }
    if (due >= 0 && this.introT <= 0) {
      const i = due
      const elapsed = this.senseT[i]
      this.senseT[i] = 0
      {
        const f = this.flies[i]
        const pose = f.pose()
        const ch = this.timed("senses", () =>
          this.senses[i].compute(i, pose, this.sources.items, elapsed, f.landedOn, f.energy, (a: vec3, b: vec3) => !this.eyes || !this.eyes.blocked(a, b)),
        )
        // airflow on the antennae (Johnston's organ JO-C/E) while flying: the brain should know it
        // flies (11.09 — it got no flight input at all before)
        const w = f.state !== "landed" ? Math.min(1, (Math.abs(f.speed) / FlyConfig.CRUISE_CM_S) * FlyConfig.WIND_GAIN) : 0
        const gust = this.handGust(pose) // air pushed by a moving hand (11.09)
        if (w > 0 || gust.L > 0 || gust.R > 0) ch.wind = { L: Math.max(w, gust.L), R: Math.max(w, gust.R) }
        const snd = this.ears ? this.ears.take(i) : 0 // a loud onset (clap) -> JO-A/B; the brain decides (ADR 29)
        if (snd > 0) ch.sound = snd
        // Bristles (12.09): a fly picks dust up sitting and walking on surfaces and in wind. The
        // load goes to the BM mechanosensory bristles, which drive DNg12 (+8..+15 Hz, measured) —
        // so the BRAIN picks the moment to clean, and grooming discharges the load, which ends the
        // bout by itself. Replaces the random timer that used to start grooming (ADR).
        const la: any = this.link.latest[i]
        const gr = la && la.act && typeof la.act.groom === "number" ? la.act.groom : 0
        const air = Math.max(w, gust.L, gust.R)
        const load = FlyConfig.BRISTLE_LOAD * ((f.state === "landed" ? 1 : 0.15) + 0.5 * air)
        this.dust[i] = Math.max(0, Math.min(1, (this.dust[i] || 0) + elapsed * (load - FlyConfig.BRISTLE_CLEAN * gr)))
        if (this.dust[i] > 0.02) ch.bristle = { L: this.dust[i], R: this.dust[i] }
        // Hunger (12.09): this brain has no gut — measured, every driver of its appetitive DNs is
        // food already touching it, and DNp09 (walk) answers nothing. So an empty fly would sit
        // forever. Starvation is injected as a current into the appetitive DNs themselves, where a
        // real fly's hunger peptides act. Engineered and disclosed (ADR).
        if (f.energy < FlyConfig.HUNGER_FEEL) {
          ch.hunger = FlyConfig.HUNGER_DRIVE * Math.min(1, (FlyConfig.HUNGER_FEEL - f.energy) / FlyConfig.HUNGER_FEEL)
        }
        if (this.eyes && f.state === "landed") this.eyes.clear(i)
        if (this.eyes && f.state !== "landed") {
          // its own rays against the world mesh: surfaces closing in loom on that side
          // the rays are the expensive sense: they run at EYE_HZ and the view is reused in between,
          // so senses can go at SENSE_HZ without multiplying raycasts (12.09 reaction speed)
          this.eyeT[i] = (this.eyeT[i] || 0) + elapsed
          let view = this.lastView[i]
          if (!view || this.eyeT[i] >= 1 / FlyConfig.EYE_HZ) {
            this.eyeT[i] = 0
            view = this.timed("eyerays", () => this.eyes!.look(i, pose, pose.fwd.uniformScale(f.speed), i === this.selected))
            this.lastView[i] = view
          }
          // Landing response (11.09 "hungry but never lands on the apple"): a surface closing in
          // while the fly approaches its landing target is the landing, not a threat — real flies
          // switch looming from escape to leg extension on approach. Engineered gate (disclosed):
          // eye loom is scaled down while a landing target is within reach.
          const lureI = this.lure && (this.lure.forFly < 0 || this.lure.forFly === i) ? this.lure : null
          const tgt = lureI || this.foodTarget(f) || this.palmTarget(f)
          const lk = tgt && tgt.pos.distance(pose.head) < FlyConfig.FOOD_ASSIST_CM ? FlyConfig.LAND_LOOM_KEEP : 1
          // walls / ceiling closing in go to LPLC1 (-> DNp03, the fly turns away), NOT to the escape
          // suite LC4/LPLC2 (11.09: wall loom there = escape at 120 cm/s = more loom = escape loops),
          // lifted above the firing floor like every graded cue (ADR 31)
          const wl = (x: number) => (x > 0.05 ? FlyConfig.SENSE_FLOOR + (1 - FlyConfig.SENSE_FLOOR) * Math.min(1, x) : 0)
          // other flies are obstacles too (11.09 bench: flies converging on food passed 4-12 cm from each
          // other and the one already eating escaped): the same time-to-contact rule as the eye rays feeds
          // LPLC1 -> DNp03, so the brain steers around a neighbour before it becomes a looming threat
          const ob = FlyConfig.FLY_OBSTACLES ? this.flyObstacle(i, pose, f) : { L: 0, R: 0 }
          ch.loom_wall = { L: wl(Math.max(view.loomL * lk, ob.L)), R: wl(Math.max(view.loomR * lk, ob.R)) }
          if (FlyConfig.MOTION_ENABLED) {
            // Optic flow -> LLPC1 (atlas: ipsilateral DNa02 +128/+144 Hz, the brain's strongest
            // steering input). Per eye = front-to-back (progressive) flow: translation past the
            // surfaces + the fly's own yaw. A left turn (yaw rate > 0) sweeps the world front-to-
            // back over the RIGHT eye -> LLPC1 R -> steer right: the turn is damped (optomotor).
            // A nearer wall on one side pulls the fly along it (wall following, as real flies do).
            let wz = (f.yaw - this.prevYaw[i]) / Math.max(1e-3, elapsed)
            wz = Math.atan2(Math.sin(wz * elapsed), Math.cos(wz * elapsed)) / Math.max(1e-3, elapsed) // unwrap
            // measured by the fly's own eye camera when available, else computed from its rays
            const seen = this.vision ? this.vision.flow(i) : null
            const pL = seen ? seen.L : view.transL - wz
            const pR = seen ? seen.R : view.transR + wz
            // 11.09 input audit: a channel reaches the brain only above ~0.35 (7 mV, LLPC1 threshold);
            // live motion sat at p90 0.14 = dead 99% of the time, and both sides at 0.5 push thrust
            // to 1 (runaway: faster flight, more flow). Only the net-progressive side is driven,
            // from the firing floor upward.
            const net = (pL - pR) * FlyConfig.MOTION_GAIN
            const mag = Math.min(1, Math.abs(net))
            const mv = mag > FlyConfig.MOTION_DEAD ? FlyConfig.SENSE_FLOOR + (1 - FlyConfig.SENSE_FLOOR) * mag : 0
            ch.motion = net > 0 ? { L: mv, R: 0 } : { L: 0, R: mv }
            this.lastFlow[i] = { L: ch.motion.L, R: ch.motion.R, src: seen ? "cam" : "rays" }
          }
        }
        this.prevYaw[i] = f.yaw
        const retina = this.vision ? this.vision.retina(i) : null
        if (retina) ch.retina = retina // its own view onto R1-R8 (mean pinned to 160)
        this.link.sendSenses(i, ch)
      }
    }
  }
}
