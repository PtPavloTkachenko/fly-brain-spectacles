/**
 * TextBatch — every label of one font in ONE MeshBuilder mesh: 1 draw call instead of one per
 * Component.Text (12.09 device measurement: the board alone was 67 text draws of the ~90 in view,
 * and every `.text` write re-tessellates that text's own mesh).
 *
 * How it works:
 * `SdfTextLayout` turns a string into glyph rectangles with atlas UVs, this class bakes them into
 * one mesh and `BoardText.glsl` draws them (MSDF body + SDF outline, see tools/text).
 *
 * Two LS specifics the port must keep:
 *   - mesh attribute `texture0` is the engine's own auto UV, so the atlas UV lives in `texture1`;
 *   - assigning `vis.mesh` re-instantiates the material pass and DROPS uniforms, so every uniform
 *     is written again after each mesh swap (and on the VISUAL's pass, not the material's).
 */
import { FontMetadata, LaidText, SdfTextLayout } from "./SdfTextLayout"

export type FontKind = "ui" | "mono"

interface Item {
  text: string
  x: number
  y: number
  z: number
  capCm: number
  align: number // -1 left, 0 centre, 1 right
  color: vec4 // per-vertex, so one batch holds every colour on the board
}

/** One font: its atlas texture, its metadata and the cap-height geometry derived from it. */
class Face {
  layout: SdfTextLayout
  capEm: number // cap height ('H') in EM units
  capTopEm: number // distance from the line top to the cap top, EM
  private cache: { [k: string]: LaidText } = {}
  private cached = 0

  constructor(public atlas: Texture | null, meta: FontMetadata) {
    this.layout = new SdfTextLayout(meta)
    const size = meta.info.size
    // every glyph rect in the atlas carries the generator's padding (-p 8) around the real glyph, so
    // the raw height of 'H' is cap + 2*pad. Measuring cap from it made every label ~20 % too small.
    const pad: number[] = ((meta as any).info && (meta as any).info.padding) || [0, 0, 0, 0]
    const padTop = pad[0] || 0
    const padBottom = pad[2] || 0
    let h: any = null
    for (const g of meta.chars) if (g.id === 72) h = g // 'H'
    this.capEm = h ? Math.max(0.1, (h.height - padTop - padBottom) / size) : 0.7
    this.capTopEm = h ? (h.yoffset + padTop) / size : 0.25
  }

  /** Layouts repeat every tick (the same labels, the same numbers) — lay each string out once. */
  laid(text: string): LaidText {
    let l = this.cache[text]
    if (l) return l
    l = this.layout.layout(text, 1.0)
    if (this.cached > 400) {
      this.cache = {}
      this.cached = 0
    }
    this.cache[text] = l
    this.cached++
    return l
  }
}

export class TextBatch {
  private obj: SceneObject
  private vis: RenderMeshVisual
  private items: Item[] = []
  private sig = NaN // no real hash equals NaN, so the first flush always builds
  private empty = true

  /** Metadata (+ the atlas texture when LS will hand it over) for one font. 12.09 measured: the
   *  `.mat` resolves through requireAsset but a PNG does NOT ("Cannot find asset") unless the scene
   *  references it — so the atlas is bound on the MATERIAL in Lens Studio and the batch simply
   *  inherits it, the usual pattern ("bind the atlas on the SOURCE material once"). */
  static face(kind: FontKind): Face | null {
    let meta: FontMetadata
    try {
      meta = (kind === "mono" ? require("./BoardMonoFontData") : require("./BoardUiFontData")) as FontMetadata
    } catch (e) {
      print("TextBatch: no font metadata for " + kind + " (" + e + ")")
      return null
    }
    let atlas: Texture | null = null
    try {
      atlas = requireAsset(kind === "mono" ? "../../Fly/UI/Fonts/BoardMono.png" : "../../Fly/UI/Fonts/BoardUi.png") as Texture
    } catch (e) {
      atlas = null // the material carries it
    }
    return new Face(atlas, meta)
  }

  static material(): Material | null {
    try {
      return requireAsset("../../Fly/Shaders/BoardText.mat") as Material
    } catch (e) {
      print("TextBatch: no BoardText material (" + e + ")")
      return null
    }
  }

  // every label carries its own colour in its vertices, so the material tint is a GLOBAL multiplier
  // (white = leave the colours alone; the board uses it to fade the whole text layer)
  private tintMul = new vec4(1, 1, 1, 1)

