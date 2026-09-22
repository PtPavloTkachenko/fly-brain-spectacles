// GPU (Metal) port of memory_advance / fast_advance for several flies in one dispatch.
// Compiled at run time by metal_engine.mm (mathMode Safe, no contraction), see RESULTS.md.
//
// Exactness plan (same operations, same order per neuron as the CPU kernel):
//  * evolve(): the CPU statement compiles (clang -O3, fp-contract=on) to
//      v = ((fma(v-rest, a, rest) -> fma(current, 1-a, .)) + (g*(a-b))/3 ;  v = fma(-(adapt*tau)/(tau-20), cc-a, v)
//    written out explicitly here. Division is correctly rounded in Safe mode (checked
//    exhaustively for /3 and /180). Exp tables come from the CPU (same expressions).
//  * The CPU's only cross-neuron order is the active list (append order -> spike queue order
//    -> order of the g += w additions into a target). Each active entry carries a key
//    (epoch, seq) that reproduces that order: epoch 0 = carried over (seq = position),
//    1 = drive change at call start (seq = neuron index), 2+t = woken at tick t (seq = the
//    global delivery sequence number of the first waking delivery). Spikes of a tick are
//    sorted by key, so the queue is the CPU's queue.
//  * Deliveries: record r (= the CPU's delivery sequence number) is linked into its
//    target's list; one thread per target sorts its list by r and adds in that order.
//  * Only difference: the GPU flushes float denormals to zero (tiny g / adaptation /
//    modulation remainders become 0; they are absorbed in every expression).
#include <metal_stdlib>
#pragma METAL fp contract(off)
using namespace metal;

constant uint EMPTY = 0xFFFFFFFFu;
constant uint ENDL = 0x7FFFFFFFu;
constant uint MODBIT = 0x80000000u;
#define TG 256u
#define KMAX 16
#define LOCALSORT 2048u

struct Cell { int last; int spk; float v, g, adapt, rest, drive; short refr; uchar flag, kc; };
struct Edge { int post; float w; };
struct FlyCall { long clock0; int steps; int fly; };

struct Globals {
  device const uint* ptr; device const Edge* edges; device const uchar* modmask; device const uchar* kc;
  device const float* rest; device const float* av; device const float* ag; device const float* aa; device const float* mtab;
  device float* v; device float* g; device short* refr; device float* drive; device float* prev;
  device int* queue; device int* qcount; device int* counts; device int* active; device uchar* flags;
  device int* nactive; device long* last; device float* mod; device long* mlast; device float* adapt;
  device Cell* cells; device ulong* key; device int* act; device ulong* spkey; device int* spid;
  device uint* prefix; device atomic_uint* head; device int* touched; device uint* nxt; device float* recv;
  device int2* kclog; device ulong* sortk; device int* sortid; device atomic_uint* ctr;
  device const FlyCall* call; device uint* scr;
  int n, slots, delay, rfc, TA, TM, NP, kcap, CS, MAXT, ga1, ga2, gb1, nblk;
  uint E; float adapt_jump, tau, tau20;
  int scap, pad2;
};

// per-fly counters
#define C_NA(t) (uint(t))
#define C_NSP(t) (uint(G.MAXT) + 1u + uint(t))
#define C_NT(t) (2u * (uint(G.MAXT) + 1u) + uint(t))
#define C_R(t) (3u * (uint(G.MAXT) + 1u) + uint(t))
#define C_SC(t) (4u * (uint(G.MAXT) + 1u) + uint(t))
#define C_NKC (5u * (uint(G.MAXT) + 1u))
#define C_OVF (C_NKC + 1u)

inline uint ld(device atomic_uint* p) { return atomic_load_explicit(p, memory_order_relaxed); }

// SIMD-aggregated append: one atomic per simdgroup. Every active lane must call it.
inline uint agg_add(device atomic_uint* c, bool want) {
  uint w = want ? 1u : 0u;
  uint tot = simd_sum(w);
  uint pre = simd_prefix_exclusive_sum(w);
  uint base = 0;
  if (simd_is_first() && tot) base = atomic_fetch_add_explicit(c, tot, memory_order_relaxed);
  return simd_broadcast_first(base) + pre;
}

