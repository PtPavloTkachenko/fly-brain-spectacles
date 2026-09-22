/**
 * FlySidePanel — tap a NEURAL row on the board and this plate unfolds beside it with what that
 * population IS, why it matters and what you will see it do (ADR 98; 21.09 Pavlo: "якщо на якийсь
 * сенсор натискаю — бокова панель з описом зʼявляється"). The guiding cut in action: the board keeps
 * the numbers, the explanation is on demand. The words live in FlyGuide.ROW_BLURBS with the rest of
 * the lens's copy.
 *
 * Anchored, not centred (Pavlo: "хай скейлиться з рамки бокової панелі, а не з центру основної"):
 * the pivot object sits ON THE SEAM — the board's right edge plus the gap — and the panel body hangs
 * off it by half its width, so `Anim.popIn` on the pivot grows the plate OUT of the seam sideways,
 * like a drawer, never from a point in the middle of the board. A connector in the fly's colour runs
 * from the seam back to the tapped row, so the plate reads as that row's.
 *
 * Cost: one NeonBatch (plate + frame + rule + connector), one TextBatch rebuilt once per opened row
 * (its flush diff-caches), one invisible hit box. Root disabled while closed = 0 draws, and nothing
 * is written per frame but the auto-hide clock.
 */
import NativeLogger from "SpectaclesInteractionKit.lspkg/Utils/NativeLogger"
import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable"
import { FlyConfig } from "./FlyConfig"
import { Anim, Ease } from "./FlyMotion"
import { NeonBatch, NeonQuadSet, QuadSink, addFrame } from "./UIBatch"
import { CARD_RENDER_ORDER, MkBatch, MkText, Still, fitText, stillText, wrapWords } from "./UICard"
import { TextBatch } from "./TextBatch"
import { BAR_MEANING, ROW_BLURBS, RowBlurb } from "./FlyGuide"
import { FRAME, PLATE, TXT, TXT2, WHITE } from "./FlyPalette"

const log = new NativeLogger("FlySidePanel")

// board-local cm (x BOARD_SCALE 0.85 on the device: 18.7 x 12.8 cm, 1.9 cm off the board's edge).
// Measured against the font (tools: scratch measure.js, 21.09): the longest row is 4 + 1 lines and
// ends 0.7 cm above the atlas line; every head + caption pair is under 15 of the 19 text cm.
const PW = 22
const PH = 15
const GAP = 2.2 // the seam: the same gap the guide card keeps on the other side
const MARGIN = 1.5
const TEXT_W = PW - 2 * MARGIN
const T_HEAD = 0.56 // the board's T_LABEL
const T_SMALL = 0.46 // the board's floor: nothing below it (16.09 typography pass)
const LINE_CM = 1.25
const AUTO_HIDE_S = 45 // read, then gone by itself; a tap anywhere on the board closes it sooner
const POP_S = 0.4
const MOVE_S = 0.25
const K = FlyConfig.BOARD_TEXT_SCALE * FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_TEXT_CAP // scale -> cap cm
const SCRATCH = new vec3(0, 0, 0) // setLocalPosition copies; no vec3 per animation frame

export class FlySidePanel {
  private pivot: SceneObject // on the seam: what pops
  private body: SceneObject // half a width off it: what is drawn
  private ui: QuadSink
  private tb: TextBatch | null
  private still: Still
  private fit: (s: string, x: number, y: number, scale: number, color: vec4, maxCm: number,
                opt?: { align?: "L" | "R" | "C"; lineCm?: number; min?: number }) => number
  private fallback: Text | null = null // no atlas: one Text, rewritten per open (never one per line)
  private conn: number
  private rowKey: string | null = null
  private openT = 0
  private seq = 0
  private y = 0 // the pivot's y, board-local
  /** the board un-highlights the row when the panel goes by itself (auto-hide) */
  onClose: () => void = () => {}

