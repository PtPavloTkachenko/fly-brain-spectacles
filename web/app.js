/**
 * CyberFly web twin (ADR 61) — the lens's dashboard, at laptop resolution.
 *
 * The page is already the brain (ADR 55): `brain_worker.js` runs the same C++ core in WASM with the
 * same kernel on WebGPU, and every number on this screen comes out of that worker or off the relay.
 * The lens adds the one thing the worker cannot know — the room — as a `scene` packet (ADR 61).
 * The relay protocol is untouched: an older lens that sends no `scene` simply leaves the room panel
 * empty, and the brain link is unaffected.
 */
import { BrainView } from "./gfx/brain.js";
import { RoomView } from "./gfx/room.js";
import { EyesView } from "./gfx/eyes.js";
import { Raster } from "./gfx/raster.js";
import { TrainView, drawHistory } from "./gfx/train.js";
import { Chains } from "./gfx/chain.js";
import { MODES } from "./gfx/teach.js";
import { Versions } from "./gfx/versions.js";
import { initRejoin } from "./gfx/rejoin.js";
import { buildNav, smallScreenGate } from "./gfx/nav.js";
import { SB, sbBase, sbRealtime, asset } from "./config.js";
import { CLASS } from "./gfx/brain.js";
import { approach, stagger, setText, setStyle, kick } from "./gfx/motion.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// ?demo=1 ALWAYS means the standalone demo (21.09). It used to be dropped by the small-screen gate,
// which sent WATCH IT THINK to the PIN screen in any window under 860 px.
const DEMO = params.get("demo") === "1";
const BRAIN_URL = params.get("brain") || "brain_c0.flyb.z";
/* THE BRAIN FILE IS VERSIONED IN ITS URL (21.09). The worker keeps the 75 MB file in the Cache API
 * under the URL it fetched, and a deployed .flyb.z is HTTP-cached for a year — so a page that once
 * had the brain kept it for good, and a re-export (today: memory decay 1800 -> 10800 s inside the
 * file) never reached a browser that had the old one. The version is `brain.version` next to the
 * page (one line, the file's hash; a comment says how to regenerate it); without that file it is
 * the byte length a HEAD request reports. Either way it rides on the URL as ?v=, so a changed file
 * is a new URL — fetched once, cached again — and an unchanged one still costs nothing. The worker
 * (brain_worker.js) is untouched: it fetches and caches whatever URL it is handed. */
async function brainVersion() {
  try {
    const r = await fetch("brain.version", { cache: "no-cache" });
    if (r.ok) {
      const line = (await r.text()).split("\n").map((s) => s.trim()).find((s) => s && s[0] !== "#");
      if (line) return line.slice(0, 40);
    }
  } catch (e) { /* no version file: the HEAD below decides */ }
  try {
    const h = await fetch(BRAIN_URL, { method: "HEAD", cache: "no-cache" });
    const len = h.ok && h.headers.get("content-length");
    if (len) return "len" + len;
  } catch (e) { /* unreachable: the worker says so, in the header */ }
  return "";
}
async function brainUrl() {
  const v = await brainVersion();
  const url = v ? BRAIN_URL + (BRAIN_URL.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(v) : BRAIN_URL;
  // one plain line when the file changed under a page that had the old one — in the footer, which
  // the worker's own status overwrites within a second, and in the console, where it stays
  const had = localStorage.getItem("brainVer") || "";
  if (v && had && had !== v) {
    const line = "the brain file changed (" + had + " \u2192 " + v + "): downloading the new one, 75 MB";
    log(line);
    console.info("CyberFly: " + line);
  }
  if (v) localStorage.setItem("brainVer", v);
  await dropOldBrains(url);
  return url;
}
/** the Cache API keeps every URL it was ever given: an old brain (75 MB) leaves before the new one
 *  arrives, or a phone's quota refuses the second copy and the new one is downloaded every visit */
async function dropOldBrains(keep) {
  try {
    const cache = await caches.open("flybrain-v1");
    const now = new URL(keep, location.href);
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (u.pathname === now.pathname && u.href !== now.href) await cache.delete(req);
    }
  } catch (e) { /* no Cache API (file://): nothing was kept */ }
}
// ONE Supabase config for the page (config.js; release.sh writes it): the room, the memory and the
// versions table all come out of the same ref + anon key. A URL parameter always wins over it.
const SB_REF = params.get("sb") || SB.ref;
const SB_HOST = params.get("sbhost") || SB.host || "supabase.co"; // snapcloud.dev for a Snap Cloud project
const SB_ANON = params.get("sbkey") || params.get("key2") || SB.anon;
let RELAY_KEY = params.get("key") || (SB_REF ? SB_ANON : "") || localStorage.getItem("relayKey") || "";
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const FLY_CSS = ["#33ff73", "#ff4dd9", "#33d9ff", "#ffb833", "#9e6bff"];
const EDGE_CAP = +(params.get("edges") || 0) || 0; // ?edges=N caps the synapses, for measuring
const NO_LENS_S = 10; // joined, said hello, nobody answered: that is a named state, not a spinner

// the board's NEURAL rows, in the board's order: six anatomical regions (measured mean rate of
// every neuron in them) then six command readouts. The bit index is the group bit in neurons.bin,
// so hovering a row isolates exactly those cells in the point cloud.
const ROWS = [
  { k: "optic", src: "regions", label: "OPTIC LOBE" },
  { k: "central", src: "regions", label: "CENTRAL BRAIN" },
  { k: "mushroom", src: "regions", label: "MEMORY  MUSHROOM BODY" },
  { k: "sensory", src: "regions", label: "SENSORY" },
  { k: "descending", src: "regions", label: "BRAIN TO BODY  DESCENDING" },
  { k: "vnc", src: "regions", label: "BODY  VENTRAL NERVE CORD" },
  { k: "DNa02_L", src: "hz", label: "STEER L  DNa02" },
  { k: "DNa02_R", src: "hz", label: "STEER R  DNa02" },
  { k: "escape", src: "max", a: "esc_L", b: "esc_R", label: "ESCAPE  DNp01/02/04" },
  { k: "stop", src: "hz", label: "STOP  DNpe007" },
  { k: "feed", src: "hz", label: "FEED  MN9" },
  // NOT "stress": the key is the model's, the word was ours. PPL101 idles near 71 Hz with nothing
  // happening at all, and a raw rate under an emotion is a lie the whole page then tells (21.09).
  { k: "stress", src: "hz", label: "STRESS  PPL101" },
];
const STATE = ["AIR", "LANDED", "ESCAPE"];

const S = {
  joined: false, room: "", lensSeen: -1e9, toLens: 0, fromLens: 0,
  brain: null, regions: {}, hz: {}, act: {}, stepMs: 0, engine: "", gpu: "",
  sel: 0, flies: [], head: null, thought: "", sceneN: 0, sceneB: 0, sceneAt: -1e9,
  eye: null, eyeImg: null, tab: "brain", lensGap: 0, lensSlow: false, stepBase: 0, stepSamples: [], everTrained: false, invItems: null, summary: null, evKey: "", trainUnavailable: "", blobThen: null, surfParts: 0, surfSeen: 0, surfAt: -1e9, learning: false, focus: 0, invCount: 0, meshPts: 0, surfTris: 0, chain: null, chainKey: "",
  // every way this can fail, named (ADR 61 follow-up). `relay` is the socket's own state,
  // `lensEver` remembers that a lens WAS there, so "never showed up" and "went quiet" are
  // different refusals with different advice.
  relay: "idle", relayUrl: "", pin: "", joinedAt: 0, lensEver: false,
  retryAt: 0, backoff: 2, brainErr: "", faultKind: "", faultShown: "",
  train: null, mem: null, trainAt: -1e9,
};
let worker = null, ws = null, ref = 0, topic = "", hb = null;
let brainView = null, roomView = null, eyesView = null, raster = null, trainView = null, chains = null;

const log = (s) => setText($("logline"), s);
// a page that fails silently is worse than one that fails loudly: every throw lands in the footer
window.addEventListener("error", (e) => log("JS " + (e.message || e.error)));
window.addEventListener("unhandledrejection", (e) => log("JS " + (e.reason && e.reason.message || e.reason)));
if (params.get("debug") === "1") {
  const ce = console.error.bind(console);
  console.error = (...a) => { log("ERR " + a.map(String).join(" ").slice(0, 400)); ce(...a); };
}

/* ---- the site around the instrument: one shared nav, and the phone's own answer (gfx/nav.js) ----
 * The compact nav carries HOME and CREDITS only: DASHBOARD and TRAINING are the tab strip two
 * centimetres to the right, and a second copy of a control is a worse page, not a more navigable
 * one. SMALL is decided before boot(), so a phone never downloads 11 MB it cannot draw. */
const NAV = buildNav($("top"), { compact: true, active: "dash" });
$("top").insertBefore(NAV, $("top").firstChild);
const SMALL = smallScreenGate({ force: params.get("force") === "1" || DEMO });
// the demo path has no PIN, no relay and no gate: say so on the very first paint, before the demo
// module has even loaded, so the PIN card never flashes over a page that was asked for the demo
if (DEMO) {
  S.demo = true;
  $("gate").classList.add("gone");
  document.getElementById("app").classList.add("demo");
  // a narrow window still runs it; one soft line says what to expect. A phone (style.css folds the
  // page to one column under 700 px) gets plain words, and they follow the phone when it turns.
  const phone = window.matchMedia("(max-width: 700px)"), narrow = window.matchMedia("(max-width: 860px)");
  const sideways = window.matchMedia("(max-width: 1180px) and (max-height: 500px)"); // a phone on its side: it was told, and did
  const sizeWords = () => setText($("sizeNote"), phone.matches
    ? "ON A PHONE THE BRAIN RUNS SLOWER \u00b7 TURN IT SIDEWAYS FOR MORE ROOM"
    : narrow.matches && !sideways.matches ? "MADE FOR A WIDE WINDOW \u00b7 IT RUNS HERE, BUT THE PANELS ARE CRAMPED \u00b7 TRY A LAPTOP SCREEN" : "");
  sizeWords();
  for (const q of [phone, narrow, sideways]) q.addEventListener("change", sizeWords);
}
// ?tab=training opens the hidden experiment tool: the tab strip and the training tab appear only then
if (params.get("tab") === "training") document.getElementById("app").classList.add("lab");

/* ------------------------------------------------------------------ the gate */
// the gate's relay is, in order: the URL, the deployed Supabase project (config.js, or ?sb=), what
// this browser used last, and finally the LAN relay next to a page served over http. A deployed
// page has its relay baked in, so the gate shows only the PIN: the relay field appears only when
// nothing is baked (a local build) or when the URL names another relay. The ROOM chip (R) can
// still point one session at another relay, e.g. relay.py at an event.
const BAKED_RELAY = sbRealtime(SB_REF, SB_HOST);
const RELAY_FIXED = !!BAKED_RELAY && !params.get("relay");
$("relay").value = params.get("relay") || BAKED_RELAY || localStorage.getItem("relay") ||
  (location.protocol === "https:" ? "" : "ws://" + location.hostname + ":8795");
// with a project baked in, the ADVANCED fold (the relay) is not offered at all: the relay is a
// deployment detail; a ?relay= in the address bar still brings it back
if (RELAY_FIXED) $("adv").style.display = "none";
$("pin").value = params.get("pin") || "";
/* The relay is a deployment detail, not a question: on a built page `release.sh` has already put it
 * in config.js, so the gate asks for the PIN and nothing else. The fold opens ITSELF in the only
 * two cases where the answer is not the baked one — a ?relay= in the address bar, or a relay this
 * browser used before that is not what config.js says. The precedence above is untouched. */
$("adv").open = !!params.get("relay");

