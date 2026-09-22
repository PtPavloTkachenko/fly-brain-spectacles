/**
 * BrainView — the whole brain, lit by the whole brain (ADR 61).
 *
 * WHAT IS REAL, precisely:
 *  - every point is one neuron of MaleCNS v1.0 at its measured position (`brain/results/pointcloud.npz`:
 *    140,638 at their own soma, 25,850 at the synapse-weighted mean of located partners, 212 at the
 *    global centroid). The inferred ones are drawn dimmer and the page says how many there are.
 *  - the glow is EVERY neuron's own spike: the worker hands the page `fb_spikes_all`, one bit per
 *    neuron per 50 ms step, straight out of the core. Nothing is sampled, nothing goes near the relay.
 *  - the lines are real synapses: the six strongest OUTGOING edges of every neuron (982,224 of the
 *    connectome's 25.6 M), so no neuron is mute and no region is silent for want of a strong synapse.
 *  - a pulse leaves a soma when THAT neuron fires and travels to the target it really projects to.
 *    Warm = excitatory, cool = inhibitory, brightness by |weight|. The travel time is a display
 *    choice and is stated on screen: this model's synaptic delay is a flat 1.8 ms for every edge,
 *    so every hop takes the same time here too.
 *
 * DETAIL (2026-09-15). All of that is still more than a loaded laptop can draw at 60 fps, so the
 * three heavy layers are ordered PROGRESSIVELY and drawn as a prefix: every neuron's arbor
 * segments are laid out so the first eighth is an even subsample of every arbor, and the synapses
 * are laid out by their rank inside their own neuron, so the first bucket is the STRONGEST synapse
 * of every neuron. LOW is therefore never a silent region or a missing cell, only a sparser one.
 * `brain.setDetail()` / `?detail=` pick a rung; auto measures the page's own frame time and walks
 * the ladder with hysteresis. A level change cross-fades over 0.4 s (a second mesh over the same
 * GPU buffer draws the arriving or leaving slice at its own alpha) so nothing ever hard-cuts.
 *
 * HOW it stays at 60 fps with a million synapses: nothing is per-frame CPU work. Positions, the
 * edge table and the per-neuron last-spike time live in textures; the point cloud, the resting
 * lines and the pulses are three draws whose vertex buffers hold one float each (an index), and
 * every shader reads what it needs out of those textures. The only upload per brain step is the
 * 1 MB last-spike texture.
 */
import * as THREE from "../vendor/three.module.min.js";
import { Post } from "./post.js";
import { asset } from "../config.js";

const NT = 512;   // neuron texture side: 512^2 = 262,144 >= 166,700
const ET = 1024;  // edge texture side: 1024^2 = 1,048,576 >= 982,224
const AT = 2048;  // arbor point texture side: 2048^2 = 4,194,304 >= 2 x 1,996,613 endpoints
const S = 150;    // the unit cube -> scene units
const KSEG = 4;   // segments per fibre: enough for the bend to read as a curve

// The ladder. `arbor` / `edge` are bucket indices: a level draws buckets 0..k of each layer, and
// the buckets are built so that prefix is an even subsample (arbor) or the strongest-first slice
// of every neuron's own outgoing synapses (edges). `bloom` is the pyramid depth in post.js.
export const DETAIL = [
  { name: "LOW", arbor: 0, edge: 0, bloom: 1 },
  { name: "MEDIUM", arbor: 1, edge: 1, bloom: 2 },
  { name: "HIGH", arbor: 2, edge: 2, bloom: 3 },
  { name: "ULTRA", arbor: 3, edge: 3, bloom: 4 },
];
const LEVEL_OF = { low: 0, medium: 1, high: 2, ultra: 3 };
// which bucket an arbor segment falls in, by its index inside its own neuron: one in eight, then
// one in four, then one in two, then all of them -- an even thinning, not a truncated arbor
const ARBOR_BUCKET = [0, 3, 2, 3, 1, 3, 2, 3];
// and a synapse, by its rank inside its own neuron (they are stored strongest first)
const EDGE_BUCKET = [0, 1, 2, 2, 3, 3];
const HOP = 0.18;         // the pulse hop, seconds of page time (the model's own delay is 1.8 ms)
// skel_l0.bin carries its quantiser in its version byte, so a reader never guesses: v2 saturated
// at 4 units and clipped the longest arbors, v3 reaches 8. (make_assets.py::FLYL_VERSION)
const FLYL_Q = { 2: 16384.0, 3: 8192.0 };
const MM_PER_UNIT = 0.49762;               // the fitted MaleCNS affine: one unit cube unit, in mm
const SU_PER_MM = S / MM_PER_UNIT;         // and therefore scene units per brain millimetre
const FADE_S = 0.4;       // a level change cross-fades over this; it never cuts
const DOWN_MS = 18;       // median frame above this -> one rung down
const UP_MS = 9;          // and below this, held, -> one rung up
// MEASURED 2026-09-15: requestAnimationFrame is pinned to the display, so on a 60 Hz panel the
// page's own frame time cannot go under 16.7 ms however light the brain is, and a flat 9 ms test
// would never let auto climb back. The real question is "is the page holding the refresh rate",
// so the step-up test is 9 ms OR within FLOOR_SLACK of the fastest frame this session has seen
// (8.3 ms on a 120 Hz panel, 16.7 on a 60 Hz one). Disclosed, because it is not the flat 9 ms.
const FLOOR_SLACK = 1.5;
const SETTLE_S = 0.6;     // frames right after a change are the change, not the new steady state

const COMMON = `
precision highp float;
uniform mat4 projectionMatrix, modelViewMatrix;
uniform sampler2D uPos, uSpike;
uniform float uTime, uDecay;
vec4 node(float i) { return texture2D(uPos, (vec2(mod(i, ${NT}.0), floor(i / ${NT}.0)) + 0.5) / ${NT}.0); }
float spikeAge(float i) {
  float t0 = texture2D(uSpike, (vec2(mod(i, ${NT}.0), floor(i / ${NT}.0)) + 0.5) / ${NT}.0).r;
  return t0 <= 0.0 ? 1e6 : uTime - t0;
}
vec3 hue2rgb(float h) {
  vec3 k = mod(vec3(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return 1.0 - 0.78 * clamp(min(k, 4.0 - k), 0.0, 1.0);
}
uniform sampler2D uMask;
uniform vec3 uClassCol[13];
uniform vec3 uCentroid[13];
uniform float uChain, uBend;
float mask(float i) { return texture2D(uMask, (vec2(mod(i, ${NT}.0), floor(i / ${NT}.0)) + 0.5) / ${NT}.0).r; }
// a fibre bows toward the middle of the population it leaves, so a tract reads as a tract
vec3 bez(vec3 a, vec3 b, vec3 c, float t) {
  float u = 1.0 - t;
  return u * u * a + 2.0 * u * t * c + t * t * b;
}`;