  constructor(parent: SceneObject, name: string, private face: Face, base: Material, renderOrder: number) {
    this.obj = global.scene.createSceneObject(name)
    this.obj.setParent(parent)
    this.vis = this.obj.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
    this.vis.mainMaterial = base.clone()
    this.vis.setRenderOrder(renderOrder)
    this.obj.enabled = false
    this.applyUniforms()
  }

  setTint(c: vec4) {
    if (this.tintMul === c) return
    this.tintMul = c
    this.applyUniforms()
  }

  // a 5.15 clone takes the .mat defaults and a mesh swap drops what was written: set everything
  private applyUniforms() {
    const p: any = (this.vis as any).mainPass
    if (!p) return
    if (this.face.atlas) p.atlas = this.face.atlas // else: whatever the .mat was given in Lens Studio
    p.tint = this.tintMul
    // the outline path is gone from the shader (12.09 audit: always off on an additive display, and
    // it cost a second fwidth + smoothstep on every glyph pixel), so its uniforms are not written
    p.gain = 1
    p.blendMode = BlendMode.Add // the glasses' display is additive: Normal darkens the plate at every glyph edge
    p.depthWrite = false
    p.twoSided = true
  }

  begin() {
    this.items = []
  }

  /** Queue one label in board-local cm. capCm = height of a capital letter. */
  add(text: string, x: number, y: number, z: number, capCm: number, color: vec4, align: "L" | "C" | "R" = "L") {
    if (text) this.items.push({ text: text, x: x, y: y, z: z, capCm: capCm, color: color, align: align === "L" ? -1 : align === "R" ? 1 : 0 })
  }

  /** Rebuild the mesh, but only when something actually changed. */
  flush() {
    let h = this.items.length | 0
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i]
      const t = it.text
      for (let c = 0; c < t.length; c++) h = (h * 31 + t.charCodeAt(c)) | 0
      h = (h * 31 + ((it.x * 20) | 0)) | 0
      h = (h * 31 + ((it.y * 20) | 0)) | 0
      h = (h * 31 + ((it.capCm * 100) | 0)) | 0
      h = (h * 31 + it.align) | 0
      h = (h * 31 + ((it.color.x * 255) | 0)) | 0
      h = (h * 31 + ((it.color.y * 255) | 0)) | 0
      h = (h * 31 + ((it.color.z * 255) | 0)) | 0
      h = (h * 31 + ((it.color.w * 255) | 0)) | 0
    }
    if (h === this.sig) return
    this.sig = h
    if (this.items.length === 0) {
      if (!this.empty) {
        this.obj.enabled = false
        this.empty = true
      }
      return
    }

    const mb = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "texture1", components: 2 }, // index 0 is the engine's auto UV and cannot be written
      { name: "texture2", components: 2 }, // colour r,g
      { name: "texture3", components: 2 }, // colour b,a
    ])
    mb.topology = MeshTopology.Triangles
    mb.indexType = MeshIndexType.UInt16
    const f = this.face
    let base = 0
    for (const it of this.items) {
      const laid = f.laid(it.text)
      const s = it.capCm / f.capEm // EM units -> board cm
      const w = laid.width * s
      const x = it.align < 0 ? it.x : it.align > 0 ? it.x - w : it.x - w / 2
      // the cap box is centred on it.y: its top lands at y + capCm/2, its baseline at y - capCm/2
      const top = it.y + it.capCm * 0.5 + f.capTopEm * s
      const cr = it.color.x
      const cg = it.color.y
      const cb = it.color.z
      const ca = it.color.w
      for (const g of laid.glyphs) {
        const x0 = x + g.x * s
        const x1 = x + (g.x + g.width) * s
        const y0 = top - g.y * s
        const y1 = top - (g.y + g.height) * s
        mb.appendVerticesInterleaved([
          x0, y0, it.z, g.u0, g.v0, cr, cg, cb, ca,
          x1, y0, it.z, g.u1, g.v0, cr, cg, cb, ca,
          x1, y1, it.z, g.u1, g.v1, cr, cg, cb, ca,
          x0, y1, it.z, g.u0, g.v1, cr, cg, cb, ca,
        ])
        mb.appendIndices([base, base + 2, base + 1, base, base + 3, base + 2])
        base += 4
        if (base > 65000) break // UInt16 index ceiling
      }
      if (base > 65000) break
    }
    if (base === 0 || !mb.isValid()) {
      this.obj.enabled = false
      this.empty = true
      return
    }
    this.vis.mesh = mb.getMesh()
    mb.updateMesh()
    this.applyUniforms() // the mesh swap re-instantiated the pass
    this.obj.enabled = true
    this.empty = false
  }

  get drawn(): number {
    return this.items.length
  }
}