inline void evolve(thread Cell& c, int now, float cur, constant Globals& G) {
  int d = now - c.last;
  if (d <= 0) return;
  const int frozen = c.refr > 0 ? c.refr - 1 : 0;
  const int skip = d < frozen ? d : frozen;
  if (skip > 0 && c.adapt > 0) c.adapt = c.adapt * G.aa[min(skip, G.TA - 1)];
  c.refr = d >= c.refr ? 0 : short(c.refr - d);
  d -= skip;
  if (d > 0) {
    const int k = min(d, G.TA - 1);
    const float a = G.av[k], b = G.ag[k];
    float t1 = fma(c.v - c.rest, a, c.rest);
    t1 = fma(cur, 1.0f - a, t1);
    const float t2 = (c.g * (a - b)) / 3.0f;
    c.v = t1 + t2;
    c.g = c.g * b;
    if (c.adapt > 0) {
      const float cc = G.aa[k];
      const float x = (-(c.adapt * G.tau)) / G.tau20;
      c.v = fma(x, cc - a, c.v);
      c.adapt = c.adapt * cc;
    }
  }
  c.last = now;
}

// Exclusive prefix of out-degrees of the spikes queued in `slot` (queue order); total -> *R.
inline void prefix_tg(constant Globals& G, int f, int slot, device atomic_uint* R, uint lid, threadgroup uint* sums) {
  const int n = G.n;
  device const int* q = G.queue + (ulong(f) * G.slots + slot) * n;
  const int c = G.qcount[f * G.slots + slot];
  device uint* P = G.prefix + ulong(f) * (n + 1);
  const int chunk = (c + int(TG) - 1) / int(TG);
  const int s0 = int(lid) * chunk, s1 = min(c, s0 + chunk);
  uint s = 0;
  for (int k = s0; k < s1; k++) { const int i = q[k]; s += G.ptr[i + 1] - G.ptr[i]; }
  const uint pre = simd_prefix_exclusive_sum(s);
  const uint sg = lid / 32u, lane = lid % 32u;
  if (lane == 31u) sums[sg] = pre + s;
  threadgroup_barrier(mem_flags::mem_threadgroup);
  uint run = pre;
  for (uint k = 0; k < sg; k++) run += sums[k];
  if (lid == TG - 1) atomic_store_explicit(R, run + s, memory_order_relaxed);
  for (int k = s0; k < s1; k++) { P[k] = run; const int i = q[k]; run += G.ptr[i + 1] - G.ptr[i]; }
}

inline void bitonic_tg(threadgroup ulong* K, threadgroup int* I, uint P, uint lid) {
  for (uint k = 2; k <= P; k <<= 1)
    for (uint j = k >> 1; j > 0; j >>= 1) {
      for (uint x = lid; x < P; x += TG) {
        const uint y = x ^ j;
        if (y > x) {
          const bool up = (x & k) == 0;
          const ulong a = K[x], b = K[y];
          if ((a > b) == up) { K[x] = b; K[y] = a; const int t = I[x]; I[x] = I[y]; I[y] = t; }
        }
      }
      threadgroup_barrier(mem_flags::mem_threadgroup);
    }
}

inline void bitonic_dev(device ulong* K, device int* I, uint P, uint lid) {
  for (uint k = 2; k <= P; k <<= 1)
    for (uint j = k >> 1; j > 0; j >>= 1) {
      for (uint x = lid; x < P; x += TG) {
        const uint y = x ^ j;
        if (y > x) {
          const bool up = (x & k) == 0;
          const ulong a = K[x], b = K[y];
          if ((a > b) == up) { K[x] = b; K[y] = a; const int t = I[x]; I[x] = I[y]; I[y] = t; }
        }
      }
      threadgroup_barrier(mem_flags::mem_device);
    }
}

inline uint pow2ceil(uint x) { uint p = 1; while (p < x) p <<= 1; return p; }