(async () => {
  if (!navigator.gpu) {
    setText($("gpuinfo"), "no WebGPU in this browser — the brain will run on the CPU, about 8× slower. Chrome / Edge 113+ and Safari 26+ have WebGPU.");
    return;
  }
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const info = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null));
    setText($("gpuinfo"), a ? "graphics card ready · WebGPU · " + ([info && info.vendor, info && info.architecture, info && info.description].filter(Boolean).join(" ") || "adapter found") : "no WebGPU adapter — the brain will run on the CPU, about 8× slower");
  } catch (e) { setText($("gpuinfo"), "WebGPU: " + e.message); }
})();

$("go").onclick = () => {
  const pin = $("pin").value.trim();
  const url = $("relay").value.trim();
  const note = $("note");
  note.className = "note warn";
  if (!/^\d{4}$/.test(pin)) { setText(note, "the PIN is the four digits on the glasses' board"); kick(note); return; }
  if (!url) { setText(note, "no link server is set — open ADVANCED and enter the relay address"); kick(note); return; }
  note.className = "note";
  localStorage.setItem("relay", url);
  $("go").disabled = true;
  setText(note, "linking to the glasses with PIN " + pin + " ...");
  start(pin, url);
};
$("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });

function openDashboard() {
  $("gate").classList.add("gone");
  stagger([$("top"), $("stage"), $("pNeural"), $("pEyes"), $("pBody"), $("pRoom"), $("pLearn"), $("pGem")], 55, 60);
}

/* ------------------------------------------------------------------ relay */
function phx(event, payload, t = topic) {
  if (!ws || ws.readyState !== 1) return;
  ref++;
  ws.send(JSON.stringify({ topic: t, event, payload, ref: String(ref) }));
}
function toRoom(ev, payload) {
  if (!S.joined) return;
  phx("broadcast", { type: "broadcast", event: ev, payload });
  if (ev === "brain") S.toLens++;
}

function connectRelay(url, pin) {
  topic = "realtime:fly-" + pin;
  S.room = "fly-" + pin;
  S.relayUrl = url;
  S.pin = pin;
  S.relay = "connecting";
  S.retryAt = 0;
  const full = RELAY_KEY ? url + (url.includes("?") ? "&" : "?") + "apikey=" + RELAY_KEY + "&vsn=1.0.0" : url;
  let sock;
  try {
    sock = ws = new WebSocket(full);
  } catch (e) {
    return relayDown("BAD RELAY URL", e.message || String(e));
  }
  sock.onopen = () => {
    if (ws !== sock) return;
    S.relay = "open";
    S.backoff = 2;
    log("link open, joining PIN " + pin);
    const p = { config: { broadcast: { self: false, ack: false } } };
    if (RELAY_KEY) p.access_token = RELAY_KEY;
    phx("phx_join", p);
    clearInterval(hb);
    hb = setInterval(() => phx("heartbeat", {}, "phoenix"), 25000);
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    let m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.event === "phx_reply" && m.topic === topic) {
      // 21.09: say hello on EVERY successful join, not only the first one.
      //
      // The lens sends a page NOTHING until it has heard a hello — `WebBrainLink.send` forwards to
      // the page only while `webActive`, and only a hello flips that. Proven from outside: an
      // independent client that joins this room in silence receives nothing for 45 s, and the same
      // client receives select, welcome, learning, 43 senses and 22 scene packets within half a
      // second of saying hello.
      //
      // The guard used to be `!S.joined`, so when the page opened a second socket — a reconnect, or
      // the PIN screen and `?pin=&auto=1` both connecting — the first socket set the flag and the
      // SURVIVING socket skipped its hello. The page then sat in the room, believing it had joined,
      // with a warm brain and a lens that had no idea it was there. That is what made TRAINING read
      // "no lens in this room" while the header showed the lens connected.
      const ok = !!(m.payload && m.payload.status === "ok");
      const first = !S.joined;
      S.joined = ok;
      S.relay = ok ? "joined" : "refused";
      if (first) S.joinedAt = performance.now();
      log(ok ? (first ? "linked, saying hello to the glasses" : "re-linked, saying hello again") : "the link server refused the PIN");
      if (ok) toRoom("hello", { name: "web " + (navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform) });
      return;
    }
    if (m.event !== "broadcast" || !m.payload || m.payload.event !== "lens") return;
    // 21.09: a lens broadcast on OUR topic is proof we are in the room, so trust it over the join
    // reply. `S.joined` was set only from that one reply, and a reconnect clears the flag; if the
    // fresh reply is ever missed the page sits there receiving the lens perfectly while believing
    // it never joined -- and `toRoom` refuses to send, silently. That is what disabled the TRAINING
    // start button with "join a room first" while the header showed the lens connected.
    if (!S.joined) {
      S.joined = true;
      S.relay = "joined";
      S.joinedAt = performance.now();
      log("linked (the glasses spoke before the join reply did)");
      toRoom("hello", { name: "web " + (navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform) });
    }
    onLens(m.payload.payload);
  };
  // a socket that never opened fires error THEN close, so both funnel into the same named state
  sock.onclose = () => { if (ws === sock) relayDown(S.relay === "connecting" ? "RELAY UNREACHABLE" : "RELAY CLOSED", ""); };
  sock.onerror = () => { if (ws === sock) relayDown("RELAY UNREACHABLE", ""); };
}

/** the relay is gone: say so, say what happens next, and retry with a growing backoff */
function relayDown(kind, detail) {
  if (S.relay === "down" && S.faultKind === kind) return;
  clearInterval(hb);
  ws = null;
  S.joined = false;
  S.relay = "down";
  S.faultKind = kind;
  S.room = "down";
  S.retryAt = performance.now() + S.backoff * 1000;
  log("link server " + kind.toLowerCase().replace(/^relay /, "").replace(/^bad relay url$/, "address is bad") + " " + S.relayUrl + (detail ? " (" + detail + ")" : "") + ", retrying in " + S.backoff + " s");
  S.backoff = Math.min(20, S.backoff * 2);
  if (!$("gate").classList.contains("gone")) $("go").disabled = false; // still on the gate: let them fix the URL
}

/* ---- the ROOM chip is a control: change the PIN, or leave (gfx/rejoin.js owns the form) ----
 * Both paths drop the socket and nothing else: the worker, the loaded brain and every view survive,
 * so switching rooms costs no reload and no second 75 MB download. */
function dropSocket() {
  clearInterval(hb);
  if (ws) { const s = ws; ws = null; s.onclose = s.onerror = s.onmessage = null; try { s.close(); } catch (e) {} }
  S.joined = false;
  S.relay = "idle";
  S.faultKind = "";
  S.retryAt = 0;
  S.backoff = 2;
  // the lens in the OLD room is not the lens in the new one: forget that one was ever seen
  S.lensEver = false;
  S.lensSeen = -1e9;
  S.lensGap = 0;
  S.sceneAt = -1e9;
  S.surfAt = -1e9;
}
initRejoin({
  state: S,
  chip: $("chipRoom"),
  defaults: () => ({ pin: $("pin").value.trim(), relay: $("relay").value.trim(), key: RELAY_KEY }),
  onRejoin: (pin, url, key) => {
    dropSocket();
    RELAY_KEY = key;
    localStorage.setItem("relay", url);
    if (key) localStorage.setItem("relayKey", key); else localStorage.removeItem("relayKey");
    $("pin").value = pin;
    $("relay").value = url;
    log("re-linking with PIN " + pin);
    connectRelay(url, pin);
  },
  onLeave: () => {
    dropSocket();
    S.room = "—";
    $("gate").classList.remove("gone"); // the gate comes back over a brain that never stopped
    $("go").disabled = false;
    setText($("note"), "unlinked — the brain is still loaded, type another PIN");
    $("note").className = "note";
    log("unlinked, brain still running");
    $("pin").focus();
  },
});

function onLens(msg) {
  S.fromLens++;
  const now = performance.now();
  if (S.lensEver) { // how often this lens actually talks, so "silent" means silent for IT
    const d = (now - S.lensSeen) / 1000;
    if (d > 0.01 && d < 30) S.lensGap = S.lensGap ? S.lensGap * 0.8 + d * 0.2 : d;
  }
  S.lensSeen = now;
  S.lensEver = true;
  if (!worker) return;
  const t = msg.t;
  if (t === "senses") {
    worker.postMessage({ cmd: "post", json: JSON.stringify({ senses: msg.ch || {} }) });
    if (msg.ch && msg.ch.eye) S.eye = b64bytes(msg.ch.eye); // the exact bytes the brain is injected with
  } else if (t === "select") { S.sel = msg.fly | 0; worker.postMessage({ cmd: "post", json: JSON.stringify({ cloud: true }) }); }
  else if (t === "pulse") worker.postMessage({ cmd: "post", json: JSON.stringify({ pulse: msg.kind }) });
  else if (t === "reset") worker.postMessage({ cmd: "post", json: JSON.stringify({ reset: true }) });
  else if (t === "learning") { S.learning = !!msg.on; worker.postMessage({ cmd: "post", json: JSON.stringify({ learning: !!msg.on }) }); }
  // ADR 63: the fly's memory. The lens keeps the canonical copy and hands it to whoever is the brain,
  // so the page only passes these two ways: a `set` in, and whatever the core answers back out.
  else if (t === "memory") {
    const p = { memory: msg.op };
    if (msg.data !== undefined) p.data = msg.data;
    if (msg.elapsed_s !== undefined) p.elapsed_s = msg.elapsed_s;
    if (msg.compact !== undefined) p.compact = msg.compact;
    worker.postMessage({ cmd: "post", json: JSON.stringify(p) });
  }
  else if (t === "welcome") { S.learning = !!msg.learning; worker.postMessage({ cmd: "post", json: JSON.stringify({ learning: !!msg.learning, cloud: true }) }); }
  else if (t === "scene") onScene(msg);
  // 21.09 perf pass: the lens's 2 s telemetry row used to be dropped here. It is the only place the
  // GLASSES' frame numbers can be read without a server: keep the last one for the footer, and echo
  // the perf part to the console (`LENS_PERF …`) so a dev tab is a device perf log.
  else if (t === "dbg") onDbg(msg);

}

function onDbg(m) {
  const c = String(m.cloud || "");
  const f = /\| fps (\d+|\?) worst (\d+)ms/.exec(c);
  let scripts = 0;
  const perf = c.split("| perf")[1] || "";
  for (const mm of perf.matchAll(/(\w+)=([\d.]+)\/([\d.]+)/g)) scripts += +mm[3];
  S.dbg = { fps: f && f[1] !== "?" ? +f[1] : null, worst: f ? +f[2] : null, scripts, at: performance.now(), depth: /depth[=>]\s*[1-9]/.test(c) };
  console.log("LENS_PERF " + c.slice(0, 600));
}

/* ------------------------------------------------------------------ the room feed (ADR 61) */
function onScene(m) {
  S.sceneN++;
  S.sceneAt = performance.now();
  S.sceneB = JSON.stringify(m).length;
  if (typeof m.s === "number") S.sel = m.s;
  if (m.h) { S.head = m.h; roomView.setHead(m.h); }
  if (m.f) { S.flies = m.f; roomView.setFlies(m.f, S.sel); }
  if (m.inv) { S.invCount = roomView.setInventory(m.inv, m.iv); S.invItems = m.inv.map((x) => x[1]); fillThings(); }
  if (m.mesh) S.meshPts = roomView.setMesh(m.mesh.p, m.mesh.b, m.mesh.v) || S.meshPts;
  if (m.surf) { const t = roomView.setSurface(m.surf); if (t) S.surfTris = t; S.surfParts = m.surf.parts; S.surfSeen = (m.surf.part | 0) + 1; S.surfAt = performance.now(); }
  // the same surface, as the scan PAINTED it: RGBA per vertex, arriving after the geometry and
  // again while the room keeps being painted. It is applied in place, so it must come after `surf`.
  if (m.surfc) S.surfPainted = roomView.setSurfaceColors(m.surfc) || S.surfPainted;
  if (m.eyeimg) S.eyeImg = b64bytes(m.eyeimg); // what the ommatidia actually sampled
  if (m.th) S.thought = String(m.th); // Gemini's inner voice, only when it changes
  // training + memory (the trainer and the memory agent add these to the same packet, on change)
  if (m.train) { S.train = m.train; S.trainAt = performance.now(); trainView.set(m.train); roomView.setCs(m.train.csPlus, m.train.csMinus); }
  if (m.mem) { S.mem = m.mem; if (m.mem.key) VERS.key = m.mem.key; }
  if (m.train_summary) { S.summary = m.train_summary; drawVerdict(); }
  if (m.train_unavailable !== undefined) S.trainUnavailable = m.train_unavailable || "";
}

