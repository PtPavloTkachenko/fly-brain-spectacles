// The brain in a Web Worker (ADR 55): the WASM core (dist/flybrain.js) with the WebGPU backend,
// stepping as fast as it can; the page thread only relays. Messages:
//   in : {cmd:"init", brainUrl, gpu, threads} | {cmd:"post", json} | {cmd:"stop"}
//   out: {t:"status", text} | {t:"ready", msg} | {t:"brain", text} | {t:"memory", text}
//        | {t:"error", text} | {t:"stats", ...}
// The core has two output paths: `fb_step` returns the step message, and `fb_take` drains a small
// queue of messages that must not be dropped -- today the memory blobs of ADR 63.
importScripts("dist/flybrain.js");

let Module = null;
let brain = 0;
let running = false;
const inbox = [];
let steps = 0;
let spikeBuf = 0, spikeCap = 0, neurons = 0;
let stepMsSum = 0;
let takeBuf = 0, takeCap = 0;

/** drain the core's queued messages (memory blobs): they never come back from fb_step */
function drainQueue() {
  if (!takeBuf) { takeCap = 1 << 20; takeBuf = Module._malloc(takeCap); }
  for (;;) {
    let n = Module.ccall("fb_take", "number", ["number", "number", "number"], [brain, takeBuf, takeCap]);
    if (n > takeCap) { Module._free(takeBuf); takeCap = n + 4096; takeBuf = Module._malloc(takeCap); continue; }
    if (n <= 0) return;
    postMessage({ t: "memory", text: Module.UTF8ToString(takeBuf) });
  }
}

const status = (text) => postMessage({ t: "status", text });

async function loadBrainFile(url) {
  // cached across visits (75 MB): the Cache API keeps it next to the page
  let cache = null;
  try { cache = await caches.open("flybrain-v1"); } catch (e) { /* no Cache API (file://) */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) { status("brain file from cache"); return new Uint8Array(await hit.arrayBuffer()); }
  }
  status("downloading the brain (75 MB)...");
  const res = await fetch(url);
  if (!res.ok) throw new Error("brain download HTTP " + res.status);
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0, lastPc = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) { const pc = Math.floor((100 * got) / total / 5) * 5; if (pc !== lastPc) { lastPc = pc; status("downloading the brain " + pc + "%"); } }
  }
  const all = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  if (cache) { try { await cache.put(url, new Response(all)); } catch (e) { /* quota */ } }
  return all;
}

async function init(cfg) {
  status("loading the core");
  Module = await createFlyBrain({ locateFile: (p) => "dist/" + p }); // the worker lives one folder up from the build
  const data = await loadBrainFile(cfg.brainUrl);
  const ptr = Module._malloc(data.length);
  Module.HEAPU8.set(data, ptr);
  status("parsing the brain");
  brain = Module.ccall("fb_create", "number", ["number", "number", "number", "number"], [ptr, data.length, 50.0, 0]);
  Module._free(ptr);
  if (!brain) throw new Error("fb_create: " + Module.ccall("fb_last_error", "string", [], []));
  if (cfg.gpu) {
    status("bringing WebGPU up");
    Module.ccall("fb_post", null, ["number", "string"], [brain, JSON.stringify({ gpu: 1 })]);
  } else if (cfg.threads > 1) {
    Module.ccall("fb_set_threads", null, ["number", "number"], [brain, cfg.threads]);
  }
  // one scratch buffer for the per-step spike bitset, sized from the core's own neuron count
  const st = Module._malloc(32);
  Module.ccall("fb_stats", null, ["number", "number"], [brain, st]);
  neurons = Module.HEAPF64[st / 8] | 0;
  Module._free(st);
  spikeCap = Module.ccall("fb_spikes_all", "number", ["number", "number", "number"], [brain, 0, 0]);
  spikeBuf = spikeCap > 0 ? Module._malloc(spikeCap) : 0;
  status("warming up");
  const ready = await Module.ccall("fb_warmup", "string", ["number"], [brain], { async: true });
  const r = JSON.parse(ready);
  postMessage({ t: "ready", msg: r });
  status("thinking on " + (r.gpu && r.gpu !== "off" && !/^(no |vk|rc=|webgpu:)/.test(r.gpu) ? r.gpu : "CPU (wasm)"));
  running = true;
  loop();
}

async function loop() {
  while (running) {
    // settings and senses arrive between steps (the core is suspended inside a step while WebGPU works)
    while (inbox.length) Module.ccall("fb_post", null, ["number", "string"], [brain, inbox.shift()]);
    const t0 = performance.now();
    const text = await Module.ccall("fb_step", "string", ["number"], [brain], { async: true });
    stepMsSum += performance.now() - t0;
    steps++;
    drainQueue();
    postMessage({ t: "brain", text });
    // EVERY neuron's spike, straight off the core (ADR 61): 166,700 bits = 20.8 KB per step,
    // handed over as a transferable so nothing is copied and nothing touches the relay. The
    // 16,000-neuron `cloud` string in the message above is for the LENS and stays as it was.
    if (spikeBuf) {
      const nb = Module.ccall("fb_spikes_all", "number", ["number", "number", "number"], [brain, spikeBuf, spikeCap]);
      if (nb > 0 && nb <= spikeCap) {
        const bits = Module.HEAPU8.slice(spikeBuf, spikeBuf + nb); // a fresh buffer we can hand over
        postMessage({ t: "spikes", bits: bits.buffer, n: neurons }, [bits.buffer]);
      }
    }
    if (steps % 20 === 0) {
      postMessage({ t: "stats", steps, stepMs: stepMsSum / 20 });
      stepMsSum = 0;
    }
  }
}

onmessage = (e) => {
  const m = e.data;
  if (m.cmd === "init") init(m).catch((err) => postMessage({ t: "error", text: err && err.message ? err.message : String(err) }));
  else if (m.cmd === "post") inbox.push(m.json);
  else if (m.cmd === "stop") running = false;
};