// ---- call start: pack state, drive-change wake-ups, prefix of the first delivery slot ----
kernel void k_begin(constant Globals& G [[buffer(0)]], uint tg [[threadgroup_position_in_grid]],
                    uint lid [[thread_position_in_threadgroup]]) {
  threadgroup uint sums[TG];
  const int per = (G.n + int(TG) - 1) / int(TG) + 1;
  const int b = int(tg) / per, lt = int(tg) % per;
  const FlyCall C = G.call[b];
  const int f = C.fly, n = G.n;
  device atomic_uint* ctr = G.ctr + ulong(f) * G.CS;
  if (lt == per - 1) { prefix_tg(G, f, int(C.clock0 % G.slots), ctr + C_R(0), lid, sums); return; }
  const int i = lt * int(TG) + int(lid);
  if (i >= n) return;
  const ulong o = ulong(f) * n;
  Cell c;
  c.last = int(G.last[o + i] - C.clock0); c.spk = -2147483647 - 1;
  c.v = G.v[o + i]; c.g = G.g[o + i]; c.adapt = G.adapt[o + i]; c.rest = G.rest[i]; c.drive = G.drive[o + i];
  c.refr = G.refr[o + i]; c.flag = G.flags[o + i]; c.kc = G.kc[i];
  const int na0 = G.nactive[f];
  device int* act0 = G.act + ulong(f) * 2 * n;
  if (i < na0) { const int j = G.active[o + i]; G.key[o + j] = ulong(i); act0[i] = j; }
  const float pd = G.prev[o + i];
  bool wake = false;
  if (c.drive != pd) {
    evolve(c, -1, pd, G);
    G.prev[o + i] = c.drive;
    if (!c.flag) { c.flag = 1; wake = true; G.key[o + i] = (1ul << 32) | ulong(i); }
  }
  const uint pos = agg_add(ctr + C_NA(0), wake);
  if (wake) act0[pos] = i;
  G.cells[o + i] = c;
}

// ---- tick part A: phase 1 (active neurons) + delivery records of this tick's slot ----
kernel void k_tickA(constant Globals& G [[buffer(0)]], constant int& t [[buffer(1)]], constant int& roles [[buffer(2)]],
                    uint tg [[threadgroup_position_in_grid]], uint lid [[thread_position_in_threadgroup]]) {
  const int per = G.ga1 + G.ga2;
  const int b = int(tg) / per, lt = int(tg) % per;
  if (!(roles & (lt < G.ga1 ? 1 : 2))) return;  // role split (profiling only)
  const FlyCall C = G.call[b];
  if (t >= C.steps) return;
  const int f = C.fly, n = G.n;
  const ulong o = ulong(f) * n;
  device atomic_uint* ctr = G.ctr + ulong(f) * G.CS;
  if (lt < G.ga1) {
    const uint na = ld(ctr + C_NA(t));
    device const int* ain = G.act + ulong(f) * 2 * n + ulong(t & 1) * n;
    device int* aout = G.act + ulong(f) * 2 * n + ulong((t + 1) & 1) * n;
    const uint stride = uint(G.ga1) * TG;
    for (uint base = 0; base < na; base += stride) {
      const uint k = base + uint(lt) * TG + lid;
      const bool valid = k < na;
      bool keep = false;
      int i = 0;
      if (valid) {
        i = ain[k];
        Cell c = G.cells[o + i];
        if (c.spk == t - 1) { c.v = c.rest; c.g = 0.0f; c.refr = short(G.rfc); }  // phase 3 of tick t-1
        evolve(c, t, c.drive, G);
        if (c.refr == 0 && c.v > -45.f) {
          const uint s = atomic_fetch_add_explicit(ctr + C_NSP(t), 1u, memory_order_relaxed);
          G.spkey[o + s] = G.key[o + i]; G.spid[o + s] = i;
          G.counts[o + i]++;
          c.spk = t;
          if (c.kc) {
            c.adapt = c.adapt + G.adapt_jump;
            const uint kk = atomic_fetch_add_explicit(ctr + C_NKC, 1u, memory_order_relaxed);
            if (kk < uint(G.kcap)) G.kclog[ulong(f) * G.kcap + kk] = int2(i, t);
            else atomic_store_explicit(ctr + C_OVF, 1u, memory_order_relaxed);
          }
        }
        const float gap = -45.f - c.rest;
        keep = c.v > -45.f || c.drive > gap || c.drive + c.g > gap;
        if (!keep) c.flag = 0;
        G.cells[o + i] = c;
      }
      const uint p = agg_add(ctr + C_NA(t + 1), valid && keep);
      if (valid && keep) aout[p] = i;
    }
  } else {
    const int slot = int((C.clock0 + t) % G.slots);
    const int c = G.qcount[f * G.slots + slot];
    const uint R = ld(ctr + C_R(t));
    device const int* q = G.queue + (ulong(f) * G.slots + slot) * n;
    device const uint* P = G.prefix + ulong(f) * (n + 1);
    const ulong fe = ulong(f) * G.E;
    const uint stride = uint(G.ga2) * TG;
    for (uint base = 0; base < R; base += stride) {
      const uint r = base + uint(lt - G.ga1) * TG + lid;
      const bool valid = r < R;
      bool first = false;
      int j = 0;
      if (valid) {
        int lo = 0, hi = c - 1;  // largest q with P[q] <= r
        while (lo < hi) { const int mid = (lo + hi + 1) >> 1; if (P[mid] <= r) lo = mid; else hi = mid - 1; }
        const int i = q[lo];
        const Edge ed = G.edges[G.ptr[i] + (r - P[lo])];
        j = ed.post;
        // push record r on target j's list; record arrays are indexed by r (contiguous per tick)
        const uint old = atomic_exchange_explicit(G.head + o + j, r, memory_order_relaxed);
        G.nxt[fe + r] = (old & ENDL) | (G.modmask[i] ? MODBIT : 0u);
        G.recv[fe + r] = ed.w;
        first = old == EMPTY;
      }
      const uint p = agg_add(ctr + C_NT(t), valid && first);
      if (valid && first) G.touched[o + p] = j;
    }
  }
}

