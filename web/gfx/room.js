/**
 * RoomView — the real room, rebuilt from the lens's `scene` feed (ADR 61).
 *
 * WHAT IS REAL: the point cloud is the Spectacles world mesh (its own vertices, in cm); the box is
 * the scanned room bounds; every marker is a thing Gemini labelled in that room, at the position
 * the lens resolved through depth / World Query; the flies and the head are the poses the lens
 * sends at WEB_SCENE_HZ. WHAT IS OURS: the trails (built here from those poses), the interpolation
 * between packets, and the ground grid, which is drawn under the scanned floor as a reference.
 *
 * Two views out of one scene: the orbit camera, and — bottom right — a camera sitting in the
 * selected fly's head, looking where it looks. That second one is "what the fly sees", at the fly's
 * real 100 deg field.
 *
 * HOW HEAVY the room is drawn is a control (`setMode`, MODES below, the MESH chip in app.js): the
 * lit surface, its wireframe alone, the scan's bare vertices, or nothing. All four are the SAME
 * geometry — a mode is a visibility flag and, for the wire, a material swap. None of them touches
 * what arrives from the lens or what the brain is shown.
 *
 * `eyePixels()` is that second camera again, offscreen and tiny: ?demo=1 has no glasses, so the
 * `eye` bytes the brain is injected with have to come from the fly's own view of THIS room
 * (gfx/demo.js does the ommatidial sampling). Nothing on the relay path calls it.
 */
import * as THREE from "../vendor/three.module.min.js";

const FLY_COLORS = [0x33ff73, 0xff4dd9, 0x33d9ff, 0xffb833, 0x9e6bff];
const CLS_COLOR = { food: 0x5cff8a, lure: 0xffcc33, threat: 0xff6a5c, bad: 0xb070ff, scent: 0xff8ad4, object: 0x9fd6e8 };
const TRAIL = 260; // ~4.3 s of flight at 60 fps (the page says so under the panel)

// A flat-shaded room: one fixed key light plus a rim, so the facets read without a light rig — and,
// where the scan painted it, the room's OWN colour instead of the one blue (`surfc`, below).
// `aCol` is not called `color` on purpose: on a ShaderMaterial that name belongs to three's own
// USE_COLOR path and is not declared for us, so it would be a silently unbound attribute.
const SURF_VS = `
attribute vec3 aCol; attribute float aSeen;
varying vec3 vN; varying vec3 vV; varying float vD; varying vec3 vC; varying float vSeen;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vD = length(mv.xyz);
  vC = aCol;
  vSeen = aSeen;
  gl_Position = projectionMatrix * mv;
}`;
const SURF_FS = `
precision mediump float;
uniform vec3 uCol; uniform float uAlpha, uCut;
varying vec3 vN; varying vec3 vV; varying float vD; varying vec3 vC; varying float vSeen;
void main() {
  // a depth cutaway: whatever is between the eye and the middle of the room dissolves, so the
  // near wall never hides the room and the floor stays where it is
  float cut = smoothstep(uCut, uCut + 70.0, vD);
  if (cut <= 0.01) discard;
  vec3 n = normalize(vN);
  float key = 0.42 + 0.58 * max(0.0, dot(n, normalize(vec3(0.35, 0.86, 0.36))));
  float rim = pow(1.0 - abs(dot(n, normalize(vV))), 2.0);
  // what the scan saw, lit by the SAME key and rim as the unpainted room — no saturation boost and
  // no brightness lift: the additive display needs those on the glasses, a screen does not, and a
  // room repainted to look better is a room the page is lying about
  vec3 base = mix(uCol, vC, vSeen);
  gl_FragColor = vec4((base * key + vec3(0.30, 0.72, 0.88) * rim * 0.6) * cut, (uAlpha + 0.34 * rim) * cut);
}`;

/* THE LIGHT ROOM (`setMode("wire")`). The same wireframe buffer the solid room already carries, lit
 * enough to be the only thing drawn: no fill, no shading, one line pass over ~15,000 edges that are
 * already on the GPU. It keeps the surface's depth cutaway, so the near wall still dissolves, and
 * adds a far fade — with no surface writing depth nothing occludes anything, and a whole room of
 * un-faded edges reads as a hairball instead of a room. */