const b64bytes = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/* ------------------------------------------------------------------ the brain worker */
function startBrain(gpu) {
  worker = new Worker("brain_worker.js");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.t === "status") { log(m.text); setText($("note"), m.text); S.engine = m.text.replace(/^thinking on /, ""); }
    else if (m.t === "error") { setBrainErr(m.text); }
    else if (m.t === "ready") {
      S.gpu = m.msg.gpu || "";
      log("brain ready" + (S.gpu ? " (" + S.gpu + ")" : ""));
      toRoom("brain", m.msg);
      worker.postMessage({ cmd: "post", json: JSON.stringify({ cloud: true }) }); // we want the spikes
    } else if (m.t === "memory") {
      const mm = JSON.parse(m.text);
      S.memory = mm;
      if (S.blobThen && mm.data) { const f = S.blobThen; S.blobThen = null; f(mm.data, mm); }
      toRoom("brain", mm); // the lens routes by `t`, so it arrives as a memory message
      log("memory " + mm.op + (mm.ok ? " ok " : " FAILED " + (mm.err || "")) + (mm.bytes ? mm.bytes + "B" : ""));
    } else if (m.t === "brain") {
      const b = JSON.parse(m.text);
      toRoom("brain", b);
      S.brain = b;
      S.steps = (S.steps || 0) + 1;      // the heartbeat in the header
      S.stepAt = performance.now();
      S.regions = b.regions || {};
      S.hz = b.hz || {};
      S.act = b.act || {};
      // b.cloud (16,000 neurons, base64) still goes to the LENS untouched; the page lights all
      // 166,700 from the worker's own `spikes` message instead
    } else if (m.t === "spikes") {
      if (brainView) brainView.spikesAll(new Uint8Array(m.bits));
      S.spikeBytes = m.bits.byteLength;
    } else if (m.t === "stats") S.stepMs = m.stepMs;
  };
  // importScripts() failing inside the worker never reaches onmessage: it lands here
  worker.onerror = (e) => setBrainErr("core: " + (e.message || "dist/flybrain.js failed to load"));
  // the worker is already loading its core while the version (one small fetch) is looked up
  brainUrl().then((url) => worker.postMessage({ cmd: "init", brainUrl: url, gpu, threads: 1 }));
}

/** the brain could not be loaded: name WHICH part, not just "error" */
function setBrainErr(text) {
  const t = String(text || "");
  const http = t.match(/HTTP (\d+)/);
  S.brainErr =
    http ? "BRAIN FILE " + (http[1] === "404" ? "NOT FOUND" : "HTTP " + http[1]) + " \u00b7 " + BRAIN_URL
    : /flybrain\.wasm|wasm/i.test(t) ? "BRAIN CORE (WASM) FAILED TO LOAD \u00b7 run web/build_wasm.sh"
    : /flybrain\.js|importScripts|core:/i.test(t) ? "BRAIN CORE FAILED TO LOAD \u00b7 web/dist/flybrain.js"
    : /fb_create/i.test(t) ? "BRAIN FILE UNREADABLE \u00b7 " + BRAIN_URL
    : /fetch|network|Failed to fetch/i.test(t) ? "BRAIN FILE UNREACHABLE \u00b7 " + BRAIN_URL
    : "BRAIN FAILED \u00b7 " + t.slice(0, 80);
  log(S.brainErr.toLowerCase());
}

/** The brain is on screen before anything is connected: it turns behind the PIN card, so the page
 *  opens on the thing it is about, and the gate dissolves INTO the dashboard instead of cutting. */
async function boot() {
  brainView = new BrainView($("brainCanvas"), { reducedMotion: REDUCED, bloom: params.get("bloom") === null ? 2 : +params.get("bloom") });
  roomView = new RoomView($("roomCanvas"), $("roomLabels"));
  roomView.setMode(roomMode.id);            // whatever the MESH chip was left on last time
  window.__room = roomView; // a handle for the headless fit check (harmless, read-only)
  eyesView = new EyesView($("eyeCanvas"), $("eyeBars"));
  raster = new Raster($("raster"), ROWS.length);
  trainView = new TrainView($("trainTimeline"), $("trainEff"));
  buildRows();
  buildModes();
  fillThings();
  refreshDesigner();
  refreshVersions();
  setTab("brain");
  setTimeout(fitTitles, 300);
  requestAnimationFrame(frame);
  $("stage").classList.add("in");
  brainView.onDetail((st) => { detailStats = st; if (detailMenuOn) buildDetailMenu(); });
  try {
    const info = await brainView.load(asset("assets/neurons.bin"));
    buildLegend(info);
    buildRegionLabels(info.keys);
    S.info = info;
    setText($("brainStat"), info.n.toLocaleString() + " NEURONS, ALL LIT BY THEIR OWN SPIKES");
    // the synapses are a second, much bigger file: the brain is already on screen while it loads
    // every neuron's real arbor (26 MB); the page is already usable while it streams in
    brainView.arbors(asset("assets/skel_l0.bin")).then((segs) => {
      if (!segs) return;
      S.arborSegs = segs;
      setText($("brainStat"), info.n.toLocaleString() + " NEURONS \u00b7 " + segs.toLocaleString()
        + " REAL ARBOR SEGMENTS \u00b7 " + (S.edgeCount || 0).toLocaleString() + " OF 25.6 M SYNAPSES");
    });
    const m = await brainView.edges(asset("assets/edges.bin"), EDGE_CAP);
    S.edgeCount = m;
    if (m) chains = new Chains(info.n, brainView.edgePre, brainView.edgePost, brainView.edgeW, info.cls, CLASS.length);
    if (m) setText($("brainStat"), info.n.toLocaleString() + " NEURONS  //  " + m.toLocaleString() + " OF 25.6 M SYNAPSES SHOWN");
    setText($("brainPlaced"), info.placed.soma.toLocaleString() + " AT THEIR OWN SOMA \u00b7 "
      + (info.placed.partners + info.placed.centroid).toLocaleString() + " INFERRED, DIMMER");
  } catch (e) { log("neurons.bin: " + e.message); }
  try {
    const n = await eyesView.load(asset("assets/eye_lattice.bin"));
    setText($("eyeCols"), n.toLocaleString() + " EYE FACETS");
  } catch (e) { log("eye_lattice.bin: " + e.message); }
}

function start(pin, url) {
  connectRelay(url, pin);
  openDashboard(); // the dashboard arrives now and fills in as the brain warms: nothing waits on a blank screen
  if (!worker) startBrain(!!navigator.gpu && params.get("gpu") !== "0"); // a retry must not spawn a second brain
}

/* ------------------------------------------------------------------ hover chains */
// one line per population, in the page's own words: what it is and where its signal goes
const CHAIN_WORD = {
  "OPTIC LOBE": "the eye's own lobe: 104,702 cells that see before the brain does",
  "CENTRAL BRAIN": "where the senses meet and a decision gets made",
  "MUSHROOM BODY": "the memory: Kenyon cells -> MBONs, the 7,835 synapses that move as the fly lives",
  SENSORY: "everything coming in: eyes, antennae, bristles, taste",
  DESCENDING: "the 1,332 cells that carry a decision from the brain to the body",
  VNC: "the ventral nerve cord: the legs, the wings, the gait",
  "DNa02 L": "steering left: the descending neuron the body turns on",
  "DNa02 R": "steering right: the descending neuron the body turns on",
  ESCAPE: "DNp01/02/04, the giant-fibre escape: a loom in, a jump out",
  STOP: "DNpe007: the brake",
  FEED: "MN9: the proboscis motor neuron, the one that makes the fly eat",
  STRESS: "PPL101: her alarm -- the punishment dopamine. It idles near 71 Hz here, so only a move off that rest means anything",
  OTHER: "cells the connectome put in no named population",
};
let chainPinned = false;

function showChain(ci, why) {
  if (!chains || ci == null) return;
  const r = chains.mask(ci);
  brainView.setChain(r.mask);
  S.chain = { ci, reach: r.reach, seeds: r.seeds, why: why || CHAIN_WORD[CLASS[ci][0]] || "" };
  $("chainPanel").classList.add("on");
}
function clearChain(force) {
  if (chainPinned && !force) return;
  chainPinned = false;
  brainView && brainView.setChain(null);
  S.chain = null;
  $("chainPanel").classList.remove("on");
}
function drawChain() {
  const c = S.chain;
  if (!c) return;
  const col = "#" + CLASS[c.ci][1].toString(16).padStart(6, "0");
  setText($("chainName"), CLASS[c.ci][0]);
  setStyle($("chainName"), "color", col);
  setText($("chainWhy"), c.why);
  setText($("chainSeeds"), c.seeds.toLocaleString() + " NEURONS" + (chainPinned ? "  \u00b7  PINNED, ESC RELEASES" : ""));
  const host = $("chainHops");
  const want = c.reach.map((hit, h) => {
    const top = hit.map((v, i) => [v, i]).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 4);
    return { h: h + 1, ms: (h + 1) * 180, top };
  });
  const key = JSON.stringify(want);
  if (key === S.chainKey) return;
  S.chainKey = key;
  host.innerHTML = "";
  for (const row of want) {
    const d = document.createElement("div");
    d.className = "hop";
    d.innerHTML = '<span class="n">+' + row.h + " HOP \u00b7 " + row.ms + ' MS</span>'
      + row.top.map((x) => '<i style="color:#' + CLASS[x[1]][1].toString(16).padStart(6, "0") + '">'
        + CLASS[x[1]][0] + " " + x[0].toLocaleString() + "</i>").join("");
    host.appendChild(d);
  }
}

/* ------------------------------------------------------------------ rows and legend */
const rowEls = [];
function buildRows() {
  const host = $("neural");
  ROWS.forEach((r, i) => {
    const d = document.createElement("div");
    d.className = "row";
    d.innerHTML = '<i class="sw"></i><div class="lbl"></div><div class="val">0.0</div><div class="trk"></div><div class="fil"></div>';
    d.querySelector(".sw").style.color = "#" + (CLASS[i] ? CLASS[i][1].toString(16).padStart(6, "0") : "5fd8f5");
    d.querySelector(".lbl").textContent = r.label;
    host.appendChild(d);
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", r.label + " — hover or focus to isolate these neurons in the brain");
    const el = { d, lbl: d.querySelector(".lbl"), val: d.querySelector(".val"), fil: d.querySelector(".fil"), v: 0, peak: 1, bit: 1 << i };
    const enter = () => {
      host.classList.add("hover");
      d.classList.add("hot");
      S.focus = el.bit;
      if (brainView) brainView.setFocus(el.bit);
      showChain(i);            // the row's own population, and where its signal goes
    };
    d.addEventListener("pointerenter", enter);
    d.addEventListener("click", () => { chainPinned = true; enter(); });
    d.addEventListener("focus", enter);
    d.addEventListener("blur", () => { if (chainPinned) return; host.classList.remove("hover"); d.classList.remove("hot"); S.focus = 0; if (brainView) brainView.setFocus(0); clearChain(); });
    d.addEventListener("pointerleave", () => {
      if (chainPinned) return;
      host.classList.remove("hover");
      d.classList.remove("hot");
      S.focus = 0;
      if (brainView) brainView.setFocus(0);
      clearChain();
    });
    rowEls.push(el);
  });
}