// ---- tick part B: ordered delivery per target + sort this tick's spikes into the queue ----
kernel void k_tickB(constant Globals& G [[buffer(0)]], constant int& t [[buffer(1)]], constant int& roles [[buffer(2)]],
                    uint tg [[threadgroup_position_in_grid]], uint lid [[thread_position_in_threadgroup]]) {
  threadgroup uint sums[TG];
  const int per = G.gb1 + 1;
  const int b = int(tg) / per, lt = int(tg) % per;
  if (!(roles & (lt < G.gb1 ? 1 : 2))) return;  // role split (profiling only)
  const FlyCall C = G.call[b];
  if (t >= C.steps) return;
  const int f = C.fly, n = G.n;
  const ulong o = ulong(f) * n, fe = ulong(f) * G.E;
  device atomic_uint* ctr = G.ctr + ulong(f) * G.CS;
  if (lt < G.gb1) {
    const uint nt = ld(ctr + C_NT(t));
    device int* aout = G.act + ulong(f) * 2 * n + ulong((t + 1) & 1) * n;
    const long clk = C.clock0 + t;
    const uint stride = uint(G.gb1) * TG;
    for (uint base = 0; base < nt; base += stride) {
      const uint u = base + uint(lt) * TG + lid;
      const bool valid = u < nt;
      bool wake = false;
      int j = 0;
      if (valid) {
        j = G.touched[o + u];
        const uint h0 = ld(G.head + o + j);
        const uint nx0 = G.nxt[fe + h0];
        // Records in delivery order. One record (76% of targets) needs no sort; several are
        // copied into this tick's scratch slice, insertion-sorted there, then applied.
        uint k = 1;
        bool sorted = false;
        device uint* S = G.scr + ulong(f) * G.scap;
        if ((nx0 & ENDL) != ENDL) {
          k = 0;
          for (uint r = h0; r != ENDL; r = G.nxt[fe + r] & ENDL) k++;
          const uint sb = atomic_fetch_add_explicit(ctr + C_SC(t), k, memory_order_relaxed);
          if (sb + k <= uint(G.scap)) {
            sorted = true;
            S += sb;
            uint m = 0;
            for (uint r = h0; r != ENDL; m++) {
              const uint nx = G.nxt[fe + r];
              int y = int(m) - 1;
              while (y >= 0 && (S[y] & ENDL) > r) { S[y + 1] = S[y]; y--; }
              S[y + 1] = r | (nx & MODBIT);
              r = nx & ENDL;
            }
          }
        }
        Cell c;
        bool ev = false, md = false;
        float mv = 0.0f;
        long ml = 0;
        long prevr = -1;
        for (uint x = 0; x < k; x++) {
          uint rec;
          if (k == 1) rec = h0 | (nx0 & MODBIT);
          else if (sorted) rec = S[x];
          else {  // scratch full (extreme burst): pick the next smallest r (O(k^2))
            uint best = ENDL, bestm = 0;
            for (uint r = ld(G.head + o + j); r != ENDL;) {
              const uint nx = G.nxt[fe + r];
              if (long(r) > prevr && r < best) { best = r; bestm = nx & MODBIT; }
              r = nx & ENDL;
            }
            rec = best | bestm;
            prevr = long(best);
          }
          const uint r = rec & ENDL;
          const float w = G.recv[fe + r];
          if (rec & MODBIT) {
            if (!md) { md = true; mv = G.mod[o + j]; ml = G.mlast[o + j]; }
            mv = mv * G.mtab[int(min(clk - ml, long(G.TM - 1)))];
            mv = mv + w;
            ml = clk;
          } else {
            if (!ev) { ev = true; c = G.cells[o + j]; evolve(c, t, c.drive, G); }
            if (c.refr == 0) {
              c.g = c.g + w;
              if (!c.flag) { c.flag = 1; wake = true; G.key[o + j] = (ulong(2 + t) << 32) | ulong(r); }
            }
          }
        }
        if (ev) G.cells[o + j] = c;
        if (md) { G.mod[o + j] = mv; G.mlast[o + j] = ml; }
        atomic_store_explicit(G.head + o + j, EMPTY, memory_order_relaxed);
      }
      const uint p = agg_add(ctr + C_NA(t + 1), valid && wake);
      if (valid && wake) aout[p] = j;
    }
  } else {
    // spikes of tick t in active-list (key) order -> queue slot `future`
    const uint ns = ld(ctr + C_NSP(t));
    const int fs = int((C.clock0 + t + G.delay) % G.slots);
    device int* qf = G.queue + (ulong(f) * G.slots + fs) * n;
    if (ns <= LOCALSORT) {  // rank sort: keys are unique, position = number of smaller keys
      device const ulong* K = G.spkey + o;
      for (uint x = lid; x < ns; x += TG) {
        const ulong kx = K[x];
        uint pos = 0;
        for (uint y = 0; y < ns; y++) pos += K[y] < kx ? 1u : 0u;
        qf[pos] = G.spid[o + x];
      }
    } else {
      const uint P = pow2ceil(ns);
      device ulong* K = G.sortk + ulong(f) * G.NP;
      device int* I = G.sortid + ulong(f) * G.NP;
      for (uint x = lid; x < P; x += TG) { K[x] = x < ns ? G.spkey[o + x] : ~0ul; I[x] = x < ns ? G.spid[o + x] : 0; }
      threadgroup_barrier(mem_flags::mem_device);
      bitonic_dev(K, I, P, lid);
      for (uint x = lid; x < ns; x += TG) qf[x] = I[x];
    }
    if (lid == 0) {
      G.qcount[f * G.slots + fs] = int(ns);
      G.qcount[f * G.slots + int((C.clock0 + t) % G.slots)] = 0;  // delivered this tick
    }
    threadgroup_barrier(mem_flags::mem_device);
    if (t + 1 < C.steps) prefix_tg(G, f, int((C.clock0 + t + 1) % G.slots), ctr + C_R(t + 1), lid, sums);
  }
}

