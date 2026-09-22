/**
 * FlyEyePanel — the compound eye and the optic lobe, on the board (ADR 54).
 *
 * Three honest layers, left to right / top to bottom:
 *   1. TWO HEX MOSAICS, one per eye: every ommatidial column of the MaleCNS optic lobe at its own
 *      lattice position (hex1, hex2). Amber = that column got brighter (ON), cyan = it got darker
 *      (OFF), a faint tint = the column exists but nothing changed. These are the EXACT bytes the
 *      brain is injected with — the panel interprets nothing.
 *   2. LEFT / RIGHT bars for the connectome's own feature detectors, straight off the brain
 *      message: LC4 and LPLC2 (looming — Ache et al. 2019, Klapoetke et al. 2017), LC11 (small
 *      moving objects, and it takes no T4/T5 input, so it is not a motion detector — Keles & Frye
 *      2017), T4 (ON motion) and T5 (OFF motion).
 * Nothing here is computed on the lens except the mosaic colours; the rates are measured spikes.
 *
 * Cost: two quads + 10 batched bars, uploaded at EYE_PANEL_HZ (under the board's 15 Hz data tick),
 * and the mosaic texture is written only where a column exists.
 */
import { EYE_HEX, EYE_HX, EYE_HY, EYE_N, EYE_SIDE } from "./FlyRetinaData"
import { FlyConfig } from "./FlyConfig"
import { FlyRetina } from "./FlyRetina"
import { QuadSink } from "./UIBatch"

// what the bars show: [readout key, label]. `hz` carries these since the optic-lobe readouts were
// added to channels.READOUTS (ADR 54).
const BARS: [string, string][] = [
  // 21.09 audience rule: five different detectors, five different words (was IMPACT / IMPACT / SPECK /
  // MOTION / MOTION -- two pairs read as duplicates). LC4 = something growing fast in view; LPLC2 =
  // growing straight at her; LC11 = a small thing moving; T4 = a bright edge moving; T5 = a dark one.
  ["LC4_L", "LOOMING"], ["LPLC2_L", "HEAD-ON"], ["LC11_L", "SPECK"], ["T4_L", "LIT MOVE"], ["T5_L", "DARK MOVE"],
]

interface Mosaic {
  imgTex: ProceduralTextureProvider // rgb = what the column sees, a = a column lives here
  imgPix: Uint8Array
  cxTex: ProceduralTextureProvider // r = ON, g = OFF, b = a column lives here
  cxPix: Uint8Array
  mats: Material[] // IMAGE, ON, OFF — the same graph in three modes (tint.a)
  cols: Int32Array // columns of this eye
  texel: Int32Array // its byte offset in a texture
}

export class FlyEyePanel {
  private eyes: Mosaic[] = []
  private bars: { l: number; r: number; tl: number; tr: number }[] = []
  private map: Uint8Array | null = null
  private img: Uint8Array | null = null
  private hz: any = null
  private t = 0
  private peak = 1
  private err = ""
  private texW = 0
  private texH = 0
  private lastMoved = -1 // skip the whole upload when the map has not changed (diff-cache, ADR 45)
  // 16.09: the eye is produced at RETINA_HZ 4 and this panel repaints at EYE_PANEL_HZ 10, so six
  // of every ten uploads pushed byte-identical pixels. `FlyRetina.stamp` counts ommatidial samples;
  // the buffer identity catches the other way the picture can change — a different fly selected.
  private lastStamp = -1
  private lastImg: Uint8Array | null = null
  private lastMap: Uint8Array | null = null
  private shownW: number[] = []
  private tintKey = -1 // re-tint the mosaics only when the selected fly's colour changes

