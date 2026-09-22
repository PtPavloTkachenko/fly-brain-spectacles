/**
 * Post — an HDR pass for the brain (ADR 61).
 *
 * MEASURED, 2026-09-15, headless Chrome on a LOADED M1 Max (load average 14): with the pyramid off
 * the whole page holds 16.7 ms even with 2 M arbor segments on screen; with it on, the frame goes
 * to 33-50 ms, and the cost is the SAME at 1, 2 and 4 levels and the same with 8-bit targets as
 * with half-float. That points at a per-pass stall (render-target ping-pong waiting on a very deep
 * additive draw) rather than fill, and it needs re-measuring on an idle machine before it is tuned.
 * `?bloom=0..4` switches levels; 0 is the tone map alone.
 *
 * 166,700 additive points, 104,000 of them in the optic lobes, saturate any 8-bit target long
 * before the picture is bright enough to read: the lobes turn into one white blob and the anatomy
 * is lost. So the cloud is rendered into a half-float target and tone-mapped once, with a small
 * bloom taken from what is ALREADY over 1.0 — the cells that are actually firing hard. The
 * exposure is a display control; it changes nothing about the spikes.
 */
import * as THREE from "../vendor/three.module.min.js";

const QUAD = new THREE.BufferGeometry();
QUAD.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
QUAD.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const CUT = `
precision highp float;
varying vec2 vUv; uniform sampler2D tSrc; uniform float uThr, uKnee;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  // a soft knee: nothing switches on at the threshold, it eases in over uKnee
  float k = clamp((l - uThr + uKnee) / max(1e-4, 2.0 * uKnee), 0.0, 1.0);
  float w = max(l - uThr, k * k * uKnee) / max(1e-4, l);
  gl_FragColor = vec4(c * clamp(w, 0.0, 1.0), 1.0);
}`;

