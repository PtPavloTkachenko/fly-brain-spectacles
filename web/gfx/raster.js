/** Raster — the last 30 s of every NEURAL row, one line each, scrolling left (ADR 61).
 *  A single-column blit per tick: the history is the canvas itself, so it costs one drawImage. */
export class Raster {
  constructor(canvas, rows) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d");
    this.rows = rows;
    this.t = 0;
    this.hz = 12; // one column per 1/12 s = 30 s across ~360 columns
  }
  frame(dt, values, accent) {
    const c = this.c, ctx = this.ctx;
    const cw = c.clientWidth | 0, ch = c.clientHeight | 0;
    if (!cw || !ch) return;
    // the backing store follows DEVICE pixels, so the one-pixel columns stay crisp on a retina
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    if (c.width !== w || c.height !== h) {
      // a resize used to CLEAR: thirty seconds of history were thrown away by a tab switch, a
      // window drag or the session strip opening. Re-blit the old picture instead.
      let old = null;
      if (c.width > 1 && c.height > 1) {
        old = document.createElement("canvas");
        old.width = c.width; old.height = c.height;
        old.getContext("2d").drawImage(c, 0, 0);
      }
      c.width = w; c.height = h;
      ctx.clearRect(0, 0, w, h);
      if (old) ctx.drawImage(old, w - old.width, 0, old.width, h);   // keep the RIGHT edge: it is now
    }
    this.t += dt;
    if (this.t < 1 / this.hz) return;
    this.t = 0;
    const step = Math.max(1, Math.round(dpr));
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(c, -step, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(w - step, 0, step, h);
    const n = this.rows;
    const bh = h / n;
    const edge = Math.max(1, Math.round(dpr));
    for (let i = 0; i < n; i++) {
      // a band edge, always drawn, so twelve rows read as twelve rows even where nothing fired
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#16323d";
      ctx.fillRect(w - step, Math.round(i * bh), step, edge);
      const v = Math.pow(Math.max(0, Math.min(1, values[i])), 1.7);
      if (v <= 0.004) continue;
      ctx.fillStyle = i >= 6 ? accent : "rgba(95,216,245,1)";
      ctx.globalAlpha = 0.16 + 0.84 * v;
      const y = i * bh;
      ctx.fillRect(w - step, y + bh * (1 - v) * 0.5, step, Math.max(1, bh * v));
    }
    ctx.globalAlpha = 1;
  }
}