  constructor(
    parent: SceneObject,
    quad: RenderMesh | null,
    private ui: QuadSink,
    still: (s: string, x: number, y: number, scale: number, color: vec4, align?: "L" | "R" | "C") => void,
    tint: vec4,
    labelColor: vec4,
  ) {
    if (!FlyConfig.EYE_PANEL) return
    // The eye map, in OFFSET hex coordinates. hex1/hex2 are AXIAL, and plotting them on a square
    // grid shears the lattice ~30 deg — that is what drew the tilted, uneven blobs (15.09 Pavlo:
    // "are these eyes really in the right proportions?"). row = hex2, col = hex1 - (hex2 - hex2&1)/2
    // turns them into a regular hex grid, and the footprint becomes a clean 30 x 39 oval.
    const col = new Int32Array(EYE_N)
    const row = new Int32Array(EYE_N)
    let c0 = 1 << 30
    let c1 = -(1 << 30)
    let r0 = 1 << 30
    let r1 = -(1 << 30)
    for (let i = 0; i < EYE_N; i++) {
      const r = EYE_HY[i]
      const cc = EYE_HX[i] - ((r - (r & 1)) >> 1)
      col[i] = cc
      row[i] = r
      if (cc < c0) c0 = cc
      if (cc > c1) c1 = cc
      if (r < r0) r0 = r
      if (r > r1) r1 = r
    }
    const CW = c1 - c0 + 1 // 30
    const CH = r1 - r0 + 1 // 39
    // ONE silhouette for both eyes, and the right is its mirror (15.09 Pavlo: "they are not
    // symmetric"). The two lobes really differ — 875 columns left, 892 right, and their hex sets
    // are not each other's mirror — so each lobe's own outline gave two different blobs. The
    // outline is the union of both lobes, then each row filled between its first and last column
    // so the ragged edge closes into a disc; it never reaches past a row's real extent. Each eye
    // still lights only the columns its OWN lobe has, and the brain still gets every one of them.
    const mask = new Uint8Array(CW * CH)
    const lo = new Int32Array(CH).fill(1 << 30)
    const hi = new Int32Array(CH).fill(-(1 << 30))
    for (let i = 0; i < EYE_N; i++) {
      const r = row[i] - r0
      const cc = col[i] - c0
      if (cc < lo[r]) lo[r] = cc
      if (cc > hi[r]) hi[r] = cc
    }
    for (let r = 0; r < CH; r++) for (let cc = lo[r]; cc <= hi[r]; cc++) mask[cc + r * CW] = 1
    // quad proportions: hex rows sit 0.866 apart, so the eye is CW : CH*0.866 wide to tall
    const h = FlyConfig.EYE_PANEL_H_CM
    const eyeW = (h * CW) / (CH * 0.866)
    const gap = FlyConfig.EYE_PANEL_GAP_CM
    try {
      if (!quad) throw new Error("no quad mesh")
      const mat = requireAsset("../../Fly/Shaders/EyeMosaic.mat") as Material
      // Three maps per eye, the way the fly's own view is read: the IMAGE its ommatidia sample,
      // and the ON and OFF halves of the contrast that is actually injected into the lamina.
      // Two textures per eye carry all three (RGBA8 has no room for image + ON + OFF in one).
      const imgH = FlyConfig.EYE_PANEL_H_CM
      const imgW = (imgH * CW) / (CH * 0.866)
      const cxH = FlyConfig.EYE_PANEL_CX_H_CM
      const cxW = (cxH * CW) / (CH * 0.866)
      const gap = FlyConfig.EYE_PANEL_GAP_CM
      const quadOf = (name: string, x: number, y: number, w: number, hh: number, tex: Texture, mode: number) => {
        const so = global.scene.createSceneObject(name)
        so.setParent(parent)
        const t = so.getTransform()
        t.setLocalPosition(new vec3(x, y, 0.3))
        t.setLocalScale(new vec3(w, hh, 1))
        const rmv = so.createComponent("Component.RenderMeshVisual") as RenderMeshVisual
        rmv.mesh = quad as RenderMesh
        const m = mat.clone()
        const pp: any = m.mainPass
        // a 5.15/5.23 clone takes the .mat defaults: write every one of them (RUNBOOK)
        pp.eye = tex
        pp.tint = new vec4(tint.r, tint.g, tint.b, mode / 10) // tint.a IS the mode (see the shader)
        pp.gain = mode === 0 ? FlyConfig.EYE_PANEL_IMAGE_GAIN : FlyConfig.EYE_PANEL_GAIN
        pp.cells = CW + CH / 100
        pp.grid = 0.3
        pp.blendMode = BlendMode.Add
        pp.depthWrite = false
        pp.twoSided = true
        try {
          ;(pp as any).samplers.eye.filtering = FilteringMode.Nearest // one texel = one ommatidium
        } catch (e) {
          /* the .mat default stands */
        }
        rmv.mainMaterial = m
        return m
      }
      for (let side = 0; side < 2; side++) {
        const imgTex = ProceduralTextureProvider.createWithFormat(CW, CH, TextureFormat.RGBA8Unorm)
        const cxTex = ProceduralTextureProvider.createWithFormat(CW, CH, TextureFormat.RGBA8Unorm)
        const imgPix = new Uint8Array(CW * CH * 4)
        const cxPix = new Uint8Array(CW * CH * 4)
        const cols: number[] = []
        const texel: number[] = []
        const mir = side === 1
        for (let r = 0; r < CH; r++) {
          for (let cc = 0; cc < CW; cc++) {
            if (!mask[cc + r * CW]) continue
            const o = 4 * ((mir ? CW - 1 - cc : cc) + r * CW)
            imgPix[o + 3] = 255 // A: a column lives here (IMAGE mask)
            cxPix[o + 2] = 255 // B: same mask for the ON/OFF maps
            cxPix[o + 3] = 255
          }
        }
        for (let i = 0; i < EYE_N; i++) {
          if (EYE_SIDE[i] !== side) continue
          const cc = col[i] - c0
          const r = row[i] - r0
          cols.push(i)
          texel.push(4 * ((mir ? CW - 1 - cc : cc) + r * CW))
        }
        ;(imgTex.control as ProceduralTextureProvider).setPixels(0, 0, CW, CH, imgPix)
        ;(cxTex.control as ProceduralTextureProvider).setPixels(0, 0, CW, CH, cxPix)

        const sx = side === 0 ? -1 : 1
        // the fly's LEFT eye on the left, as the fly would have it
        const ix = FlyConfig.EYE_PANEL_X + (sx * (imgW + gap)) / 2
        const mats = [quadOf(side === 0 ? "EyeMosaicLeft" : "EyeMosaicRight", ix, FlyConfig.EYE_PANEL_Y, imgW, imgH, imgTex, 0)]
        // ON and OFF under it — centred on THEIR OWN eye, so the four small maps read as two pairs
        // and not as four copies (15.09 Pavlo: "what are these 4 copies?"). Each is labelled.
        const cy = FlyConfig.EYE_PANEL_CX_Y
        const half = (cxW + FlyConfig.EYE_PANEL_CX_GAP_CM) / 2
        const onX = ix - half
        const offX = ix + half
        mats.push(quadOf((side === 0 ? "EyeOnLeft" : "EyeOnRight"), onX, cy, cxW, cxH, cxTex, 1))
        mats.push(quadOf((side === 0 ? "EyeOffLeft" : "EyeOffRight"), offX, cy, cxW, cxH, cxTex, 2))
        // batched static text: no new draw call
        const ly = cy - cxH / 2 - FlyConfig.EYE_PANEL_CX_LABEL_DY
        const sn = side === 0 ? "L" : "R"
        still(sn + " BRIGHT", onX, ly, FlyConfig.EYE_PANEL_CX_LABEL_SCALE, labelColor, "C")
        still(sn + " DARK", offX, ly, FlyConfig.EYE_PANEL_CX_LABEL_SCALE, labelColor, "C")
        this.eyes.push({
          imgTex: imgTex.control as ProceduralTextureProvider, imgPix: imgPix,
          cxTex: cxTex.control as ProceduralTextureProvider, cxPix: cxPix,
          mats: mats, cols: new Int32Array(cols), texel: new Int32Array(texel),
        })
      }
      this.texW = CW
      this.texH = CH
    } catch (e) {
      this.err = "" + e
      print("EyePanel unavailable: " + e)
    }
    // the detector bars: one pair per cell type, left eye's lobe growing left, right growing right
    // the bars sit BESIDE the mosaics: label on the left margin of this strip, then L growing
    // left and R growing right from a shared centre, so the two lobes read as one instrument.
    const cx = FlyConfig.EYE_PANEL_BAR_CX
    const bw = FlyConfig.EYE_PANEL_BAR_W
    const bh = FlyConfig.EYE_PANEL_BAR_H
    for (let i = 0; i < BARS.length; i++) {
      const y = FlyConfig.EYE_PANEL_BAR_Y - i * FlyConfig.EYE_PANEL_BAR_STEP
      const tl = this.ui.add(cx - 0.12 - bw / 2, y, -0.1, bw, bh, tint, 0.16)
      const tr = this.ui.add(cx + 0.12 + bw / 2, y, -0.1, bw, bh, tint, 0.16)
      const l = this.ui.add(cx - 0.12, y, 0, 0, bh, tint, 1)
      const r = this.ui.add(cx + 0.12, y, 0, 0, bh, tint, 1)
      this.bars.push({ l: l, r: r, tl: tl, tr: tr })
      still(BARS[i][1], FlyConfig.EYE_PANEL_LABEL_X, y - 0.13, FlyConfig.EYE_PANEL_LABEL_SCALE, labelColor)
    }
  }

