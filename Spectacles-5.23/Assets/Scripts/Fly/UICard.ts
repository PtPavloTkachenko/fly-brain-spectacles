/**
 * UICard — what the board hands its cards (start, scan, guide) so they draw in its language and on
 * its budget (ADR 58): a Text factory for the few labels that change, a batched-text factory for
 * every label that never does (one MSDF mesh, one draw call per card), and the neon button builder
 * that can put its quads into the card's own batch.
 */
import { FlyConfig } from "./FlyConfig"
import { TextBatch } from "./TextBatch"
import { QuadSink } from "./UIBatch"

export type Align = "L" | "R" | "C"
export type MkText = (parent: SceneObject, s: string, x: number, y: number, scale: number, color: vec4, opt?: { align?: Align; mono?: boolean; top?: boolean }) => Text
export type MkButton = (parent: SceneObject, name: string, x: number, y: number, w: number, h: number, onPress: () => void, sink?: QuadSink) => {
  so: SceneObject
  kit: boolean
  quads: number[]
  hover?: (cb: (on: boolean) => void) => void
  /** the 4th state: a toggle that stays lit */
  on?: (v: boolean) => void
  /** 16.09: the key's RESTING level. Below BTN_IDLE = a secondary key (a way in that is not the
   *  point yet); the refused TEACH key idles here too, so a key that cannot act never looks armed. */
  idle?: (k: number) => void
  /** 16.09: an extra term ON TOP of the resting level, for a key that is doing something right now
   *  (ASK while it listens). Driven from the caller's own clock. */
  live?: (k: number) => void
  /** replay the press flash without a press: a key that has just become the thing to do */
  flash?: () => void
}
export type MkBatch = (parent: SceneObject, name: string) => TextBatch | null
export type Still = (s: string, x: number, y: number, scale: number, color: vec4, align?: Align, z?: number) => void

/**
 * ADR 97: every plate, frame, key and label of the board and its cards draws at this render order —
 * BEFORE the fly (its visuals sit at the default 0) and the FX (RENDER_ORDER_FX 1). Nothing on a card
 * writes depth, so the fly drawn after it simply ADDS on top: she shows through the panel instead of
 * being cut out by it (21.09 Pavlo: "хай муха просвічується").
 */
export const CARD_RENDER_ORDER = -1

/**
 * Greedy word wrap against the font's real advances (the side panel, ADR 98): a paragraph becomes as
 * many lines as fit `maxCm` at `capCm`. Without a batch (no atlas) the paragraph comes back whole.
 * One-off per open, never per frame.
 */
export function wrapWords(tb: TextBatch | null, s: string, capCm: number, maxCm: number): string[] {
  if (!tb || !s) return s ? [s] : []
  const out: string[] = []
  let cur = ""
  for (const w of s.split(" ")) {
    if (!w) continue
    const next = cur ? cur + " " + w : w
    if (cur && tb.drawnWidthOf(next, capCm) > maxCm) {
      out.push(cur)
      cur = w
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

/**
 * ADR 71: a batched line that is guaranteed to stay inside the card. It measures the string with
 * the font's own advances and, if it is too wide, first shrinks the scale (down to `min`), then
 * splits at " · " onto as many lines as it needs. It warns once per offending string, so a label
 * that grew in a later edit says so in the log instead of silently sliding under a key.
 */
export function fitText(tb: TextBatch | null, st: Still, warn: (m: string) => void) {
  const seen: { [k: string]: boolean } = {}
  const K = FlyConfig.BOARD_TEXT_SCALE * FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_TEXT_CAP
  return (s: string, x: number, y: number, scale: number, color: vec4, maxCm: number,
          opt?: { align?: Align; lineCm?: number; min?: number }): number => {
    const align = (opt && opt.align) || "L"
    const lineCm = (opt && opt.lineCm) || 1.25
    const min = (opt && opt.min) || 0.36
    if (!tb || !s) {
      st(s, x, y, scale, color, align)
      return 1
    }
    let sc = scale
    while (sc > min && tb.drawnWidthOf(s, sc * K) > maxCm) sc = Math.round((sc - 0.02) * 100) / 100
    if (tb.drawnWidthOf(s, sc * K) <= maxCm) {
      st(s, x, y, sc, color, align)
      return 1
    }
    // still too wide at the smallest size we allow: break it where it was meant to break
    const parts = s.split(" · ")
    if (parts.length < 2) {
      if (!seen[s]) {
        seen[s] = true
        warn("text does not fit (" + Math.round(tb.drawnWidthOf(s, sc * K)) + " cm > " + maxCm + "): " + s)
      }
      st(s, x, y, sc, color, align)
      return 1
    }
    const lines: string[] = []
    let cur = ""
    for (const part of parts) {
      const next = cur ? cur + " · " + part : part
      if (cur && tb.drawnWidthOf(next, sc * K) > maxCm) {
        lines.push(cur)
        cur = part
      } else cur = next
    }
    if (cur) lines.push(cur)
    for (let i = 0; i < lines.length; i++) st(lines[i], x, y - i * lineCm, sc, color, align)
    return lines.length
  }
}

/** a label that never changes: into the card's batch, or a Component.Text when there is no batch */
export function stillText(tb: TextBatch | null, mkText: MkText, parent: SceneObject): Still {
  const k = FlyConfig.BOARD_TEXT_SCALE * FlyConfig.BOARD_LINE_CM * FlyConfig.BOARD_TEXT_CAP
  return (s, x, y, scale, color, align = "L", z = 0.2) => {
    if (tb) tb.add(s, x, y, z, scale * k, color, align)
    else {
      const t = mkText(parent, s, x, y, scale, color, { align: align })
      if (z !== 0.2) t.getTransform().setLocalPosition(new vec3(x, y, z))
    }
  }
}
