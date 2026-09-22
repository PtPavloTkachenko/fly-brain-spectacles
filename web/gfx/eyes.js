/**
 * EyesView — the fly's two compound eyes, exactly as the lens draws them (ADR 54 + 61).
 *
 * Every cell is one of the MaleCNS optic lobe's own 1,767 ommatidial columns (875 left, 892 right)
 * at its own hex lattice position, and the byte it shows is the byte the brain was injected with
 * this step: the page reads the SAME `senses.eye` string the core reads, so nothing is
 * interpreted here. Amber = that column got brighter (ON), cyan = darker (OFF); the lattice itself
 * is always faintly lit and breathing out of phase, so a still room still reads as a live sensor.
 * `sqrt()` on ON/OFF is a display gamma and nothing else — the brain gets the linear bytes.
 *
 * Unlike the lens, which pools 875 columns into 14x14 display bins because 3 cm on the glasses is
 * mush, the page draws every column.
 */
const R3 = Math.sqrt(3) / 2;

export class EyesView {
  constructor(canvas, barHost) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cols = null;
    this.map = null;
    this.bars = [];
    this.peak = 1;
    this.tint = "#33ff73";
    this.moved = 0;
    this.img = null;
    // Each bar leads with the plain word (the headline a newcomer reads); the real optic-lobe cell
    // code stays the data key and opens the hover line (app.js LEGEND). T4/T5 are shortened to fit
    // the 128px bar -- the full "... EDGES" wording lives in the hover.
    for (const [code, label] of [["LC4", "LOOMING"], ["LPLC2", "LOOMING · HEAD-ON"], ["LC11", "SMALL MOVER"], ["T4", "MOTION · BRIGHT"], ["T5", "MOTION · DARK"]]) {
      const d = document.createElement("div");
      d.className = "dbar";
      d.innerHTML = '<div class="n">' + label + '</div><div class="t"></div><div class="l"></div><div class="r"></div>';
      barHost.appendChild(d);
      this.bars.push({ key: code + "_L", l: d.querySelector(".l"), r: d.querySelector(".r"), lw: -1, rw: -1 });
    }
  }

  async load(url) {
    const b = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const dv = new DataView(b.buffer);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== "EYEL") throw new Error("eye_lattice.bin: bad magic");
    const n = dv.getUint32(4, true);
    let o = 16;
    const side = b.subarray(o, o + n); o += n;
    const hx = b.subarray(o, o + n); o += n;
    const hy = b.subarray(o, o + n); o += n;
    // Every column's own VIEWING DIRECTION, int16 hundredths of a degree (make_assets.py writes
    // az then el after the hex coordinates). The panel itself does not need them — it draws the
    // lattice, not the world — but they are the whole file's second half and the only place the
    // page has the real 5 deg interommatidial geometry, so they are parsed once and handed on:
    // ?demo=1 samples its synthetic room through exactly these directions (gfx/demo.js).
    const az = new Float32Array(n), el = new Float32Array(n);
    const RAD = Math.PI / 18000; // hundredths of a degree -> radians
    for (let i = 0; i < n; i++) {
      az[i] = dv.getInt16(o + 2 * i, true) * RAD;
      el[i] = dv.getInt16(o + 2 * n + 2 * i, true) * RAD;
    }
    // hex axial -> cartesian, then each eye normalised into its own half of the panel
    const px = new Float32Array(n), py = new Float32Array(n);
    const lo = [[1e9, 1e9], [1e9, 1e9]], hi = [[-1e9, -1e9], [-1e9, -1e9]];
    for (let i = 0; i < n; i++) {
      const s = side[i];
      const x = hx[i] - hy[i] / 2, y = hy[i] * R3;
      px[i] = x; py[i] = y;
      if (x < lo[s][0]) lo[s][0] = x;
      if (y < lo[s][1]) lo[s][1] = y;
      if (x > hi[s][0]) hi[s][0] = x;
      if (y > hi[s][1]) hi[s][1] = y;
    }
    // ONE scale per eye so the lattice keeps its real aspect (a squashed eye is a wrong eye)
    this.span = [[hi[0][0] - lo[0][0], hi[0][1] - lo[0][1]], [hi[1][0] - lo[1][0], hi[1][1] - lo[1][1]]];
    for (let i = 0; i < n; i++) {
      const s = side[i];
      px[i] = px[i] - lo[s][0];
      py[i] = hi[s][1] - py[i];
    }
    this.cols = { n, side, px, py, az, el };
    this.cell = 1 / Math.max(1, this.span[0][0]);
    return n;
  }

  /** the raw `eye` bytes (128 = no change), the ommatidial IMAGE (EYE_N x RGB) and the rates */
  setData(map, hz, img) {
    if (map) this.map = map;
    if (img) this.img = img;
    this.hz = hz;
  }

  setTint(css) { this.tint = css; }

  frame(dt, t) {
    const c = this.canvas, ctx = this.ctx;
    const w = c.clientWidth | 0, h = c.clientHeight | 0;
    if (!w || !h || !this.cols) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== (w * dpr | 0)) { c.width = w * dpr | 0; c.height = h * dpr | 0; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const gap = 8;
    const ew = (w - gap) / 2;
    const { n, side, px, py } = this.cols;
    const sc = [0, 0], ox = [0, 0], oy = [0, 0];
    for (let s = 0; s < 2; s++) {
      sc[s] = Math.min((ew - 6) / this.span[s][0], (h - 6) / this.span[s][1]);
      ox[s] = s * (ew + gap) + (ew - this.span[s][0] * sc[s]) / 2;
      oy[s] = (h - this.span[s][1] * sc[s]) / 2;
    }
    const r = Math.max(1.0, sc[0] * 0.44);
    const map = this.map;
    let moved = 0;
    // one global, very slow breath for the whole lattice, so it is alive without being striped
    const idle = "rgba(58,132,160," + (0.17 + 0.030 * Math.sin(t * 0.55)).toFixed(3) + ")";
    for (let i = 0; i < n; i++) {
      const s = side[i];
      const x = ox[s] + px[i] * sc[s];
      const y = oy[s] + py[i] * sc[s];
      const b = map ? map[i] : 128;
      const img = this.img;
      // Three maps in one cell, as the board draws them: the IMAGE this column sampled underneath,
      // then the ON / OFF contrast the brain is actually injected with, over it. The idle lattice
      // is UNIFORM — a per-column breathing phase drew diagonal bands that read as a gradient.
      // A column the cameras never reach is left at 0,0,0 by the retina (the lens leaves it there
      // too — a 100 deg frustum does not cover a 170 deg eye), and painting those pure black turned
      // the idle lattice into a hole. An untouched triplet keeps the breathing lattice; only a
      // column that really sampled something shows what it sampled.
      const o = 3 * i;
      if (img && (img[o] | img[o + 1] | img[o + 2])) {
        ctx.fillStyle = "rgb(" + ((img[o] * 0.70) | 0) + "," + ((img[o + 1] * 0.82) | 0) + "," + ((img[o + 2] * 0.95) | 0) + ")";
      } else {
        ctx.fillStyle = idle;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.2832);
      ctx.fill();
      if (b !== 128) {
        moved++;
        const v = Math.sqrt(Math.min(1, Math.abs(b - 128) / 127)); // display gamma, disclosed
        ctx.fillStyle = b > 128
          ? "rgba(255," + (190 - 60 * v | 0) + ",70," + (0.34 + 0.66 * v).toFixed(3) + ")"
          : "rgba(70," + (200 + 40 * v | 0) + ",255," + (0.34 + 0.66 * v).toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fill();
      }
    }
    this.moved = moved;
    // the eye's own outline: a thin frame per eye so the panel reads as an instrument
    ctx.strokeStyle = "rgba(45,138,165,.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(.5, .5, ew - 1, h - 1);
    ctx.strokeRect(ew + gap + .5, .5, ew - 1, h - 1);

    // the connectome's own feature detectors, straight off the brain message
    const hz = this.hz;
    let top = 1;
    if (hz) for (const b of this.bars) {
      const l = hz[b.key] || 0, rr = hz[b.key.slice(0, -1) + "R"] || 0;
      if (l > top) top = l;
      if (rr > top) top = rr;
    }
    this.peak += (Math.max(1, top) - this.peak) * (1 - Math.exp(-dt / 1.6));
    for (const b of this.bars) {
      const l = hz ? hz[b.key] || 0 : 0, rr = hz ? hz[b.key.slice(0, -1) + "R"] || 0 : 0;
      const wl = Math.max(0, Math.min(1, l / this.peak)) * 48;
      const wr = Math.max(0, Math.min(1, rr / this.peak)) * 48;
      if (Math.abs(wl - b.lw) > 0.4) { b.lw = wl; b.l.style.width = wl.toFixed(1) + "%"; b.l.style.background = this.tint; }
      if (Math.abs(wr - b.rw) > 0.4) { b.rw = wr; b.r.style.width = wr.toFixed(1) + "%"; b.r.style.background = this.tint; }
    }
  }
}