  constructor(parent: SceneObject, private seamX: number, private boardH: number, quad: RenderMesh, neon: Material, batchMat: Material | null, mkText: MkText, mkBatch: MkBatch, private accent: vec4) {
    this.pivot = global.scene.createSceneObject("FlySidePanel")
    this.pivot.setParent(parent)
    this.pivot.getTransform().setLocalPosition(new vec3(seamX, 0, 0))
    this.body = global.scene.createSceneObject("SidePanelBody")
    this.body.setParent(this.pivot)
    this.body.getTransform().setLocalPosition(new vec3(PW / 2, 0, 0))
    // its own batch: the board's is sized at its first flush and every quad of it is spoken for
    const ui: QuadSink = batchMat ? new NeonBatch(this.body, batchMat, "SideNeon") : new NeonQuadSet(this.body, quad, neon, "SideNeon")
    ui.setRenderOrder(CARD_RENDER_ORDER) // ADR 97: under the fly, like every card
    ui.add(0, 0, -0.6, PW, PH, PLATE, FlyConfig.BOARD_PLATE, 2) // the plate: the board's own tint
    addFrame(ui, 0, 0, PW, PH, FRAME, accent) // the board's frame, in the card's proportions
    ui.add(0, PH / 2 - 3.2, 0, PW - 2, 0.16, FRAME, 0.6, 2) // the header rule every card has
    // the connector: from the seam back to the tapped row, in the fly's colour
    this.conn = ui.add(-PW / 2 - GAP / 2, 0, 0, GAP, 0.22, accent, 1.2, 2)
    ui.flush()
    this.ui = ui
    this.tb = mkBatch(this.body, "SideText")
    if (this.tb) this.tb.setRenderOrder(CARD_RENDER_ORDER)
    if (!this.tb) {
      this.fallback = mkText(this.body, "", -PW / 2 + MARGIN, PH / 2 - 1.6, T_SMALL, TXT, { top: true })
    }
    this.still = stillText(this.tb, mkText, this.body)
    this.fit = fitText(this.tb, this.still, (m: string) => log.w("SIDE " + m))
    // a tap on the plate closes it: the hit box is the plate's own size, an invisible collider
    const so = global.scene.createSceneObject("SideHit")
    so.setParent(this.body)
    so.getTransform().setLocalPosition(new vec3(0, 0, 0.05))
    so.getTransform().setLocalScale(new vec3(PW, PH, 1))
    const col = so.createComponent("Physics.ColliderComponent") as ColliderComponent
    const box = Shape.createBoxShape()
    box.size = new vec3(1, 1, 1)
    col.shape = box
    const it = so.createComponent(Interactable.getTypeName()) as Interactable
    it.targetingMode = 3
    it.onTriggerStart.add(() => this.close())
    this.pivot.enabled = false
  }

  /** which row is open, or null */
  get row(): string | null {
    return this.rowKey
  }

  /** open beside the row at `rowY` (board-local); an open panel swaps its words and slides to the row */
  open(key: string, rowY: number) {
    const b = ROW_BLURBS[key]
    if (!b) {
      log.w("SIDE_NO_BLURB row=" + key)
      return
    }
    const was = this.rowKey
    this.rowKey = key
    this.openT = 0
    const seq = ++this.seq
    // at the row's height, kept inside the board's own height; the connector still points at the row
    const half = this.boardH / 2 - PH / 2 - 0.5
    const py = Math.max(-half, Math.min(half, rowY))
    this.ui.set(this.conn, { y: rowY - py })
    this.rebuild(b)
    this.ui.flush()
    const tr = this.pivot.getTransform()
    if (was === null) {
      this.y = py
      SCRATCH.x = this.seamX
      SCRATCH.y = py
      SCRATCH.z = 0
      tr.setLocalPosition(SCRATCH)
      this.pivot.enabled = true
      Anim.stop("side.move")
      // the pivot is ON the seam: scaling it grows the plate out of the board's edge, not from a centre
      Anim.popIn("side.pop", tr, POP_S, 1.12)
    } else if (was !== key) {
      // another row: the same plate slides to it and takes a beat, so the swap is seen as a change
      const y0 = this.y
      Anim.run("side.move", MOVE_S, (t) => {
        const k = Ease.outCubic(t)
        this.y = y0 + (py - y0) * k
        SCRATCH.x = this.seamX
        SCRATCH.y = this.y
        SCRATCH.z = 0
        tr.setLocalPosition(SCRATCH)
      })
      Anim.pulse("side.swap", this.body.getTransform(), 1.04, 0.3)
    }
    log.i("SIDE_OPEN row=" + key + " y=" + py.toFixed(1) + (was && was !== key ? " from=" + was : "") + " seq=" + seq)
  }