// four anatomical labels anchored to the real centroid of those neurons, so the picture names
// itself: the legend below is for isolating a row, these are for reading the brain
const REGION_LABELS = [["optic", "OPTIC LOBE", -1], ["central", "CENTRAL BRAIN", 0], ["mushroom", "MUSHROOM BODY", 1], ["vnc", "VENTRAL NERVE CORD", 0]];
const regionEls = [];
function buildRegionLabels(keys) {
  const host = $("regionLabels");
  for (const [k, text, side] of REGION_LABELS) {
    const i = keys.indexOf(k);
    if (i < 0) continue;
    const el = document.createElement("div");
    el.className = "rl";
    el.textContent = text;
    host.appendChild(el);
    regionEls.push({ el, c: brainView.centroid(1 << i, side), p: { x: 0, y: 0, on: false }, y: 0 });
  }
}

// A colour KEY, not a control: the NEURAL rows are the single hover surface, so the key under the
// brain is one static line and the full table with counts lives in the "?" card.
function buildLegend(info) {
  const full = $("helpKey");
  full.innerHTML = "";
  CLASS.forEach((c, i) => {
    if (!info.count[i]) return;
    const col = "#" + c[1].toString(16).padStart(6, "0");
    const d = document.createElement("div");
    d.className = "keyrow";
    d.style.color = col;
    d.innerHTML = "<i></i><b>" + c[0] + "</b><u>" + info.count[i].toLocaleString() + "</u>";
    full.appendChild(d);
  });
}

/* ------------------------------------------------------------------ the frame */
let accentShown = "", mmShown = -1;
const rasterBuf = new Float32Array(ROWS.length);
let last = performance.now() / 1000;
let fpsAvg = 60, fpsWorst = 0, fpsT = 0;

/* BRAIN FIRST (17.09, Pavlo: "does the brain run faster when I minimise the page?" - yes it does).
 * Minimising stops requestAnimationFrame, the whole brain drawing halts, and the worker gets the GPU
 * to itself. So the renderer and the brain really do compete here, and when a lens is waiting on this
 * page for its next decision, the drawing is the part that can afford to wait. So the loop is simply
 * capped, always: eighty frames a second of brain animation is never what anyone came for, and the
 * spare GPU goes to the worker. ?render=N sets another rate, ?render=0 removes the cap. Nothing about
 * the brain changes, only how often we draw it. */
/* WHAT THE GPU IS SPENT ON (17.09, measured by Pavlo on the glasses + this page): minimise the page
 * and the brain's step falls from 750 ms to 150 - the drawing was costing the brain FIVE times its
 * speed. Capping the frame rate alone is not enough, because the cost is how MUCH is drawn (1,996,613
 * arbor segments, 982,224 pulses, the bloom pyramid), not how often. So this is a real trade, exposed
 * as one control: each step down hands the worker more of the GPU. BLIND is minimising without losing
 * the numbers - the panels keep updating, the brain canvas simply is not drawn. */
const PERF_MODES = [
  { id: "full", label: "FULL PICTURE", fps: 0, detail: "auto", bloom: null, draw: true, note: "everything drawn; the brain waits its turn" },
  { id: "balanced", label: "BALANCED", fps: 30, detail: "auto", bloom: 2, draw: true, note: "30 fps, softer glow — the default" },
  { id: "brain", label: "BRAIN FIRST", fps: 10, detail: "low", bloom: 0, draw: true, note: "10 fps, thinnest picture: the fly thinks fastest" },
  { id: "blind", label: "BOOST BRAIN", fps: 10, detail: "low", bloom: 0, draw: false, note: "nothing is drawn: the whole graphics card thinks for the fly; every number still updates" },
];
// 21.09 Pavlo: a phone starts in BRAIN FIRST (it is ~4x slower than a laptop; the brain is the point), a
// desktop in BALANCED; the FASTEST BRAIN chip flips either way and the choice is remembered.
const PHONE = matchMedia("(max-width: 700px)").matches || matchMedia("(pointer: coarse)").matches;
// 22.09 Pavlo: a fresh visitor starts with the 3D OFF while the brain warms. A cold GPU plus the page's
// own load spike (WASM init, the connectome uploaded to the card) is what could hang the whole machine
// if the first frame drew HIGH. So nothing is drawn until the brain is stepping; then drawing switches
// on and the detail ladder climbs from LOW. An explicit ?perf= or a remembered choice is honoured as-is.
const SAVED_PERF = params.get("perf") || localStorage.getItem("perf");
const AUTO_WARM = !SAVED_PERF;
let perfMode = PERF_MODES.find((m) => m.id === SAVED_PERF)
  || (AUTO_WARM ? PERF_MODES.find((m) => m.id === "blind") : PERF_MODES[PHONE ? 2 : 1]);
const WARMUP_MS = 1500;   // a brief settle with nothing drawn before the picture switches on
let warmed = false, warmAt = 0;
let perfBeforeFast = "balanced"; // where BOOST BRAIN returns to
const BRAIN_FIRST_FPS = params.has("render") ? +params.get("render") : -1; // an explicit ?render= wins
let renderT = 0;

function perfFps() {
  return BRAIN_FIRST_FPS >= 0 ? BRAIN_FIRST_FPS : perfMode.fps;
}
function setPerf(id, persist = true) {
  const m = PERF_MODES.find((x) => x.id === id);
  if (!m) return;
  perfMode = m;
  if (persist) localStorage.setItem("perf", m.id);   // the warm-up's own switches pass false, so a
  // fresh visitor warms on every load; only a deliberate choice (the chip or the menu) is remembered
  setText($("chipPerf").querySelector("i"), m.label);
  if (brainView) m.detail === "auto" ? brainView.detailAuto() : brainView.setDetail(m.detail);
  if (brainView && brainView.post && m.bloom !== null && typeof brainView.post.setLevels === "function") brainView.post.setLevels(m.bloom);
  syncFast();
}
// the one-tap chip (21.09 Pavlo: BOOST BRAIN): on = NOTHING is drawn -- brain, eyes and room go dark
// and say PREVIEW PAUSED -- so the graphics card does nothing but think for the fly; the numbers keep
// updating at the blind mode's 10 Hz. Off = back to whatever priority it was in.
function syncFast() {
  const c = $("chipFast"); if (!c) return;
  const on = !perfMode.draw;
  c.classList.toggle("on", on);
  c.setAttribute("aria-pressed", on ? "true" : "false");
  c.innerHTML = on ? "&#9889; draw again" : "&#9889; boost brain";
  c.title = on ? "Draw the brain, the eyes and the room again (the fly thinks a little slower)."
    : "BOOST BRAIN \u2014 stop drawing everything so the whole graphics card thinks for the fly. Tap again to draw.";
  document.body.classList.toggle("boost", on);
}
function toggleFast() {
  const on = !perfMode.draw;
  if (on) {
    const back = PERF_MODES.find((m) => m.id === perfBeforeFast && m.draw);
    setPerf(back ? back.id : (PHONE ? "brain" : "balanced"));
  } else { perfBeforeFast = perfMode.id; setPerf("blind"); }
}

// 22.09 the warm-up: with nothing drawn the brain loads and takes its first steps; once it is stepping
// and a moment (WARMUP_MS) has passed, drawing switches on -- BALANCED on a desktop, BRAIN FIRST on a
// phone -- with the detail ladder starting LOW. Only for a fresh visitor; a chosen mode is left alone.
const pausedEl = $("paused");
const pausedHTML = pausedEl ? pausedEl.innerHTML : "";
function maybeWarm(now) {
  if (warmed || !AUTO_WARM) return;
  if (!S.steps) return;                 // the brain is not stepping yet: keep the picture off
  if (!warmAt) warmAt = now;            // first step seen: start the warm clock
  if (now - warmAt < WARMUP_MS) return;
  warmed = true;
  document.body.classList.remove("warming");
  if (pausedEl) pausedEl.innerHTML = pausedHTML;   // restore the real BOOST copy for a later manual tap
  setPerf(PHONE ? "brain" : "balanced", false);    // draw now; brainView's auto ladder is already at LOW
}