// ---- call end (1): phase 3 of the last tick, boundary evolve, unpack; block-sort active keys ----
kernel void k_end(constant Globals& G [[buffer(0)]], uint tg [[threadgroup_position_in_grid]],
                  uint lid [[thread_position_in_threadgroup]]) {
  const int per = (G.n + int(TG) - 1) / int(TG);
  const int b = int(tg) / per, lt = int(tg) % per;
  const FlyCall C = G.call[b];
  const int f = C.fly, n = G.n, T = C.steps;
  const ulong o = ulong(f) * n;
  const int i = lt * int(TG) + int(lid);
  if (i >= n) return;
  Cell c = G.cells[o + i];
  if (c.spk == T - 1) { c.v = c.rest; c.g = 0.0f; c.refr = short(G.rfc); }
  evolve(c, T - 1, c.drive, G);
  G.last[o + i] = long(c.last) + C.clock0;
  G.v[o + i] = c.v; G.g[o + i] = c.g; G.adapt[o + i] = c.adapt; G.refr[o + i] = c.refr; G.flags[o + i] = c.flag;
}

kernel void k_blksort(constant Globals& G [[buffer(0)]], uint tg [[threadgroup_position_in_grid]],
                      uint lid [[thread_position_in_threadgroup]]) {
  threadgroup ulong SK[LOCALSORT];
  threadgroup int SI[LOCALSORT];
  const int per = G.nblk;
  const int b = int(tg) / per, lt = int(tg) % per;
  const FlyCall C = G.call[b];
  const int f = C.fly, n = G.n, T = C.steps;
  const ulong o = ulong(f) * n;
  device atomic_uint* ctr = G.ctr + ulong(f) * G.CS;
  const uint blk = uint(lt);
  const uint na = ld(ctr + C_NA(T));
  const uint s0 = blk * LOCALSORT;
  if (s0 >= na) return;
  const uint cnt = min(LOCALSORT, na - s0);
  device const int* afin = G.act + ulong(f) * 2 * n + ulong(T & 1) * n;
  const uint P = pow2ceil(cnt);
  for (uint x = lid; x < P; x += TG) {
    const int j = x < cnt ? afin[s0 + x] : 0;
    SK[x] = x < cnt ? G.key[o + j] : ~0ul; SI[x] = j;
  }
  threadgroup_barrier(mem_flags::mem_threadgroup);
  bitonic_tg(SK, SI, P, lid);
  for (uint x = lid; x < cnt; x += TG) { G.sortk[ulong(f) * G.NP + s0 + x] = SK[x]; G.sortid[ulong(f) * G.NP + s0 + x] = SI[x]; }
}

