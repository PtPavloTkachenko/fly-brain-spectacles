// WebGPU port of the exact brain kernel: brain.comp (Vulkan GLSL) line for line, in WGSL.
// Six entry points in one module (k_begin, k_tickA, k_tickB, k_end, k_blksort, k_rank); the host is
// web/brain_gpu.js, driven by the same C++ core (webbrain.cpp) that drives the Vulkan backend.
// Differences forced by WebGPU, none of them touching the model:
//   * one storage buffer per family (10 bindings: Chrome on Metal allows 10 per stage):
//     consts = ptr | nc | tab, QS = queue | qcount | scr, the counters live at the end of W;
//     binding 9 is now the per-target integer accumulator (ADR 82), not the record buffer;
//   * the work arena W and the counters are atomic<u32> everywhere (WGSL binds one type per buffer),
//     non-contended reads use atomicLoad;
//   * LOCALSORT is 1024 (a 16 KB workgroup-memory default), so the final active list is sorted in
//     smaller blocks and ranked across more of them (same result);
//   * no `precise`: WGSL forbids reassociation but may fuse a*b+c, so evolve() may still differ from
//     the CPU in the last bit on a backend that fuses. The `plain` mode (P.acc == 0, the default,
//     DETERMINISM.md) removes every fma and both divisions from evolve, leaving only +, - and *,
//     which is as close to fusion-proof as WGSL allows; gpu_check reports what is left.

const TG: u32 = 256u;
const EMPTY: u32 = 0xFFFFFFFFu;
const ENDL: u32 = 0x7FFFFFFFu;
const LOCALSORT: u32 = 1024u;
const INT_MIN_: i32 = -2147483648;
const EPART_SHIFT: u32 = 23u;
const EPART: u32 = 1u << EPART_SHIFT;

struct Cell { last: i32, spk: i32, v: f32, g: f32, adapt: f32, rest: f32, drive: f32, pk: i32 }
struct Edge { post: i32, units: i32 }
struct IO { prev: f32, drive: f32, counts: i32, pad: i32 }