function frame(now) {
  requestAnimationFrame(frame);
  maybeWarm(now);
  const t = now / 1000;
  let dt = Math.min(0.1, t - last);
  // draw less often so the worker keeps the GPU
  const capFps = perfFps();
  if (capFps > 0) {
    renderT += dt;
    if (renderT < 1 / capFps) { last = t; return; }
    dt = Math.min(0.1, renderT);
    renderT = 0;
  }
  last = t;
  fpsAvg = approach(fpsAvg, 1 / Math.max(1e-4, dt), 1.5, dt);
  if (dt * 1000 > fpsWorst) fpsWorst = dt * 1000;

  const selCol = FLY_CSS[Math.max(0, S.sel) % FLY_CSS.length];
  if (accentShown !== selCol) { accentShown = selCol; document.documentElement.style.setProperty("--accent", selCol); }
  if (eyesView) eyesView.setTint(selCol);

  // neural rows: every row auto-ranges on its own decaying peak, like the board's bars
  for (let i = 0; i < ROWS.length; i++) {
    const r = ROWS[i], el = rowEls[i];
    let v = 0;
    if (r.src === "regions") v = S.regions[r.k] || 0;
    else if (r.src === "hz") v = S.hz[r.k] || 0;
    else v = Math.max(S.hz[r.a] || 0, S.hz[r.b] || 0);
    el.v = approach(el.v, v, 9, dt);
    el.peak = Math.max(1, el.peak * Math.exp(-dt * 0.12), el.v);
    setText(el.val, el.v.toFixed(1));
    // scaleX, not width: a percentage width on a positioned element costs a LAYOUT, and this
    // runs on twelve rows every frame. The value is quantised so the string only changes when the
    // drawn pixel could change, which is what makes the diff-cache in setStyle worth having.
    setStyle(el.fil, "transform", "scaleX(" + (Math.round((el.v / el.peak) * 400) / 400) + ")");

    rasterBuf[i] = el.v / el.peak;
  }
  // the empty state REPLACES the rows: twelve "0.0"s under a "waiting" line are twelve numbers
  // that look measured and are not (DESIGN §8)
  setStyle($("neuralEmpty"), "display", S.brain ? "none" : "");
  setStyle($("neural"), "display", S.brain ? "" : "none");
  if (raster) raster.frame(dt, rasterBuf, selCol);

  // the body, from the fly's own packet
  const me = S.flies.find((f) => f[0] === S.sel) || S.flies[0];
  if (me) {
    setText($("bodyName"), me[1]);
    setText($("bState"), STATE[me[9] | 0] || "AIR", true);
    setText($("bSpeed"), Math.round(me[10]) + " cm/s");
    const en = Math.max(0, Math.min(1, me[13]));
    setText($("bEnergy"), (en * 100).toFixed(0) + " %");
    setStyle($("bEnergyBar"), "transform", "scaleX(" + (Math.round(en * 200) / 200) + ")");
    setStyle($("bEnergyBar"), "background", en < 0.35 ? "#ff8a5c" : selCol);
    setText($("bWing"), me[11].toFixed(2));
  }
  const a = S.act;
  const action = !S.brain ? "—"
    : (a.stop || 0) > 0.5 ? "STOP"
    : Math.max(a.escape_L || 0, a.escape_R || 0) > 0.5 ? "ESCAPE"
    : (a.feed || 0) > 0.4 ? "FEEDING"
    : (a.groom || 0) > 0.4 ? "GROOMING"
    : (a.forward || 0) > 0.3 ? "CRUISE " + ((a.steer || 0) > 0.3 ? "›" : (a.steer || 0) < -0.3 ? "‹" : "")
    : "HOVER";
  setText($("bAction"), action, true);
  if (S.brain) setText($("bSim"), (S.brain.sim_ms / 1000).toFixed(1) + " s");

  // link / engine chips, and the named state of every way this can fail
  const lensOn = performance.now() - S.lensSeen < 6000;
  const st = status(lensOn);
  // the PIN chip shows the four digits the person typed, never the room's internal name
  chip($("chipRoom"), S.joined ? S.pin : st.room, S.joined, S.relay === "down" || S.relay === "refused");
  chip($("chipLens"), st.lens, lensOn, st.lensBad);
  const cpu = !!S.engine && /cpu|wasm/i.test(S.engine);
  // THE BRAIN CHIP IS THE HEARTBEAT (21.09): what a stranger needs from the header is that the
  // thing is alive. The dot beats on every step; the number is how many 50 ms slices of fly life
  // the brain has thought through. Where it thinks (the GPU's name) is the hover, never the label.
  const beat = S.stepAt && performance.now() - S.stepAt < 700;
  const live = $("chipLive");
  const liveText = S.brainErr ? "failed"
    : !S.brain ? loadWord(S.engine)
    : cpu ? "thinking on the CPU \u00b7 slow \u00b7 " + S.steps + " steps"
    : "thinking \u00b7 " + (S.steps || 0).toLocaleString() + " steps";
  chip(live, liveText, !!S.brain && !S.brainErr && !cpu, !!S.brainErr || cpu);
  live.classList.toggle("beat", !!beat);
  const liveTitle = "One step = the brain thinking through 50 ms of the fly's life. The dot beats on every step."
    + (S.engine ? " \u00b7 running on " + S.engine : "");
  if (live.title !== liveTitle) live.title = liveTitle;
  // DETAIL: which rung of the draw ladder, and what it costs. A view control, never a brain control.
  const det = detailStats ? detailStats.level + " \u00b7 " + Math.round(detailStats.ms) + " MS" : "\u2014";
  chip($("chipEngine"), det, !!detailStats, false);
  const engTitle = "DETAIL \u2014 how much of the brain is drawn. Lower it if the picture stutters. It never changes what the brain computes."
    + (detailStats ? (detailStats.auto ? " \u00b7 AUTO: the page picks the rung that holds the frame" : " \u00b7 pinned by hand") + " \u00b7 click to change" : "");
  if ($("chipEngine").title !== engTitle) $("chipEngine").title = engTitle;
  if (S.stepMs && S.stepSamples.length < 20) { S.stepSamples.push(S.stepMs); if (S.stepSamples.length === 20) { const a2 = S.stepSamples.slice().sort((x, y) => x - y); S.stepBase = a2[10]; } }
  const shared = !cpu && S.lensSlow;
  chip($("chipStep"), S.stepMs ? Math.round(S.stepMs) + " ms" : "\u2014", S.stepMs > 0 && S.stepMs < 200, shared);
  // one advisory row at a time: a refusal outranks a note about the engine
  setStyle($("engineNote"), "display", (cpu || shared) && !S.faultShown ? "" : "none");
  setText($("engineNote"), cpu
    ? "NO WEBGPU IN THIS BROWSER \u00b7 THE BRAIN IS THINKING ON THE CPU, ABOUT 8\u00d7 SLOWER \u00b7 CHROME / EDGE 113+ AND SAFARI 26+ HAVE WEBGPU \u00b7 HTTPS NEEDED OUTSIDE LOCALHOST"
    : "GRAPHICS CARD SHARED \u00b7 " + Math.round(S.stepMs) + " MS A STEP \u00b7 CLOSE OTHER GPU APPS OR THE LENS PREVIEW, OR PICK BRAIN FIRST UNDER ADVANCED");
  fpsT += dt;
  if (fpsT > 0.5) {
    fpsT = 0;
    chip($("chipFps"), fpsAvg.toFixed(0) + " fps", fpsAvg > 50);
    fpsWorst = 0;
  }
  setText($("ioOut"), String(S.toLens));
  setText($("ioIn"), String(S.fromLens));
  setText($("ioPerf"), S.dbg && performance.now() - S.dbg.at < 8000 && S.dbg.fps != null
    ? S.dbg.fps + " fps \u00b7 worst " + S.dbg.worst + " ms \u00b7 scripts " + S.dbg.scripts.toFixed(1) + " ms" : "\u2014");
  setText($("spikes"), S.brain && S.brain.neural ? String(S.brain.neural.spikes) : "—");
  const sceneOn = performance.now() - S.sceneAt < 4000;
  setText($("sceneRate"), sceneOn ? S.sceneB + " B" : S.sceneN ? "quiet" : "—");
  setText($("learnState"), S.learning ? "LEARNING ON" : "LEARNING OFF");
  // the room panel says which of its six states it is in, and nothing else
  const lostFor = S.lensEver && !lensOn ? Math.round((performance.now() - S.lensSeen) / 1000) : 0;
  const growing = performance.now() - S.surfAt < 6000 && S.surfParts && S.surfSeen < S.surfParts;
  const roomState = S.demo ? "MADE-UP ROOM" + (S.invCount ? " \u00b7 " + S.invCount + " THINGS" : "")
    : !S.joined ? st.room.toUpperCase()
    : !lensOn && S.lensEver ? "GLASSES LOST \u00b7 LAST SEEN " + lostFor + " S"
    : st.lens === "not found" ? "NO GLASSES YET"
    : !sceneOn ? "WAITING FOR THE GLASSES"
    : growing ? "THE GLASSES ARE SCANNING \u00b7 " + (S.surfTris || 0).toLocaleString() + " TRIANGLES"
    : S.surfTris ? "SCANNED \u00b7 " + S.surfTris.toLocaleString() + " TRI"
      + (S.invCount ? " \u00b7 " + S.invCount + " THINGS" : " \u00b7 NAMING THINGS")
    : "THE GLASSES ARE SCANNING \u00b7 0 TRIANGLES";
  setText($("roomStat"), roomState);
  setStyle($("pRoom"), "opacity", !lensOn && S.lensEver ? "0.55" : "1"); // lens lost: the room stays, greyed
  setText($("trailNote"), roomView && roomView.trailSeconds ? "TRAIL " + roomView.trailSeconds.toFixed(1) + " S" : "");
  // the MESH chip exists only while there is a mesh to draw: an empty room offers no ways to draw it
  const hasMesh = !!(roomView && roomView.hasRoom());
  setStyle($("chipMesh"), "display", hasMesh ? "" : "none");
  if (!hasMesh && $("meshMenu").classList.contains("on")) meshMenu(false);
  setText($("gemCount"), S.invCount ? S.invCount + " THINGS" : "—");
  if (S.thought) setText($("thought"), S.thought);
  else if (S.invCount) setText($("thought"), "The glasses have named " + S.invCount + " things in the room the fly can land on or flee from. Point at one and it starts to smell.");
  setText($("neuralRange"), "HZ");
  setText($("linkTitle"), S.demo ? "// PAGE \u2194 MADE-UP GLASSES" : "// PAGE \u2194 GLASSES");

  // there is no invitation to teach any more: training runs by itself and the TRAINING tab is
  // where its DATA is read, not a lesson to be started. #sessionBanner still announces a live one.
  setStyle($("howStart"), "display", S.everTrained ? "none" : "");
  drawChain();
  // refreshDesigner() rebuilds a whole panel; it used to run sixty times a second on the TRAINING
  // tab (and write into #pDesign, which is display:none). It answers the same six facts each time,
  // so it runs when one of them changes and not otherwise.
  if (S.tab === "training") {
    const k = mode + "|" + S.joined + "|" + lensOn + "|" + (S.invItems ? S.invItems.length : -1)
      + "|" + S.trainUnavailable + "|" + (S.train && S.train.phase);
    if (k !== S.designKey) { S.designKey = k; refreshDesigner(); }
  }
  drawTraining(dt, selCol);
  drawMemory(selCol);
  if (eyesView && perfMode.draw) { // BOOST BRAIN: the eyes are not drawn either
    eyesView.setData(S.eye, S.hz, S.eyeImg);
    eyesView.frame(dt, t);
    // an honest empty state: a landed fly moves nothing, so ON/OFF and the detectors ARE zero
    const still = eyesView.moved === 0;
    setText($("eyeCols"), !S.eyeImg && !S.eye ? (S.demo ? "WAITING FOR THE ROOM" : "WAITING FOR THE GLASSES")
      : still ? (me && (me[10] | 0) === 0 ? "STILL \u00b7 NOTHING MOVING TO DETECT" : "NO CONTRAST")
      : eyesView.moved + "/1767 MOVING");
  }
  // the two tabs now share the grid cell and cross-fade instead of display:none-ing each other, so
  // the stage keeps its size on the TRAINING tab — which means the draw has to be gated HERE, or
  // the brain would keep costing its frame behind a panel nobody is looking at
  if (brainView && S.tab === "brain" && perfMode.draw) {
    brainView.frame(dt, t);
    for (const r of regionEls) brainView.project(r.c, r.p);
    // screen-space de-overlap: labels never stack, they slide apart (one vocabulary: eased, not snapped)
    const sorted = regionEls.slice().sort((a, b) => a.p.y - b.p.y);
    let prev = -1e9;
    for (const r of sorted) {
      const want = Math.max(r.p.y, prev + 17);
      prev = want;
      r.y = approach(r.y || want, want, 10, dt);
    }
    for (const r of regionEls) {
      setStyle(r.el, "opacity", r.p.on ? (S.focus ? "0.3" : "0.85") : "0");
      if (r.p.on) r.el.style.transform = `translate(-50%,-50%) translate(${r.p.x.toFixed(1)}px, ${r.y.toFixed(1)}px)`;
    }
    setText($("brainExp"), (100 * brainView.frac).toFixed(1) + " % FIRING \u00b7 EXPOSURE " + brainView.exp.toFixed(2) + "x");
  }
  if (roomView && perfMode.draw) { // BOOST BRAIN: nor the room
    roomView.frame(dt, t);
    const mm = roomView.flies.size ? roomView.mini : null;
    setStyle($("minimapFrame"), "opacity", mm ? "1" : "0");
    setStyle($("minimapCap"), "opacity", mm ? "1" : "0");
    if (mm && mmShown !== mm.w) {
      mmShown = mm.w;
      const f = $("minimapFrame"), c = $("minimapCap");
      f.style.width = mm.w + "px"; f.style.height = mm.h + "px";
      c.style.right = mm.x === undefined ? "5px" : "5px";
      c.style.bottom = mm.h + 7 + "px";
    }
  }
}

/** One named state per failure, in the order they matter, plus what happens next.
 *  Nothing here is a spinner: every branch says WHAT is wrong and WHAT to do. */
/** the worker's own status line, as one or two words after the word BRAIN: "brain · unpacking" */
function loadWord(t) {
  t = String(t || "");
  const pc = t.match(/downloading the brain (\d+)%/);
  return pc ? "downloading \u00b7 " + pc[1] + " %"
    : /downloading/.test(t) ? "downloading \u00b7 75 MB"
    : /cache|loading the core/.test(t) ? "loading"
    : /parsing/.test(t) ? "unpacking"
    : /webgpu/i.test(t) ? "waking the graphics card"
    : /warming/.test(t) ? "warming up"
    : t ? t : "starting";
}

