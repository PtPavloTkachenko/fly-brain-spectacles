/**
 * DEMO — a lens made of JavaScript, so a visitor with no glasses sees the whole thing alive.
 *
 * `?demo=1` starts this instead of a relay. It is `web/lens_sim.py` ported to the page: the same
 * packets, in the same shapes, at the same rates — senses at 8 Hz, a `scene` packet at 4 Hz, one
 * triangle room sent once, one inventory, real ON/OFF contrast bytes for 1,767 ommatidia. They go
 * straight into `onLens`, which cannot tell them from a lens, because they are the same messages.
 *
 * THE EYES SEE THIS ROOM. The `eye` bytes used to be a drifting grating — a real byte layout
 * carrying nothing about the room on screen, so the one panel that says "what the brain sees" was
 * the one panel that was not looking. Every senses tick now renders the synthetic room from the
 * selected fly's head (`RoomView.eyePixels`, the same camera and 100 deg field as the FLY'S VIEW
 * inset, once per eye at the lens's own +-35 deg) and samples it through the 1,767 ommatidial
 * directions in `eye_lattice.bin`, with the lens's own photoreceptor maths: log luminance minus its
 * own running mean (Weber contrast), 128 = no change, and the per-eye deadzone that holds the
 * number of driven columns under the brain's cost guard. Byte for byte what `FlyRetina` sends, and
 * the ommatidial IMAGE rides on the `scene` packet as `eyeimg`, at WEB_SCENE_EYE_HZ like the lens.
 *
 * What is REAL in demo mode: the brain. The same 75 MB connectome, the same WebGPU kernel, the same
 * spikes and the same decoded action — it is genuinely deciding what to do about this room.
 * What is SYNTHETIC: the room, the fly's path through it, the numbers on its body, and the one line
 * in the GEMINI panel, which says so itself. The page says so in the header and never stops saying
 * it, because a demo that flatters itself is a lie with good lighting.
 *
 * Owns nothing else: one badge in the header, one `demo` flag on the state (the chips read it) and
 * the matching class on #app (the TRAINING tab's own refusal is written in style.css).
 */

const EYE_N = 1767;
// ?eye=0 — the demo without vision, which is the A/B behind the number in the header: a blind
// brain steps in about 175 ms on an M-series GPU, the same brain with ~270 ommatidial columns
// driven takes about 390. Vision is not free, and this is how to measure what it costs here.
const EYE_ON = new URLSearchParams(location.search).get("eye") !== "0";
const NAMES = ["NOVA", "PIP", "ZIGGY"];
// label, class, x, y, z (cm), size — a desk-shaped room, and honestly a made-up one
const THINGS = [
  ["coffee mug", "scent", 62, 76, 150, 11],
  ["banana", "food", 140, 70, -40, 14],
  ["monstera", "scent", -170, 40, -150, 60],
  ["laptop", "object", 0, 74, 40, 34],
  ["speaker", "object", 180, 30, 130, 26],
  ["bin", "bad", -200, 20, 60, 40],
];
// The GEMINI panel, honestly. There is no Gemini here — it runs on the glasses, off the lens's own
// remote service — and four canned lines rotating under "WHAT THE FLY THINKS" would be the page
// claiming a narrator it does not have. Worse, one of them ("the table is warm") invented a sense
// the fly is never given. So the panel says what it is instead.
const THOUGHTS = [
  "In the demo nobody narrates. On the glasses an AI reads this fly's brain and writes one line here about what it is up to.",
];
const W = 460, D = 420, H = 250;

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** the room as a triangle surface, exactly the shape FlySceneFeed.buildSurface sends */
function surface() {
  const verts = [], index = new Map(), tri = [];
  const v = (x, y, z) => {
    const k = Math.round(x) + "," + Math.round(y) + "," + Math.round(z);
    let i = index.get(k);
    if (i === undefined) { i = verts.length / 3; index.set(k, i); verts.push(Math.round(x), Math.round(y), Math.round(z)); }
    return i;
  };
  const grid = (f, nu, nv) => {
    for (let iu = 0; iu < nu; iu++) for (let iv = 0; iv < nv; iv++) {
      const a = v(...f(iu / nu, iv / nv)), b = v(...f((iu + 1) / nu, iv / nv));
      const c = v(...f((iu + 1) / nu, (iv + 1) / nv)), d = v(...f(iu / nu, (iv + 1) / nv));
      tri.push(a, b, c, a, c, d);
    }
  };
  grid((u, w) => [-W / 2 + u * W, 0, -D / 2 + w * D], 26, 24);          // floor
  grid((u, w) => [-W / 2 + u * W, w * H, -D / 2], 26, 12);              // four walls
  grid((u, w) => [-W / 2 + u * W, w * H, D / 2], 26, 12);
  grid((u, w) => [-W / 2, w * H, -D / 2 + u * D], 24, 12);
  grid((u, w) => [W / 2, w * H, -D / 2 + u * D], 24, 12);
  grid((u, w) => [-60 + u * 180, 72, 20 + w * 150], 10, 8);             // a table top
  const vb = new Int16Array(verts), ib = new Uint16Array(tri);
  return {
    s: b64(new Uint8Array(vb.buffer)) + "|" + b64(new Uint8Array(ib.buffer)),
    n: verts.length / 3, t: tri.length / 3, b: [-W / 2, 0, -D / 2, W / 2, H, D / 2],
  };
}

