/**
 * TrainView — the training session as an instrument (ADR 61 follow-up; the lens's `train` field).
 *
 * Everything drawn here is a field of that packet, 1:1:
 *   mode / phase / n / N       the session and where it is (probe -> bouts -> probe)
 *   csPlus / csMinus           the two things, named, never "stimulus A"
 *   biasBefore / biasAfter     the measured bias, on a shared zero line (the paper's zero)
 *   eff                        the KC->MBON efficacy, sampled; the CURVE is built here from
 *                              those samples over the session, the way the trail is built from
 *                              poses — the lens sends the value, not the history
 *   mbon                       whatever MBON rates the feed names (MBON07 / MBON11 ...)
 *   result                     the verdict, said in words
 * No field is invented and none is smoothed into something it is not: an absent field draws nothing.
 */
const PH = { idle: 0, probe: 1, bout: 2, bouts: 2, probe2: 3, done: 4 };

export class TrainView {
  constructor(timelineCanvas, effCanvas) {
    this.tl = timelineCanvas;
    this.tlx = timelineCanvas.getContext("2d");
    this.ef = effCanvas;
    this.efx = effCanvas.getContext("2d");
    this.eff = [];      // efficacy samples for this session
    this.us = [];       // bout index of every US pulse we were told about
    this.sessionKey = "";
    this.t = 0;
  }

  /** a new `train` object off the feed; returns true when it starts a new session */
  set(d) {
    this.d = d;
    if (!d) return false;
    const key = (d.mode || "") + "|" + (d.csPlus || "") + "|" + (d.csMinus || "") + "|" + (d.N || 0) + "|" + (d.startedAt || "");
    const fresh = key !== this.sessionKey;
    if (fresh) { this.sessionKey = key; this.eff = []; this.us = []; }
    if (typeof d.eff === "number") {
      const last = this.eff[this.eff.length - 1];
      if (!last || Math.abs(last.v - d.eff) > 1e-9 || last.n !== (d.n | 0)) this.eff.push({ v: d.eff, n: d.n | 0 });
      if (this.eff.length > 600) this.eff.shift();
    }
    // a US tick per bout the feed reports while it is presenting the CS+
    const ph = PH[String(d.phase || "").toLowerCase()] ?? 0;
    if (ph === 2 && d.n > 0 && this.us[this.us.length - 1] !== d.n) this.us.push(d.n);
    return fresh;
  }

  frame(dt, accent) {
    this.t += dt;
    this._timeline(accent);
    this._effCurve(accent);
  }