const DOWN = `
precision highp float;
varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
void main() {
  // a 4-tap box at the parent's texel centres: cheap, and it does not alias into the next level
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

const BLUR = `
precision highp float;
varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uDir;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += (texture2D(tSrc, vUv + uDir * 1.3846153846).rgb + texture2D(tSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
  c += (texture2D(tSrc, vUv + uDir * 3.2307692308).rgb + texture2D(tSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const UP = `
precision highp float;
varying vec2 vUv; uniform sampler2D tSrc; uniform float uAmt;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb * uAmt, 1.0); }`;

const TONE = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc, tBloom;
uniform float uExposure, uBloom, uVig;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom;
  c *= uExposure;
  c = vec3(1.0) - exp(-c);            // filmic roll-off: dense tissue stays tissue, not paper
  c = pow(c, vec3(0.88));
  vec2 d = vUv - 0.5;
  c *= 1.0 - uVig * dot(d, d) * 1.7;  // a little vignette so the stage has a centre
  float a = clamp(max(c.r, max(c.g, c.b)) * 1.25, 0.0, 1.0);
  gl_FragColor = vec4(c, a);
}`;

const MAXL = 4;   // the deepest pyramid; brain.js picks the depth it can afford per detail level

const mat = (fs, uniforms) => new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });

export class Post {
  /** no bloom at all: the tone map straight off the HDR target, for measuring what bloom costs */
  plain(scene, camera, exposure) {
    const r = this.r, target = r.getRenderTarget(), auto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.hdr); r.setClearColor(0x000000, 0); r.clear(); r.render(scene, camera);
    this.uTone.tSrc.value = this.hdr.texture;
    this.uTone.tBloom.value = this.hdr.texture;
    this.uTone.uExposure.value = exposure;
    const keep = this.uTone.uBloom.value;
    this.uTone.uBloom.value = 0;
    this.mesh.material = this.mTone; r.setRenderTarget(target); r.clear(); r.render(this.scene, this.cam);
    this.uTone.uBloom.value = keep;
    r.autoClear = auto;
  }

  /** the pyramid depth, 0..MAXL: the detail ladder in brain.js turns it down with everything else.
   *  All MAXL targets are allocated once (they are tiny, the base is capped at 512 px wide), so a
   *  level change is a loop bound and never a reallocation mid-frame. */
  setLevels(n) {
    const v = Math.max(0, Math.min(MAXL, n | 0));
    if (v === this.levels) return false;
    this.levels = v;
    return true;
  }

  constructor(renderer, levels = 4) {
    this.r = renderer;
    this.levels = Math.max(0, Math.min(MAXL, levels | 0));
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.mesh = new THREE.Mesh(QUAD, null);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    const o = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.hdr = new THREE.WebGLRenderTarget(2, 2, { ...o, depthBuffer: true });
    this.mip = [];      // the bloom pyramid: five halvings
    this.tmp = [];      // a scratch target per level, for the separable blur
    for (let i = 0; i < MAXL; i++) {
      this.mip.push(new THREE.WebGLRenderTarget(2, 2, o));
      this.tmp.push(new THREE.WebGLRenderTarget(2, 2, o));
    }
    this.uCut = { tSrc: { value: null }, uThr: { value: 0.75 }, uKnee: { value: 0.45 } };
    this.uDown = { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } };
    this.uBlur = { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } };
    this.uUp = { tSrc: { value: null }, uAmt: { value: 1 } };
    this.uTone = { tSrc: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.75 }, uVig: { value: 0.5 } };
    this.mCut = mat(CUT, this.uCut);
    this.mDown = mat(DOWN, this.uDown);
    this.mBlur = mat(BLUR, this.uBlur);
    this.mUp = mat(UP, this.uUp);
    this.mUp.blending = THREE.AdditiveBlending;
    this.mUp.transparent = true;
    this.mTone = mat(TONE, this.uTone);
  }

  setSize(w, h, dpr) {
    const W = Math.max(2, (w * dpr) | 0), H = Math.max(2, (h * dpr) | 0);
    if (this.w === W && this.h === H) return;
    this.w = W; this.h = H;
    this.hdr.setSize(W, H);
    // the base of the pyramid is capped at 512 px wide: the blur is measured in screen space, so a
    // bigger base buys nothing visible and costs the whole budget (measured: 33 ms at half-size)
    const base = Math.min(512, Math.max(64, (W / 4) | 0));
    const scale = base / W;
    for (let i = 0; i < MAXL; i++) {
      const s = 1 << i;
      const lw = Math.max(2, (W * scale / s) | 0), lh = Math.max(2, (H * scale / s) | 0);
      this.mip[i].setSize(lw, lh);
      this.tmp[i].setSize(lw, lh);
    }
  }

  /** render `scene` through the pass; exposure is set by the caller each frame */
  render(scene, camera, exposure) {
    if (this.levels <= 0) return this.plain(scene, camera, exposure);
    const r = this.r;
    const target = r.getRenderTarget();
    const auto = r.autoClear;
    r.autoClear = false;              // Three clears on every render() otherwise, which would
    r.setRenderTarget(this.hdr);      // throw away the additive accumulation below
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, camera);

    const blit = (m, to, clear = true) => {
      this.mesh.material = m;
      r.setRenderTarget(to);
      if (clear) r.clear(true, false, false);
      r.render(this.scene, this.cam);
    };

    // 1. bright pass with a soft knee, straight into the first (half-size) level
    this.uCut.tSrc.value = this.hdr.texture;
    this.uCut.uThr.value = 0.62 / Math.max(0.05, exposure);
    this.uCut.uKnee.value = this.uCut.uThr.value * 0.6;
    blit(this.mCut, this.mip[0]);

    // 2. down the pyramid
    for (let i = 1; i < this.levels; i++) {
      const src = this.mip[i - 1];
      this.uDown.tSrc.value = src.texture;
      this.uDown.uTexel.value.set(0.5 / src.width, 0.5 / src.height);
      blit(this.mDown, this.mip[i]);
    }

    // 3. blur every level separably, then add it into the level above — a wide, soft glow that
    //    keeps its shape instead of the one-level smear this used to be
    for (let i = this.levels - 1; i >= 0; i--) {
      const lv = this.mip[i];
      this.uBlur.tSrc.value = lv.texture;
      this.uBlur.uDir.value.set(1.2 / lv.width, 0);
      blit(this.mBlur, this.tmp[i]);
      this.uBlur.tSrc.value = this.tmp[i].texture;
      this.uBlur.uDir.value.set(0, 1.2 / lv.height);
      blit(this.mBlur, lv);
      if (i > 0) {
        this.uUp.tSrc.value = lv.texture;
        this.uUp.uAmt.value = 0.82;
        blit(this.mUp, this.mip[i - 1], false);   // additive, no clear
      }
    }

    // 4. composite
    this.uTone.tSrc.value = this.hdr.texture;
    this.uTone.tBloom.value = this.mip[0].texture;
    this.uTone.uExposure.value = exposure;
    blit(this.mTone, target);
    r.autoClear = auto;
  }
}