// ---- call end (2): merge the sorted blocks by rank -> active[] in the CPU's order ----
kernel void k_rank(constant Globals& G [[buffer(0)]], uint tg [[threadgroup_position_in_grid]],
                   uint lid [[thread_position_in_threadgroup]]) {
  const int per = G.NP / int(TG);
  const int b = int(tg) / per, lt = int(tg) % per;
  const FlyCall C = G.call[b];
  const int f = C.fly;
  device atomic_uint* ctr = G.ctr + ulong(f) * G.CS;
  const uint na = ld(ctr + C_NA(C.steps));
  const uint k = uint(lt) * TG + lid;
  if (k == 0) G.nactive[f] = int(na);
  if (k >= na) return;
  device const ulong* K = G.sortk + ulong(f) * G.NP;
  const ulong key = K[k];
  const uint mb = k / LOCALSORT;
  uint pos = k - mb * LOCALSORT;
  const uint nb = (na + LOCALSORT - 1) / LOCALSORT;
  for (uint bb = 0; bb < nb; bb++) {
    if (bb == mb) continue;
    uint lo = bb * LOCALSORT, hi = min(na, lo + LOCALSORT);  // count of keys < key in block bb
    const uint start = lo;
    while (lo < hi) { const uint mid = (lo + hi) >> 1; if (K[mid] < key) lo = mid + 1; else hi = mid; }
    pos += lo - start;
  }
  G.active[ulong(f) * G.n + pos] = G.sortid[ulong(f) * G.NP + k];
}