// ---------------------------------------------------------------- the neurons
const NEURON_VS = COMMON + `
attribute float position;   // the neuron's index, and nothing else
attribute float aHue;
attribute float aGroup;
attribute float aClass;
uniform float uSize, uFocus, uLife, uCine;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 nd = node(position);
  float firm = nd.w;
  float act = exp(-spikeAge(position) * uDecay);
  float focus = 1.0;
  if (uFocus > 0.5) focus = (mod(floor(aGroup / uFocus), 2.0) >= 1.0) ? 1.0 : 0.05;
  // a hovered population: its own neurons in the class colour, its cascade behind it, the rest away
  float mk = mask(position);
  if (uChain > 0.5) focus *= mk > 0.9 ? 1.6 : mk > 0.05 ? 0.35 + 0.9 * mk : 0.035;
  float breath = 0.84 + 0.16 * sin(uTime * 0.9 + aHue * 24.0 + position * 0.0007) * uLife;
  vec4 mv = modelViewMatrix * vec4(nd.xyz, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, uSize * (0.46 + 1.05 * act + (uChain > 0.5 && mk > 0.9 ? 0.9 : 0.0)) * firm * (480.0 / max(60.0, -mv.z)));
  vec3 base = mix(hue2rgb(aHue), uClassCol[int(aClass)], 0.85);
  vCol = mix(base * (0.46 + 0.36 * breath), vec3(1.0, 0.88, 0.52), clamp(act * act * 1.8, 0.0, 1.0));
  vA = focus * (0.065 + 0.145 * firm + (0.20 + 0.35 * uCine) * act * act);
}`;

const NEURON_FS = `
precision mediump float;
varying vec3 vCol;
varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float A = vA * (1.0 - 3.6 * r);
  gl_FragColor = vec4(vCol * A, A); // premultiplied: the canvas is, and additive adds rgb straight
}`;

// ---------------------------------------------------------------- the resting connections
// the two ends of a synapse, when edges.bin v3 has them: the presynaptic neuron's own skeleton
// point nearest the postsynaptic soma, and the postsynaptic neuron's own point nearest the
// presynaptic soma. Real measured points off skel_l0.bin; -1 means that neuron had none and the
// end stays at its soma. The class-centroid bow exists to make soma-to-soma lines read as tracts,
// so it is switched OFF exactly where both ends are real -- there the chord IS the geometry.
const SITE = `
uniform sampler2D uArbor, uSite;
uniform float uSites;
vec3 apt(float i) { return texture2D(uArbor, (vec2(mod(i, ${AT}.0), floor(i / ${AT}.0)) + 0.5) / ${AT}.0).xyz; }
vec2 euv(float e) { return (vec2(mod(e, ${ET}.0), floor(e / ${ET}.0)) + 0.5) / ${ET}.0; }`;

const WIRE_VS = COMMON + SITE + `
attribute float position;   // vertex index: KSEG segments per edge, 2 vertices each
uniform sampler2D uEdge;
uniform float uFocus, uWire, uFadeA;
varying float vA;
void main() {
  float v = position;
  float e = floor(v / ${KSEG * 2}.0);
  float j = mod(floor(v * 0.5), ${KSEG}.0) + mod(v, 2.0);
  vec4 ed = texture2D(uEdge, euv(e));
  vec4 a = node(ed.x), b = node(ed.y);
  vec3 pa = a.xyz, pb = b.xyz;
  float real = 0.0;
  if (uSites > 0.5) {
    vec4 st = texture2D(uSite, euv(e));
    if (st.x >= 0.0) { pa = apt(st.x); real = 1.0; }
    if (st.y >= 0.0) { pb = apt(st.y); } else { real = 0.0; }
  }
  vec3 ctrl = mix((pa + pb) * 0.5, uCentroid[int(ed.w)], uBend * (1.0 - real));
  vec3 p = bez(pa, pb, ctrl, j / ${KSEG}.0);
  float mk = uChain > 0.5 ? mask(ed.x) : 1.0;
  vA = uFadeA * uWire * (0.55 + 0.45 * abs(ed.z)) * (uChain > 0.5 ? (mk > 0.05 ? 2.6 * mk : 0.06) : 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const WIRE_FS = `
