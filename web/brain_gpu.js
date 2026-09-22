// WebGPU host for brain.wgsl, as an Emscripten JS library (ADR 55): the C++ backend webbrain.cpp
// calls wgpu_create / wgpu_run / wgpu_upload_all / wgpu_fetch_all / wgpu_weight; the state lives in
// the WASM heap (host copies) and in GPU buffers (the truth while the brain runs on the GPU).
//
// Buffer families (see brain.wgsl): params (uniform) | consts = ptr | nc | tab | e0..e1 (edge slices of
// 2^24) | cells | io | W (work arena) | ACC (this tick's integer units per target) | QS = queue | qcount | scr | ctr.
// Per chunk: io up (drive), dispatches, ctr + io down (nactive, counts). Everything else moves only at
// upload_all / fetch_all. Asyncify makes the C++ side wait for the readbacks.
const FlyGpuLib = {
  $FlyGpu: {
    dev: null, adapter: null, q: null, pipes: {}, bind: null, bufs: {}, heap: null, info: "",
    n: 0, E: 0, slots: 0, TA: 0, NP: 0, CS: 0, MAXT: 1024, ga1: 64, ga2: 128, gb1: 64, TAB_BLOCKS: 5,
    off: {}, ptrs: {}, sizes: {}, params: null, dirtyEdges: new Set(), staging: {}, LOCALSORT: 1024, TG: 256,
    shaderSrc: null, timing: { up: 0, gpu: 0, down: 0, runs: 0 },
    runChunk: 8, // 22.09 Pavlo: drain the GPU every N steps inside run() so a long warm-up never freezes macOS (0 = off)

    err(msg) {
      FlyGpu.info = String(msg);
      if (FlyGpu.infoPtr) FlyGpu.writeInfo(msg);
      console.error("[FlyGpu]", msg);
    },
    writeInfo(text) {
      const bytes = new TextEncoder().encode(String(text).substring(0, FlyGpu.infoCap - 1));
      HEAPU8.set(bytes, FlyGpu.infoPtr);
      HEAPU8[FlyGpu.infoPtr + bytes.length] = 0;
    },
    heapView(ptr, bytes) { return new Uint8Array(HEAPU8.buffer, ptr, bytes); },

    async init() {
      if (!navigator.gpu) throw new Error("no WebGPU in this browser");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("no WebGPU adapter");
      const L = adapter.limits;
      const want = {
        maxStorageBuffersPerShaderStage: Math.min(8, L.maxStorageBuffersPerShaderStage),
        maxStorageBufferBindingSize: Math.min(L.maxStorageBufferBindingSize, 1 << 30),
        maxBufferSize: Math.min(L.maxBufferSize, 1 << 30),
        maxComputeWorkgroupStorageSize: Math.min(L.maxComputeWorkgroupStorageSize, 16384),
      };
      // 22.09: the kernel now binds 8 storage buffers (was 10). Metal gives 10+, but Chrome/Edge on
      // Windows/D3D12 caps a stage at 8, so the old build only ran on the Mac. Two 128 MB edge buffers.
      if (L.maxStorageBuffersPerShaderStage < 8) throw new Error("adapter allows only " + L.maxStorageBuffersPerShaderStage + " storage buffers per stage (need 8)");
      if (L.maxStorageBufferBindingSize < (1 << 27)) throw new Error("storage binding too small: " + L.maxStorageBufferBindingSize + " (need 128 MB)");
      const dev = await adapter.requestDevice({ requiredLimits: want });
      dev.lost.then((i) => FlyGpu.err("device lost: " + i.message));
      FlyGpu.adapter = adapter;
      FlyGpu.dev = dev;
      FlyGpu.q = dev.queue;
      let name = "WebGPU";
      try {
        const ai = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
        if (ai) name = [ai.vendor, ai.architecture, ai.device, ai.description].filter((x) => x).join(" ") || name;
      } catch (e) { /* older browsers */ }
      FlyGpu.info = name;
      if (!FlyGpu.shaderSrc) {
        const r = await fetch("dist/brain.wgsl"); // relative to the worker (web/), the build lives in dist/
        FlyGpu.shaderSrc = await r.text();
      }
      const mod = dev.createShaderModule({ code: FlyGpu.shaderSrc });
      const ci = await mod.getCompilationInfo();
      for (const m of ci.messages) if (m.type === "error") throw new Error("WGSL " + m.lineNum + ":" + m.linePos + " " + m.message);
      const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }];
      for (let b = 1; b <= 8; b++) entries.push({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: b <= 3 ? "read-only-storage" : "storage" } });
      const bgl = dev.createBindGroupLayout({ entries });
      const layout = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
      for (const k of ["k_begin", "k_tickA", "k_tickB", "k_end", "k_blksort", "k_rank"]) {
        FlyGpu.pipes[k] = await dev.createComputePipelineAsync({ layout, compute: { module: mod, entryPoint: k } });
      }
      FlyGpu.bgl = bgl;
    },

    mk(name, bytes, usage) {
      const size = Math.max(256, (bytes + 255) & ~255);
      const b = FlyGpu.dev.createBuffer({ size, usage });
      FlyGpu.bufs[name] = b;
      FlyGpu.sizes[name] = size;
      return b;
    },
    up(name, ptr, bytes, dstOff = 0, srcOff = 0) {
      // writeBuffer copies at call time, so a view into the (growable) heap is fine
      FlyGpu.q.writeBuffer(FlyGpu.bufs[name], dstOff, HEAPU8.buffer, ptr + srcOff, bytes);
    },
    async down(name, ptr, bytes) {
      const st = FlyGpu.staging[name] || (FlyGpu.staging[name] = FlyGpu.dev.createBuffer({ size: FlyGpu.sizes[name], usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
      const enc = FlyGpu.dev.createCommandEncoder();
      enc.copyBufferToBuffer(FlyGpu.bufs[name], 0, st, 0, (bytes + 255) & ~255);
      FlyGpu.q.submit([enc.finish()]);
      await st.mapAsync(GPUMapMode.READ, 0, (bytes + 255) & ~255);
      HEAPU8.set(new Uint8Array(st.getMappedRange(0, bytes)), ptr);
      st.unmap();
    },

    async create(n, E, ptr32, edges, nc, tab, TA, slots, delay, rfc, adapt_jump, tau, w_unit, acc, cells, io, queue, active) {
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
      const g = FlyGpu;
      g.n = n; g.E = E; g.slots = slots; g.TA = TA;
      g.NP = 1; while (g.NP < n) g.NP <<= 1;
      g.CS = 5 * (g.MAXT + 1) + 8;
      g.ptrs = { cells, io, queue, active, edges };
      const un = n >>> 0;
      g.off = {
        key: 0, act: 2 * un, active: 4 * un, spkey: 5 * un, spid: 7 * un, prefix: 8 * un, head: 9 * un + 1, touched: 10 * un + 1,
        ctr: 11 * un + 1, wcount: 11 * un + 1 + g.CS,
        nc: n + 1, tab: n + 1 + 4 * n, constsCount: n + 1 + 4 * n + FlyGpu.TAB_BLOCKS * TA,
        qcount: slots * n, scr: slots * n + slots, qsCount: slots * n + slots + 3 * g.NP, // scr = sortk 2NP | sortid NP
      };
      g.mk("params", 36 * 4, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      g.mk("consts", 4 * g.off.constsCount, S);
      g.up("consts", ptr32, 4 * (n + 1), 0);
      g.up("consts", nc, 16 * n, 4 * g.off.nc);
      g.up("consts", tab, 4 * g.TAB_BLOCKS * TA, 4 * g.off.tab);
      const EPART = 1 << 24;   // 22.09: 16M edges (128 MB) per buffer, TWO buffers -> 8 storage bindings, fits Windows/D3D12
      for (let s = 0; s < 2; s++) {
        const s0 = s * EPART, cnt = Math.max(1, Math.min(EPART, E - s0));
        g.mk("e" + s, 8 * cnt, S);
        if (s0 < E) g.up("e" + s, edges, 8 * cnt, 0, 8 * s0);
      }
      g.mk("cells", 32 * n, S);
      g.mk("io", 16 * n, S);
      g.mk("W", 4 * g.off.wcount + 512, S); // + the 256-byte rounding of the counter readback at its end
      g.mk("ACC", 4 * n, S);  // ADR 82: n ints, was a 64 MB record buffer
      g.mk("QS", 4 * g.off.qsCount, S);
      // empty target lists: head = 0xFFFFFFFF
      const heads = new Uint32Array(n).fill(0xFFFFFFFF);
      g.q.writeBuffer(g.bufs.W, 4 * g.off.head, heads.buffer);
      const names = ["params", "consts", "e0", "e1", "cells", "io", "W", "ACC", "QS"];
      g.bind = g.dev.createBindGroup({ layout: g.bgl, entries: names.map((nm, i) => ({ binding: i, resource: { buffer: g.bufs[nm] } })) });
      g.params = new Int32Array(36);
      const P = g.params, F = new Float32Array(P.buffer), U = new Uint32Array(P.buffer);
      P[0] = n; P[1] = slots; P[2] = delay; P[3] = rfc; P[4] = TA; P[5] = g.NP; P[6] = g.CS; P[7] = g.MAXT;
      P[8] = g.ga1; P[9] = g.ga2; P[10] = g.gb1; P[11] = (g.NP / g.LOCALSORT) | 0;
      U[13] = g.off.ctr; F[14] = w_unit; U[15] = acc >>> 0;  // acc: 0 = plain evolve, 1 = fma (DETERMINISM.md)
      F[16] = adapt_jump; F[17] = tau; F[18] = tau - 20; F[19] = 1 / (tau - 20);
      U[20] = g.off.key; U[21] = g.off.act; U[22] = g.off.active; U[23] = g.off.spkey; U[24] = g.off.spid; U[25] = g.off.prefix; U[26] = g.off.head; U[27] = g.off.touched;
      U[32] = g.off.nc; U[33] = g.off.tab; U[34] = g.off.qcount; U[35] = g.off.scr;
      g.uploadAll();
    },

    uploadAll() {
      const g = FlyGpu, n = g.n;
      g.up("cells", g.ptrs.cells, 32 * n);
      g.up("io", g.ptrs.io, 16 * n);
      g.up("QS", g.ptrs.queue, 4 * (g.slots * n + g.slots));
      g.up("W", g.ptrs.active, 4 * n, 4 * g.off.active);
    },
    async fetchAll() {
      const g = FlyGpu, n = g.n;
      await g.down("cells", g.ptrs.cells, 32 * n);
      await g.down("io", g.ptrs.io, 16 * n);
      await g.downRange("QS", g.ptrs.queue, 0, 4 * (g.slots * n + g.slots));
      await g.downRange("W", g.ptrs.active, 4 * g.off.active, 4 * n);
    },
    async downRange(name, ptr, srcOff, bytes) {
      const key = name + ":r";
      const sz = (bytes + 255) & ~255;
      const st = FlyGpu.staging[key] && FlyGpu.staging[key].size >= sz ? FlyGpu.staging[key] : (FlyGpu.staging[key] = FlyGpu.dev.createBuffer({ size: sz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
      const enc = FlyGpu.dev.createCommandEncoder();
      enc.copyBufferToBuffer(FlyGpu.bufs[name], srcOff, st, 0, sz);
      FlyGpu.q.submit([enc.finish()]);
      await st.mapAsync(GPUMapMode.READ, 0, sz);
      HEAPU8.set(new Uint8Array(st.getMappedRange(0, bytes)), ptr);
      st.unmap();
    },

    // The whole CSR, host copy -> e0..e1. flybrain.cpp::set_gpu fills edges() only AFTER create (one
    // source array at a time, so bringing the GPU up never holds two 200 MB copies at once). On
    // Vulkan edges() is mapped device memory, so those writes are already on the GPU; here it is a
    // vector in the WASM heap, so webbrain.cpp calls this once before the first run -- without it
    // the kernel runs on an all-zero CSR and nothing but the directly driven cells ever fires.
    uploadEdges() {
      const g = FlyGpu, EPART = 1 << 24;   // must match create()/flushEdges(): two 16M-edge buffers
      for (let s = 0; s < 2; s++) {
        const s0 = s * EPART;
        if (s0 >= g.E) break;
        g.up("e" + s, g.ptrs.edges, 8 * Math.min(EPART, g.E - s0), 0, 8 * s0);
      }
      g.dirtyEdges.clear();  // the fresh copy already carries every pending per-edge change
    },

    flushEdges() {
      const g = FlyGpu;
      if (!g.dirtyEdges.size) return;
      // learning touches ~8k scattered synapses per chunk: re-upload their 4 KB pages, once each
      const pages = new Set();
      for (const e of g.dirtyEdges) pages.add((e * 8) >> 12);
      g.dirtyEdges.clear();
      const EPART = 1 << 24;   // must match create()/uploadEdges(): two 16M-edge buffers
      for (const pg of pages) {
        const byte = pg << 12;
        const s = Math.floor(byte / (8 * EPART)), local = byte - s * 8 * EPART;
        const len = Math.min(4096, 8 * g.E - byte);
        g.up("e" + s, g.ptrs.edges, len, local, byte);
      }
    },

    async run(steps, slot0, nactive) {
      const g = FlyGpu, n = g.n;
      const t0 = performance.now();
      g.flushEdges();
      const P = g.params;
      P[28] = steps; P[29] = slot0; P[30] = nactive; P[31] = 0;
      const ctr = new Uint32Array(g.CS);
      ctr[0] = nactive;
      g.q.writeBuffer(g.bufs.W, 4 * g.off.ctr, ctr.buffer);
      g.up("io", g.ptrs.io, 16 * n);
      const nbt = Math.ceil(n / g.TG);
      // one command buffer, the tick index through a uniform update per dispatch pair (writeBuffer is
      // queued in order with the submits, so each pass sees its own t)
      const paramsPerT = [];
      for (let t = 0; t < steps; t++) { const c = new Int32Array(P); c[31] = t; paramsPerT.push(c); }
      const pass = (enc, pipe, groups) => {
        const cp = enc.beginComputePass();
        cp.setPipeline(g.pipes[pipe]);
        cp.setBindGroup(0, g.bind);
        cp.dispatchWorkgroups(groups);
        cp.end();
      };
      P[31] = 0;
      g.q.writeBuffer(g.bufs.params, 0, P.buffer);
      let enc = g.dev.createCommandEncoder();
      pass(enc, "k_begin", nbt + 1);
      g.q.submit([enc.finish()]);
      // 22.09 Pavlo: never queue a whole run at once. On macOS the window compositor shares this GPU,
      // so a large in-flight compute batch (e.g. the ~260-step warm-up submitted back to back) starves
      // the display and freezes the whole machine -- and the hung GPU work keeps freezing it even after
      // the tab is closed. Drain every FB_RUN_CHUNK steps so the GPU services the compositor between
      // batches. onSubmittedWorkDone waits for the work already queued, then we submit the next chunk.
      const CHUNK = FlyGpu.runChunk;
      for (let t = 0; t < steps; t++) {
        g.q.writeBuffer(g.bufs.params, 0, paramsPerT[t].buffer);
        enc = g.dev.createCommandEncoder();
        pass(enc, "k_tickA", g.ga1 + g.ga2);
        pass(enc, "k_tickB", g.gb1 + 1);
        g.q.submit([enc.finish()]);
        if (CHUNK > 0 && (t + 1) % CHUNK === 0 && t + 1 < steps) await g.q.onSubmittedWorkDone();
      }
      enc = g.dev.createCommandEncoder();
      pass(enc, "k_end", nbt);
      pass(enc, "k_blksort", (g.NP / g.LOCALSORT) | 0);
      pass(enc, "k_rank", (g.NP / g.TG) | 0);
      g.q.submit([enc.finish()]);
      const t1 = performance.now();
      // readback: counters (overflow + nactive) and io (counts)
      const csz = (4 * g.CS + 255) & ~255;
      const cst = g.staging.ctr || (g.staging.ctr = g.dev.createBuffer({ size: csz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
      enc = g.dev.createCommandEncoder();
      enc.copyBufferToBuffer(g.bufs.W, 4 * g.off.ctr, cst, 0, csz);
      g.q.submit([enc.finish()]);
      await g.down("io", g.ptrs.io, 16 * n);
      await cst.mapAsync(GPUMapMode.READ);
      const c = new Uint32Array(cst.getMappedRange().slice(0));
      cst.unmap();
      g.timing.gpu += t1 - t0; g.timing.down += performance.now() - t1; g.timing.runs++;
      if (c[5 * (g.MAXT + 1) + 1]) { g.err("delivery records overflowed in one tick"); return -1; }
      return c[5 * (g.MAXT + 1) + 2];
    },
  },

  wgpu_create__deps: ["$FlyGpu"],
  wgpu_create__async: true,
  wgpu_create: function (n, E, ptr32, edges, nc, tab, TA, slots, delay, rfc, adapt_jump, tau, w_unit, acc, cells, io, queue, active, info, infoCap) {
    return Asyncify.handleAsync(async () => {
      FlyGpu.infoPtr = info; FlyGpu.infoCap = infoCap;
      try {
        if (!FlyGpu.dev) await FlyGpu.init();
        await FlyGpu.create(n, E, ptr32, edges, nc, tab, TA, slots, delay, rfc, adapt_jump, tau, w_unit, acc, cells, io, queue, active);
        FlyGpu.writeInfo(FlyGpu.info);
        return 1;
      } catch (e) {
        FlyGpu.err(e && e.message ? e.message : String(e));
        return 0;
      }
    });
  },
  wgpu_run__deps: ["$FlyGpu"],
  wgpu_run__async: true,
  wgpu_run: function (steps, slot0, nactive) {
    return Asyncify.handleAsync(async () => {
      try { return await FlyGpu.run(steps, slot0, nactive); } catch (e) { FlyGpu.err(e && e.message ? e.message : String(e)); return -1; }
    });
  },
  wgpu_upload_all__deps: ["$FlyGpu"],
  wgpu_upload_all: function () { FlyGpu.uploadAll(); },
  wgpu_fetch_all__deps: ["$FlyGpu"],
  wgpu_fetch_all__async: true,
  wgpu_fetch_all: function () { return Asyncify.handleAsync(async () => { await FlyGpu.fetchAll(); }); },
  wgpu_units__deps: ["$FlyGpu"],
  wgpu_units: function (e) { FlyGpu.dirtyEdges.add(e); },
  wgpu_edges_all__deps: ["$FlyGpu"],
  wgpu_edges_all: function () { FlyGpu.uploadEdges(); },
  wgpu_acc__deps: ["$FlyGpu"],
  wgpu_acc: function (acc) {  // DETERMINISM.md: switch evolve between the plain and the fma form
    if (FlyGpu.params) new Uint32Array(FlyGpu.params.buffer)[15] = acc >>> 0;
  },
};
mergeInto(LibraryManager.library, FlyGpuLib);