/* ---------------------------------------------------------------- the compound eye
 * The four constants the lens's photoreceptor runs on (FlyConfig): they are copied, not invented,
 * and the sampling below is FlyRetina.sample() line for line. */
const RETINA_TAU_S = 0.25;      // photoreceptor adaptation / LMC high-pass, ~ 1 / RETINA_HZ
const RETINA_FULL = 1.0;        // the log-luminance change that counts as full contrast
// cost guard: every DRIVEN column costs the brain (not the page) a step: the optic lobe fires for
// each one and the LIF kernel's work scales with spikes. ?cols=N lowers the cap (the lens's
// FlyConfig.RETINA_MAX_COLUMNS is 400); the lattice itself never changes, only how many columns
// may be driven per step.
const RETINA_MAX_COLUMNS = Math.max(0, Math.min(1767, +(new URLSearchParams(location.search).get("cols") || 400)));

/** Project every ommatidium through its own eye's camera, once. A column outside that 100 deg
 *  frustum keeps -1 and is never driven — on the glasses it is dark for the same reason. */
function makeRetina(cols, shot) {
  const n = cols.n;
  const idx = new Int32Array(n).fill(-1);
  const E = shot.eye;
  for (let c = 0; c < n; c++) {
    const s = cols.side[c];
    const az = cols.az[c] - shot.yaw * (s === 0 ? 1 : -1);
    const el = cols.el[c];
    const ce = Math.cos(el);
    // camera space: -Z forward, +X the fly's right (so its left is -X), +Y up
    const vx = -ce * Math.sin(az), vy = Math.sin(el), vz = -ce * Math.cos(az);
    if (-vz <= 0.05) continue;                       // behind this eye's camera
    const nx = vx / -vz / shot.tan, ny = vy / -vz / shot.tan;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) continue;
    let x = Math.floor((nx * 0.5 + 0.5) * E), y = Math.floor((ny * 0.5 + 0.5) * E);
    x = x < 0 ? 0 : x >= E ? E - 1 : x;
    y = y < 0 ? 0 : y >= E ? E - 1 : y;
    idx[c] = (y * shot.w + s * E + x) * 4;           // readback rows are bottom-up: +y is up
  }
  let seen = 0;
  for (let c = 0; c < n; c++) if (idx[c] >= 0) seen++;
  return {
    idx, seen, side: cols.side, mean: new Float32Array(n), primed: false, dead: [0, 0], moved: 0,
    bytes: new Uint8Array(n).fill(128), rgb: new Uint8Array(3 * n),
  };
}

/** One read of the texel feeds both the brain (signed contrast) and the panel (the image). */
function sampleRetina(r, shot, dt) {
  const px = shot.px, idx = r.idx, mean = r.mean, bytes = r.bytes, rgb = r.rgb, side = r.side;
  const alpha = 1 - Math.exp(-dt / RETINA_TAU_S);
  const inv = 1 / RETINA_FULL;
  const prime = !r.primed;
  const moved = [0, 0];
  for (let c = 0; c < idx.length; c++) {
    const o = idx[c];
    if (o < 0) continue;
    const cr = px[o], cg = px[o + 1], cb = px[o + 2];
    const j = 3 * c;
    rgb[j] = cr; rgb[j + 1] = cg; rgb[j + 2] = cb;
    // Rec.709 luminance, then log: the fly answers CHANGE, not absolute brightness
    const p = Math.log((cr * 0.2126 + cg * 0.7152 + cb * 0.0722) / 255 + 0.004);
    if (prime) { mean[c] = p; bytes[c] = 128; continue; }
    const m = mean[c] + (p - mean[c]) * alpha;
    mean[c] = m;
    let v = (p - m) * inv;
    if (v > 1) v = 1; else if (v < -1) v = -1;
    const s = side[c];
    if (v > -r.dead[s] && v < r.dead[s]) { bytes[c] = 128; continue; }
    const b = 128 + Math.round(127 * v);
    bytes[c] = b;
    if (b !== 128) moved[s]++;
  }
  const cap = RETINA_MAX_COLUMNS >> 1; // per eye, exactly as the lens splits it
  for (let s = 0; s < 2; s++) {
    if (moved[s] > cap) r.dead[s] = Math.min(0.8, r.dead[s] + 0.05);
    else if (moved[s] < cap * 0.6) r.dead[s] = Math.max(0, r.dead[s] - 0.02);
  }
  r.primed = true;
  r.moved = moved[0] + moved[1];
}