  _fit(c) {
    const w = c.clientWidth | 0, h = c.clientHeight | 0;
    if (!w || !h) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== (w * dpr | 0) || c.height !== (h * dpr | 0)) { c.width = w * dpr | 0; c.height = h * dpr | 0; }
    const x = c.getContext("2d");
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    return { x, w, h };
  }

  /** probe -> N bouts -> probe, with a US tick on every bout the feed reported */
  _timeline(accent) {
    const f = this._fit(this.tl);
    if (!f) return;
    const { x, w, h } = f;
    const d = this.d || {};
    const N = Math.max(1, d.N | 0 || 8);
    const ph = PH[String(d.phase || "").toLowerCase()] ?? 0;
    const n = Math.max(0, Math.min(N, d.n | 0));
    const y = h - 13;
    const padL = 30, padR = 30;
    const x0 = padL, x1 = w - padR;
    const bx = (i) => x0 + ((x1 - x0) * i) / N;

    x.strokeStyle = "#12414f";
    x.lineWidth = 1;
    x.beginPath(); x.moveTo(2, y + 0.5); x.lineTo(w - 2, y + 0.5); x.stroke();

    // the two probes, at the ends
    for (const [px, done, label] of [[padL / 2, ph >= 2, "PROBE"], [w - padR / 2, ph >= 4, "PROBE"]]) {
      x.strokeStyle = done ? accent : "#2d8aa5";
      x.fillStyle = done ? accent : "transparent";
      x.beginPath(); x.arc(px, y, 4.2, 0, 6.2832); x.stroke(); if (done) x.fill();
      x.fillStyle = "#5d8390";
      x.font = "8px ui-monospace, Menlo, monospace";
      x.textAlign = "center";
      x.fillText(label, px, y + 12);
    }
    // the bouts
    for (let i = 1; i <= N; i++) {
      const px = bx(i - 0.5);
      const on = i <= n && ph >= 2;
      x.fillStyle = on ? accent : "#143743";
      x.fillRect(px - 5, y - 15, 10, 13);
      if (this.us.indexOf(i) >= 0) { // the US pulse that made it a pairing
        x.fillStyle = "#ffcf5a";
        x.fillRect(px - 1, y - 24, 2, 7);
      }
      if (i === n && ph === 2) { // where we are now: a breathing cursor, never a frozen dot
        x.globalAlpha = 0.35 + 0.35 * Math.sin(this.t * 4);
        x.fillStyle = accent;
        x.fillRect(px - 7, y - 17, 14, 17);
        x.globalAlpha = 1;
      }
    }
    x.fillStyle = "#5d8390";
    x.font = "8px ui-monospace, Menlo, monospace";
    x.textAlign = "center";
    x.fillText("US", (bx(0) + bx(N)) / 2, y - 27);
  }

  /** the efficacy the lens reported, sample by sample, over this session */
  _effCurve(accent) {
    const f = this._fit(this.ef);
    if (!f) return;
    const { x, w, h } = f;
    const e = this.eff;
    x.strokeStyle = "#12414f";
    x.setLineDash([2, 3]);
    x.beginPath(); x.moveTo(0, h - 0.5); x.lineTo(w, h - 0.5); x.stroke();
    x.setLineDash([]);
    if (e.length < 2) {
      x.fillStyle = "#3c6a78";
      x.font = "9px ui-monospace, Menlo, monospace";
      x.fillText("no samples yet", 2, h / 2);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (const s of e) { if (s.v < lo) lo = s.v; if (s.v > hi) hi = s.v; }
    const span = Math.max(1e-4, hi - lo);
    const px = (i) => (w * i) / (e.length - 1);
    const py = (v) => h - 3 - ((v - lo) / span) * (h - 8);
    x.beginPath();
    x.moveTo(px(0), py(e[0].v));
    for (let i = 1; i < e.length; i++) x.lineTo(px(i), py(e[i].v));
    x.strokeStyle = accent;
    x.lineWidth = 1.4;
    x.shadowColor = accent;
    x.shadowBlur = 7;
    x.stroke();
    x.shadowBlur = 0;
    x.fillStyle = accent;
    x.beginPath(); x.arc(px(e.length - 1), py(e[e.length - 1].v), 2.4, 0, 6.2832); x.fill();
    x.fillStyle = "#3c6a78";
    x.font = "8px ui-monospace, Menlo, monospace";
    x.fillText(hi.toFixed(3), 2, 8);
    x.fillText(lo.toFixed(3), 2, h - 4);
  }
}

/** past sessions, one bar each — drawn only if the feed actually carries a history */
export function drawHistory(canvas, hist, accent) {
  const w = canvas.clientWidth | 0, h = canvas.clientHeight | 0;
  if (!w || !h || !hist || !hist.length) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== (w * dpr | 0)) { canvas.width = w * dpr | 0; canvas.height = h * dpr | 0; }
  const x = canvas.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  const n = Math.min(hist.length, 24);
  const bw = Math.max(2, (w - (n - 1) * 2) / n);
  let top = 0;
  for (const s of hist) top = Math.max(top, Math.abs(val(s)));
  top = Math.max(0.2, top);
  // a shared mid-line, so a session that moved the bias the other way hangs BELOW it
  const mid = Math.round(h / 2);
  x.fillStyle = "#12414f";
  x.fillRect(0, mid, w, 1);
  hist.slice(-n).forEach((s, i) => {
    const v = val(s);
    const bh = Math.max(1, (Math.abs(v) / top) * (mid - 1));
    x.fillStyle = v > 0 ? accent : v < 0 ? "#9a86d8" : "#1d5464";
    x.fillRect(i * (bw + 2), v >= 0 ? mid - bh : mid + 1, bw, bh);
  });
  return true;
}
const val = (s) => (typeof s === "number" ? s : s && (s.biasAfter ?? s.delta ?? s.eff ?? 0)) || 0;