const WIRE_VS = `
varying float vD;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vD = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const WIRE_FS = `
precision mediump float;
uniform vec3 uCol; uniform float uAlpha, uCut, uFar;
varying float vD;
void main() {
  float cut = smoothstep(uCut, uCut + 70.0, vD);
  float far = 1.0 - smoothstep(uFar * 0.55, uFar * 1.25, vD);
  float a = uAlpha * cut * (0.34 + 0.66 * far);
  if (a <= 0.004) discard;
  gl_FragColor = vec4(uCol, a);
}`;
/** HOW THE ROOM IS DRAWN — the four modes `setMode()` takes, cheapest last but for OFF. They change
 *  what the ORBIT view draws and nothing else: no geometry is re-uploaded, no packet is refused, and
 *  the fly's eye shot (`eyePixels`) ignores them completely, because that one feeds the brain. */
const MODES = ["solid", "wire", "points", "off"];

/** A VIEW FRUSTUM AS A LINE FIGURE: apex at the origin, opening along -Z (where a camera looks),
 *  `len` deep and `2 * half` across at that depth, with the far rectangle drawn. Four edges and a
 *  rectangle say "an eye is HERE, looking THAT way"; a cone says it only if you already know which
 *  end is which — which is how one ended up drawn backwards. Used for YOU and, small and faint,
 *  for every fly. */
function frustum(len, half, col, opacity) {
  const far = [[-half, -half], [half, -half], [half, half], [-half, half]];
  const p = [];
  for (const [x, y] of far) p.push(0, 0, 0, x, y, -len);
  for (let i = 0; i < 4; i++) {
    const a = far[i], b = far[(i + 1) % 4];
    p.push(a[0], a[1], -len, b[0], b[1], -len);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: col, transparent: true, opacity: opacity, depthWrite: false,
  }));
}

const b64buf = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class RoomView {
  constructor(canvas, labelHost) {
    this.canvas = canvas;
    this.labels = labelHost;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 3, 6000);
    this.eyeCam = new THREE.PerspectiveCamera(100, 1, 1.5, 4000);
    this.centre = new THREE.Vector3(0, 0, 0);
    this.yaw = 0.7; this.yawWant = 0.7; this.pitch = 0.34; this.pitchWant = 0.34;
    this.dist = 420; this.distWant = 420;
    this.spin = 0; // the room's frame does not drift; only what is inside it moves
    this.flies = new Map();
    this.marks = new Map();
    this.mesh = null;
    this.meshV = -1;
    this.invV = -1;
    this.box = null;
    this.sel = 0;
    this.has = false;
    this.userZoom = false;
    this.csP = "";
    this.csM = "";
    this.surf = null;
    this.surfWire = null;
    this.surfPts = null;
    this.mode = "solid";     // what the orbit view draws (app.js owns the control; MODES above)
    this.wireFaint = null;   // the two line materials, made once and swapped, never rebuilt
    this.wireLit = null;
    this.surfV = -1;
    this.surfParts = null;
    this.surfTris = 0;
    this.centreWant = new THREE.Vector3();
    this.fitDist = 420;
    this.fitT = 0;
    this.fitAt = 0;
    this.fitSpan = 0;
    this.fitMin = null;
    this.fitMax = null;
    this.trailSeconds = TRAIL / 60;
    this._build();
    this._drag(canvas);
  }

  _build() {
    const grid = new THREE.GridHelper(600, 24, 0x14424f, 0x0c2a33);
    grid.material.transparent = true;
    grid.material.opacity = 0.34;
    grid.material.depthWrite = false;
    this.scene.add((this.grid = grid));
    // the user
    const you = new THREE.Group();
    const head = new THREE.Mesh(new THREE.OctahedronGeometry(6.5), new THREE.MeshBasicMaterial({ color: 0xffcf5a, wireframe: true, transparent: true, opacity: 0.95 }));
    // WHICH WAY THE PERSON IS LOOKING. This was a 4-sided cone with `rotation.x = -PI/2`, which put
    // its BASE at the head and its tip 92 cm in front — a frustum opening backwards, and it read
    // as a head turned 180 deg. A view frustum has its apex in the eye: four edges out of the head
    // and the far rectangle closed, so there is nothing to misread.
    const cone = frustum(92, 34, 0xffcf5a, 0.26);
    you.add(head, cone);
    this.you = you;
    this.youCone = cone;
    this.scene.add(you);
    you.visible = false;
  }

  _drag(el) {
    let down = false, px = 0, py = 0;
    el.addEventListener("pointerdown", (e) => { down = true; px = e.clientX; py = e.clientY; this.spin = 0; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointerup", (e) => { down = false; try { el.releasePointerCapture(e.pointerId); } catch (x) {} });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      this.yawWant += (e.clientX - px) * 0.007;
      this.pitchWant = Math.max(-0.2, Math.min(1.35, this.pitchWant + (e.clientY - py) * 0.005));
      px = e.clientX; py = e.clientY;
    });
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.userZoom = true; this.distWant = Math.max(90, Math.min(1600, this.distWant * (1 + e.deltaY * 0.0012))); }, { passive: false });
  }

  /** HOW HEAVY THE ROOM IS DRAWN, as a control (MODES above). Returns the mode actually taken, so
   *  the caller's chip says what is on screen and not what it asked for. */
  setMode(id) {
    this.mode = MODES.indexOf(id) < 0 ? "solid" : id;
    this._applyMode();
    return this.mode;
  }

  /** Is there any real room geometry? The control is hidden until there is: a menu that offers four
   *  ways to draw nothing is a menu that lies, and the SCENE status line already says why. */
  hasRoom() {
    return !!(this.surf || this.mesh);
  }

  /** THE ONE WRITER of what the room shows. Every path that builds geometry ends here, so the mode
   *  the user picked survives a new surface, a late point set and a re-scan — and nothing else in
   *  this file ever touches `.visible` on these four objects.
   *
   *  The box and the floor grid are NOT in it: they are the frame the flies are in (scanned bounds,
   *  and our own reference grid), not the mesh, and OFF is about the mesh. */
  _applyMode() {
    const m = this.mode;
    if (this.surf) this.surf.visible = m === "solid";
    if (this.surfWire) {
      this.surfWire.visible = m === "solid" || m === "wire";
      const want = m === "wire" ? this._wireLitMat() : this._wireMat();
      if (this.surfWire.material !== want) this.surfWire.material = want;
    }
    if (this.surfPts) this.surfPts.visible = m === "points";
    // the pre-surface point fallback is the room until triangles arrive, and nothing after them
    if (this.mesh) this.mesh.visible = m !== "off" && !this.surf;
  }

  /** the faint wire that has always sat over the solid room — unchanged, and the default */
  _wireMat() {
    if (!this.wireFaint) this.wireFaint = new THREE.LineBasicMaterial({
      color: 0x4fb6d4, transparent: true, opacity: 0.045, depthWrite: false });
    return this.wireFaint;
  }

  /** the same lines, carrying the room on their own (WIRE_FS above) */
  _wireLitMat() {
    if (!this.wireLit) this.wireLit = new THREE.ShaderMaterial({
      uniforms: {
        uCol: { value: new THREE.Color(0x63c8e4) }, uAlpha: { value: 0.34 },
        uCut: { value: 0 }, uFar: { value: 600 },
      },
      vertexShader: WIRE_VS, fragmentShader: WIRE_FS, transparent: true, depthWrite: false,
    });
    return this.wireLit;
  }

  /** The room as a real SURFACE (ADR 61 follow-up): the lens's own world mesh, decimated and
   *  vertex-merged, arriving a chunk per tick. Rebuilt only when the whole thing is in. */
  setSurface(m) {
    if (m.v !== this.surfV) { this.surfV = m.v; this.surfParts = new Array(m.parts).fill(null); this.surfHead = m; }
    if (!this.surfParts || m.part >= this.surfParts.length) return 0;
    this.surfParts[m.part] = m.s;
    if (this.surfParts.some((x) => x === null)) return 0;
    const [pv, pi] = this.surfParts.join("").split("|");
    this.surfParts = null;
    const vb = b64buf(pv), ib = b64buf(pi);
    const verts = new Int16Array(vb.buffer, vb.byteOffset, (vb.length / 2) | 0);
    const tris = new Uint16Array(ib.buffer, ib.byteOffset, (ib.length / 2) | 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(verts), 3));
    g.setIndex(new THREE.BufferAttribute(tris, 1));
    const flat = g.toNonIndexed();         // one normal per triangle: the room reads as facets
    flat.computeVertexNormals();
    // room for the scan's own colours, whether or not any arrive: an attribute the shader reads
    // and the geometry does not have is a silent zero, and `surfc` comes in its own message later.
    const n3 = flat.getAttribute("position").count;
    flat.setAttribute("aCol", new THREE.BufferAttribute(new Float32Array(3 * n3), 3));
    flat.setAttribute("aSeen", new THREE.BufferAttribute(new Float32Array(n3), 1));
    this.surfTri = tris;                   // the index list `surfc` is expanded through
    this.surfPainted = 0;
    if (this.surf) { this.scene.remove(this.surf); this.surf.geometry.dispose(); }
    if (this.surfWire) { this.scene.remove(this.surfWire); this.surfWire.geometry.dispose(); }
    this.surf = new THREE.Mesh(flat, new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(0x3f93ad) }, uAlpha: { value: 0.46 }, uCut: { value: 0 } },
      vertexShader: SURF_VS, fragmentShader: SURF_FS,
      transparent: true, depthWrite: true, side: THREE.BackSide,
    }));
    this.surf.renderOrder = -3;
    this.scene.add(this.surf);
    this.surfWire = new THREE.LineSegments(new THREE.WireframeGeometry(g), this._wireMat());
    this.scene.add(this.surfWire);
    // THE LIGHTEST ROOM THERE IS, out of geometry this function was about to throw away: `g`'s
    // position attribute is the scan's own merged vertex list (measured 5,458 of them), and it is
    // handed to the Points object BY REFERENCE — one buffer, drawn either as triangles or as dots,
    // never uploaded twice. Un-indexed on purpose: indexed points would draw each vertex once per
    // triangle it belongs to, which is the same picture for six times the work.
    if (this.surfPts) { this.scene.remove(this.surfPts); this.surfPts.geometry.dispose(); }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", g.getAttribute("position"));
    this.surfPts = new THREE.Points(pg, new THREE.PointsMaterial({
      color: 0x6fd0ea, size: 2.0, sizeAttenuation: false, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.surfPts);
    this._applyMode();                     // incl. the point fallback stepping aside
    this._floor(flat);
    if (m.b) this._box(m.b);
    this.has = true;
    this.surfTris = m.t;
    return m.t;
  }

  /** THE ROOM AS THE SCAN PAINTED IT (`surfc`, 16.09).
   *
   *  The lens sends `{v, c}` after the geometry of surface `v` and again every few seconds while it
   *  keeps painting: `c` is base64 RGBA per vertex, in the order of THAT surface's merged vertex
   *  list, alpha 255 where the camera actually saw the voxel and 0 where it never did. It is
   *  applied in place — the geometry is not rebuilt, only two attributes are rewritten, so a repaint
   *  costs nothing a frame notices.
   *
   *  The vertex list is the INDEXED one; the drawn geometry is not (flat facets need one normal per
   *  triangle), so every colour is expanded through the index list — each vertex lands in as many
   *  places as it has triangles. Returns how many vertices the scan had actually seen. */
  setSurfaceColors(m) {
    if (!m || !this.surf || !this.surfTri || m.v !== this.surfV) return 0;
    const c = b64buf(m.c);
    const tri = this.surfTri;
    const col = this.surf.geometry.getAttribute("aCol");
    const seen = this.surf.geometry.getAttribute("aSeen");
    if (!col || !seen || col.count !== tri.length) return 0;
    const ca = col.array, sa = seen.array;
    let painted = 0;
    const done = new Uint8Array((c.length / 4) | 0);
    for (let k = 0; k < tri.length; k++) {
      const v = tri[k] * 4;
      if (v + 3 >= c.length) continue;
      const a = c[v + 3] > 127 ? 1 : 0;
      ca[3 * k] = c[v] / 255;
      ca[3 * k + 1] = c[v + 1] / 255;
      ca[3 * k + 2] = c[v + 2] / 255;
      sa[k] = a;
      if (a && !done[tri[k]]) { done[tri[k]] = 1; painted++; }
    }
    col.needsUpdate = true;
    seen.needsUpdate = true;
    this.surfPainted = painted;
    return painted;
  }

  /** Fit the frame to a box, once. Refused if the room did not grow by 10 %, or if a fit already
   *  happened in the last few seconds. "first" places it instantly, with no tween to watch. */
  fitBox(min, max, why) {
    const span = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
    const now = performance.now() / 1000;
    if (why !== "first" && this.fitSpan && span < this.fitSpan * 1.10) return false;
    if (why !== "first" && this.fitAt && now - this.fitAt < 3) return false;
    this.fitAt = now;
    this.fitSpan = span;
    this.fitMin = min.clone();
    this.fitMax = max.clone();
    this.centreWant.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    this.fitDist = this.distFor(min, max);
    this.fitT = 1.0;
    if (why === "first") { this.centre.copy(this.centreWant); this.distWant = this.dist = this.fitDist; this.fitT = 0; }
    return true;
  }

  /** The distance at which the box's bounding sphere fits BOTH axes of this panel. Using the
   *  sphere means no corner can leave the frame whatever angle the camera sits at, and the
   *  horizontal half-angle is the vertical one scaled by the panel's own aspect — a tall narrow
   *  panel therefore backs off further, which is what "fit everything" has to mean. */
  distFor(min, max) {
    const r = 0.5 * Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z);
    const vy = (this.camera.fov * Math.PI) / 360;
    const vx = Math.atan(Math.tan(vy) * Math.max(0.2, this.camera.aspect));
    const d = r / Math.sin(Math.max(0.08, Math.min(vy, vx)));
    return Math.max(140, Math.min(2400, d * 1.04));   // the sphere fit already guarantees the corners
  }

  /** the floor is the height where the up-facing triangles pile up; the grid goes there */
  _floor(flat) {
    const p = flat.getAttribute("position").array, nrm = flat.getAttribute("normal").array;
    const bins = new Map();
    let lo = Infinity;
    for (let t = 0; t < p.length / 9; t++) {
      if (nrm[9 * t + 1] < 0.75) continue;                 // not facing up
      const y = (p[9 * t + 1] + p[9 * t + 4] + p[9 * t + 7]) / 3;
      const k = Math.round(y / 5);
      bins.set(k, (bins.get(k) || 0) + 1);
      if (y < lo) lo = y;
    }
    let best = null, bestN = 0;
    for (const [k, n] of bins) if (n > bestN) { bestN = n; best = k; }
    if (best === null) return;
    this.grid.position.y = best * 5 + 1.0; // just above the real floor, never fighting it
    this.grid.material.opacity = 0.16;
  }

  _box(b) {
    if (this.box) this.scene.remove(this.box);
    const sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2];
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
      new THREE.LineBasicMaterial({ color: 0x1d6b80, transparent: true, opacity: 0.30 }));
    e.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    this.scene.add((this.box = e));
    this.grid.position.x = e.position.x;
    this.grid.position.z = e.position.z;
    this.roomSize = Math.max(sx, sz);
    this.fitBox(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]), this.fitSpan ? "grew" : "first");
  }

  /** the world-mesh point set + the scanned box (only arrives when it changed) */
  setMesh(b64, box, ver) {
    if (ver === this.meshV || this.surf) return;
    this.meshV = ver;
    const bin = atob(b64);
    const n = (bin.length / 6) | 0;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      const lo = bin.charCodeAt(2 * i), hi = bin.charCodeAt(2 * i + 1);
      const v = lo | (hi << 8);
      p[i] = v & 0x8000 ? v - 65536 : v;
    }
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    this.mesh = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x3f93ad, size: 2.0, sizeAttenuation: false, transparent: true, opacity: 0.4,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.mesh);
    this._applyMode();
    if (box) {
      if (this.box) this.scene.remove(this.box);
      const sx = box[3] - box[0], sy = box[4] - box[1], sz = box[5] - box[2];
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
        new THREE.LineBasicMaterial({ color: 0x1d6b80, transparent: true, opacity: 0.45 }));
      e.position.set((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
      this.scene.add((this.box = e));
      this.grid.position.set(e.position.x, box[1], e.position.z);
      if (!this.userZoom && !this.flies.size) this.distWant = Math.max(150, Math.min(1400, 0.86 * Math.max(sx, sz)));
    }
    this.has = true;
    return n;
  }

  /** While a training session runs, the two things it is about wear rings: the CS+ gold, the
   *  CS- violet. Matched by the label the feed names, so nothing here guesses which is which. */
  setCs(plus, minus) {
    const p = (plus || "").toLowerCase().trim(), m = (minus || "").toLowerCase().trim();
    if (p === this.csP && m === this.csM) return;
    this.csP = p;
    this.csM = m;
    for (const [, k] of this.marks) this._ring(k, (k.label || "").toLowerCase().trim());
  }

  _ring(mk, label) {
    const kind = label && label === this.csP ? 1 : label && label === this.csM ? -1 : 0;
    if (mk.ringKind === kind) return;
    mk.ringKind = kind;
    if (mk.ring) { this.scene.remove(mk.ring); mk.ring.geometry.dispose(); mk.ring = null; }
    if (!kind) { if (mk.el) mk.el.dataset.cs = ""; return; }
    const col = kind > 0 ? 0xffcf5a : 0x9a86d8;
    const r = new THREE.Mesh(new THREE.RingGeometry(16, 19, 40), new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.scene.add(r);
    mk.ring = r;
    if (mk.el) mk.el.dataset.cs = kind > 0 ? "+" : "-";
  }

  /** Gemini's room inventory (only when it changed): [id, label, cls, x, y, z, sizeCm, active] */
  setInventory(items, ver) {
    if (ver === this.invV) return;
    this.invV = ver;
    const seen = new Set();
    for (const it of items) {
      const [id, label, cls, x, y, z, size, active] = it;
      seen.add(id);
      let m = this.marks.get(id);
      if (!m) {
        const col = CLS_COLOR[cls] || 0x9fd6e8;
        const o = new THREE.Mesh(new THREE.OctahedronGeometry(Math.max(4, Math.min(22, size * 0.45))),
          new THREE.MeshBasicMaterial({ color: col, wireframe: true, transparent: true, opacity: 0.9 }));
        const el = document.createElement("div");
        el.className = "mk " + cls;
        el.textContent = label;
        this.labels.appendChild(el);
        this.scene.add(o);
        m = { o, el, born: performance.now() / 1000, cls };
        this.marks.set(id, m);
      }
      m.o.position.set(x, y, z);
      m.o.visible = !!active;
      m.el.style.display = active ? "" : "none";
      m.label = label;
      this._ring(m, String(label).toLowerCase().trim());
    }
    for (const [id, m] of this.marks) {
      if (seen.has(id)) continue;
      this.scene.remove(m.o);
      if (m.ring) this.scene.remove(m.ring);
      m.el.remove();
      this.marks.delete(id);
    }
    return this.marks.size;
  }

  /** every fly (and every ghost) from one packet: [i, name, x,y,z, qx,qy,qz,qw, ...body] */
  setFlies(rows, sel) {
    this.sel = sel;
    const seen = new Set();
    for (const r of rows) {
      const i = r[0];
      seen.add(i);
      let f = this.flies.get(i);
      if (!f) f = this._makeFly(i, r[1]);
      f.target.set(r[2], r[3], r[4]);
      f.qTarget.set(r[5], r[6], r[7], r[8]);
      f.state = r[9] | 0;
      f.speed = r[10];
      f.energy = r[13];
      f.name = r[1];
      f.seenAt = performance.now() / 1000;
      if (!f.started) { f.started = true; f.o.position.copy(f.target); f.o.quaternion.copy(f.qTarget); }
    }
    for (const [i, f] of this.flies) {
      if (seen.has(i)) continue;
      this.scene.remove(f.o);
      this.scene.remove(f.trail);
      f.el.remove();
      this.flies.delete(i);
    }
  }

  _makeFly(i, name) {
    const col = FLY_COLORS[(i < 0 ? 4 - i : i) % FLY_COLORS.length];
    const o = new THREE.Group();
    // the fly's own axis is +X forward (FlyBody AX); the cone is built along +Y, so lay it down
    const body = new THREE.Mesh(new THREE.ConeGeometry(4.6, 19, 6), new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
    body.rotation.z = -Math.PI / 2;
    body.position.x = 3;
    const halo = new THREE.Mesh(new THREE.SphereGeometry(13, 12, 9), new THREE.MeshBasicMaterial({
      color: col, transparent: true, opacity: 0.16, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    // the same figure as YOU, small and faint: which way this fly is LOOKING, at the 100 deg field
    // the inset shows (30 cm deep, so 2 x 30 tan 50 across). The cone body is an arrowhead and says
    // the same thing, but only for a reader who already knows a cone points forward.
    const wedge = frustum(30, 36, col, 0.16);
    wedge.quaternion.copy(FLY_TO_CAM);   // the wedge looks down -Z, the fly along its own +X
    wedge.material.depthTest = false;
    wedge.renderOrder = 49;
    o.add(body, halo, wedge);
    o.renderOrder = 50; // the fly draws last: no label and no wall ever covers it
    this.scene.add(o);
    const tp = new Float32Array(TRAIL * 3);
    const tc = new Float32Array(TRAIL * 3);
    const c3 = new THREE.Color(col);
    for (let i = 0; i < TRAIL; i++) {
      const k = Math.pow(i / (TRAIL - 1), 2.2); // the tail fades out behind the fly
      tc[3 * i] = c3.r * k; tc[3 * i + 1] = c3.g * k; tc[3 * i + 2] = c3.b * k;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(tp, 3));
    tg.setAttribute("color", new THREE.BufferAttribute(tc, 3));
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    }));
    trail.frustumCulled = false;
    trail.renderOrder = 49;
    this.scene.add(trail);
    const el = document.createElement("div");
    el.className = "mk fly";
    el.style.color = "#" + col.toString(16).padStart(6, "0");
    el.textContent = name;
    this.labels.appendChild(el);
    const f = {
      o, halo, trail, tp, el, col, wedge, n: 0, started: false,
      target: new THREE.Vector3(), qTarget: new THREE.Quaternion(), state: 0, speed: 0, energy: 0, name,
    };
    this.flies.set(i, f);
    return f;
  }

  setHead(h) {
    this.you.visible = true;
    this.you.position.set(h[0], h[1], h[2]);
    this.you.quaternion.set(h[3], h[4], h[5], h[6]);
    // before any room exists: ONE default frame, a 4 x 4 m floor around where the person first was
    if (!this.has && !this.fitSpan) {
      this.fitBox(new THREE.Vector3(h[0] - 200, h[1] - 170, h[2] - 200),
        new THREE.Vector3(h[0] + 200, h[1] + 60, h[2] + 200), "first");
      this.grid.position.set(h[0], h[1] - 170, h[2]);
    }
  }

  /** WHAT THE FLY'S EYES SEE, as pixels — the demo's only source of vision (gfx/demo.js).
   *
   *  The same `eyeCam` and the same 100 deg field as the FLY'S VIEW inset, rendered TWICE into one
   *  reused 96 x 48 target: once per eye, yawed +-EYE_YAW like the lens's two ommatidia cameras
   *  (FlyRetina RETINA_EYE_YAW_DEG = 35), so a wall on the fly's right lands in the right eye and
   *  not in the left. One forward camera would have reached 41 % of the 1,767 columns; the two
   *  reach the same 851 the glasses do — the rest of the lattice looks past the edge of a 100 deg
   *  frustum on the device too, and stays dark there for the same reason.
   *
   *  Two things are turned off for the shot and turned straight back on: the fly's own body (a fly
   *  never sees the inside of its own thorax — the lens gives every eye every body but its own) and
   *  the orbit view's depth cutaway, which exists so the near wall cannot hide the room from the
   *  ORBIT camera and would otherwise dissolve exactly the walls the fly is looking at.
   *
   *  Returns { px, w, h, eye, tan } — RGBA rows bottom-up, `eye` the square side of one viewport,
   *  `tan` the tangent of its half-field — or null while there is no fly to look out of. */
  eyePixels(sel) {
    const f = this.flies.get(sel) || this.flies.values().next().value;
    if (!f || !f.started) return null;
    const E = 48, W = 2 * E, H = E;
    if (!this.eyeRT) {
      this.eyeRT = new THREE.WebGLRenderTarget(W, H);
      this.eyePx = new Uint8Array(W * H * 4);
    }
    // What the fly does NOT see: its own body, its own trail (ours, not a thing in the room), the
    // reference grid, the mesh's wireframe (11,000 line segments, and most of the shot's cost), and
    // every view figure — a frustum is a thing we draw ABOUT the room, not a thing in it. The room,
    // the markers, the other flies and the person's head marker stay: they are really there.
    const off = [f.o, f.trail, this.grid, this.surfWire, this.youCone];
    for (const [, g] of this.flies) if (g.wedge) off.push(g.wedge);
    const was = off.map((o) => o && o.visible);
    for (const o of off) if (o) o.visible = false;
    // WHAT THE BRAIN IS INJECTED WITH DOES NOT FOLLOW A VIEW CONTROL. `mode` decides what the orbit
    // view draws; this shot is the demo's only source of vision, so it always gets the solid room —
    // otherwise picking the lighter room, or OFF, would quietly blind the fly. `_applyMode()` at the
    // end puts the mode back, which is also why nothing here has to remember these three.
    if (this.surf) this.surf.visible = true;
    if (this.surfPts) this.surfPts.visible = false;
    if (this.mesh) this.mesh.visible = !this.surf;
    const cut = this.surf ? this.surf.material.uniforms.uCut.value : 0;
    if (this.surf) this.surf.material.uniforms.uCut.value = 0;
    const cam = this.eyeCam;
    cam.aspect = 1;
    cam.updateProjectionMatrix();
    cam.position.copy(f.o.position);
    const r = this.renderer;
    r.setRenderTarget(this.eyeRT);
    r.setScissorTest(false);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.setScissorTest(true);
    for (let s = 0; s < 2; s++) {
      // + turns the camera toward the fly's left, which is the eye the lattice calls side 0
      EYE_TURN.setFromAxisAngle(UP, (s === 0 ? 1 : -1) * EYE_YAW);
      cam.quaternion.copy(f.o.quaternion).multiply(FLY_TO_CAM).multiply(EYE_TURN);
      r.setScissor(s * E, 0, E, E);
      r.setViewport(s * E, 0, E, E);
      r.render(this.scene, cam);
    }
    r.readRenderTargetPixels(this.eyeRT, 0, 0, W, H, this.eyePx);
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setClearColor(0x000000, 0);
    if (this.surf) this.surf.material.uniforms.uCut.value = cut;
    for (let i = 0; i < off.length; i++) if (off[i]) off[i].visible = was[i];
    this._applyMode();
    return { px: this.eyePx, w: W, h: H, eye: E, tan: Math.tan((cam.fov * Math.PI) / 360), yaw: EYE_YAW };
  }

  resize() {
    const w = this.canvas.clientWidth | 0, h = this.canvas.clientHeight | 0;
    this.cw = w; this.ch = h;   // cached for this frame: every read below reuses it
    if (!w || !h) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    if (this.canvas.width !== (w * dpr | 0) || this.canvas.height !== (h * dpr | 0)) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.fitMin && !this.userZoom) {          // a reshaped panel needs a new fit distance
        this.fitDist = this.distFor(this.fitMin, this.fitMax);
        this.fitT = Math.max(this.fitT, 0.5);
      }
    }
    return true;
  }

  frame(dt, t) {
    if (!this.resize()) return;
    const e = 1 - Math.exp(-dt * 7);
    // flies ease toward the last packet: 4 Hz in, 60 fps out
    const lerp = 1 - Math.exp(-dt * 9);
    for (const [, f] of this.flies) {
      f.o.position.lerp(f.target, lerp);
      f.o.quaternion.slerp(f.qTarget, lerp);
      f.halo.scale.setScalar(1 + 0.16 * Math.sin(t * 2.4 + f.col * 0.0001) + f.speed * 0.004);
      f.halo.material.opacity = 0.11 + 0.1 * Math.min(1, f.speed / 90) + (f.state === 2 ? 0.2 : 0);
      // the trail is built here, from the poses: one sample per frame, oldest dropped
      const p = f.tp;
      p.copyWithin(0, 3);
      p[3 * TRAIL - 3] = f.o.position.x; p[3 * TRAIL - 2] = f.o.position.y; p[3 * TRAIL - 1] = f.o.position.z;
      if (f.n < TRAIL) { // no line from the origin before the buffer has filled
        f.n++;
        for (let i = 0; i < TRAIL - f.n; i++) { p[3 * i] = p[3 * (TRAIL - f.n)]; p[3 * i + 1] = p[3 * (TRAIL - f.n) + 1]; p[3 * i + 2] = p[3 * (TRAIL - f.n) + 2]; }
      }
      f.trail.geometry.getAttribute("position").needsUpdate = true;
    }
    // The camera is STATIC. It is fitted to the room once and re-fitted only when the room grows
    // by more than 10 %, as a 1 s tween and never twice within a few seconds. It does NOT follow a
    // fly or the person: a frame that chases something that moves reads as the panel twitching.
    if (this.fitT > 0) {
      this.fitT = Math.max(0, this.fitT - dt);
      const k = 1 - Math.exp(-dt * 3.2);
      this.centre.lerp(this.centreWant, k);
      if (!this.userZoom) this.distWant += (this.fitDist - this.distWant) * k;
    }
    for (const [, m] of this.marks) {
      if (!m.ring) continue;
      m.ring.position.copy(m.o.position);
      m.ring.quaternion.copy(this.camera.quaternion); // always face the eye, like the lens's markers
      const ph = t * 2.6 + (m.ringKind > 0 ? 0 : 1.6);
      m.ring.scale.setScalar(1 + 0.09 * Math.sin(ph));
      m.ring.material.opacity = 0.55 + 0.3 * Math.sin(ph);
      m.ring.visible = m.o.visible;
    }
    this.yawWant += this.spin * dt;
    this.yaw += (this.yawWant - this.yaw) * e;
    this.pitch += (this.pitchWant - this.pitch) * e;
    this.dist += (this.distWant - this.dist) * e;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.centre.x + Math.sin(this.yaw) * cp * this.dist,
      this.centre.y + Math.sin(this.pitch) * this.dist,
      this.centre.z + Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(this.centre);

    if (this.surf) {
      // the cut plane rides with the camera: always the near 45 % of the room
      const d = this.camera.position.distanceTo(this.centre);
      const cut = Math.max(10, d - (this.roomSize || 400) * 0.45);
      this.surf.material.uniforms.uCut.value = cut;
      // WIRE mode borrows the same plane, so the two modes cut the room at the same depth
      if (this.wireLit && this.surfWire && this.surfWire.material === this.wireLit) {
        this.wireLit.uniforms.uCut.value = cut;
        this.wireLit.uniforms.uFar.value = (this.roomSize || 400) * 1.5;
      }
    }
    const r = this.renderer;
    r.clear();
    r.setScissorTest(false);
    r.setViewport(0, 0, this.cw || this.canvas.clientWidth, this.ch || this.canvas.clientHeight);
    r.render(this.scene, this.camera);

    // "what the fly sees": the same room, from the selected fly's head, at its real field
    const f = this.flies.get(this.sel) || this.flies.values().next().value;
    this.mini = null;
    if (f) {
      const w = this.cw || this.canvas.clientWidth, h = this.ch || this.canvas.clientHeight;
      const mw = Math.round(Math.min(150, w * 0.42)), mh = Math.round(mw * 0.62);
      this.eyeCam.aspect = mw / mh;
      this.eyeCam.updateProjectionMatrix();
      this.eyeCam.position.copy(f.o.position);
      // the fly looks along its own +X; a camera looks along -Z
      this.eyeCam.quaternion.copy(f.o.quaternion).multiply(FLY_TO_CAM);
      r.setScissorTest(true);
      r.setScissor(w - mw - 5, 5, mw, mh);
      r.setViewport(w - mw - 5, 5, mw, mh);
      // an OPAQUE plate under the inset (DESIGN.md's plate colour): the room behind it must not
      // bleed through, and neither must a label
      r.setClearColor(0x0b1b25, 1);
      r.clear(true, true, false);
      r.render(this.scene, this.eyeCam);
      r.setScissorTest(false);
      r.setClearColor(0x000000, 0);
      this.mini = { x: w - mw - 5, y: 5, w: mw, h: mh };
    }
    this._labels();
  }

  /** NAMES NEVER STACK.
   *  The old pass collided on the RAW projection and then let `place()` clamp to the frame edges
   *  and lift anything over the fly's-eye inset onto one shared line — so labels that had tested
   *  apart were re-stacked by the clamp itself, several onto the same y. It also compared x with a
   *  fixed 74 px against labels 90-110 px wide ("ZIGGY"), so two names 80 px apart passed
   *  the test and still overlapped. Now: seat every candidate at its FINAL position first, collide
   *  on that with the measured widths, and DROP the lowest-priority name instead of piling it. */
  _labels() {
    const w = this.cw || this.canvas.clientWidth, h = this.ch || this.canvas.clientHeight;
    const v = new THREE.Vector3();
    const mm = this.mini;
    // the final on-screen seat, or null when there is nowhere honest to put it
    const seat = (pos, dy, halfW) => {
      v.copy(pos).project(this.camera);
      if (v.z >= 1) return null;                   // behind the camera
      const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h + dy;
      // the camera never chases: whatever leaves the frame is pinned to its edge instead
      const px = Math.max(34, Math.min(w - 34, sx));
      let py = Math.max(12, Math.min(h - 12, sy));
      if (mm) {                                    // the inset is an obstacle, not a backdrop
        // its OWN half-width, not a flat 40: a long name reached over the edge of the inset while
        // its centre tested clear, and landed across the FLY'S VIEW caption
        const l = mm.x - (halfW || 40) - 4, top = h - mm.y - mm.h - 20;
        if (px > l && py > top) {
          py = top - 6;                            // lift it clear of the plate
          if (py < 12) return null;
        }
      }
      return { px, py };
    };
    // the real width, measured once per label and re-measured only when its text changes
    const wOf = (el) => {
      if (el.__wt !== el.textContent) { el.__wt = el.textContent; el.__w = el.offsetWidth || 80; }
      return el.__w;
    };
    // every write is diff-cached: this runs for every label on every frame (it was 315 style
    // writes/s straight onto .style, which is also why a dropped name strobed)
    const put = (el, px, py, alpha) => {
      const a = alpha.toFixed(2);
      if (el.__a !== a) { el.__a = a; el.style.opacity = a; }
      const t = `translate(-50%,-50%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
      if (el.__t !== t) { el.__t = t; el.style.transform = t; }
    };
    const hide = (el) => { if (el.__a !== "0.00") { el.__a = "0.00"; el.style.opacity = "0"; } };
    // only the things NEAR the fly get named: a wall of labels names nothing (the markers stay)
    const sel = this.flies.get(this.sel) || this.flies.values().next().value;
    const near = [];
    for (const [, m] of this.marks) {
      if (m.el.style.display === "none") continue;
      near.push([sel ? m.o.position.distanceTo(sel.o.position) : 0, m]);
    }
    near.sort((a, b) => a[0] - b[0]);
    // priority: flies, then YOU, then CS+/CS-, then things, nearest first
    const shown = [];
    for (const [, f] of this.flies) shown.push({ el: f.el, pos: f.o.position, dy: -18, pri: 0 });
    if (this.you.visible) {
      if (!this.youEl) {
        this.youEl = document.createElement("div");
        this.youEl.className = "mk you";
        this.youEl.textContent = "YOU";
        this.labels.appendChild(this.youEl);
      }
      shown.push({ el: this.youEl, pos: this.you.position, dy: -16, pri: 0.5 });
    }
    // how many names a panel this size can carry. Nine in a 370 x 230 panel is a pile whatever the
    // de-overlap does; the markers stay either way, so what is dropped is a word, not a thing.
    const cap = Math.max(3, Math.min(9, Math.round((w * h) / 22000)));
    near.forEach(([, m], i) => {
      const pri = m.ringKind ? 1 : 2 + i * 0.001;
      if (i < cap || m.ringKind) shown.push({ el: m.el, pos: m.o.position, dy: -13, pri: pri });
      else hide(m.el);
    });
    const fade = this.roomSize ? this.roomSize * 1.9 : 900;
    const seats = [];
    for (const s0 of shown) {
      const halfW = wOf(s0.el) / 2;
      const st = seat(s0.pos, s0.dy, halfW);
      if (!st) { hide(s0.el); continue; }
      seats.push({ el: s0.el, px: st.px, py: st.py, pri: s0.pri, halfW: halfW,
        far: this.camera.position.distanceTo(s0.pos) });
    }
    // the important label keeps its seat; the one that would land on it moves once or twice, and
    // then gives way rather than sitting on top of it
    seats.sort((a, b) => a.pri - b.pri);
    const taken = [];
    for (const s0 of seats) {
      const hits = () => taken.some((t) =>
        Math.abs(t.px - s0.px) < t.halfW + s0.halfW + 6 && Math.abs(t.py - s0.py) < 13);
      let tries = 0;
      while (tries < 3 && s0.py + 14 < h - 12 && hits()) { s0.py += 14; tries++; }
      if (hits()) { hide(s0.el); continue; }       // a drop, not a pile
      taken.push(s0);
      put(s0.el, s0.px, s0.py, Math.max(0.25, Math.min(1, 1.6 - s0.far / fade)));
    }
  }
}

// the fly's forward is +X (FlyBody AX); a THREE camera looks down -Z: yaw it by -90 deg
const UP = new THREE.Vector3(0, 1, 0);
const FLY_TO_CAM = new THREE.Quaternion().setFromAxisAngle(UP, -Math.PI / 2);
// the optical axis of one eye, off the head axis (FlyConfig RETINA_EYE_YAW_DEG) — ~30 deg overlap
const EYE_YAW = (35 * Math.PI) / 180;
const EYE_TURN = new THREE.Quaternion();