precision mediump float;
varying float vA;
void main() { gl_FragColor = vec4(vec3(0.24, 0.52, 0.66) * vA, vA); }`;

// ---------------------------------------------------------------- the pulses
// Each pulse is a short streak, not a dot: a head at the spike's position along the edge and a
// tail behind it. A dot in a cloud of a million reads as dust; a streak reads as a signal going
// somewhere, which is what it is.
const PULSE_VS = COMMON + SITE + `
attribute float position;   // vertex index: edge = floor(v/2), end = 0 tail / 1 head
uniform sampler2D uEdge;
uniform float uHop, uFocus, uPulse, uTail, uFadeA;
varying vec3 vCol;
varying float vA;
void main() {
  float e = floor(position * 0.5), end = mod(position, 2.0);
  vec4 ed = texture2D(uEdge, euv(e));
  float k = spikeAge(ed.x) / uHop;
  if (k < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
  float kk = end > 0.5 ? k : max(0.0, k - uTail);
  vec4 a = node(ed.x), b = node(ed.y);
  vec3 pa = a.xyz, pb = b.xyz;
  vec3 ctrl = mix((pa + pb) * 0.5, uCentroid[int(ed.w)], uBend);
  if (uSites > 0.5) {
    vec4 st = texture2D(uSite, euv(e));
    vec3 qa = st.x >= 0.0 ? apt(st.x) : pa;
    vec3 qb = st.y >= 0.0 ? apt(st.y) : pb;
    // leave ALONG the fibre: the other end of that same arbor segment is its direction, so the
    // streak comes out of the branch it really leaves from instead of sideways out of nothing
    vec3 tang = vec3(0.0);
    if (st.x >= 0.0) tang = qa - apt(st.x + (mod(st.x, 2.0) < 0.5 ? 1.0 : -1.0));
    float L = length(tang);
    ctrl = L > 1e-4 ? qa + (tang / L) * (0.35 * distance(qa, qb)) : (qa + qb) * 0.5;
    pa = qa; pb = qb;
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(bez(pa, pb, ctrl, kk), 1.0);
  float w = abs(ed.z);
  // warm leaving an excitatory synapse, cool leaving an inhibitory one — the connectome's own sign
  vCol = ed.z >= 0.0 ? vec3(1.0, 0.74, 0.34) : vec3(0.36, 0.76, 1.0);
  float mk = uChain > 0.5 ? mask(ed.x) : 1.0;
  vA = uFadeA * uPulse * (0.04 + 0.96 * pow(w, 1.25)) * sin(3.14159 * k) * end
     * (uChain > 0.5 ? (mk > 0.05 ? 1.0 + 1.4 * mk : 0.05) : 1.0);
}`;

const PULSE_FS = `
precision mediump float;
varying vec3 vCol;
varying float vA;
void main() {
  if (vA <= 0.002) discard;
  gl_FragColor = vec4(vCol * vA, vA);
}`;

// ---------------------------------------------------------------- the anatomical hull
const SVERT = `
precision highp float;
uniform mat4 projectionMatrix, modelViewMatrix;
uniform mat3 normalMatrix;
attribute vec3 position;
attribute vec3 normal;
varying vec3 vN, vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const SFRAG = `
precision mediump float;
uniform vec3 uCol;
uniform float uFade, uGain;
varying vec3 vN, vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
  float A = uFade * uGain * (0.035 + 0.75 * f);
  gl_FragColor = vec4(uCol * A, A);
}`;

// class -> [label, colour]. The first six are the anatomical regions, then five command populations
// the body reads plus PPL101, which it does not read at all (it moves the plastic synapses), then
// everything the connectome did not put in either. PPL101's label is STRESS (Pavlo's word, 21.09; it IS the punishment dopamine, the blurb says so): the
// cell idles near 71 Hz with nothing happening, and an emotion on a raw rate is a lie (21.09).
export const CLASS = [
  ["OPTIC LOBE", 0x4fd3ff], ["CENTRAL BRAIN", 0x9ab4ff], ["MUSHROOM BODY", 0xffc94f],
  ["SENSORY", 0x63ffb0], ["DESCENDING", 0xff6fae], ["VNC", 0xb98cff],
  ["DNa02 L", 0x33ff73], ["DNa02 R", 0x9dff33], ["ESCAPE", 0xff5c48],
  ["STOP", 0xffa030], ["FEED", 0x5cffd0], ["STRESS", 0xd06bff], ["OTHER", 0x3d6b7a],
];

// EVERY neuron's real arbor: its own precomputed MaleCNS skeleton, decimated to N segments. The
// points live in a texture; the geometry is one float per vertex, so 2 M segments cost 16 MB.
const ARBOR_VS = COMMON + `
attribute float position;          // vertex index: point = position
attribute float aDist;             // path length from THIS neuron's soma, along its own skeleton
uniform sampler2D uArbor, uClassTex;
uniform float uArborGain, uFadeA, uCond, uWave, uDistScale, uConduct;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 a = texture2D(uArbor, (vec2(mod(position, ${AT}.0), floor(position / ${AT}.0)) + 0.5) / ${AT}.0);
  float owner = a.w;
  float age = spikeAge(owner);
  float flash = exp(-age * uDecay);
  // CONDUCTION: the spike leaves the cell body and runs OUT along the fibre at uCond scene units
  // per second. A point is dark until the front reaches it (a soft leading edge of uWave), then it
  // decays from the moment the front passed IT, not from the moment the cell fired. The whole
  // effect is one subtraction and two exps -- same draw call, same fetches.
  float lead = aDist * uDistScale - age * uCond;
  float wave = lead > 0.0 ? exp(-(lead * lead) / (uWave * uWave)) : exp(-(-lead / uCond) * uDecay);
  float act = mix(flash, wave, uConduct);
  float mk = uChain > 0.5 ? mask(owner) : 1.0;
  vec4 cl = texture2D(uClassTex, (vec2(mod(owner, ${NT}.0), floor(owner / ${NT}.0)) + 0.5) / ${NT}.0);
  vCol = mix(uClassCol[int(cl.r * 255.0 + 0.5)] * 0.55, vec3(1.0, 0.90, 0.58), clamp(act * 1.5, 0.0, 1.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(a.xyz, 1.0);
  vA = uFadeA * uArborGain * (0.055 + (0.95 + 1.15 * uConduct) * act) * (uChain > 0.5 ? (mk > 0.05 ? 1.0 + mk : 0.05) : 1.0);
}`;
const ARBOR_FS = `
precision mediump float;
varying vec3 vCol; varying float vA;
void main() { if (vA <= 0.003) discard; gl_FragColor = vec4(vCol * vA, vA); }`;

// the 39 hand-picked skeletons: drawn in their own class colour, brightening with their own spike
const SKEL_VS = COMMON + `
attribute vec3 position;
attribute float aOwner;
attribute float aClass;
uniform float uSkel;
varying vec3 vCol;
varying float vA;
void main() {
  float act = aOwner >= 0.0 ? exp(-spikeAge(aOwner) * uDecay) : 0.0;
  float mk = (uChain > 0.5 && aOwner >= 0.0) ? mask(aOwner) : 1.0;
  vCol = mix(uClassCol[int(aClass)], vec3(1.0, 0.92, 0.6), clamp(act * 1.6, 0.0, 1.0));
  vA = uSkel * (0.16 + 0.84 * act) * (uChain > 0.5 ? (mk > 0.05 ? 1.0 + mk : 0.06) : 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKEL_FS = `
precision mediump float;
varying vec3 vCol; varying float vA;
void main() { if (vA <= 0.003) discard; gl_FragColor = vec4(vCol * vA, vA); }`;

// head LEFT, nerve cord RIGHT, the way the reference draws it: the A-P axis rolled onto the screen X
const VIEWS = {
  default: { roll: 0, yaw: 0.42, pitch: 0.10, dist: 575 },
  top: { roll: Math.PI / 2, yaw: 0, pitch: 0, dist: 540 },
  side: { roll: Math.PI / 2, yaw: 0, pitch: 1.45, dist: 540 },
  front: { roll: Math.PI / 2, yaw: Math.PI / 2, pitch: 0, dist: 470 },
};
const NEUROPIL_COL = (n) => (n.indexOf("OL") === 0 ? 0x4fd3ff : n.indexOf("MB") === 0 ? 0xffc94f
  : n.indexOf("CX") === 0 ? 0x9ab4ff : n.indexOf("AL") === 0 ? 0x63ffb0 : n.indexOf("LH") === 0 ? 0xff9ad4
  : n.indexOf("SEZ") === 0 ? 0xffa030 : 0xb98cff);

// most specific region first: a Kenyon cell is a mushroom-body cell before it is a central one
const REGION_ORDER = [2, 0, 5, 3, 4, 1];

const POP = new Uint8Array(256);
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1) + ((i >> 4) & 1) + ((i >> 5) & 1) + ((i >> 6) & 1) + ((i >> 7) & 1);

export class BrainView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.reduced = !!opts.reducedMotion;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 4, 4000);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.yaw = this.yawWant = 0.42;
    this.roll = this.rollWant = 0;
    this.viewName = "default";
    this.cine = false;
    this.arborGain = 0.10;
    this.pitch = this.pitchWant = 0.10;
    this.dist = 700;
    this.distWant = 575;
    this.spin = this.reduced ? 0 : 0.055;
    this.fade = 0;
    this.exp = 1;
    this.frac = 0;
    this.lit = 0;
    this.keys = [];
    this.focus = 0;
    this.n = 0;
    this.nEdge = 0;
    this.ready = false;
    this.t = 0;
    this.post = new Post(this.renderer, opts.bloom === undefined ? 4 : opts.bloom);

    // ---- the detail ladder. ?detail=ultra|high|medium|low|auto, auto by default.
    const q = new URLSearchParams(location.search);
    const want = String(opts.detail || q.get("detail") || "auto").toLowerCase();
    this.autoDetail = want === "auto" || !(want in LEVEL_OF);
    this.levelIdx = this.autoDetail ? 0 : LEVEL_OF[want];   // 22.09: auto starts at LOW and climbs -- a HIGH first frame could hang a busy GPU before auto ever measured (Pavlo: the 3D is what killed the browser)
    this.bloomLock = q.has("bloom");                        // an explicit ?bloom= is the operator's
    this.trans = null;
    this.layers = [];
    this._cbs = [];
    this._ms = new Float32Array(180);                       // the page's own frame deltas, a ring
    this._msAt = new Float32Array(180);
    this._msI = 0;
    this._msN = 0;
    this._last = 0;
    this._drawnAt = 0;
    this._changedAt = 0;
    this._belowSince = 0;
    this._upWindow = 10;                                    // grows if a step up has to be undone
    this._statAt = 0;
    this.median = 0;
    this._floor = 99;       // the fastest frame seen: the display's own period, measured not assumed
    this.drawMs = 0;
    // ?gpuprobe=1 times the draw around a gl.finish(). MEASURED: it reports 0.3-0.5 ms at every
    // rung, because Chrome runs GL in a separate process and finish() only drains the client side.
    // It measures the SUBMIT, never the card. Kept as a diagnostic, and labelled as one.
    this.gpuProbe = q.get("gpuprobe") === "1";
    // conduction: 1 brain-mm per 120 ms of page time (?conduct=0 turns it off, ?mmps= retimes it)
    this.conduct = q.get("conduct") !== "0";
    // Real arbor endpoints make every streak SHORT, so the layer emits far less light than the old
    // soma-to-soma cables did. That is a look decision, not a truth one, so it is a knob and not a
    // silent rebalance: ?pulse= and ?wire= (or brain.pulseGain / brain.wireGain), 1 = as measured.
    this.pulseGain = +(q.get("pulse") || 0) || 1;
    this.wireGain = +(q.get("wire") || 0) || 1;
    this.mmPerS = +(q.get("mmps") || 0) || (1 / 0.120);
    window.brain = this;                                    // the page's handle on all of this
    this._input(canvas);
  }

  /** one layer, drawn twice over ONE GPU buffer: the settled prefix, and the slice that is
   *  currently fading in or out. Sharing the BufferAttribute means no second copy on the card. */
  _pairLayer(attrs, uni, vs, fs, renderOrder) {
    const geo = () => {
      const g = new THREE.BufferGeometry();
      for (const k in attrs) g.setAttribute(k, attrs[k]);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), S * 1.9);
      return g;
    };
    const mat = (a) => new THREE.RawShaderMaterial({
      vertexShader: vs, fragmentShader: fs,
      uniforms: Object.assign({}, uni, { uFadeA: { value: a } }),
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    });
    const main = new THREE.LineSegments(geo(), mat(1));
    const fade = new THREE.LineSegments(geo(), mat(0));
    for (const m of [main, fade]) { m.frustumCulled = false; m.renderOrder = renderOrder; this.root.add(m); }
    fade.visible = false;
    const L = { main, fade, ends: [0, 0, 0, 0] };
    this.layers.push(L);
    return L;
  }

  _input(el) {
    let down = false, px = 0, py = 0;
    const stop = () => { this.spin = 0; };
    el.addEventListener("pointerdown", (e) => { down = true; px = e.clientX; py = e.clientY; stop(); el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointerup", (e) => { down = false; try { el.releasePointerCapture(e.pointerId); } catch (x) {} });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      this.yawWant += (e.clientX - px) * 0.0062;
      this.pitchWant = Math.max(-1.25, Math.min(1.25, this.pitchWant + (e.clientY - py) * 0.005));
      px = e.clientX; py = e.clientY;
    });
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.distWant = Math.max(200, Math.min(1500, this.distWant * (1 + e.deltaY * 0.0011))); }, { passive: false });
    // the same view, from the keyboard
    el.addEventListener("keydown", (e) => {
      const k = { ArrowLeft: [-0.12, 0, 0], ArrowRight: [0.12, 0, 0], ArrowUp: [0, -0.08, 0], ArrowDown: [0, 0.08, 0], "+": [0, 0, -40], "=": [0, 0, -40], "-": [0, 0, 40] }[e.key];
      if (!k) return;
      e.preventDefault();
      stop();
      this.yawWant += k[0];
      this.pitchWant = Math.max(-1.25, Math.min(1.25, this.pitchWant + k[1]));
      this.distWant = Math.max(200, Math.min(1500, this.distWant + k[2]));
    });
  }

  _tex(data, side, fmt, type) {
    const t = new THREE.DataTexture(data, side, side, fmt, type);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  /** assets/neurons.bin — layout in web/make_assets.py */
  async load(url) {
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const dv = new DataView(buf.buffer);
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "FLYN") throw new Error("neurons.bin: bad magic");
    const n = dv.getUint32(8, true), nStream = dv.getUint32(12, true), nEdge0 = dv.getUint32(16, true);
    let o = 24;
    while (buf[o] !== 0) o++;
    this.keys = JSON.parse(new TextDecoder().decode(buf.subarray(24, o)));
    o += 1 + ((8 - ((o + 1 - 24) % 8)) % 8);
    const xyz = new Int16Array(buf.buffer, buf.byteOffset + o, n * 3); o += n * 6;
    const hue = buf.subarray(o, o + n); o += n;
    const flag = buf.subarray(o, o + n); o += n;
    const group = new Uint16Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + n * 2)); o += n * 2 + nStream * 4 + nEdge0 * 4;

    // positions + placement firmness in one RGBA32F texture: the unit cube stood up the way the
    // lens does it, brain at the top and VNC below
    const pos = new Float32Array(NT * NT * 4);
    const cpu = new Float32Array(n * 3);
    let soma = 0, partners = 0, centroid = 0;
    for (let i = 0; i < n; i++) {
      const x = (xyz[3 * i] / 32767) * S, y = (-xyz[3 * i + 2] / 32767) * S, z = (xyz[3 * i + 1] / 32767) * S;
      pos[4 * i] = cpu[3 * i] = x;
      pos[4 * i + 1] = cpu[3 * i + 1] = y;
      pos[4 * i + 2] = cpu[3 * i + 2] = z;
      pos[4 * i + 3] = flag[i] === 0 ? 1 : flag[i] === 1 ? 0.55 : 0.25;
      if (flag[i] === 0) soma++; else if (flag[i] === 1) partners++; else centroid++;
    }
    this.cpuPos = cpu;
    this.groupArr = group;
    this.placed = { soma, partners, centroid };
    this.posTex = this._tex(pos, NT, THREE.RGBAFormat, THREE.FloatType);
    this.spike = new Float32Array(NT * NT);
    this.spikeTex = this._tex(this.spike, NT, THREE.RedFormat, THREE.FloatType);
    this.maskArr = new Uint8Array(NT * NT);
    this.maskTex = this._tex(this.maskArr, NT, THREE.RedFormat, THREE.UnsignedByteType);

    // one class per neuron: a command population if it is in one, else its region, else "other".
    // The colour it gets here is the colour it gets in the legend and on the row that names it.
    const cls = new Float32Array(n);
    const count = new Array(CLASS.length).fill(0);
    for (let i = 0; i < n; i++) {
      const g = group[i];
      let c = CLASS.length - 1;
      for (let b2 = this.keys.length - 1; b2 >= 6; b2--) if (g & (1 << b2)) { c = b2; break; }
      if (c === CLASS.length - 1) for (const b2 of REGION_ORDER) if (g & (1 << b2)) { c = b2; break; }
      cls[i] = c;
      count[c]++;
    }
    this.classOf = cls;
    const cbytes = new Uint8Array(NT * NT);
    for (let i = 0; i < n; i++) cbytes[i] = cls[i];
    this.classTex = this._tex(cbytes, NT, THREE.RedFormat, THREE.UnsignedByteType);
    this.classCount = count;
    // and the centre of each class, which is where its fibres bow toward
    const cen = [];
    for (let c = 0; c < CLASS.length; c++) {
      let x = 0, y = 0, z = 0, k = 0;
      for (let i = 0; i < n; i++) if (cls[i] === c) { x += cpu[3 * i]; y += cpu[3 * i + 1]; z += cpu[3 * i + 2]; k++; }
      cen.push(new THREE.Vector3(k ? x / k : 0, k ? y / k : 0, k ? z / k : 0));
    }
    this.classCentroid = cen;

    this.uni = {
      uPos: { value: this.posTex }, uSpike: { value: this.spikeTex }, uMask: { value: this.maskTex },
      uTime: { value: 0 }, uDecay: { value: 3.1 }, uSize: { value: 3.0 },
      uFocus: { value: 0 }, uLife: { value: this.reduced ? 0 : 1 }, uCine: { value: 0 },
      uChain: { value: 0 }, uBend: { value: 0.42 },
      uClassCol: { value: CLASS.map((c) => new THREE.Color(c[1])) },
      uCentroid: { value: cen },
    };
    const idx = (count) => {
      const a = new Float32Array(count);
      for (let i = 0; i < count; i++) a[i] = i;
      return a;
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(idx(n), 1));
    g.setAttribute("aHue", new THREE.BufferAttribute(Float32Array.from(hue, (v) => v / 255), 1));
    g.setAttribute("aGroup", new THREE.BufferAttribute(Float32Array.from(group), 1));
    g.setAttribute("aClass", new THREE.BufferAttribute(cls, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), S * 1.9);
    this.points = new THREE.Points(g, new THREE.RawShaderMaterial({
      vertexShader: NEURON_VS, fragmentShader: NEURON_FS, uniforms: this.uni,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    this.root.add(this.points);

    this.n = n;
    this.nStream = nStream;
    await this.shells(asset("assets/shells.bin"));
    await this.neuropils(asset("assets/neuropils.bin"));
    await this.skeletons(asset("assets/skeletons.bin"));
    this.ready = true;
    return { n, nStream, keys: this.keys, placed: this.placed, classes: CLASS, count, cls };
  }

  /** assets/edges.bin — the synapses that carry the pulses */
  async edges(url, cap) {
    let buf;
    try { buf = new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch (e) { return 0; }
    if (buf.length < 16 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "FLYE") return 0;
    const dv = new DataView(buf.buffer);
    const ver = dv.getUint32(4, true);
    let m = dv.getUint32(8, true);
    const k = dv.getUint32(12, true);
    if (cap && m > cap) m = cap;
    const mAll = dv.getUint32(8, true);
    let o = 20;
    const pre = new Uint32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + mAll * 4)); o += mAll * 4;
    const post = new Uint32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + mAll * 4)); o += mAll * 4;
    const w = new Int8Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + mAll)); o += mAll;
    // v3: the two real skeleton points this synapse runs between (make_assets.py::_synapse_sites)
    this.edgeSites = 0;
    if (ver >= 3 && buf.length >= o + mAll * 8) {
      const sa = new Uint32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + mAll * 4));
      const sb = new Uint32Array(buf.buffer.slice(buf.byteOffset + o + mAll * 4, buf.byteOffset + o + mAll * 8));
      const st = new Float32Array(ET * ET * 4);
      for (let i = 0; i < m; i++) {
        const a = sa[i], b = sb[i];
        st[4 * i] = a === 0xFFFFFFFF ? -1 : a;
        st[4 * i + 1] = b === 0xFFFFFFFF ? -1 : b;
        if (a !== 0xFFFFFFFF && b !== 0xFFFFFFFF) this.edgeSites++;
      }
      this.siteTex = this._tex(st, ET, THREE.RGBAFormat, THREE.FloatType);
    }

    const ed = new Float32Array(ET * ET * 4);
    for (let i = 0; i < m; i++) {
      ed[4 * i] = pre[i];
      ed[4 * i + 1] = post[i];
      ed[4 * i + 2] = w[i] / 127;
      ed[4 * i + 3] = this.classOf ? this.classOf[pre[i]] : 12; // whose tract this fibre belongs to
    }
    this.edgeTex = this._tex(ed, ET, THREE.RGBAFormat, THREE.FloatType);
    this.eUni = Object.assign({}, this.uni, {
      uEdge: { value: this.edgeTex }, uHop: { value: HOP },
      uWire: { value: 0.0 }, uPulse: { value: 0.0 }, uTail: { value: 0.16 },
      // the arbor texture may still be streaming in: the sites switch on the moment it lands
      uArbor: { value: this.arborTex || null }, uSite: { value: this.siteTex || null },
      uSites: { value: this.siteTex && this.arborTex ? 1 : 0 },
    });

    // the progressive order: an edge's bucket is its RANK inside its own presynaptic neuron, and
    // make_assets.py writes each neuron's outgoing edges strongest first. So bucket 0 is the
    // single strongest synapse of every neuron -- at LOW every cell still has something to send.
    const cnt4 = [0, 0, 0, 0];
    const bof = new Uint8Array(m);
    for (let i = 0, r = 0; i < m; i++) {
      if (i) r = pre[i] !== pre[i - 1] ? 0 : r + 1;
      const b = EDGE_BUCKET[Math.min(r, EDGE_BUCKET.length - 1)];
      bof[i] = b;
      cnt4[b]++;
    }
    const at = [0, 0, 0, 0];
    for (let b = 0, acc = 0; b < 4; b++) { at[b] = acc; acc += cnt4[b]; }
    const wIdx = new Float32Array(m * KSEG * 2), pIdx = new Float32Array(m * 2);
    const cur = at.slice();
    for (let i = 0; i < m; i++) {
      const slot = cur[bof[i]]++;
      for (let v = 0; v < KSEG * 2; v++) wIdx[slot * KSEG * 2 + v] = i * KSEG * 2 + v;
      pIdx[slot * 2] = i * 2;
      pIdx[slot * 2 + 1] = i * 2 + 1;
    }

    this.Lwire = this._pairLayer({ position: new THREE.BufferAttribute(wIdx, 1) }, this.eUni, WIRE_VS, WIRE_FS, -2);
    this.Lpulse = this._pairLayer({ position: new THREE.BufferAttribute(pIdx, 1) }, this.eUni, PULSE_VS, PULSE_FS, 0);
    for (let b = 0; b < 4; b++) {
      this.Lwire.ends[b] = (at[b] + cnt4[b]) * KSEG * 2;
      this.Lpulse.ends[b] = (at[b] + cnt4[b]) * 2;
    }
    this.wires = this.Lwire.main;
    this.pulses = this.Lpulse.main;
    this.edgeBuckets = cnt4;
    this._applyLevel(this.levelIdx, false);
    this.edgePre = pre.subarray(0, m);
    this.edgePost = post.subarray(0, m);
    this.edgeW = w.subarray(0, m);
    this.nEdge = m;
    this.nEdgeAll = mAll;
    this.outDegree = k;
    return m;
  }

  /** assets/shells.bin — the decimated MaleCNS brain and VNC surfaces */
  async shells(url, gain = 0.85, dim = false) {
    let buf;
    try { buf = new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch (e) { return; }
    if (buf.length < 12 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "FLYS") return;
    const dv = new DataView(buf.buffer);
    const parts = dv.getUint32(8, true);
    let o = 12;
    if (!this.hull) this.hull = [];
    for (let k = 0; k < parts; k++) {
      const nl = dv.getUint16(o, true); o += 2;
      const name = new TextDecoder().decode(buf.subarray(o, o + nl)); o += nl;
      const nv = dv.getUint32(o, true); o += 4;
      const src = new Int16Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nv * 6)); o += nv * 6;
      const p = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        p[3 * i] = (src[3 * i] / 32767) * S;
        p[3 * i + 1] = (-src[3 * i + 2] / 32767) * S;
        p[3 * i + 2] = (src[3 * i + 1] / 32767) * S;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      g.computeVertexNormals();
      const col = dim ? NEUROPIL_COL(name) : name[0] === "b" ? 0x5fd8f5 : 0x7fa9ff;
      const uni = { uCol: { value: new THREE.Color(col) }, uFade: { value: 0 }, uGain: { value: gain } };
      const m = new THREE.Mesh(g, new THREE.RawShaderMaterial({
        vertexShader: SVERT, fragmentShader: SFRAG, uniforms: uni,
        transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      }));
      m.renderOrder = -1;
      this.root.add(m);
      this.hull.push(uni);
    }
  }

  /** assets/skel_l0.bin — EVERY neuron's real arbor, decimated to N segments per neuron */
  async arbors(url) {
    let buf;
    try { buf = new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch (e) { return 0; }
    if (buf.length < 20 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "FLYL") return 0;
    const dv = new DataView(buf.buffer);
    const ver = dv.getUint32(4, true);
    const nN = dv.getUint32(8, true), nSeg = dv.getUint32(12, true), per = dv.getUint32(16, true);
    let o = 20;
    const table = new Int32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nN * 12)); o += nN * 12;
    const q = new Int16Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nSeg * 2 * 6)); o += nSeg * 12;
    const nPt = Math.min(nSeg * 2, AT * AT);
    // v2 carries the PATH length from every neuron's soma to every one of its points, walked along
    // the skeleton's own edges. v1 has none: the straight line from the soma stands in, which is
    // still a measured distance, just not the walk -- `arborPath` says which one the page is on.
    let dq = null;
    if (ver >= 2 && buf.length >= o + nSeg * 4) dq = new Uint16Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nSeg * 4));
    this.arborPath = !!dq;
    const qScale = FLYL_Q[ver] || 16384.0;

    const tex = new Float32Array(AT * AT * 4);
    for (let i = 0; i < nPt; i++) {
      tex[4 * i] = (q[3 * i] / 32767) * S;
      tex[4 * i + 1] = (-q[3 * i + 2] / 32767) * S;
      tex[4 * i + 2] = (q[3 * i + 1] / 32767) * S;
    }
    if (!dq) dq = new Uint16Array(nPt);
    let maxQ = 0;
    for (let k = 0; k < nN; k++) {              // whose arbor each endpoint is
      const owner = table[3 * k], first = table[3 * k + 1], cnt = table[3 * k + 2];
      for (let sgi = first; sgi < first + cnt; sgi++) {
        const i0 = 2 * sgi;
        if (i0 + 1 >= nPt) break;
        tex[4 * i0 + 3] = owner;
        tex[4 * (i0 + 1) + 3] = owner;
        if (!this.arborPath && this.cpuPos && owner >= 0) {   // the v1 stand-in, in the same units
          for (const i of [i0, i0 + 1]) {
            const dx = tex[4 * i] - this.cpuPos[3 * owner], dy = tex[4 * i + 1] - this.cpuPos[3 * owner + 1], dz = tex[4 * i + 2] - this.cpuPos[3 * owner + 2];
            dq[i] = Math.min(65535, Math.round((Math.sqrt(dx * dx + dy * dy + dz * dz) / S) * qScale));
          }
        }
        if (dq[i0] > maxQ) maxQ = dq[i0];
        if (dq[i0 + 1] > maxQ) maxQ = dq[i0 + 1];
      }
    }
    this.arborTex = this._tex(tex, AT, THREE.RGBAFormat, THREE.FloatType);
    if (this.eUni) {                            // edges.bin landed first: give it its geometry now
      this.eUni.uArbor.value = this.arborTex;
      this.eUni.uSites.value = this.siteTex ? 1 : 0;
    }

    // the progressive order: bucket by the segment's index INSIDE its own neuron, so the first
    // bucket is an even one-in-eight sample of every arbor and LOW thins, never truncates
    const cnt4 = [0, 0, 0, 0];
    for (let k = 0; k < nN; k++) {
      const first = table[3 * k + 1], c = table[3 * k + 2];
      for (let s = 0; s < c; s++) { if (2 * (first + s) + 1 >= nPt) break; cnt4[ARBOR_BUCKET[s & 7]]++; }
    }
    const at = [0, 0, 0, 0];
    let acc = 0;
    for (let b = 0; b < 4; b++) { at[b] = acc; acc += cnt4[b] * 2; }
    const idx = new Float32Array(acc), ad = new Uint16Array(acc);
    const cur = at.slice();
    for (let k = 0; k < nN; k++) {
      const first = table[3 * k + 1], c = table[3 * k + 2];
      for (let s = 0; s < c; s++) {
        const i0 = 2 * (first + s);
        if (i0 + 1 >= nPt) break;
        const b = ARBOR_BUCKET[s & 7], w = cur[b];
        idx[w] = i0; ad[w] = dq[i0];
        idx[w + 1] = i0 + 1; ad[w + 1] = dq[i0 + 1];
        cur[b] = w + 2;
      }
    }

    // the wave's speed: the asked-for 1 mm per 120 ms, raised if the longest arbor would otherwise
    // still be lighting up when the next hop starts (the brief's clamp to the step hop)
    const reach = (maxQ / qScale) * S;
    const cond = Math.max(this.mmPerS * SU_PER_MM, reach / HOP);
    this.condReach = reach;
    this.condMmPerS = cond / SU_PER_MM;
    this.aUni = Object.assign({}, this.uni, {
      uArbor: { value: this.arborTex }, uClassTex: { value: this.classTex }, uArborGain: { value: 0 },
      uCond: { value: cond }, uWave: { value: 16.0 }, uDistScale: { value: S / qScale },
      uConduct: { value: this.conduct ? 1 : 0 },
    });
    const attrs = { position: new THREE.BufferAttribute(idx, 1), aDist: new THREE.BufferAttribute(ad, 1) };
    this.Larbor = this._pairLayer(attrs, this.aUni, ARBOR_VS, ARBOR_FS, -1);
    for (let b = 0; b < 4; b++) this.Larbor.ends[b] = at[b] + cnt4[b] * 2;
    this.arbor = this.Larbor.main;
    this.arborBuckets = cnt4;
    this.nArborSeg = acc >> 1;
    this.arborPer = per;
    this._applyLevel(this.levelIdx, false);
    return this.nArborSeg;
  }

  /** assets/skeletons.bin — the 39 hand-picked skeletons, each tied to its own neuron
   *  so it lights from that neuron's measured spikes. There are no synapse-site coordinates in
   *  the dataset, so these 39 are the only true morphology on the page and the page says so. */
  async skeletons(url) {
    let buf;
    try { buf = new Uint8Array(await (await fetch(url)).arrayBuffer()); } catch (e) { return 0; }
    if (buf.length < 20 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "FLYK") return 0;
    const dv = new DataView(buf.buffer);
    const nCell = dv.getUint32(8, true), nPt = dv.getUint32(12, true), nSeg = dv.getUint32(16, true);
    let o = 20;
    while (buf[o] !== 0) o++;
    this.skelNames = JSON.parse(new TextDecoder().decode(buf.subarray(20, o)));
    o += 1 + ((8 - ((o + 1 - 20) % 8)) % 8);
    const meta = new Int32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nCell * 12)); o += nCell * 12;
    const q = new Int16Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nPt * 6)); o += nPt * 6;
    const seg = new Uint32Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + nSeg * 8));

    const pos = new Float32Array(nPt * 3);
    const owner = new Float32Array(nPt);
    const klass = new Float32Array(nPt);
    for (let i = 0; i < nPt; i++) {
      pos[3 * i] = (q[3 * i] / 32767) * S;
      pos[3 * i + 1] = (-q[3 * i + 2] / 32767) * S;
      pos[3 * i + 2] = (q[3 * i + 1] / 32767) * S;
    }
    for (let c = 0; c < nCell; c++) {
      const ni = meta[3 * c], at = meta[3 * c + 1], len = meta[3 * c + 2];
      for (let i = at; i < at + len; i++) {
        owner[i] = ni;
        klass[i] = ni >= 0 && this.classOf ? this.classOf[ni] : 4;
      }
    }
    const sp = new Float32Array(nSeg * 2 * 3), so = new Float32Array(nSeg * 2), sc = new Float32Array(nSeg * 2);
    for (let e = 0; e < nSeg * 2; e++) {
      const v = seg[e];
      sp[3 * e] = pos[3 * v]; sp[3 * e + 1] = pos[3 * v + 1]; sp[3 * e + 2] = pos[3 * v + 2];
      so[e] = owner[v];
      sc[e] = klass[v];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    g.setAttribute("aOwner", new THREE.BufferAttribute(so, 1));
    g.setAttribute("aClass", new THREE.BufferAttribute(sc, 1));
    this.sUni = Object.assign({}, this.uni, { uSkel: { value: 0 } });
    this.skel = new THREE.LineSegments(g, new THREE.RawShaderMaterial({
      vertexShader: SKEL_VS, fragmentShader: SKEL_FS, uniforms: this.sUni,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    this.skel.frustumCulled = false;
    this.root.add(this.skel);
    this.nSkel = nCell;
    this.nSkelSeg = nSeg;
    return nCell;
  }

  /** assets/neuropils.bin — the 16 real neuropil surfaces, in the same unit space */
  async neuropils(url) {
    await this.shells(url, 0.30, true);
  }

  /** the camera presets: the reference's top view (head left, cord right), a side and a front */
  view(name) {
    const v = VIEWS[name] || VIEWS.default;
    this.rollWant = v.roll;
    this.yawWant = v.yaw;
    this.pitchWant = v.pitch;
    this.distWant = v.dist;
    this.spin = 0;
    this.viewName = name;
  }

  /** a per-neuron mask: 255 = the hovered population, 1..3 = how many hops downstream */
  setChain(mask) {
    if (!mask) { this.uni.uChain.value = 0; return; }
    this.maskArr.set(mask.subarray(0, Math.min(mask.length, this.maskArr.length)));
    this.maskTex.needsUpdate = true;
    this.uni.uChain.value = 1;
  }

  // ---------------------------------------------------------------- the detail ladder
  /** move to `next`: the settled prefix redraws at once, the difference cross-fades over FADE_S */
  _applyLevel(next, animate) {
    const from = this.levelIdx;
    const set = [[this.Larbor, "arbor"], [this.Lwire, "edge"], [this.Lpulse, "edge"]];
    let moving = false;
    for (const [L, key] of set) {
      if (!L) continue;
      const ne = L.ends[DETAIL[next][key]], oe = L.ends[DETAIL[from][key]];
      if (!animate || ne === oe) { L.main.geometry.setDrawRange(0, ne); L.fade.visible = false; continue; }
      moving = true;
      const lo = Math.min(ne, oe);
      L.main.geometry.setDrawRange(0, lo);                 // what both levels agree on
      L.fade.geometry.setDrawRange(lo, Math.abs(ne - oe)); // and the slice arriving or leaving
      L.fade.material.uniforms.uFadeA.value = ne > oe ? 0 : 1;
      L.fade.visible = true;
    }
    if (animate && moving) this.trans = { to: next, up: DETAIL[next].arbor > DETAIL[from].arbor, t: 0 };
    else this._commit(next);
  }

  _commit(next) {
    this.levelIdx = next;
    this.trans = null;
    const set = [[this.Larbor, "arbor"], [this.Lwire, "edge"], [this.Lpulse, "edge"]];
    for (const [L, key] of set) {
      if (!L) continue;
      L.main.geometry.setDrawRange(0, L.ends[DETAIL[next][key]]);
      L.fade.visible = false;
    }
    if (!this.bloomLock) this.post.setLevels(DETAIL[next].bloom);
    this._changedAt = this.t;
    this._belowSince = 0;
    this._emit(true);
  }

  /** "ultra" | "high" | "medium" | "low" | "auto" -- anything else is ignored */
  setDetail(level) {
    const k = String(level == null ? "" : level).toLowerCase();
    if (k === "auto") return this.detailAuto();
    if (!(k in LEVEL_OF)) return this.detail();
    this.autoDetail = false;
    if (LEVEL_OF[k] !== this.levelIdx && !this.trans) this._applyLevel(LEVEL_OF[k], true);
    else this._emit(true);
    return this.detail();
  }

  /** the level being drawn right now, as its name */
  detail() { return DETAIL[this.levelIdx].name; }

  /** hand the ladder back to the frame-time measurement */
  detailAuto() {
    this.autoDetail = true;
    this._belowSince = 0;
    this._changedAt = this.t;
    this._emit(true);
    return this.detail();
  }

  /** cb({level, ms, ...}) four times a second and on every change; returns an unsubscribe */
  onDetail(cb) {
    if (typeof cb !== "function") return () => {};
    this._cbs.push(cb);
    cb(this.stats());
    return () => { const i = this._cbs.indexOf(cb); if (i >= 0) this._cbs.splice(i, 1); };
  }

  /** what the ENGINE chip reads; also published as window.__brainStats */
  stats() {
    const d = DETAIL[this.levelIdx];
    const ms = Math.round(this.median * 10) / 10;
    return {
      level: d.name,
      levelIndex: this.levelIdx,
      auto: this.autoDetail,
      ms,
      label: d.name + " \u00b7 " + Math.round(ms) + " MS",
      fps: ms > 0 ? Math.round(1000 / ms) : 0,
      segments: this.Larbor ? this.Larbor.ends[d.arbor] >> 1 : 0,
      segmentsAll: this.nArborSeg || 0,
      pulses: this.Lpulse ? this.Lpulse.ends[d.edge] >> 1 : 0,
      pulsesAll: this.nEdge || 0,
      bloom: this.bloomLock ? this.post.levels : d.bloom,
      conduction: this.conduct,
      conductionMmPerS: this.condMmPerS || 0,
      arborPath: !!this.arborPath,
      sites: this.edgeSites || 0,
      pulseGain: this.pulseGain,
      wireGain: this.wireGain,
      sitesOn: !!(this.eUni && this.eUni.uSites.value > 0.5),
      moving: !!this.trans,
      floorMs: Math.round(this._floor * 10) / 10,
      drawMs: this.gpuProbe ? Math.round(this.drawMs * 10) / 10 : 0,
    };
  }

  _emit(changed) {
    const s = this.stats();
    s.changed = !!changed;
    window.__brainStats = s;
    for (const cb of this._cbs.slice()) { try { cb(s); } catch (e) {} }
  }

  /** the median of the page's own frame deltas over the last `win` seconds, minus the frames that
   *  ARE a level change (a cross-fade draws both slices, so it is never the new steady state) */
  _median(now, win) {
    const a = [];
    for (let i = 0; i < this._msN; i++) {
      const at = this._msAt[i];
      if (now - at > win) continue;
      if (at >= this._changedAt && at - this._changedAt < SETTLE_S) continue;
      a.push(this._ms[i]);
    }
    if (a.length < 5) return this.median;
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  }

  _tickDetail(now) {
    if (!this.ready) return;
    if (!this._drawnAt) this._drawnAt = now;
    if (now - this._statAt < 0.25) return;
    this._statAt = now;
    this.median = this._median(now, 2.0);
    // the floor is the best MEDIAN this session has held, not one lucky frame: on a display-locked
    // page every rung under the cap reports the same number, and that number IS the headroom test
    if (this.median > 0 && this.median < this._floor && now - this._changedAt > 2) this._floor = this.median;
    this._emit(false);
    if (!this.autoDetail || this.trans) return;
    if (now - this._drawnAt < 4) return;            // start at HIGH and just watch for 4 s
    if (now - this._changedAt < 10) return;         // never more than one change per 10 s
    const med = this.median;
    if (!med) return;
    if (med > DOWN_MS && this.levelIdx > 0) {
      if (now - (this._upAt || -1e9) < 20) this._upWindow = Math.min(120, this._upWindow * 2);
      this._applyLevel(this.levelIdx - 1, true);    // a step up it had to undo: wait longer next time
      return;
    }
    if (med < Math.max(UP_MS, this._floor + FLOOR_SLACK) && this.levelIdx < DETAIL.length - 1) {
      if (!this._belowSince) this._belowSince = now;
      if (now - this._belowSince >= this._upWindow) { this._upAt = now; this._applyLevel(this.levelIdx + 1, true); }
    } else this._belowSince = 0;
  }

  /** the spike travelling out along the arbor (ADR: it is the brief's display speed, not biology) */
  setConduction(on) {
    this.conduct = !!on;
    if (this.aUni) this.aUni.uConduct.value = this.conduct ? 1 : 0;
    this._emit(true);
    return this.conduct;
  }

  cinematic(on) {
    this.cine = !!on && !this.reduced;
    this.spin = this.cine ? 0.085 : (this.reduced ? 0 : 0.055);
    if (!this.cine) this.exp = Math.min(this.exp, 1.9); // leaving cinema leaves no bright residue
  }

  /** every neuron's spike for this step, MSB first, straight from fb_spikes_all */
  spikesAll(bits) {
    const now = this.t;
    const sp = this.spike;
    const n = this.n;
    let lit = 0;
    for (let byte = 0, i = 0; i < n; byte++) {
      const v = bits[byte];
      if (v) {
        lit += POP[v];
        const top = Math.min(i + 8, n);
        for (let b = i; b < top; b++) if ((v >> (7 - (b - i))) & 1) sp[b] = now;
      }
      i += 8;
    }
    this.lit = lit;
    this.spikeTex.needsUpdate = true;
  }

  setFocus(bit) { this.focus = bit || 0; }

  resize() {
    const w = this.canvas.clientWidth | 0, h = this.canvas.clientHeight | 0;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, w > 2000 ? 1.5 : 2);
    if (this.canvas.width !== (w * dpr | 0) || this.canvas.height !== (h * dpr | 0)) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      // a point cloud spread over more pixels is a dimmer point cloud: hold the density
      this.uni.uSize.value = 3.0 * Math.pow((h * dpr) / 900, 0.45);
    }
    this.post.setSize(w, h, dpr);
  }

  frame(dt, t) {
    // the page's OWN frame time, unclamped and measured here, not app.js's smoothed fps
    const w = performance.now();
    if (this._last) {
      const d = w - this._last;
      if (d > 0 && d < 500) {
        this._ms[this._msI] = d;
        this._msAt[this._msI] = t;
        this._msI = (this._msI + 1) % this._ms.length;
        if (this._msN < this._ms.length) this._msN++;
      }
    }
    this._last = w;
    if (!this.ready) return;
    this.t = t;
    this._tickDetail(t);
    if (this.trans) {
      this.trans.t += dt / FADE_S;
      const k = Math.min(1, this.trans.t);
      const a = this.trans.up ? k : 1 - k;
      const e = a * a * (3 - 2 * a);                  // eased, like everything else on this page
      for (const L of this.layers) if (L.fade.visible) L.fade.material.uniforms.uFadeA.value = e;
      if (k >= 1) this._commit(this.trans.to);
    }
    this.resize();
    this.frac += (this.lit / Math.max(1, this.n) - this.frac) * (1 - Math.exp(-dt * 2.2));
    // the auto level tracks how much of the brain is firing; cinema asks for a slow lift on top
    // of it. Both are TARGETS: the value tweens toward them and is clamped, so it cannot run away.
    const auto = Math.max(1.0, Math.min(1.9, 0.22 / Math.max(0.01, this.frac)));
    this.expWant = Math.max(0.5, Math.min(4, auto * (this.cine ? 1.45 + 0.12 * Math.sin(t * 0.35) : 1)));
    this.exp += (this.expWant - this.exp) * (1 - Math.exp(-dt * (this.cine ? 0.8 : 0.35)));
    this.exp = Math.max(0.5, Math.min(4, this.exp));
    this.fade += (1 - this.fade) * (1 - Math.exp(-dt * 1.6));
    this.uni.uTime.value = t;
    this.uni.uFocus.value = this.focus;
    this.uni.uCine.value += ((this.cine ? 1 : 0) - this.uni.uCine.value) * (1 - Math.exp(-dt * 1.2));
    if (this.sUni) this.sUni.uSkel.value = this.fade * (0.55 + 0.45 * this.uni.uCine.value);
    if (this.aUni) this.aUni.uArborGain.value = this.fade * this.arborGain;

    if (this.eUni) {
      this.eUni.uWire.value = this.fade * 0.030 * this.wireGain;
      this.eUni.uPulse.value = this.fade * (this.reduced ? 0.4 : 1.0) * this.pulseGain;
      this.eUni.uFocus.value = this.focus;
    }
    if (this.hull) for (const u of this.hull) u.uFade.value = this.fade;
    this.yawWant += this.spin * dt;
    const e = 1 - Math.exp(-dt * (this.cine ? 3.2 : 7));
    this.yaw += (this.yawWant - this.yaw) * e;
    this.pitch += (this.pitchWant - this.pitch) * e;
    this.dist += (this.distWant - this.dist) * e;
    this.roll += (this.rollWant - this.roll) * e;   // presets tween, they never cut
    this.root.rotation.z = this.roll;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * cp * this.dist, Math.sin(this.pitch) * this.dist + 8, Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(0, 2, 0);
    const g0 = this.gpuProbe ? performance.now() : 0;
    this.post.render(this.scene, this.camera, this.exp * this.fade);
    if (this.gpuProbe) {                          // block until the card is done: the honest cost
      this.renderer.getContext().finish();
      const d = performance.now() - g0;
      this.drawMs = this.drawMs ? this.drawMs * 0.85 + d * 0.15 : d;
    }
  }

  project(v3, out) {
    const p = v3.clone().project(this.camera);
    out.x = ((p.x + 1) / 2) * this.canvas.clientWidth;
    out.y = ((1 - p.y) / 2) * this.canvas.clientHeight;
    out.on = p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1;
    return out;
  }

  centroid(bit, side = 0) {
    if (!this._cent) this._cent = {};
    const key = bit + ":" + side;
    if (this._cent[key]) return this._cent[key];
    const pos = this.cpuPos, grp = this.groupArr;
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = 0; i < grp.length; i++) {
      if (!(grp[i] & bit)) continue;
      if (side < 0 && pos[3 * i] > -25) continue;
      if (side > 0 && pos[3 * i] < 25) continue;
      x += pos[3 * i]; y += pos[3 * i + 1]; z += pos[3 * i + 2]; n++;
    }
    return (this._cent[key] = n ? new THREE.Vector3(x / n, y / n, z / n) : new THREE.Vector3());
  }
}