struct Params {
  n: i32, slots: i32, delay: i32, rfc: i32, TA: i32, NP: i32, CS: i32, MAXT: i32,
  ga1: i32, ga2: i32, gb1: i32, nblk: i32,
  upad: u32, o_ctr: u32, w_unit: f32, acc: u32,
  adapt_jump: f32, tau: f32, tau20: f32, inv_tau20: f32,
  o_key: u32, o_act: u32, o_active: u32, o_spkey: u32, o_spid: u32, o_prefix: u32, o_head: u32, o_touched: u32,
  steps: i32, slot0: i32, na0: i32, t: i32,
  o_nc: u32, o_tab: u32, o_qcount: u32, o_scr: u32,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> consts: array<u32>;
@group(0) @binding(2) var<storage, read> e0: array<Edge>;
@group(0) @binding(3) var<storage, read> e1: array<Edge>;
@group(0) @binding(4) var<storage, read> e2: array<Edge>;
@group(0) @binding(5) var<storage, read> e3: array<Edge>;
@group(0) @binding(6) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(7) var<storage, read_write> io: array<IO>;
@group(0) @binding(8) var<storage, read_write> W: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> ACC: array<atomic<i32>>;  // this tick's integer units per target
@group(0) @binding(10) var<storage, read_write> QS: array<i32>;

fn C_NA(t: i32) -> u32 { return u32(t); }
fn C_NSP(t: i32) -> u32 { return u32(P.MAXT + 1 + t); }
fn C_NT(t: i32) -> u32 { return u32(2 * (P.MAXT + 1) + t); }
fn C_R(t: i32) -> u32 { return u32(3 * (P.MAXT + 1) + t); }
fn C_SC(t: i32) -> u32 { return u32(4 * (P.MAXT + 1) + t); }
fn C_OVF() -> u32 { return u32(5 * (P.MAXT + 1) + 1); }

fn ptrAt(i: i32) -> u32 { return consts[u32(i)]; }
fn ncRest(i: i32) -> f32 { return bitcast<f32>(consts[P.o_nc + 4u * u32(i)]); }
fn ncKc(i: i32) -> u32 { return consts[P.o_nc + 4u * u32(i) + 1u]; }
fn ncOldof(i: i32) -> u32 { return consts[P.o_nc + 4u * u32(i) + 2u]; }
fn ncMod(i: i32) -> u32 { return consts[P.o_nc + 4u * u32(i) + 3u]; }
fn tab(k: u32) -> f32 { return bitcast<f32>(consts[P.o_tab + k]); }

fn edge(e: u32) -> Edge {
  let b = e >> EPART_SHIFT;
  let o = e & (EPART - 1u);
  if (b == 0u) { return e0[o]; }
  if (b == 1u) { return e1[o]; }
  if (b == 2u) { return e2[o]; }
  return e3[o];
}
fn deg(i: i32) -> u32 {
  if (ncMod(i) != 0u) { return 0u; }
  return ptrAt(i + 1) - ptrAt(i);
}

fn wld(k: u32) -> u32 { return atomicLoad(&W[k]); }
fn wst(k: u32, v: u32) { atomicStore(&W[k], v); }
fn keyAt(i: i32) -> vec2<u32> { return vec2<u32>(wld(P.o_key + 2u * u32(i)), wld(P.o_key + 2u * u32(i) + 1u)); }
fn keySet(i: i32, k: vec2<u32>) { wst(P.o_key + 2u * u32(i), k.x); wst(P.o_key + 2u * u32(i) + 1u, k.y); }
fn keyLess(a: vec2<u32>, b: vec2<u32>) -> bool { return a.x < b.x || (a.x == b.x && a.y < b.y); }
fn actIdx(parity: i32, k: u32) -> u32 { return P.o_act + u32(parity) * u32(P.n) + k; }
fn qAt(k: u32) -> i32 { return QS[k]; }
fn qcount(slot: i32) -> i32 { return QS[P.o_qcount + u32(slot)]; }
fn scrAt(k: u32) -> u32 { return bitcast<u32>(QS[P.o_scr + k]); }
fn scrSet(k: u32, v: u32) { QS[P.o_scr + k] = bitcast<i32>(v); }

struct L { last: i32, spk: i32, v: f32, g: f32, adapt: f32, rest: f32, drive: f32, refr: i32, flag: i32, kc: i32 }
fn unpack(c: Cell) -> L {
  var l: L;
  l.last = c.last; l.spk = c.spk; l.v = c.v; l.g = c.g; l.adapt = c.adapt; l.rest = c.rest; l.drive = c.drive;
  l.refr = c.pk & 0xFFFF; l.flag = (c.pk >> 16u) & 0xFF; l.kc = (c.pk >> 24u) & 0xFF;
  return l;
}
fn pack(l: L) -> Cell {
  var c: Cell;
  c.last = l.last; c.spk = l.spk; c.v = l.v; c.g = l.g; c.adapt = l.adapt; c.rest = l.rest; c.drive = l.drive;
  c.pk = (l.refr & 0xFFFF) | (l.flag << 16u) | (l.kc << 24u);
  return c;
}

// correctly rounded x / y for y = 3 and y = tau-20 (two fmas, tools/divcheck.cpp)
fn div3(x: f32) -> f32 {
  let q = x * 0.333333343267440796;
  let r = fma(-q, 3.0, x);
  return fma(r, 0.333333343267440796, q);
}
fn divTau20(x: f32) -> f32 {
  let q = x * P.inv_tau20;
  let r = fma(-q, P.tau20, x);
  return fma(r, P.inv_tau20, q);
}

fn evolve(c: ptr<function, L>, now: i32, cur: f32) {
  var d = now - (*c).last;
  if (d <= 0) { return; }
  var frozen = 0;
  if ((*c).refr > 0) { frozen = (*c).refr - 1; }
  var skip = frozen;
  if (d < frozen) { skip = d; }
  if (skip > 0 && (*c).adapt > 0.0) { (*c).adapt = (*c).adapt * tab(u32(2 * P.TA + min(skip, P.TA - 1))); }
  if (d >= (*c).refr) { (*c).refr = 0; } else { (*c).refr = (*c).refr - d; }
  d -= skip;
  if (d > 0) {
    let k = min(d, P.TA - 1);
    let a = tab(u32(k));
    let b = tab(u32(P.TA + k));
    if (P.acc == 0u) {  // plain: only +, - and *
      let t1 = (*c).rest + ((*c).v - (*c).rest) * a;
      let t2 = t1 + cur * (1.0 - a);
      (*c).v = t2 + (*c).g * tab(u32(3 * P.TA + k));
      (*c).g = (*c).g * b;
      if ((*c).adapt > 0.0) {
        (*c).v = (*c).v - (*c).adapt * tab(u32(4 * P.TA + k));
        (*c).adapt = (*c).adapt * tab(u32(2 * P.TA + k));
      }
    } else {  // fma: the pre-16.09 form
      let t1 = fma((*c).v - (*c).rest, a, (*c).rest);
      let t1b = fma(cur, 1.0 - a, t1);
      let gm = (*c).g * (a - b);
      let t2 = div3(gm);
      (*c).v = t1b + t2;
      (*c).g = (*c).g * b;
      if ((*c).adapt > 0.0) {
        let cc = tab(u32(2 * P.TA + k));
        let at = -((*c).adapt * P.tau);
        let x = divTau20(at);
        (*c).v = fma(x, cc - a, (*c).v);
        (*c).adapt = (*c).adapt * cc;
      }
    }
  }
  (*c).last = now;
}

var<workgroup> sums: array<u32, 256>;
var<workgroup> uni: u32;

// a counter read once per workgroup: WGSL's uniformity analysis needs loop bounds that gate barriers
// to be provably uniform, and a storage atomic read is not; a workgroup broadcast is
fn uniformCtr(k: u32, lid: u32) -> u32 {
  if (lid == 0u) { uni = atomicLoad(&W[P.o_ctr + k]); }
  workgroupBarrier();
  return workgroupUniformLoad(&uni);
}

// exclusive prefix of the out-degrees of the spikes queued in `slot` (queue order); total -> ctr[R]
fn prefix_tg(slot: i32, R: u32, lid: u32) {
  let n = P.n;
  let qb = u32(slot) * u32(n);
  let c = qcount(slot);
  let chunk = (c + i32(TG) - 1) / i32(TG);
  let s0 = i32(lid) * chunk;
  let s1 = min(c, s0 + chunk);
  var s = 0u;
  for (var k = s0; k < s1; k++) { s += deg(qAt(qb + u32(k))); }
  sums[lid] = s;
  workgroupBarrier();
  for (var off = 1u; off < TG; off <<= 1u) {
    var v = sums[lid];
    if (lid >= off) { v += sums[lid - off]; }
    workgroupBarrier();
    sums[lid] = v;
    workgroupBarrier();
  }
  var run = sums[lid] - s;
  if (lid == TG - 1u) { atomicStore(&W[P.o_ctr + R], sums[TG - 1u]); }
  for (var k = s0; k < s1; k++) { wst(P.o_prefix + u32(k), run); run += deg(qAt(qb + u32(k))); }
}

fn pow2ceil(x: u32) -> u32 { var p = 1u; while (p < x) { p <<= 1u; } return p; }

// ---- call start: keys of the carried-over list, drive-change wake-ups, prefix of the first slot ----
@compute @workgroup_size(256)
fn k_begin(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let lid = li.x;
  let per = (P.n + i32(TG) - 1) / i32(TG) + 1;
  let lt = i32(wg.x);
  let n = P.n;
  if (lt == per - 1) { prefix_tg(P.slot0, C_R(0), lid); return; }
  let i = lt * i32(TG) + i32(lid);
  if (i >= n) { return; }
  var c = unpack(cells[i]);
  c.spk = INT_MIN_;
  c.drive = io[i].drive;
  if (i < P.na0) {
    let j = i32(wld(P.o_active + u32(i)));
    keySet(j, vec2<u32>(0u, u32(i)));
    wst(actIdx(0, u32(i)), u32(j));
  }
  let pd = io[i].prev;
  var wake = false;
  if (c.drive != pd) {
    evolve(&c, -1, pd);
    io[i].prev = c.drive;
    if (c.flag == 0) { c.flag = 1; wake = true; keySet(i, vec2<u32>(1u, ncOldof(i))); }
  }
  if (wake) { let pos = atomicAdd(&W[P.o_ctr + C_NA(0)], 1u); wst(actIdx(0, pos), u32(i)); }
  cells[i] = pack(c);
}

// ---- tick part A: phase 1 (active neurons) + delivery records of this tick's slot ----
@compute @workgroup_size(256)
fn k_tickA(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let lid = li.x;
  let t = P.t;
  let lt = i32(wg.x);
  if (t >= P.steps) { return; }
  let n = P.n;
  if (lt < P.ga1) {
    let na = atomicLoad(&W[P.o_ctr + C_NA(t)]);
    let pin = t & 1;
    let pout = (t + 1) & 1;
    let stride = u32(P.ga1) * TG;
    for (var base = 0u; base < na; base += stride) {
      let k = base + u32(lt) * TG + lid;
      if (k >= na) { continue; }
      let i = i32(wld(actIdx(pin, k)));
      var c = unpack(cells[i]);
      if (c.spk == t - 1) { c.v = c.rest; c.g = 0.0; c.refr = P.rfc; }
      evolve(&c, t, c.drive);
      if (c.refr == 0 && c.v > -45.0) {
        let s = atomicAdd(&W[P.o_ctr + C_NSP(t)], 1u);
        let key = keyAt(i);
        wst(P.o_spkey + 2u * s, key.x); wst(P.o_spkey + 2u * s + 1u, key.y); wst(P.o_spid + s, u32(i));
        io[i].counts = io[i].counts + 1;
        c.spk = t;
        if (c.kc != 0) { c.adapt = c.adapt + P.adapt_jump; }
      }
      let gap = -45.0 - c.rest;
      let keep = c.v > -45.0 || c.drive > gap || c.drive + c.g > gap;
      if (!keep) { c.flag = 0; }
      cells[i] = pack(c);
      if (keep) { let p = atomicAdd(&W[P.o_ctr + C_NA(t + 1)], 1u); wst(actIdx(pout, p), u32(i)); }
    }
  } else {
    let slot = (P.slot0 + t) % P.slots;
    let c = qcount(slot);
    let R = atomicLoad(&W[P.o_ctr + C_R(t)]);
    let qb = u32(slot) * u32(n);
    let stride = u32(P.ga2) * TG;
    for (var base = 0u; base < R; base += stride) {
      let r = base + u32(lt - P.ga1) * TG + lid;
      if (r >= R) { continue; }
      var lo = 0;
      var hi = c - 1;
      while (lo < hi) { let mid = (lo + hi + 1) >> 1u; if (wld(P.o_prefix + u32(mid)) <= r) { lo = mid; } else { hi = mid - 1; } }
      let i = qAt(qb + u32(lo));
      let ed = edge(ptrAt(i) + (r - wld(P.o_prefix + u32(lo))));
      let j = ed.post;
      atomicAdd(&ACC[j], ed.units);                          // integer: order cannot change the sum
      let old = atomicMin(&W[P.o_head + u32(j)], r);          // smallest r = the CPU's first delivery
      if (old == EMPTY) { let p = atomicAdd(&W[P.o_ctr + C_NT(t)], 1u); wst(P.o_touched + p, u32(j)); }
    }
  }
}

// ---- tick part B: ordered delivery per target + sort this tick's spikes into the queue ----
@compute @workgroup_size(256)
fn k_tickB(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let lid = li.x;
  let t = P.t;
  let lt = i32(wg.x);
  if (t >= P.steps) { return; }
  let n = P.n;
  if (lt < P.gb1) {
    let nt = atomicLoad(&W[P.o_ctr + C_NT(t)]);
    let pout = (t + 1) & 1;
    let stride = u32(P.gb1) * TG;
    for (var base = 0u; base < nt; base += stride) {
      let u = base + u32(lt) * TG + lid;
      if (u >= nt) { continue; }
      let j = i32(wld(P.o_touched + u));
      let r = wld(P.o_head + u32(j));   // smallest delivery sequence that hit j this tick
      let a = atomicExchange(&ACC[j], 0);
      wst(P.o_head + u32(j), EMPTY);
      var c = unpack(cells[j]);
      evolve(&c, t, c.drive);
      var wake = false;
      if (c.refr == 0) {  // a refractory target drops the whole tick, exactly as the CPU does
        let add = f32(a) * P.w_unit;
        c.g = c.g + add;
        if (c.flag == 0) { c.flag = 1; wake = true; keySet(j, vec2<u32>(u32(2 + t), r)); }
      }
      cells[j] = pack(c);
      if (wake) { let p = atomicAdd(&W[P.o_ctr + C_NA(t + 1)], 1u); wst(actIdx(pout, p), u32(j)); }
    }
  } else {
    let ns = uniformCtr(C_NSP(t), lid);
    let fs = (P.slot0 + t + P.delay) % P.slots;
    let qf = u32(fs) * u32(n);
    if (ns <= LOCALSORT) {
      for (var x = lid; x < ns; x += TG) {
        let kx = vec2<u32>(wld(P.o_spkey + 2u * x), wld(P.o_spkey + 2u * x + 1u));
        var pos = 0u;
        for (var y = 0u; y < ns; y++) {
          let ky = vec2<u32>(wld(P.o_spkey + 2u * y), wld(P.o_spkey + 2u * y + 1u));
          if (keyLess(ky, kx)) { pos++; }
        }
        QS[qf + pos] = i32(wld(P.o_spid + x));
      }
    } else {
      let Pn = pow2ceil(ns);
      let NP = u32(P.NP);
      for (var x = lid; x < Pn; x += TG) {
        if (x < ns) {
          scrSet(2u * x, wld(P.o_spkey + 2u * x)); scrSet(2u * x + 1u, wld(P.o_spkey + 2u * x + 1u));
          scrSet(2u * NP + x, wld(P.o_spid + x));
        } else {
          scrSet(2u * x, 0xFFFFFFFFu); scrSet(2u * x + 1u, 0xFFFFFFFFu); scrSet(2u * NP + x, 0u);
        }
      }
      workgroupBarrier(); storageBarrier();
      for (var k = 2u; k <= Pn; k <<= 1u) {
        for (var j = k >> 1u; j > 0u; j >>= 1u) {
          for (var x = lid; x < Pn; x += TG) {
            let y = x ^ j;
            if (y > x) {
              let up = (x & k) == 0u;
              let a = vec2<u32>(scrAt(2u * x), scrAt(2u * x + 1u));
              let b = vec2<u32>(scrAt(2u * y), scrAt(2u * y + 1u));
              if (keyLess(b, a) == up) {
                scrSet(2u * x, b.x); scrSet(2u * x + 1u, b.y); scrSet(2u * y, a.x); scrSet(2u * y + 1u, a.y);
                let ti = scrAt(2u * NP + x); scrSet(2u * NP + x, scrAt(2u * NP + y)); scrSet(2u * NP + y, ti);
              }
            }
          }
          workgroupBarrier(); storageBarrier();
        }
      }
      for (var x = lid; x < ns; x += TG) { QS[qf + x] = i32(scrAt(2u * NP + x)); }
    }
    if (lid == 0u) {
      QS[P.o_qcount + u32(fs)] = i32(ns);
      QS[P.o_qcount + u32((P.slot0 + t) % P.slots)] = 0;
    }
    workgroupBarrier(); storageBarrier();
    if (t + 1 < P.steps) { prefix_tg((P.slot0 + t + 1) % P.slots, C_R(t + 1), lid); }
  }
}

// ---- call end: phase 3 of the last tick, boundary evolve, rebase the clock to the next call ----
@compute @workgroup_size(256)
fn k_end(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let i = i32(wg.x) * i32(TG) + i32(li.x);
  if (i >= P.n) { return; }
  let T = P.steps;
  var c = unpack(cells[i]);
  if (c.spk == T - 1) { c.v = c.rest; c.g = 0.0; c.refr = P.rfc; }
  evolve(&c, T - 1, c.drive);
  c.last -= T;
  c.spk = INT_MIN_;
  cells[i] = pack(c);
}

// ---- call end (2): sort the final active list's keys in blocks of LOCALSORT ----
var<workgroup> SK: array<vec2<u32>, 1024>;
var<workgroup> SI: array<i32, 1024>;

@compute @workgroup_size(256)
fn k_blksort(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let lid = li.x;
  let blk = wg.x;
  let T = P.steps;
  let na = uniformCtr(C_NA(T), lid);
  let s0 = blk * LOCALSORT;
  if (s0 >= na) { return; }
  let cnt = min(LOCALSORT, na - s0);
  let pin = T & 1;
  let Pn = pow2ceil(cnt);
  for (var x = lid; x < Pn; x += TG) {
    if (x < cnt) {
      let j = i32(wld(actIdx(pin, s0 + x)));
      SK[x] = keyAt(j);
      SI[x] = j;
    } else {
      SK[x] = vec2<u32>(0xFFFFFFFFu, 0xFFFFFFFFu);
      SI[x] = 0;
    }
  }
  workgroupBarrier();
  for (var k = 2u; k <= Pn; k <<= 1u) {
    for (var j = k >> 1u; j > 0u; j >>= 1u) {
      for (var x = lid; x < Pn; x += TG) {
        let y = x ^ j;
        if (y > x) {
          let up = (x & k) == 0u;
          let a = SK[x];
          let b = SK[y];
          if (keyLess(b, a) == up) { SK[x] = b; SK[y] = a; let ti = SI[x]; SI[x] = SI[y]; SI[y] = ti; }
        }
      }
      workgroupBarrier();
    }
  }
  let NP = u32(P.NP);
  for (var x = lid; x < cnt; x += TG) {
    scrSet(2u * (s0 + x), SK[x].x); scrSet(2u * (s0 + x) + 1u, SK[x].y);
    scrSet(2u * NP + s0 + x, u32(SI[x]));
  }
}

// ---- call end (3): merge the sorted blocks by rank -> active[] in the CPU's order ----
@compute @workgroup_size(256)
fn k_rank(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) li: vec3<u32>) {
  let k = wg.x * TG + li.x;
  let T = P.steps;
  let na = atomicLoad(&W[P.o_ctr + C_NA(T)]);
  if (k == 0u) { atomicStore(&W[P.o_ctr + C_OVF() + 1u], na); }
  if (k >= na) { return; }
  let NP = u32(P.NP);
  let key = vec2<u32>(scrAt(2u * k), scrAt(2u * k + 1u));
  let mb = k / LOCALSORT;
  var pos = k - mb * LOCALSORT;
  let nb = (na + LOCALSORT - 1u) / LOCALSORT;
  for (var bb = 0u; bb < nb; bb++) {
    if (bb == mb) { continue; }
    var lo = bb * LOCALSORT;
    var hi = min(na, lo + LOCALSORT);
    let start = lo;
    while (lo < hi) {
      let mid = (lo + hi) >> 1u;
      let km = vec2<u32>(scrAt(2u * mid), scrAt(2u * mid + 1u));
      if (keyLess(km, key)) { lo = mid + 1u; } else { hi = mid; }
    }
    pos += lo - start;
  }
  wst(P.o_active + pos, scrAt(2u * NP + k));
}