function status(lensOn) {
  const now = performance.now();
  // ?demo=1: there is no room and no lens, and the chips say exactly that (gfx/demo.js)
  if (S.demo) return { room: "demo", lens: "made up", lensBad: false };
  // the backoff retry runs off the same clock the countdown is drawn from
  if (S.relay === "down" && S.retryAt && now >= S.retryAt) { S.retryAt = 0; connectRelay(S.relayUrl, S.pin); }
  const room = S.relay === "down" ? "reconnecting"
    : S.relay === "refused" ? "refused"
    : S.relay === "connecting" ? "connecting"
    : S.joined ? S.room : S.relay === "idle" ? "\u2014" : "linking";
  const waited = S.joined ? (now - S.joinedAt) / 1000 : 0;
  const noLens = S.joined && !S.lensEver && waited > NO_LENS_S;
  // a busy machine makes messages late, not absent: lost needs a real silence, measured against
  // how often this lens has actually been talking, and never fires on one gap
  const gap = (now - S.lensSeen) / 1000;
  const need = Math.max(8, 4 * (S.lensGap || 1));
  const lost = S.lensEver && gap > need;
  S.lensSlow = S.lensEver && !lost && (S.stepMs > 300 || (S.stepBase && S.stepMs > 3 * S.stepBase));
  const lens = lost ? "lost" : S.lensSlow ? "slow" : lensOn ? "connected" : noLens ? "not found" : S.joined ? "waiting" : "\u2014";

  let fault = "", wait = false;
  if (S.brainErr) fault = S.brainErr;
  else if (S.relay === "down") {
    const left = Math.max(0, Math.ceil((S.retryAt - now) / 1000));
    fault = "CAN\u2019T REACH THE LINK SERVER \u00b7 retrying in " + left + " s";
  } else if (S.relay === "refused") fault = "THE LINK SERVER REFUSED PIN " + S.pin + " \u00b7 the key does not match";
  else if (S.relay === "connecting") { fault = "CONNECTING\u2026"; wait = true; }
  else if (noLens) fault = "NO GLASSES FOUND FOR PIN " + S.pin + " \u00b7 check the four digits on the glasses";
  else if (lost) fault = "GLASSES LOST \u00b7 waiting for them to come back";
  else if (S.lensSlow) { fault = "GLASSES WAITING \u00b7 the brain takes " + Math.round(S.stepMs) + " ms a step \u00b7 still talking"; wait = true; }

  const el = $("fault");
  const key = fault.replace(/\d+ s$/, ""); // the countdown ticks every second; the STATE does not
  if (setText(el, fault) && fault && !wait && key !== S.faultShown) kick(el);
  S.faultShown = key;
  const cls = (fault ? "sp on" : "sp") + (wait ? " wait" : "");
  if (el.className !== cls) el.className = cls;
  // while the gate is up it carries the same words, so the refusal is where the eye already is
  if (!$("gate").classList.contains("gone")) {
    const note = $("note");
    if (fault) { note.className = wait ? "note" : "note warn"; setText(note, fault); }
  }
  return { room, lens, lensBad: lost || noLens };
}

/* ------------------------------------------------------------------ training + memory */
const PHASE_WORD = { idle: "IDLE", probe: "PROBE \u00b7 MEASURING THE BIAS", bout: "PAIRING", bouts: "PAIRING",
  probe2: "PROBE \u00b7 MEASURING AGAIN", done: "DONE", rest: "RESTING" };
const RESULT_WORD = {
  learned: ["LEARNED", "the fly turns toward the CS+ more than it did"],
  no_change: ["NO CHANGE", "the bias did not move outside the probe's own spread"],
  nochange: ["NO CHANGE", "the bias did not move outside the probe's own spread"],
  control: ["CONTROL RUN", "plasticity off \u2014 nothing could have changed"],
  aversive: ["LEARNED (AVERSIVE)", "the fly now turns away from the CS+"],
  failed: ["FAILED", "the session did not finish"],
};