const quatY = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

export function startDemo({ state, onLens, open, brain, room = null, lattice = null }) { // one brain on this page = ONE fly (21.09; the scripted orbit had three)
  state.demo = true;                       // the header reads this: room "demo", lens "simulated"
  // the TRAINING tab asks the same question in CSS: there is no lens here to point with
  document.getElementById("app").classList.add("demo");
  open();
  brain();
  badge();
  gateTeaching();

  const surf = surface();
  const CHUNK = 40000;
  const chunks = [];
  for (let o = 0; o < surf.s.length; o += CHUNK) chunks.push(surf.s.slice(o, o + CHUNK));
  const t0 = performance.now() / 1000;
  let seq = 0, part = 0, sentInv = false, th = -1;
  // the eyes: built on the first tick that has BOTH a lattice (boot() loads it last) and a fly to
  // look out of. Until then there is simply no `eye` channel — the same silence a lens sends before
  // its first sample, rather than a stand-in nobody asked for.
  let retina = null, eyeAt = -1e9, eyeT = t0;

  // the brain worker needs a moment to exist; senses before it do nothing but cost nothing either
  setInterval(() => {
    const now = performance.now() / 1000;
    const t = now - t0;
    const ch = {
      odor: { L: 0.2 + 0.2 * Math.sin(t * 0.4), R: 0.2 + 0.2 * Math.cos(t * 0.35) },
      object: { L: Math.abs(Math.sin(t * 0.6)) * 0.5, R: Math.abs(Math.cos(t * 0.55)) * 0.5 },
      sweet: Math.max(0, Math.sin(t * 0.17)) * 0.6,
    };
    const cols = EYE_ON && lattice && lattice();
    const shot = cols && room && room().eyePixels(state.sel | 0);
    if (shot) {
      if (!retina) retina = makeRetina(cols, shot);
      sampleRetina(retina, shot, Math.max(0.01, Math.min(1, now - eyeT)));
      eyeT = now;
      ch.eye = b64(retina.bytes);
    }
    onLens({ t: "senses", fly: 0, ch });
  }, 125);

  // 21.09 Pavlo ("швидкість у мухи є ще до того як мозок підключився"): the body used to be a
  // scripted orbit -- position, speed, energy, even the act values were sines -- while the landing
  // page promised "every move decided by a real fly brain". Now the ONE fly (one brain on this page
  // = one body) integrates the brain's own decisions the way FlyBody does on the glasses: speed =
  // forward x CRUISE_CM_S (stop hovers, back reverses), yaw from steer x TURN_RATE, an escape climbs,
  // and until the first step arrives there is no body at all -- the ROOM stays empty and the BODY
  // card reads "--". Energy is the one thing the brain does not own (a body reserve, drained by
  // flying and refilled by feeding), and the card says so: "our simulation, not the brain".
  const CRUISE = 40, BACK = 15, TURN = 1.5 * 0.5, WALL = 4; // FlyConfig CRUISE_CM_S / BACK_CM_S / TURN_RATE x SACC_CRUISE_TURN / WALL_TURN_RATE
  const NET_ACT = ["forward", "steer", "stop", "feed", "groom", "neck", "orient", "ant", "prob", "abd", "legf_L", "legm_L", "legh_L", "legf_R", "legm_R", "legh_R"];
  const fly = { x: 0, y: 95, z: 40, yaw: 0, speed: 0, energy: 0.8, at: t0, seen: 0 };
  setInterval(() => {
    const now = performance.now() / 1000;
    const t = now - t0;
    const dt = Math.min(0.5, now - fly.at);
    fly.at = now;
    seq++;
    const f = [];
    const act = state.act && typeof state.act.forward === "number" ? state.act : null;
    if (act) {
      fly.seen++;
      const esc = Math.max(act.escape_L || 0, act.escape_R || 0);
      const want = act.stop > 0.5 ? 0 : act.back > 0.5 ? -BACK : (act.forward || 0) * CRUISE + esc * CRUISE * 0.5;
      fly.speed += (want - fly.speed) * Math.min(1, dt * 4);
      // steer: the smooth share between flicks, plus the flick itself when the brain says saccade
      fly.yaw -= (act.steer || 0) * (TURN + (act.sacc > 0.5 ? 1.2 : 0)) * dt;
      // walls of the made-up room: a fly at a wall turns along it (FlyConfig.WALL_TURN_RATE), then keeps thinking
      const nearX = Math.abs(fly.x) > W / 2 - 30, nearZ = Math.abs(fly.z) > D / 2 - 30;
      if (nearX || nearZ) fly.yaw += WALL * dt * (((fly.x > 0) !== (fly.z > 0)) ? 1 : -1);
      fly.x -= Math.sin(fly.yaw) * fly.speed * dt;
      fly.z -= Math.cos(fly.yaw) * fly.speed * dt;
      fly.x = Math.max(-W / 2 + 15, Math.min(W / 2 - 15, fly.x));
      fly.z = Math.max(-D / 2 + 15, Math.min(D / 2 - 15, fly.z));
      const wantY = 95 + 60 * esc - 30 * (act.stop || 0);
      fly.y += (Math.max(30, Math.min(H - 20, wantY)) - fly.y) * Math.min(1, dt * 1.5);
      fly.energy = Math.max(0.05, Math.min(1, fly.energy - dt * 0.004 * (0.5 + Math.abs(fly.speed) / CRUISE) + dt * 0.02 * (act.feed || 0)));
      const stateCode = esc > 0.5 ? 2 : 0; // FlyBody.NET_STATE: air, landed, escape (no surfaces to land on here)
      // [state, speed, wingDrive, wingBias, energy, hasNormal, nx, ny, nz, ...16 act, song*side] — FlyBody.packNet
      const body = [stateCode, fly.speed, act.thrust != null ? act.thrust : 0.8, 0.02 * (act.steer || 0), fly.energy, 0, 0, 0, 0]
        .concat(NET_ACT.map((k) => act[k] || 0)).concat([0]);
      f.push([0, NAMES[0], Math.round(fly.x), Math.round(fly.y), Math.round(fly.z)]
        .concat(quatY(fly.yaw).map((v) => +v.toFixed(3)))
        .concat(body.map((v) => +v.toFixed(2))));
    }
    const m = {
      t: "scene", n: seq, hz: 4, s: 0, f,
      h: [Math.round(60 * Math.sin(t * 0.09)), 165, Math.round(150 + 20 * Math.cos(t * 0.11))]
        .concat(quatY(Math.PI + 0.55 * Math.sin(t * 0.12)).map((v) => +v.toFixed(3))),
    };
    if (!sentInv) {
      sentInv = true;
      m.inv = THINGS.map((x) => [x[0] + "_1", x[0], x[1], x[2], x[3], x[4], x[5], 1]);
      m.iv = 1;
    }
    if (part < chunks.length) {
      m.surf = { v: 1, part, parts: chunks.length, n: surf.n, t: surf.t, b: surf.b, s: chunks[part] };
      part++;
    }
    // the ommatidial IMAGE, at the lens's own WEB_SCENE_EYE_HZ (2): what each column sampled,
    // EYE_N x RGB, the picture the eye panel draws under the ON/OFF contrast
    if (retina && t - eyeAt >= 0.5) { eyeAt = t; m.eyeimg = b64(retina.rgb); }
    const k = Math.floor(t / 17);
    if (k !== th) { th = k; m.th = THOUGHTS[k % THOUGHTS.length]; }
    onLens(m);
  }, 250);
}