  /** The signed contrast map (128 = no change) of the selected fly, and its brain message rates. */
  setData(map: Uint8Array | null, hz: any, img: Uint8Array | null = null) {
    this.map = map
    this.hz = hz
    this.img = img
  }

  status(): string {
    return this.err ? " eyepanel=" + this.err.substring(0, 40) : ""
  }

  update(dt: number, tint: vec4) {
    this.t += dt
    if (this.t < 1 / Math.max(1, FlyConfig.EYE_PANEL_HZ)) return
    this.t = 0
    const CW = this.texW
    const CH = this.texH
    const map = this.map
    const img = this.img
    // Diff-cache (ADR 45): the ON/OFF map only uploads when a column moved; the IMAGE follows the
    // fly, so it uploads whenever the sample changed at all. Both are one setPixels of ~4.7 kB.
    // 16.09: `moved` was recounted here over all 1,767 columns at EYE_PANEL_HZ 10 — ~17,700
    // iterations a second for an integer FlyRetina already holds. And nothing can change either
    // picture between ommatidial samples, so both uploads now hang off the retina's own stamp.
    let moved = FlyRetina.movedOf(map)
    if (moved < 0) {
      moved = 0
      if (map) for (let c = 0; c < EYE_N; c++) if (map[c] !== 128) moved++
    }
    const stamp = FlyRetina.stamp
    const fresh = stamp !== this.lastStamp
    const cxDue = (moved !== 0 || this.lastMoved !== 0) && (fresh || map !== this.lastMap)
    const imgDue = fresh || img !== this.lastImg
    this.lastMoved = moved
    this.lastStamp = stamp
    this.lastImg = img
    this.lastMap = map
    for (const e of this.eyes) {
      const cols = e.cols
      const texel = e.texel
      if (img && imgDue) {
        const ip = e.imgPix
        for (let k = 0; k < cols.length; k++) {
          const o = texel[k]
          const j = 3 * cols[k]
          ip[o] = img[j]
          ip[o + 1] = img[j + 1]
          ip[o + 2] = img[j + 2]
        }
        e.imgTex.setPixels(0, 0, CW, CH, ip)
      }
      if (cxDue) {
        const cp = e.cxPix
        for (let k = 0; k < cols.length; k++) {
          const o = texel[k]
          cp[o] = 0
          cp[o + 1] = 0
        }
        if (map) {
          for (let k = 0; k < cols.length; k++) {
            const b = map[cols[k]]
            if (b === 128) continue
            const o = texel[k]
            if (b > 128) {
              const v = (b - 128) << 1
              if (v > cp[o]) cp[o] = v
            } else {
              const v = (128 - b) << 1
              if (v > cp[o + 1]) cp[o + 1] = v
            }
          }
        }
        e.cxTex.setPixels(0, 0, CW, CH, cp)
      }
    }
    const key = tint.r * 7 + tint.g * 13 + tint.b * 29
    if (key !== this.tintKey) {
      this.tintKey = key
      for (const e of this.eyes) {
        for (let m = 0; m < e.mats.length; m++) {
          try {
            ;(e.mats[m].mainPass as any).tint = new vec4(tint.r, tint.g, tint.b, m / 10)
          } catch (err) {
            /* keep the clone's colour */
          }
        }
      }
    }
    // bars: the two lobes side by side, on ONE shared auto-range so L and R stay comparable
    const hz = this.hz
    const bw = FlyConfig.EYE_PANEL_BAR_W
    let top = 1
    if (hz) {
      for (const b of BARS) {
        const key = b[0]
        const l = hz[key] || 0
        const r = hz[key.substring(0, key.length - 1) + "R"] || 0
        if (l > top) top = l
        if (r > top) top = r
      }
    }
    const k = 1 - Math.exp(-dt / 2)
    this.peak += (Math.max(1, top) - this.peak) * k
    const cx = FlyConfig.EYE_PANEL_BAR_CX
    for (let i = 0; i < this.bars.length; i++) {
      const key = BARS[i][0]
      const lv = hz ? hz[key] || 0 : 0
      const rv = hz ? hz[key.substring(0, key.length - 1) + "R"] || 0 : 0
      const wl = Math.max(0, Math.min(1, lv / this.peak)) * bw
      const wr = Math.max(0, Math.min(1, rv / this.peak)) * bw
      // a dirty quad is a vertex rewrite: only touch a bar whose width actually moved
      if (Math.abs(wl - (this.shownW[2 * i] || 0)) > 0.01) {
        this.shownW[2 * i] = wl
        this.ui.set(this.bars[i].l, { x: cx - 0.12 - wl / 2, w: wl, color: tint })
      }
      if (Math.abs(wr - (this.shownW[2 * i + 1] || 0)) > 0.01) {
        this.shownW[2 * i + 1] = wr
        this.ui.set(this.bars[i].r, { x: cx + 0.12 + wr / 2, w: wr, color: tint })
      }
    }
  }
}