function drawTraining(dt, accent) {
  const d = S.train;
  const on = !!d && performance.now() - S.trainAt < 120000;
  const app = document.getElementById("app");
  // on the BRAIN tab a running session is one line, not a second dashboard
  const ban = $("sessionBanner");
  const live = on && d.phase && d.phase !== "done";
  ban.classList.toggle("on", live && S.tab !== "training");
  if (live) {
    const ph = (PHASE_WORD[String(d.phase).toLowerCase()] || String(d.phase)).split(" \u00b7 ")[0];
    setText(ban, "SESSION RUNNING \u00b7 " + String(d.mode || "").toUpperCase() + " \u00b7 " + ph
      + (d.N ? " " + (d.n | 0) + " / " + d.N : "") + " \u00b7 click to watch");
  }
  // "a strip that opens only when there is one" — on the BRAIN tab the grid row does that, but
  // inside the TRAINING tab the strip is an ordinary plate, so it has to say so itself. Seven
  // em-dashes and two blank canvases sitting ABOVE the panel that explains them is not an empty
  // state; it is the first thing the tab shows.
  const strip = $("train");
  if (strip.classList.contains("live") !== on) strip.classList.toggle("live", on);
  const rowOpen = on && S.tab === "training";
  if (app.classList.contains("training") !== rowOpen) {
    app.classList.toggle("training", rowOpen);
    // MEMORY belongs beside the session that writes it; without one it lives in the left column
    const mem = $("pMem"), grid = $("trainGrid");
    if (on) grid.appendChild(mem); else $("left").insertBefore(mem, $("pLearn"));
    grid.classList.toggle("mem", on);
  }
  if (!on) return;
  setText($("trainMode"), "// " + String(d.mode || "SESSION").toUpperCase().replace(/_/g, " "));
  const phase = String(d.phase || "").toLowerCase();
  const nN = d.N ? "  " + Math.max(0, d.n | 0) + " / " + (d.N | 0) : "";
  setText($("trainPhase"), (PHASE_WORD[phase] || phase.toUpperCase() || "\u2014") + nN, true);
  setText($("trainCsPlus"), "CS+  " + (d.csPlus || "\u2014"));
  setText($("trainCsMinus"), "CS\u2212  " + (d.csMinus || "\u2014"));

  // the two bias bars share one zero line and one scale, so before/after are comparable by eye
  const b0 = num(d.biasBefore), b1 = num(d.biasAfter);
  const top = Math.max(1, Math.abs(b0 || 0), Math.abs(b1 || 0));
  bar($("trainBiasBefore"), b0, top, accent);
  bar($("trainBiasAfter"), b1, top, accent);
  setText($("trainBiasBeforeV"), b0 === null ? "\u2014" : b0.toFixed(2));
  setText($("trainBiasAfterV"), b1 === null ? "\u2014" : b1.toFixed(2));
  const dd = b0 !== null && b1 !== null ? b1 - b0 : null;
  setText($("trainBiasD"), dd === null ? "" : (dd >= 0 ? "+" : "") + dd.toFixed(2));
  setText($("trainEffV"), typeof d.eff === "number" ? d.eff.toFixed(4) : "");

  // whatever MBONs the feed names, however it names them
  const mb = d.mbon;
  let mbText = "";
  if (mb && typeof mb === "object") mbText = Object.keys(mb).slice(0, 4).map((k) => k + " " + (+mb[k]).toFixed(1)).join("   ");
  else if (typeof mb === "number") mbText = "MBON " + mb.toFixed(1);
  const mbEl = $("trainMbon");
  if (setText(mbEl, mbText)) mbEl.innerHTML = mbText.replace(/(\d+\.\d)/g, "<b>$1</b>");

  const res = String(d.result || "");
  const key = res.toLowerCase().replace(/[^a-z_]/g, "");
  const word = RESULT_WORD[key];
  const el = $("trainResult");
  const text = word ? word[0] + " \u00b7 " + word[1]
    : res ? res.toUpperCase()
    : phase === "done" ? "SESSION OVER \u00b7 no verdict in the feed"
    : "RUNNING \u00b7 the verdict comes at the second probe";
  if (setText(el, text)) {
    el.innerHTML = text.replace(/^([^\u00b7]+)/, "<b>$1</b>");
    if (res) kick(el);
  }
  const cls = key === "control" ? "ctrl" : key.indexOf("no") === 0 || key === "failed" ? "none" : "";
  if (el.className !== cls) el.className = cls;
  trainView.frame(dt, accent);
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
function bar(el, v, top, accent) {
  if (v === null) { setStyle(el, "width", "0%"); return; }
  const k = Math.max(-1, Math.min(1, v / top)) * 50;
  setStyle(el, "left", (k >= 0 ? 50 : 50 + k) + "%");
  setStyle(el, "width", Math.abs(k) + "%");
  setStyle(el, "background", v >= 0 ? accent : "#9a86d8");
}

function drawMemory(accent) {
  const m = S.mem;
  const panel = $("pMem");
  if (!m) { panel.classList.remove("on"); document.getElementById("app").classList.remove("memcol"); return; }
  if (!panel.classList.contains("on")) { panel.classList.add("on"); panel.classList.add("in"); } // it enters, it never blinks in
  // in the left column MEMORY needs the room the other plates can spare; in the strip it does not
  const app = document.getElementById("app");
  app.classList.toggle("memcol", !app.classList.contains("training"));
  // whose fly this is — the short key only, never the whole id
  const mine = m.keySource === "user";
  const who = (mine ? "YOUR FLY" : "THIS DEVICE") + " \u00b7 " + (m.keySource || "?") + " \u00b7\u00b7\u00b7\u00b7" + (m.keyShort || "????");
  const el = $("memWho");
  if (setText(el, who)) el.innerHTML = who.replace(/^([A-Z ]+)/, "<b>$1</b>").replace(/(\u00b7 [a-z]+ \u00b7)/, "<i>$1</i>");
  setText($("memSync"), m.synced ? "SYNCED" : "LOCAL ONLY");
  setStyle($("memSync"), "color", m.synced ? accent : "var(--warn)");
  setText($("memBytes"), m.bytes ? (m.bytes > 1024 ? (m.bytes / 1024).toFixed(1) + " KB" : m.bytes + " B") : "\u2014");
  setText($("memSaved"), ago(m.savedAt) + (m.changedSinceSave ? " *" : ""));
  setStyle($("memSaved"), "color", m.changedSinceSave ? "var(--warn)" : "var(--cyan)");
  setText($("memChanged"), m.changed === undefined ? "\u2014" : Number(m.changed).toLocaleString());
  setText($("memEff"), typeof m.mean_efficacy === "number" ? m.mean_efficacy.toFixed(4) : "\u2014");
  // show the strip FIRST, then draw: a canvas inside display:none has no width to draw into
  const hist = m.history || m.sessions;
  const has = !!(hist && hist.length);
  const hEl = $("memHist");
  if (hEl.classList.contains("on") !== has) hEl.classList.toggle("on", has);
  if (has) drawHistory($("memHistCanvas"), hist, accent);
}

function ago(at) {
  if (!at) return "never";
  const ms = at < 1e12 ? at * 1000 : at; // seconds or milliseconds, both happen
  const s = Math.max(0, (Date.now() - ms) / 1000);
  // the label already says LAST SAVE, so "ago" is a word that only costs room
  return s < 60 ? Math.round(s) + " s" : s < 3600 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h";
}

// a title that still does not fit gets a one-shot marquee on hover, measured once
function fitTitles() {
  for (const cap of document.querySelectorAll(".cap")) {
    const t = cap.firstElementChild;
    if (!t || t.tagName !== "SPAN") continue;
    if (!t.querySelector(".m")) t.innerHTML = '<span class="m">' + t.innerHTML + "</span>";
    const m = t.querySelector(".m");
    const over = m.scrollWidth - t.clientWidth;
    t.style.setProperty("--mx", over > 2 ? -over - 2 + "px" : "0px");
  }
}
window.addEventListener("resize", () => setTimeout(fitTitles, 60));

/* A column that hides a panel below the fold has to say so. Reading scrollHeight forces a layout,
 * so this runs on scroll and four times a second — never in frame(). */
function markScroll() {
  for (const id of ["left", "right", "trainTab"]) {
    const el = $(id);
    if (!el) continue;
    const more = el.scrollHeight - el.clientHeight - el.scrollTop > 2;
    if (el.classList.contains("scrollable") !== more) el.classList.toggle("scrollable", more);
  }
}
for (const id of ["left", "right", "trainTab"]) {
  const el = $(id);
  if (el) el.addEventListener("scroll", markScroll, { passive: true });
}
setInterval(markScroll, 400);
window.addEventListener("resize", markScroll);

function chip(el, text, on, bad) {
  setText(el.querySelector("i"), text);
  if (el.classList.contains("on") !== (!!on && !bad)) el.classList.toggle("on", !!on && !bad);
  if (el.classList.contains("bad") !== !!bad) el.classList.toggle("bad", !!bad);
}

// "?" opens one line per number on the screen; ESC closes it. It is a dialog, so it takes focus
// when it opens and hands it back to whatever opened it — Tab used to walk straight out behind it.
let helpReturn = null;
const help = (on) => {
  const el = $("help");
  const want = on === undefined ? !el.classList.contains("on") : !!on;
  if (el.classList.contains("on") === want) return;
  if (want) helpReturn = document.activeElement;
  el.classList.toggle("on", want);
  if (want) { const c = el.querySelector(".card"); c && c.focus(); }
  else if (helpReturn && helpReturn.focus) { helpReturn.focus(); helpReturn = null; }
};
window.addEventListener("keydown", (e) => {
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); help(); }
  else if (e.key === "Escape") { help(false); clearChain(true); }
  else if (e.key === "c" || e.key === "C") setCine(!S.cine);
  else if ((e.key === "1" || e.key === "2") && !e.shiftKey && document.getElementById("app").classList.contains("lab")) setTab(["brain", "training"][+e.key - 1]);
  else if (e.shiftKey && "!@#$".indexOf(e.key) >= 0) setView(["default", "top", "side", "front"]["!@#$".indexOf(e.key)]);
});
$("help").addEventListener("click", (e) => { if (e.target.id === "help") help(false); });
$("helpClose").addEventListener("click", () => help(false));
$("stageHint").addEventListener("click", () => help(true)); // a phone has no ? key
// a modal keeps the keyboard: Tab cycles inside the card instead of walking out behind it
$("help").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const f = [...$("help").querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* ------------------------------------------------------------------ tabs */
function setTab(name) {
  S.tab = name;
  S.designKey = "";        // the panel is about to be visible again: let it answer once
  const app = document.getElementById("app");
  if (name === "training") app.classList.add("lab"); // the strip appears with it, so BRAIN is one click away
  for (const t of ["brain", "training"]) app.classList.toggle("tab-" + t, t === name);
  for (const b of document.querySelectorAll("#tabs .tb")) {
    const on = b.dataset.t === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  }
  // the live session goes to the TOP of the tab: while one runs it is the thing you came to see
  if (name === "training") { const g = $("trainTab").querySelector(".tgrid"); g.insertBefore($("train"), g.firstChild); }
  else document.getElementById("app").appendChild($("train"));
}
for (const b of document.querySelectorAll("#tabs .tb")) b.addEventListener("click", () => setTab(b.dataset.t));
$("sessionBanner").addEventListener("click", () => setTab("training"));

/* ------------------------------------------------------------------ the session designer */
const VERS = new Versions(sbBase(SB_REF, SB_HOST), SB_ANON); // the same project + anon key as the room (config.js)
let mode = "FOOD";

function buildModes() {
  const host = $("modes");
  for (const m of MODES) {
    const b = document.createElement("button");
    b.className = "md" + (m.id === mode ? " on" : "");
    b.textContent = m.id;
    b.addEventListener("click", () => { mode = m.id; buildModes(); refreshDesigner(); });
    host.appendChild(b);
  }
  host.replaceChildren(...host.querySelectorAll(".md"));
}

function fillThings() {
  const have = S.invItems || [];
  for (const id of ["csPlus", "csMinus"]) {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = "";
    if (!have.length) {
      const o = document.createElement("option");
      o.textContent = "— nothing named yet —";
      o.value = "";
      sel.appendChild(o);
      continue;
    }
    for (const label of have) {
      const o = document.createElement("option");
      o.value = o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = keep && have.indexOf(keep) >= 0 ? keep : have[id === "csPlus" ? 0 : Math.min(1, have.length - 1)];
  }
}

function refreshDesigner() {
  const m = MODES.find((x) => x.id === mode) || MODES[0];
  setText($("modeWhy"), m.why);
  setText($("bouts"), "");
  if (!$("bouts").matches(":focus")) $("bouts").value = m.trials || 0;
  const lensOn = performance.now() - S.lensSeen < 6000;
  const why = !S.joined ? "join a room first — the PIN is on the glasses"
    : !lensOn ? "no lens in this room — check the PIN on the glasses"
    : !S.invItems || !S.invItems.length ? "the lens has not named anything yet — let it scan the room"
    : S.trainUnavailable ? "the lens says training is unavailable: " + S.trainUnavailable
    : "";
  setText($("designGate"), why);
  const blocked = !!why;
  $("trStart").disabled = blocked;
  $("trStop").disabled = blocked;
  $("trReset").disabled = !lensOn || !S.joined;
  setText($("designState"), blocked ? "NOT READY" : S.train && S.train.phase && S.train.phase !== "done" ? "RUNNING" : "READY");
}

const cmd = (obj) => { toRoom("cmd", Object.assign({ t: "cmd" }, obj)); log("sent " + obj.cmd); if (obj.cmd === "train") S.everTrained = true; };
$("trStart").onclick = () => cmd({ cmd: "train", mode: mode, cs: $("csPlus").value, csMinus: $("csMinus").value, bouts: +$("bouts").value || 6 });
$("trStop").onclick = () => cmd({ cmd: "train_stop" });
$("trReset").onclick = () => { if (confirm("Reset every plastic synapse to where it started? There is no undo.")) cmd({ cmd: "reset" }); };

/* ------------------------------------------------------------------ the verdict */
function drawVerdict() {
  const v = S.summary;
  if (!v) return;
  $("pVerdict").classList.remove("none");   // it has a verdict now: the idle copy steps aside
  const verdict = String(v.learned || v.verdict || "unclear").toLowerCase();
  const word = verdict === "yes" || verdict === "learned" ? "LEARNED"
    : verdict === "no" || verdict === "none" ? "NO CHANGE" : "UNCLEAR";
  const el = $("verdictWord");
  if (setText(el, word)) kick(el);
  el.className = word === "LEARNED" ? "" : word === "NO CHANGE" ? "no" : "unclear";
  setText($("verdictConf"), v.confidence ? "CONFIDENCE " + String(v.confidence).toUpperCase() : "");
  setText($("verdictWhat"), v.what || "");
  const ev = v.evidence && typeof v.evidence === "object" ? v.evidence : null;
  const host = $("verdictEvidence");
  const key = JSON.stringify(ev);
  if (key !== S.evKey) {
    S.evKey = key;
    host.innerHTML = "";
    if (ev) for (const k of Object.keys(ev)) {
      const i = document.createElement("i");
      i.innerHTML = k.replace(/_/g, " ") + " <b>" + ev[k] + "</b>";
      host.appendChild(i);
    }
  }
  setText($("verdictText"), v.text || v.plain || "");
  setText($("verdictCaveats"), v.caveats ? "CAVEATS \u00b7 " + v.caveats : "");
  setText($("verdictNext"), v.next ? "NEXT \u00b7 " + v.next : "");
}

/* ------------------------------------------------------------------ versions */
async function refreshVersions() {
  const help = $("verHelp");
  // no backend configured: the panel is not there at all. How to configure one is in web/DEPLOY.md,
  // and a visitor is never handed a build command.
  $("pVersions").classList.toggle("off", !VERS.on);
  if (!VERS.on) return;
  if (!VERS.key) { setText($("verState"), "WAITING FOR THE GLASSES"); return; }
  try {
    const rows = await VERS.list();
    setText($("verState"), rows.length + " SAVED");
    const host = $("verList");
    host.innerHTML = "";
    rows.forEach((r, i) => {
      const d = document.createElement("div");
      d.className = "ver";
      d.innerHTML = "<b>" + (r.name || "unnamed") + "</b><span>" + new Date(r.created_at).toLocaleString()
        + " \u00b7 " + ((r.bytes || 0) / 1024).toFixed(1) + " KB</span>";
      const load = document.createElement("button");
      load.textContent = "LOAD";
      load.onclick = () => loadVersion(r.id);
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "DELETE";
      del.onclick = async () => { if (confirm("Delete " + r.name + "?")) { await VERS.remove(r.id); refreshVersions(); } };
      d.append(load, del);
      host.appendChild(d);
    });
    setText($("verDiff"), rows.length > 1 ? Versions.diff(rows[1], rows[0]) : "");
    help.innerHTML = "";
  } catch (e) { setText($("verState"), "ERROR"); help.textContent = String(e.message || e); }
}

function askBlob(then) {
  S.blobThen = then;
  worker && worker.postMessage({ cmd: "post", json: JSON.stringify({ memory: "get", compact: true }) });
}
$("verSave").onclick = () => askBlob(async (b64, meta) => {
  const name = $("verName").value.trim() || new Date().toLocaleString();
  if (!VERS.on) return log("no supabase: use DOWNLOAD");
  try { await VERS.save(name, b64, meta); $("verName").value = ""; refreshVersions(); }
  catch (e) { log("save failed: " + e.message); }
});
$("verFile").onclick = () => askBlob((b64) => {
  const a = document.createElement("a");
  a.href = "data:application/octet-stream;base64," + b64;
  a.download = (($("verName").value.trim() || "fly-brain") + ".flymem").replace(/\s+/g, "-");
  a.click();
});
$("verUp").onchange = (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => applyBlob(String(rd.result).split(",")[1], f.name);
  rd.readAsDataURL(f);
};
async function loadVersion(id) {
  try { const r = await VERS.load(id); applyBlob(r.blob, r.name); } catch (e) { log("load failed: " + e.message); }
}
/** set it here AND on the lens, so the canonical copy never drifts from what you are looking at */
function applyBlob(b64, name) {
  if (!b64) return;
  worker && worker.postMessage({ cmd: "post", json: JSON.stringify({ memory: "set", data: b64 }) });
  cmd({ cmd: "memory_set", data: b64 });
  log("loaded version " + (name || ""));
}

/* ------------------------------------------------------------------ the ENGINE chip is a control
 * The brain draws on a detail ladder (gfx/brain.js): ULTRA / HIGH / MEDIUM / LOW are prefixes over
 * the same GPU buffers, and AUTO walks them to hold the frame. The chip already says which engine
 * is running; it now also says which rung and what that rung costs, and clicking it pins one.
 * It changes what is DRAWN, never what is computed — so it is chrome, not a brain control. */
const DETAIL_LEVELS = ["auto", "ultra", "high", "medium", "low"];
let detailStats = null, detailMenuOn = false;

function buildDetailMenu() {
  const host = $("detailMenu");
  host.innerHTML = "";
  const cur = (detailStats && detailStats.auto) ? "auto" : (detailStats ? detailStats.level.toLowerCase() : "");
  for (const k of DETAIL_LEVELS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dm" + (k === cur ? " on" : "");
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", k === cur ? "true" : "false");
    b.textContent = k.toUpperCase();
    if (k === "auto" && detailStats && detailStats.auto) b.textContent = "AUTO \u00b7 " + detailStats.level;
    b.addEventListener("click", () => {
      const br = window.brain;
      if (br) { if (k === "auto") br.detailAuto(); else br.setDetail(k); }
      detailMenu(false);
    });
    host.appendChild(b);
  }
}
function detailMenu(on) {
  const want = on === undefined ? !detailMenuOn : !!on;
  if (want === detailMenuOn) return;
  detailMenuOn = want;
  if (want) {
    buildDetailMenu();
    const r = $("chipEngine").getBoundingClientRect();
    setStyle($("detailMenu"), "left", Math.round(r.left) + "px");
    setStyle($("detailMenu"), "top", Math.round(r.bottom + 4) + "px");
  }
  $("detailMenu").classList.toggle("on", want);
  $("chipEngine").setAttribute("aria-expanded", want ? "true" : "false");
}
function perfMenu(on) {
  const el = $("perfMenu");
  const want = on === undefined ? !el.classList.contains("on") : !!on;
  if (want) {
    el.innerHTML = PERF_MODES.map((m) =>
      '<button role="menuitemradio" data-p="' + m.id + '" aria-checked="' + (m.id === perfMode.id) +
      '"' + (m.id === perfMode.id ? ' class="on"' : "") + "><b>" + m.label + "</b><span>" + m.note + "</span></button>").join("");
    for (const b of el.querySelectorAll("button")) b.addEventListener("click", () => { setPerf(b.dataset.p); perfMenu(false); });
    const r = $("chipPerf").getBoundingClientRect();
    setStyle(el, "left", Math.round(r.left) + "px");
    setStyle(el, "top", Math.round(r.bottom + 4) + "px");
  }
  el.classList.toggle("on", want);
  $("chipPerf").setAttribute("aria-expanded", want ? "true" : "false");
}
/* ADVANCED (21.09): the tuning knobs — DETAIL, PRIORITY, ROOM MESH, THINK TIME, fps — are hidden
 * behind one chip. A stranger's header says what this is and that it is alive; the knobs are for
 * whoever wants them, and the choice is remembered. */
function setAdv(on) {
  const app = document.getElementById("app");
  app.classList.toggle("adv", !!on);
  $("chipAdv").setAttribute("aria-pressed", on ? "true" : "false");
  localStorage.setItem("adv", on ? "1" : "0");
  if (!on) { detailMenu(false); perfMenu(false); meshMenu(false); }
}
$("chipAdv").addEventListener("click", (e) => { e.stopPropagation(); setAdv(!document.getElementById("app").classList.contains("adv")); });
setAdv(params.get("adv") === "1" || localStorage.getItem("adv") === "1");
$("chipPerf").addEventListener("click", (e) => { e.stopPropagation(); perfMenu(); });
if ($("chipFast")) $("chipFast").addEventListener("click", (e) => { e.stopPropagation(); toggleFast(); });
document.addEventListener("click", () => perfMenu(false));
$("perfMenu").addEventListener("click", (e) => e.stopPropagation());
setPerf(perfMode.id, false);   // apply the start mode without remembering it (the warm-up owns the choice)
if (AUTO_WARM) {
  document.body.classList.add("warming");
  if (pausedEl) pausedEl.innerHTML = "<b>WAKING THE BRAIN…</b><span>loading the connectome onto the graphics card</span><span>the picture switches on in a moment</span>";
}
$("chipEngine").addEventListener("click", (e) => { e.stopPropagation(); detailMenu(); });
document.addEventListener("click", () => detailMenu(false));
$("detailMenu").addEventListener("click", (e) => e.stopPropagation());

/* ------------------------------------------------------------------ the MESH chip is a control
 * HOW HEAVY THE ROOM IS DRAWN (21.09). The page has drawn the lens's world mesh exactly one way
 * since ADR 61: the lit surface, plus its wireframe at 4.5 % — the honest picture, and the most
 * expensive thing on this panel (10,000 transparent back faces under a per-frame depth cutaway,
 * plus ~15,000 line segments). It is also the one instrument nobody is reading while they watch the
 * brain, so it is the first thing that should be allowed to get out of the way. The ladder is the
 * SAME geometry every rung down: WIRE is that wireframe buffer with the surface off, POINTS is the
 * scan's own merged vertices (`g`, which setSurface used to throw away), OFF leaves the frame — the
 * scanned box and the floor grid — and the flies in it.
 *
 * Like DRAW, it changes only what is DRAWN. gfx/room.js forces the solid room back for the fly's
 * own eye shot, because in ?demo=1 that shot is what the brain is injected with; a view control that
 * could blind the fly would not be a view control. And there is no mode that invents geometry: with
 * no mesh from the glasses the chip is not on the header at all, and the SCENE panel's status line
 * is the one that explains why. */
const ROOM_MODES = [
  { id: "solid", label: "SOLID", note: "lit facets, and the scan’s own colour where it painted" },
  { id: "wire", label: "WIRE", note: "the same triangles as lines only — the light room" },
  { id: "points", label: "POINTS", note: "the scan’s bare vertices, nothing else" },
  { id: "off", label: "OFF", note: "no mesh; the room box and the floor grid stay" },
];
let roomMode = ROOM_MODES.find((m) => m.id === (params.get("mesh") || localStorage.getItem("mesh"))) || ROOM_MODES[0];

function setRoomMode(id) {
  const m = ROOM_MODES.find((x) => x.id === id);
  if (!m) return;
  roomMode = m;
  localStorage.setItem("mesh", m.id);
  setText($("chipMesh").querySelector("i"), m.label);
  roomView && roomView.setMode(m.id);
}
function meshMenu(on) {
  const el = $("meshMenu");
  const want = on === undefined ? !el.classList.contains("on") : !!on;
  if (want) {
    el.innerHTML = ROOM_MODES.map((m) =>
      '<button role="menuitemradio" data-m="' + m.id + '" aria-checked="' + (m.id === roomMode.id) +
      '"' + (m.id === roomMode.id ? ' class="on"' : "") + "><b>" + m.label + "</b><span>" + m.note + "</span></button>").join("");
    for (const b of el.querySelectorAll("button")) b.addEventListener("click", () => { setRoomMode(b.dataset.m); meshMenu(false); });
    const r = $("chipMesh").getBoundingClientRect();
    // this chip sits further right than the other two and this menu carries the longest notes on
    // the page: seated at the chip's own left edge it would hang off the window at 1280
    setStyle(el, "left", Math.round(Math.max(4, Math.min(r.left, window.innerWidth - el.offsetWidth - 6))) + "px");
    setStyle(el, "top", Math.round(r.bottom + 4) + "px");
  }
  el.classList.toggle("on", want);
  $("chipMesh").setAttribute("aria-expanded", want ? "true" : "false");
}
$("chipMesh").addEventListener("click", (e) => { e.stopPropagation(); meshMenu(); });
document.addEventListener("click", () => meshMenu(false));
$("meshMenu").addEventListener("click", (e) => e.stopPropagation());
setRoomMode(roomMode.id);

function setView(name) {
  brainView && brainView.view(name);
  for (const b of document.querySelectorAll("#views .vw")) b.classList.toggle("on", b.dataset.v === name);
}
function setCine(on) {
  S.cine = !!on;
  brainView && brainView.cinematic(S.cine);
  const b = $("cine");
  b.classList.toggle("on", S.cine);
  b.setAttribute("aria-pressed", S.cine ? "true" : "false");
  document.getElementById("app").classList.toggle("cine", S.cine);
}
for (const b of document.querySelectorAll("#views .vw")) b.addEventListener("click", () => setView(b.dataset.v));
$("cine").addEventListener("click", () => setCine(!S.cine));

if (!SMALL) boot();
// ?demo=1 — no glasses, no relay: a lens made of JavaScript feeds the page the same packets a real
// one would, and the REAL brain decides what to do about them (gfx/demo.js says so on screen)
if (DEMO) {
  import("./gfx/demo.js").then((m) => m.startDemo({
    state: S,
    onLens,
    open: openDashboard,
    brain: () => { if (!worker) startBrain(!!navigator.gpu && params.get("gpu") !== "0"); },
    // the two things the demo's eyes need: the room to look at, and the 1,767 real viewing
    // directions to look through. Both arrive during boot(), so they are asked for, not held.
    room: () => roomView,
    lattice: () => (eyesView && eyesView.cols ? eyesView.cols : null),
  })).catch((e) => log("demo: " + e.message));
}
if (params.get("tab")) setTimeout(() => setTab(params.get("tab")), 700);
if (params.get("view")) setTimeout(() => setView(params.get("view")), 900);
if (params.get("cine") === "1") setTimeout(() => setCine(true), 900);
if (params.get("chain")) setTimeout(() => { chainPinned = true; showChain(+params.get("chain")); }, 2500);
if (params.get("help") === "1") help(true); // for the record: the same card the "?" key opens
if (params.get("open") === "1") openDashboard(); // visual tests: the dashboard without a relay
// ?pin=1234&auto=1 (&relay=... &gpu=0): connect without a click — tests, kiosks
if (params.get("auto") === "1") setTimeout(() => $("go").click(), 350);

/* ------------------------------------------------------------------ the legend
   Hover any instrument and it says what it measures. The NEURAL rows already did this — hovering
   one isolates its population in the brain and the SIGNAL PATH panel explains it — but every other
   number on the page had no explanation anywhere. The wiring is DELEGATED rather than attached per
   element, because the eye bars are built by EyesView only once a brain is running, and the stat
   rows outlive several rebuilds; a delegated listener needs no re-attaching and cannot go stale. */
const LEGEND = {
  // BODY — the fly's own state, simulated from what the descending neurons ask for
  action: "what the body is doing right now. The descending neurons choose it: cruise, turn, land, groom, escape.",
  state: "where the fly is: in the air, landed on a surface, or in the middle of an escape.",
  speed: "how fast it is moving through the room, in centimetres a second.",
  energy: "what it has left to fly on. It drains in the air and refills while the fly feeds.",
  "wing drive": "how hard the wings are being driven, 0 to 1. The body model turns descending spikes into this number.",
  "fly time": "how much of the fly's life has been lived since this brain woke up. One brain step is 50 ms of it.",
  // MEMORY — the only part of the brain that changes and lasts
  size: "the memory written to storage: the 7,835 synapses in the fly's memory centre that move as it lives.",
  "last save": "when this fly's memory was last written down.",
  "synapses changed": "how many of those memory synapses have moved away from where they started.",
  "average strength": "the average strength of the memory synapses (their efficacy). It starts at 1.0000; ten minutes of living in a room, with nobody teaching, took one fly to 0.9599.",
  // LINK — the traffic between this page and the glasses
  "decisions sent": "messages this page has sent to the glasses: the decisions the brain made.",
  "senses received": "messages the glasses have sent here: what the fly sees and smells, and the room.",
  "spikes / step": "how many spikes the whole brain fired in the last 50 ms of fly time. One neuron can fire many of them.",
  "room packet": "how many bytes the last room update from the glasses took.",
  // EYES — the five visual channels, keyed by the plain word shown on the bar (gfx/eyes.js); the
  // real optic-lobe cell code opens each line, as small print. Keys must match the bar text exactly.
  LOOMING: "LC4 — looming. It answers to something growing fast in the eye — the signal an escape starts from.",
  "LOOMING · HEAD-ON": "LPLC2 — looming as well, but tuned to an object coming straight at the fly rather than past it.",
  "SMALL MOVER": "LC11 — small moving objects. Another fly across the room looks like this.",
  "MOTION · BRIGHT": "T4 — local motion along BRIGHT edges. One half of how the fly sees the world flow past.",
  "MOTION · DARK": "T5 — local motion along DARK edges. The other half of it.",
};
(() => {
  const box = $("legend"), nameEl = $("legendName"), whyEl = $("legendWhy");
  let shownFor = null;

  /** the instrument under the pointer, and the word for it */
  function resolve(target) {
    const st = target.closest && target.closest(".st, .dbar");
    if (!st) return null;
    const labelEl = st.querySelector(".k, .n");
    if (!labelEl) return null;
    const raw = labelEl.textContent.trim();
    const why = LEGEND[raw] || LEGEND[raw.toLowerCase()];
    return why ? { el: st, name: raw, why } : null;
  }

  function show(hit) {
    if (shownFor === hit.el) return;
    shownFor = hit.el;
    hit.el.setAttribute("data-legend", "1"); // the cursor and the hover tint, only where there IS one
    if (!hit.el.hasAttribute("tabindex")) hit.el.tabIndex = 0;
    setText(nameEl, hit.name.toUpperCase());
    setText(whyEl, hit.why);
    box.classList.add("on");
    box.setAttribute("aria-hidden", "false");
    // place it under the instrument, and flip it up or pull it in rather than let it leave the window
    const r = hit.el.getBoundingClientRect();
    box.style.left = "0px"; box.style.top = "0px"; // measure unclamped
    const b = box.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - b.width - 8, Math.round(r.left)));
    const below = r.bottom + 6;
    const top = below + b.height > window.innerHeight - 8 ? Math.max(8, Math.round(r.top - b.height - 6)) : Math.round(below);
    box.style.left = left + "px";
    box.style.top = top + "px";
  }

  function hide() {
    if (!shownFor) return;
    shownFor = null;
    box.classList.remove("on");
    box.setAttribute("aria-hidden", "true");
  }

  document.addEventListener("pointerover", (e) => { const hit = resolve(e.target); hit ? show(hit) : hide(); });
  document.addEventListener("pointerleave", hide, true);
  document.addEventListener("focusin", (e) => { const hit = resolve(e.target); hit ? show(hit) : hide(); });
  document.addEventListener("focusout", hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  // a scroll moves the instrument out from under its own legend
  for (const id of ["left", "right"]) { const el = $(id); if (el) el.addEventListener("scroll", hide, { passive: true }); }
})();