/** THE ONE SENTENCE about learning in the demo. Written in two places from here — the TRAINING
 *  tab's tooltip and the empty state inside it — so they cannot drift apart. */
const NO_TEACH = "LEARNING NEEDS THE GLASSES · NOTHING HERE TO POINT AT, AND THE MEMORY STAYS FROZEN";

/** The tab stays where it is and keeps working (the empty state inside it is the explanation), but
 *  it stops LOOKING like an offer, and says why on hover and to a screen reader. */
function gateTeaching() {
  const tb = document.querySelector('#tabs .tb[data-t="training"]');
  if (tb) {
    tb.title = NO_TEACH;
    tb.setAttribute("aria-disabled", "true");
  }
  const why = document.getElementById("trainDemoWhy");
  if (why) why.textContent = NO_TEACH;
}

/** one badge that never goes away, because the room on screen is not a room */
function badge() {
  const top = document.getElementById("top");
  if (!top) return;
  const d = document.createElement("div");
  d.id = "demoChip";
  // the tail is its own element so the narrow header can drop it and keep the badge (style.css):
  // "DEMO SYNTHETIC ROOM" still says the room is not a room, and the title says the rest
  d.innerHTML = "DEMO <i>MADE-UP ROOM<u> · REAL BRAIN</u></i>";
  d.title = "The room, the flies and their bodies are made up by this page. The brain deciding what "
    + "to do about them is the real one: 166,700 neurons, running on your graphics card.";
  const tabs = document.getElementById("tabs");
  top.insertBefore(d, tabs ? tabs.nextSibling : top.firstChild);
}