  close() {
    if (this.rowKey === null) return
    const key = this.rowKey
    this.rowKey = null
    const seq = ++this.seq
    Anim.stop("side.move", true)
    // the exit runs on the same key as the entrance, so a re-open mid-exit replaces it (Anim lands
    // the run it replaces; the token keeps that landed callback from disabling the new panel)
    Anim.slipOut("side.pop", this.pivot.getTransform(), 0.22, () => {
      if (seq === this.seq) this.pivot.enabled = false
    })
    log.i("SIDE_CLOSE row=" + key)
    this.onClose()
  }

  /** the board itself went away (looked away, hidden): no motion, no callback */
  hideNow() {
    if (this.rowKey === null && !this.pivot.enabled) return
    this.rowKey = null
    this.seq++
    Anim.stop("side.pop")
    Anim.stop("side.move")
    this.pivot.enabled = false
  }

  /** per frame while the board is on: only the auto-hide clock */
  tick(dt: number) {
    if (this.rowKey === null) return
    this.openT += dt
    if (this.openT > AUTO_HIDE_S) this.close()
  }

  /** the whole text of the panel for one row: head, the bar line, what, what you will see, atlas */
  private rebuild(b: RowBlurb) {
    const top = PH / 2
    const L = -PW / 2 + MARGIN
    const cap = T_SMALL * K
    if (this.fallback) {
      const s = b.head + "\n" + BAR_MEANING + "\n\n" + b.what + "\n" + b.see + "\n" + b.atlas
      if (this.fallback.text !== s) this.fallback.text = s
      return
    }
    if (this.tb) this.tb.begin()
    const st = this.still
    st(b.head, L, top - 2.2, T_HEAD, WHITE)
    st("WHAT THIS ROW IS", PW / 2 - MARGIN, top - 2.25, T_SMALL, TXT2, "R")
    // the bar, explained once for every row: what the number IS (elevation over its own rest)
    let y = top - 4.4
    for (const l of wrapWords(this.tb, BAR_MEANING, cap, TEXT_W)) {
      st(l, L, y, T_SMALL, TXT2)
      y -= LINE_CM
    }
    y -= 0.4
    // the atlas name last and smallest, above the bottom edge; `fit` splits it at " · " if it must
    const atlasY = -PH / 2 + 2.4
    const room = Math.max(1, Math.floor((y - (atlasY + 1.0)) / LINE_CM) + 1)
    const what = wrapWords(this.tb, b.what, cap, TEXT_W)
    const see = wrapWords(this.tb, b.see, cap, TEXT_W)
    if (what.length + see.length > room) log.w("SIDE_OVERFLOW row=" + b.head + " lines=" + (what.length + see.length) + " room=" + room)
    let n = 0
    for (const l of what) {
      if (n++ >= room) break
      st(l, L, y, T_SMALL, TXT)
      y -= LINE_CM
    }
    y -= 0.3
    for (const l of see) {
      if (n++ >= room) break
      st(l, L, y, T_SMALL, this.accent) // what to watch for, in the fly's colour
      y -= LINE_CM
    }
    this.fit(b.atlas, L, atlasY, T_SMALL, TXT2, TEXT_W, { lineCm: 1.1 })
    if (this.tb) this.tb.flush()
  }
}
