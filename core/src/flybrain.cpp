// FlyBrainCore: see include/flybrain.h.
//
// Fidelity contract: this file re-implements, statement for statement, the per-fly loop of the
// Python reference (brain_server/worker.py):
//   worker.fly_loop            -> Brain::advance / warmup / step (smoothing, habituation, cloud bits)
//   VisualMemoryBrain.rgb_step -> Brain::chunk (R8 adapter + retinal samples)
//   MemoryBrain._neural_step   -> Brain::chunk (drive: lamina bias, retina, stimulation)
//   kernel_batch fast_advance  -> Brain::kernel (same float expressions, same operation order)
//   channels.build_stim/decode -> Brain::stimulate / decode
// Weights are frozen, so two pieces of the kernel are left out on purpose, and neither can change a
// spike: the modulation trace (read by nothing) and the KC eligibility trace (read only by learning).
// Modulatory cells still deliver nothing, exactly as in the original ("continue").
//
// One deliberate departure (16.09, DETERMINISM.md): `evolve` no longer relies on the compiler to
// contract its multiply-adds, and the two divisions are pre-computed into the decay tables. Same
// neurons, synapses, weights, delays and equations; the membrane update is now a fixed sequence of
// correctly-rounded +, - and *, which differs from the old single-expression form by about one ULP
// per tick. That is the price of being reproducible on a GPU whose fma or divide is not exact, and
// the {"acc":"fma"} mode restores the old form bit for bit.
#include "flybrain.h"
#include "gpu/vkbrain.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <malloc/malloc.h>
#elif defined(__linux__)
#include <malloc.h>
#endif

#include <zlib.h>
#if defined(__linux__)
#include <sys/mman.h>
#if defined(__linux__)
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
#endif
#endif

namespace {

thread_local std::string g_error;

// ------------------------------------------------------------------ tiny JSON (input only) ----
struct J {
  enum K { NUL, NUM, STR, ARR, OBJ, BOOL } k = NUL;
  double num = 0;
  bool b = false;
  std::string str;
  std::vector<J> arr;
  std::vector<std::pair<std::string, J>> obj;  // insertion order matters (drive summation order)
  const J* get(const char* key) const {
    for (auto& kv : obj)
      if (kv.first == key) return &kv.second;
    return nullptr;
  }
};

struct Parser {
  const char* p;
  const char* e;
  void ws() { while (p < e && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) p++; }
  bool parse(J& out) {
    ws();
    if (p >= e) return false;
    char c = *p;
    if (c == '{') {
      out.k = J::OBJ; p++; ws();
      if (p < e && *p == '}') { p++; return true; }
      for (;;) {
        J key;
        ws();
        if (!parse(key) || key.k != J::STR) return false;
        ws();
        if (p >= e || *p != ':') return false;
        p++;
        J val;
        if (!parse(val)) return false;
        out.obj.emplace_back(std::move(key.str), std::move(val));
        ws();
        if (p < e && *p == ',') { p++; continue; }
        if (p < e && *p == '}') { p++; return true; }
        return false;
      }
    }
    if (c == '[') {
      out.k = J::ARR; p++; ws();
      if (p < e && *p == ']') { p++; return true; }
      for (;;) {
        J val;
        if (!parse(val)) return false;
        out.arr.push_back(std::move(val));
        ws();
        if (p < e && *p == ',') { p++; continue; }
        if (p < e && *p == ']') { p++; return true; }
        return false;
      }
    }
    if (c == '"') {
      out.k = J::STR; p++;
      while (p < e && *p != '"') {
        if (*p == '\\' && p + 1 < e) { p++; }
        out.str.push_back(*p++);
      }
      if (p >= e) return false;
      p++;
      return true;
    }
    if (c == 't' && e - p >= 4 && !strncmp(p, "true", 4)) { out.k = J::BOOL; out.b = true; p += 4; return true; }
    if (c == 'f' && e - p >= 5 && !strncmp(p, "false", 5)) { out.k = J::BOOL; out.b = false; p += 5; return true; }
    if (c == 'n' && e - p >= 4 && !strncmp(p, "null", 4)) { out.k = J::NUL; p += 4; return true; }
    char* end = nullptr;
    out.num = strtod(p, &end);
    if (end == p) return false;
    out.k = J::NUM;
    p = end;
    return true;
  }
};

bool parse_json(const char* s, J& out) {
  Parser ps{s, s + strlen(s)};
  return ps.parse(out);
}

// ------------------------------------------------------------------ FLYB reader ----------------
struct Blob {
  uint8_t code = 0;
  uint64_t length = 0;
  const uint8_t* data = nullptr;
};

bool read_flyb(const uint8_t* p0, size_t len, std::map<std::string, Blob>& out) {
  const uint8_t* p = p0;
  const uint8_t* e = p + len;
  if (len < 12 || memcmp(p, "FLYB", 4)) { g_error = "not a FLYB file"; return false; }
  uint32_t version, count;
  memcpy(&version, p + 4, 4);
  memcpy(&count, p + 8, 4);
  if (version != 1 && version != 2) { g_error = "unsupported FLYB version"; return false; }  // 2 = integer weights (ADR 82)
  p += 12;
  static const int SZ[8] = {0, 1, 1, 2, 4, 8, 4, 8};
  for (uint32_t r = 0; r < count; r++) {
    if (e - p < 2) { g_error = "truncated header"; return false; }
    uint16_t nl;
    memcpy(&nl, p, 2);
    p += 2;
    if (e - p < nl + 10) { g_error = "truncated record"; return false; }
    std::string name(reinterpret_cast<const char*>(p), nl);
    p += nl;
    Blob b;
    b.code = p[0];
    memcpy(&b.length, p + 2, 8);
    p += 10;
    if (b.code < 1 || b.code > 7) { g_error = "bad dtype in " + name; return false; }
    uint64_t nbytes = b.length * SZ[b.code];
    if ((uint64_t)(e - p) < nbytes) { g_error = "truncated data in " + name; return false; }
    b.data = p;
    p += nbytes;
    size_t off = (size_t)(p - p0);
    p += (8 - off % 8) % 8;
    out[name] = b;
  }
  return true;
}

template <class T>
std::vector<T> take(const std::map<std::string, Blob>& m, const std::string& name, uint8_t code) {
  auto it = m.find(name);
  if (it == m.end() || it->second.code != code) return {};
  std::vector<T> v(it->second.length);
  if (!v.empty()) memcpy(v.data(), it->second.data, v.size() * sizeof(T));
  return v;
}

// ------------------------------------------------------------------ the brain -------------------
struct Acc { int32_t gen, sum; };  // per-target delivery accumulator, stamped by tick

// Where a 50 ms hop actually goes (17.09). A slow host once reported a step of many seconds with a
// `gpu_ms` of two, and nobody could say where the rest went -- because `gpu_ms` was the wall time of
// the LAST 10 ms chunk, one of the five in a hop, so the GPU's real share was never on the row at all.
// Every phase below is accumulated per hop in nanoseconds and published in `stats()` (which the
// LENS row already prints as `core=`) and in the step message's `prof`, so a slow run answers this
// from data instead of inference.
struct Prof {
  int64_t sense = 0;   // senses -> drive: the per-chunk sense copy, the frame, the drive fill, stimulate, the eye, R8
  int64_t push = 0;    // gpu_push: CPU state -> the mapped GPU buffers (only on an engine switch)
  int64_t pull = 0;    // gpu_pull: the other way
  int64_t drive = 0;   // vk->set_drive: n floats into mapped GPU memory, EVERY chunk
  int64_t gpu = 0;     // vk->run: record + submit + wait on the fence (WAITING, not necessarily busy)
  double busy = 0;     // ms the GPU itself was on it, from its own timestamps: gpu - busy = queued behind
                       // whatever else is using the GPU (on a mobile host, the renderer)
  int64_t counts = 0;  // vk->get_counts / set_counts: n ints out of / into mapped GPU memory, every chunk
  int64_t cpu = 0;     // kernel_serial / kernel_par
  int64_t plast = 0;   // plasticity()
  int64_t read = 0;    // rates, decode, smoothing, baselines
  int64_t msg = 0;     // building the step JSON
  int gpu_chunks = 0, cpu_chunks = 0;
  void clear() { *this = Prof(); }
};
inline int64_t now_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

struct Cell {  // same packing as kernel_batch.cpp fast_advance, but it lives here for good
  int64_t last;
  float v, g, adapt, rest, drive;
  int16_t refr;
  uint8_t flag, kc;
};

constexpr double CHUNK_MS = 10.0;
constexpr double SMOOTH_MS = 150.0;
constexpr double REST_LIGHT = 160.0 / 255.0;
constexpr double BASE_TAU_MS = 8000.0;
constexpr double ATTRACT_FREEZE = 0.2;
constexpr float MAX_MV = 20.0f;
constexpr float DT_REF = 0.1f;  // the reference kernel's tick; {"dt":0.2} halves the ticks per chunk (disclosed approximation)

// Give the freed pages back to the OS. Loading a brain frees several 50-100 MB temporaries (the
// file blob, the f32 weights of a v1 file) and `set_gpu` frees the whole CPU edge array once the
// Vulkan buffer owns it -- but an allocator keeps large freed blocks on its own free list, so the
// process still SHOWS them as resident. Measured on the Mac with brain_c0: 630 MB resident against
// a 212 MB working set, and 880 against 269 with the GPU up. A memory-pressure killer looks at
// resident size, so this is not cosmetic. Called after load and after the GPU takes the edges.
void release_memory() {
#if defined(__APPLE__)
  malloc_zone_pressure_relief(nullptr, 0);
#elif defined(__GLIBC__)
  malloc_trim(0);
#elif defined(__linux__) && defined(M_PURGE)
  mallopt(M_PURGE, 0);  // bionic
#endif
}

// Transparent huge pages for the big random-access arrays (on Linux hosts with THP). Each synaptic
// delivery is a random 32-byte read into a 5 MB cell array plus a walk through a 200-300 MB edge
// array: with 4 KB pages that is a TLB miss per access too. A no-op where THP is off (EINVAL).
template <class T>
void huge_pages(std::vector<T>& v) {
#if defined(__linux__) && defined(MADV_HUGEPAGE)
  if (v.size() * sizeof(T) < (8u << 20)) return;
  uintptr_t a = (uintptr_t)v.data(), e = a + v.size() * sizeof(T);
  const uintptr_t pg = 4096;
  a = (a + pg - 1) & ~(pg - 1);
  e &= ~(pg - 1);
  if (e > a) madvise((void*)a, e - a, MADV_HUGEPAGE);
#else
  (void)v;
#endif
}

// ---------------------------------------------------------------- evolve (DETERMINISM.md) -------
// One cell advanced `now - c.last` ticks. THE one place the model's float arithmetic lives: the GPU
// kernels (brain.comp / brain.wgsl) reproduce this function operation for operation, so anything
// that changes here must change there.
//   FMA == false ("plain", the default): only +, - and *, each of which IEEE-754 and the Vulkan spec
//     require to be correctly rounded everywhere. The awkward constants ((a-b)/3 and
//     tau/(tau-20)(cc-a)) are pre-divided into the tables, and `#pragma clang fp contract(off)`
//     stops the compiler inventing an fma the shader could not match. No fma, no divide, so a driver
//     whose fma() is an unfused mad or whose divide is the allowed 2.5 ULP cannot break exactness.
//   FMA == true: the pre-16.09 form, kept for A/B on a device (the shader's div3 / divTau20 emulate
//     the two divisions correctly-roundedly, and the fmas are what clang contracted the old
//     single-expression statement into).
template <bool FMA>
inline void evolve_cell(Cell& c, int64_t now, float current, const float* T, float tau) {
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
  constexpr int TA = vkbrain::TAB_N;
  int64_t d = now - c.last;
  if (d <= 0) return;
  const int frozen = c.refr > 0 ? c.refr - 1 : 0;
  const int skip = (int)(d < frozen ? d : frozen);
  if (skip > 0 && c.adapt > 0) c.adapt = c.adapt * T[2 * TA + (skip < TA ? skip : TA - 1)];
  c.refr = d >= c.refr ? 0 : c.refr - d;
  d -= skip;
  if (d > 0) {
    const int k = (int)(d < TA ? d : TA - 1);
    const float a = T[k], b = T[TA + k];
    if (FMA) {
      c.v = std::fma(c.v - c.rest, a, c.rest);
      c.v = std::fma(current, 1.f - a, c.v);
      c.v = c.v + c.g * (a - b) / 3.f;
      c.g = c.g * b;
      if (c.adapt > 0) {
        const float cc = T[2 * TA + k];
        c.v = std::fma(-(c.adapt * tau) / (tau - 20.f), cc - a, c.v);
        c.adapt = c.adapt * cc;
      }
    } else {
      const float t1 = c.rest + (c.v - c.rest) * a;
      const float t2 = t1 + current * (1.f - a);
      c.v = t2 + c.g * T[3 * TA + k];
      c.g = c.g * b;
      if (c.adapt > 0) {
        c.v = c.v - c.adapt * T[4 * TA + k];
        c.adapt = c.adapt * T[2 * TA + k];
      }
    }
  }
  c.last = now;
}

// A tick's deliveries into one cell: the integer sum enters `g` with ONE float rounding, and the
// contraction is switched off so the GPU can do the same two operations (DETERMINISM.md).
inline void add_units(float& g, int32_t units, float w_unit) {
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
  const float add = (float)units * w_unit;
  g = g + add;
}

struct Group {  // one sense channel side, or one readout / region
  std::string name;
  std::vector<int32_t> ix;
};

struct Sense {
  std::vector<int32_t> L, R, both;
  bool sided = false;
};

// eye.py INJECT, in its order: the sign is which half of the LMC signal each type carries.
const char* const EYE_NAME[7] = {"L1", "L2", "L5", "Mi1", "Tm1", "Tm2", "Tm9"};
constexpr int EYE_SIGN[7] = {-1, -1, +1, +1, -1, -1, -1};

// base64 -> bytes (the `eye` sense payload; the same alphabet `cloud` is encoded with)
bool b64_decode(const std::string& in, std::vector<uint8_t>& out) {
  static int8_t T[256];
  static bool built = false;
  if (!built) {
    for (int i = 0; i < 256; i++) T[i] = -1;
    const char* A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) T[(uint8_t)A[i]] = (int8_t)i;
    built = true;
  }
  out.clear();
  out.reserve(in.size() * 3 / 4 + 3);
  uint32_t acc = 0;
  int bits = 0;
  for (char ch : in) {
    if (ch == '=' || ch == '\n' || ch == '\r') continue;
    int8_t v = T[(uint8_t)ch];
    if (v < 0) return false;
    acc = (acc << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push_back((uint8_t)((acc >> bits) & 0xFF)); }
  }
  return true;
}

}  // namespace

struct fb_brain {
  // --- graph and constants
  int n = 0;
  int fly = 0;
  double step_ms = 50.0;
  std::vector<int64_t> ptr;
  std::vector<int32_t> post;
  // The weights as exact integers (DETERMINISM.md / ADR 82). w_unit mV per unit, derived from the
  // file: w_quantum is the connectome's own weight quantum (the smallest |w|, 0.275 mV here) and
  // w_k units per quantum, the largest power of two that keeps the worst possible one-tick sum
  // inside 2^30. w_exact says every weight landed on the quantum's grid, i.e. nothing was lost.
  std::vector<int32_t> wunits;
  double w_quantum = 1.0;
  int w_k = 1;
  float w_unit = 1.0f;
  bool w_exact = false;
  // One tick's deliveries, summed per target as integers before a single float add into g.
  // {gen, sum} in one 8-byte slot: the delivery loop touches ONE cache line per synapse (it used to
  // read the 32-byte Cell), and the tick stamp means the array never has to be cleared.
  std::vector<Acc> acc;
  std::vector<int32_t> touched;
  int32_t acc_gen = 0;
  std::vector<uint8_t> modmask;
  // --- dopamine plasticity (fly-wirehead rule.py on KC->MBON07/11), off unless {"learning":true}
  std::vector<int64_t> pl_edge;      // indices into post/weight
  std::vector<int32_t> pl_pre, dan;  // presynaptic KC per plastic edge; PAM11 + PPL101 cells
  std::vector<float> pl_gain, pl_base;  // gain [dan x edge], baseline efficacy per edge
  double eta = 0.001, tr_kc = 1.0, tr_dan = 1.0, mem_tau = 1800.0, w_tau = 0.05, min_frac = 0.1, max_frac = 2.0;
  std::vector<double> rate_kc, rate_dan, mem_u, mem_w, kc_hz, dan_hz, kmid, dmid;
  std::vector<int32_t> pre_before, dan_before;
  bool learning = false;
  // >>> ADR 67 (trainer agent): the mushroom body's own sparsening loop. APL is the single giant
  // GABAergic neuron per hemisphere that every KC excites and that inhibits them all back; in this
  // reconstruction its grip is only ~11 % of the feedforward drive onto a KC, so the odour code is
  // 37 % dense instead of the 5-10 % a real one is (Lin et al. 2014). `kc_inh_gain` scales JUST
  // these synapses. 1.0 = the file exactly, and the core is byte-identical there. <<<
  std::vector<int64_t> kc_inh_edge;
  std::vector<float> kc_inh_base;
  std::vector<std::pair<int32_t, int64_t>> kc_inh_part;  // edge -> (thread, position), as pl_part
  double kc_inh_gain = 1.0;
  // --- the memory this brain can carry between sessions (ADR 62). Everything the rule needs to
  // resume is here: mem_u is the slow trace (tau = rule[2] of the brain file, 10800 s since ADR 92) that IS the memory, mem_w the fast
  // follower the weights are written from (tau 0.05 s), rate_kc/rate_dan the 1 s rate traces.
  // The weights themselves are never stored: weight = pl_base * (1 + mem_w), recomputed on load.
  uint32_t mem_fp = 0;            // fingerprint of the plastic edge set: a blob from another brain file is refused
  bool mem_approx = false;        // the last `set` was a compact blob with no real gap (see memory_load)
  int64_t rewards = 0, punishes = 0;  // US pulses delivered since the last clear / load
  double last_change_ms = -1;     // brain clock the last time a weight actually moved (-1 = never)
  std::vector<int32_t> retina, lamina, sugar, r8, r8ch, cloud;
  // --- the compound eye (ADR 54): per-column ON/OFF into the lamina + first medulla neurons.
  // eye_cells[t] / eye_col[t] are eye.py's stim_lists in its wire order; EYE_SIGN says which half
  // of the LMC signal that type carries (+1 = ON, -1 = OFF).
  static constexpr int EYE_T = 7;
  std::vector<int32_t> eye_cells[EYE_T], eye_col[EYE_T];
  int eye_ncol = 0;
  float eye_mv_lam = 0.f, eye_mv_med = 0.f;
  std::vector<uint8_t> eye_raw;
  std::string eye_cache;
  // cache order (export.py --order hot): neurons are renumbered, so the two index-ordered scans of
  // the reference kernel run in the ORIGINAL order to keep every float summation the same
  std::vector<int32_t> order;        // new index of each old index, in old order (drive-change scan)
  std::vector<int32_t> old_of;       // old index of each new index (par kernel keys)
  std::vector<int32_t> init_active;  // the initial active list, already in the reference order
  std::vector<float> retina_uv, r8_uv;
  float adapt_jump = 8.0f, adapt_tau = 200.0f;
  std::map<std::string, Sense> senses_ix;
  std::vector<Group> reads, regions;
  // --- state (per fly)
  std::vector<Cell> S;
  std::vector<float> prev_drive, drive, luminance, r8_light, rest0;
  std::vector<int16_t> refr0;
  std::vector<int32_t> active;
  int32_t nactive = 0;
  std::vector<std::vector<int32_t>> ring;  // delay slots (dynamic instead of slots x n)
  int64_t clock = 0;
  std::vector<int32_t> counts;
  // --- worker state
  J senses;       // current sense dict (object, insertion order kept)
  // ADR 104: a sense packet is only good for this many steps. When the lens stops sending (the intro,
  // a withheld fly, a dropped link) the core used to keep injecting the LAST packet forever -- 1030
  // of 1485 telemetry rows on 21.09 were a hidden fly flying at fwd 1.0 into a 20-minute-old packet.
  static constexpr int SENSES_STALE_STEPS = 60;  // 3 s of fly time at 50 ms
  int senses_fresh = 0;
  std::map<std::string, double> pulses;  // kind -> remaining ms
  bool cloud_on = true;
  std::vector<double> base, smooth, rate;
  bool warmed = false;
  // --- threading
  std::mutex in_mu, out_mu;
  std::vector<std::string> inbox;
  std::string outbox;            // the newest step message; an unread one is dropped, as documented
  bool out_new = false;
  std::deque<std::string> outq;  // messages that must NOT be dropped (memory blobs): read first by fb_take
  std::atomic<bool> running{false};
  std::thread th;
  std::string last_msg;
  double last_wall_ms = 0;
  double duty = 1.0;  // {"duty":x}: the brain thread sleeps (1/x - 1) x its step time after each step, for a host that shares its CPU
  std::atomic<bool> paused{false};  // {"pause":true}: no stepping at all, state kept warm (ADR 55: a web page is the brain)
  // the five decay tables, built once by vkbrain::build_decay_tables and shared with every backend
  std::vector<float> tab;
  // Accumulation / evaluation mode (DETERMINISM.md, {"acc":"plain"|"fma"}). `plain` (default) runs
  // evolve on nothing but correctly-rounded +, - and *, so a GPU whose fma or divide is not exact is
  // still bit-identical to the CPU. `fma` is the pre-16.09 form (contracted multiply-adds + the
  // two-fma division emulation), kept so a device can A/B the two without a rebuild.
  bool acc_fma = false;
  float DT = DT_REF;      // tick in ms; a coarser tick is a model-level approximation, never on by default
  int ticks_per_chunk = 100;
  // --- exact multi-thread kernel (kernel_batch.cpp par_advance), used when threads > 1
  int threads = 1;
  struct PEdge { int32_t post; int32_t units; int32_t off; };
  std::vector<std::vector<int64_t>> part_ptr;       // [R][n+1]
  std::vector<std::vector<PEdge>> part_edges;       // [R][edges whose target thread r owns]
  std::vector<std::pair<int32_t, int64_t>> pl_part; // plastic edge -> (thread, position): learning keeps copies in sync
  std::vector<int32_t> fq;       // flat delay queue [slots x n] (par mode)
  std::vector<int32_t> fq_count; // [slots]
  static constexpr int BLOCK = 64;
  bool csr_in_parts = false;  // threads > 1: post/weight live only in part_edges (saves ~200 MB)
  // --- GPU backend (gpu/vkbrain: the same exact kernel on Vulkan compute). {"gpu":f} = the fraction
  // of 10 ms chunks the GPU takes; the CPU serial kernel does the rest on the same edge array, the
  // state moves between the two at chunk boundaries (a few MB, unified memory). ADR 52.
  vkbrain::Brain* vk = nullptr;
  bool csr_in_gpu = false;  // post/weight live only in the GPU's edge buffer
  bool on_gpu = false;      // the live state is in the GPU buffers (S/ring/active are stale)
  double gpu_frac = 0, gpu_acc = 0, gpu_last_ms = 0, gpu_hop_ms = 0;
  Prof prof;
  int gpu_chunks = 0, cpu_chunks = 0;
  std::string gpu_err, gpu_check_json;

  ~fb_brain() { delete vk; }

  // the CSR as the kernels read it: the CPU vectors, or the GPU's interleaved edge array
  const vkbrain::Edge* gpu_edges() const { return csr_in_gpu ? vk->edges() : nullptr; }
  int32_t units_of(double w) const { return (int32_t)std::llrint(w / (double)w_unit); }

  void gpu_push() {  // CPU -> GPU at a chunk boundary (every cell sits at clock - 1 there)
    vkbrain::Cell* gc = vk->cells();
    for (int i = 0; i < n; i++) {
      const Cell& c = S[i];
      gc[i] = {(int32_t)(c.last - clock), INT32_MIN, c.v, c.g, c.adapt, c.rest, c.drive,
               (int32_t)((uint32_t)(uint16_t)c.refr | ((uint32_t)c.flag << 16) | ((uint32_t)c.kc << 24))};
    }
    vk->set_prev(prev_drive.data());
    vk->set_counts(counts.data());
    uint32_t* act = vk->active();
    for (int k = 0; k < nactive; k++) act[k] = (uint32_t)active[k];
    vk->set_nactive((uint32_t)nactive);
    for (size_t s = 0; s < ring.size(); s++) {
      if (!ring[s].empty()) memcpy(vk->queue((int)s), ring[s].data(), 4 * ring[s].size());
      vk->qcount((int)s) = (int32_t)ring[s].size();
    }
    vk->upload_all();
  }

  void gpu_pull() {  // GPU -> CPU
    vk->fetch_all();
    const vkbrain::Cell* gc = vk->cells();
    for (int i = 0; i < n; i++) {
      Cell& c = S[i];
      c.last = clock + gc[i].last;
      c.v = gc[i].v; c.g = gc[i].g; c.adapt = gc[i].adapt; c.drive = gc[i].drive;
      c.refr = (int16_t)(gc[i].pk & 0xFFFF);
      c.flag = (uint8_t)((gc[i].pk >> 16) & 0xFF);
    }
    vk->get_prev(prev_drive.data());
    vk->get_counts(counts.data());
    nactive = (int32_t)vk->nactive();
    const uint32_t* act = vk->active();
    for (int k = 0; k < nactive; k++) active[k] = (int32_t)act[k];
    for (size_t s = 0; s < ring.size(); s++) ring[s].assign(vk->queue((int)s), vk->queue((int)s) + vk->qcount((int)s));
  }

  bool gpu_chunk(int steps) {
    const int64_t t0 = now_ns();
    vk->set_drive(drive.data());
    const int64_t t1 = now_ns();
    if (!vk->run(steps, (int)(clock % (int64_t)ring.size()))) { gpu_err = vk->err(); return false; }
    const int64_t t2 = now_ns();
    clock += steps;
    vk->get_counts(counts.data());
    const int64_t t3 = now_ns();
    prof.drive += t1 - t0;
    prof.gpu += t2 - t1;
    prof.counts += t3 - t2;
    prof.gpu_chunks++;
    prof.busy += vk->last_gpu_busy_ms();
    gpu_last_ms = vk->last_gpu_ms();
    gpu_hop_ms += (t2 - t1) / 1e6;
    gpu_chunks++;
    return true;
  }

  // {"gpu":f}: bring the backend up on first use (moves the CSR into the GPU buffer, one CPU thread from then on)
  void set_gpu(double frac) {
    frac = std::max(0.0, std::min(1.0, frac));
    if (frac > 0 && !vk) {
      set_threads(1);  // partitions -> CSR, flat queue -> ring
      vkbrain::Params p;
      p.n = n; p.E = ptr[n]; p.ptr = ptr.data();  // edges are filled below, array by array
      p.modmask = modmask.data(); p.rest = rest0.data(); p.old_of = old_of.empty() ? nullptr : old_of.data();
      p.tab = tab.data(); p.acc_fma = acc_fma ? 1 : 0; p.w_unit = w_unit;
      p.DT = DT; p.adapt_tau = adapt_tau; p.adapt_jump = adapt_jump;
      p.delay = (int)std::lround(1.8f / DT); p.rfc = (int)std::lround(2.2f / DT); p.slots = p.delay + 1;
      std::vector<uint8_t> kc(n);
      for (int i = 0; i < n; i++) kc[i] = S[i].kc;
      p.kc = kc.data();
      std::string err;
      vk = vkbrain::Brain::create(p, err);
      if (!vk) { gpu_err = err; gpu_frac = 0; return; }
      // Fill the GPU's interleaved edge array one source array at a time and free each as it goes,
      // so bringing the GPU up never holds two whole copies of the 200 MB edge payload at once.
      const int64_t E = ptr[n];
      vkbrain::Edge* ed = vk->edges();
      for (int64_t e = 0; e < E; e++) ed[e].post = post[e];
      post.clear(); post.shrink_to_fit();
      for (int64_t e = 0; e < E; e++) ed[e].units = wunits[e];
      wunits.clear(); wunits.shrink_to_fit();
      csr_in_gpu = true;
      gpu_err.clear();
      release_memory();  // the Vulkan buffer owns the edges now; the CPU copy was just freed
    }
    gpu_frac = vk ? frac : 0;
    if (gpu_frac >= 1.0) gpu_acc = 1.0;  // the next chunk goes to the GPU at once
  }

  // Self-check between steps: the same `chunks` chunks from the same state on the CPU and on the GPU,
  // then everything restored. Identical cells / active list / queues / spike counts = the GPU is exact
  // on THIS device (the Mac proves it against Python; any other host proves it against its own CPU).
  void gpu_check(int chunks) {
    if (!vk) { gpu_check_json = "{\"ok\":false,\"err\":\"no gpu\"}"; return; }
    if (on_gpu) { gpu_pull(); on_gpu = false; }
    chunks = std::max(1, std::min(200, chunks));  // 200 = 2 s of simulated time; the gate is meant to be run long (ADR 82)
    const auto S0 = S; const auto ring0 = ring; const auto active0 = active; const auto counts0 = counts;
    const auto prev0 = prev_drive; const int32_t na0 = nactive; const int64_t clock0 = clock;
    auto restore = [&]() { S = S0; ring = ring0; active = active0; counts = counts0; prev_drive = prev0; nactive = na0; clock = clock0; };
    auto t0 = std::chrono::steady_clock::now();
    for (int k = 0; k < chunks; k++) kernel_serial(ticks_per_chunk);
    const double cpu_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    const auto S1 = S; const auto ring1 = ring; const int32_t na1 = nactive;
    std::vector<int32_t> active1(active.begin(), active.begin() + nactive), counts1 = counts;
    restore();
    gpu_push();
    on_gpu = true;
    t0 = std::chrono::steady_clock::now();
    bool ran = true;
    for (int k = 0; k < chunks && ran; k++) ran = gpu_chunk(ticks_per_chunk);
    const double gpu_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    gpu_pull();
    on_gpu = false;
    // the GPU flushes denormals to zero (tiny g / adaptation remainders the CPU keeps): equal up to that
    auto fz = [](float x) { return std::fabs(x) < 1.17549435e-38f ? 0.0f : x; };
    // per-field counts + the worst distance in ULP. When the check fails on a driver we cannot debug
    // from here, this says WHICH arithmetic drifted: dv/dg/da alone with ulp 1 = a last-bit
    // evaluation difference (fma, divide, contraction); dg with a large ulp = the delivery ORDER;
    // dlast/drefr = the integer bookkeeping, i.e. a real logic difference, not rounding.
    auto ulps = [](float x, float y) {
      if (x == y) return 0;
      int32_t a, b;
      memcpy(&a, &x, 4); memcpy(&b, &y, 4);
      if (a < 0) a = INT32_MIN - a;
      if (b < 0) b = INT32_MIN - b;
      const int64_t d = (int64_t)a - (int64_t)b;
      const int64_t m = d < 0 ? -d : d;
      return (int)(m > 1000000 ? 1000000 : m);
    };
    int cells_diff = 0, dv = 0, dg = 0, da = 0, dlast = 0, drefr = 0, uv = 0, ug = 0, ua = 0;
    for (int i = 0; i < n; i++) {
      const Cell &a = S[i], &b = S1[i];
      const bool xv = fz(a.v) != fz(b.v), xg = fz(a.g) != fz(b.g), xa = fz(a.adapt) != fz(b.adapt);
      const bool xl = a.last != b.last, xr = a.refr != b.refr || a.flag != b.flag;
      dv += xv; dg += xg; da += xa; dlast += xl; drefr += xr;
      if (xv) uv = std::max(uv, ulps(fz(a.v), fz(b.v)));
      if (xg) ug = std::max(ug, ulps(fz(a.g), fz(b.g)));
      if (xa) ua = std::max(ua, ulps(fz(a.adapt), fz(b.adapt)));
      if (xv || xg || xa || xl || xr) cells_diff++;
    }
    const bool act_same = nactive == na1 && std::equal(active1.begin(), active1.end(), active.begin());
    const bool ring_same = ring == ring1;
    int64_t sp_cpu = 0, sp_gpu = 0;
    for (int i = 0; i < n; i++) { sp_cpu += counts1[i]; sp_gpu += counts[i]; }
    restore();
    gpu_check_json = std::string("{\"ok\":") + (ran && !cells_diff && act_same && ring_same && sp_cpu == sp_gpu ? "true" : "false") +
        ",\"acc\":\"" + (acc_fma ? "fma" : "plain") + "\",\"wk\":" + std::to_string(w_k) +
        ",\"wexact\":" + (w_exact ? "true" : "false") +
        ",\"chunks\":" + std::to_string(chunks) + ",\"cells_diff\":" + std::to_string(cells_diff) +
        ",\"dv\":" + std::to_string(dv) + ",\"dg\":" + std::to_string(dg) + ",\"da\":" + std::to_string(da) +
        ",\"dlast\":" + std::to_string(dlast) + ",\"drefr\":" + std::to_string(drefr) +
        ",\"ulp\":[" + std::to_string(uv) + "," + std::to_string(ug) + "," + std::to_string(ua) + "]" +
        ",\"active_same\":" + (act_same ? "true" : "false") + ",\"queue_same\":" + (ring_same ? "true" : "false") +
        ",\"spikes_cpu\":" + std::to_string(sp_cpu) + ",\"spikes_gpu\":" + std::to_string(sp_gpu) +
        ",\"cpu_ms\":" + std::to_string((int)cpu_ms) + ",\"gpu_ms\":" + std::to_string((int)gpu_ms) +
        (gpu_err.empty() ? "" : ",\"err\":\"" + gpu_err + "\"") + "}";
  }

  void rebuild_csr_from_parts() {
    if (!csr_in_parts) return;
    const int64_t E = ptr[n];
    post.assign(E, 0);
    wunits.assign(E, 0);
    for (size_t r = 0; r < part_edges.size(); r++) {
      const auto& sp = part_ptr[r];
      const auto& ed = part_edges[r];
      for (int i = 0; i < n; i++)
        for (int64_t k = sp[i]; k < sp[i + 1]; k++) {
          const int64_t e = ptr[i] + ed[k].off;
          post[e] = ed[k].post;
          wunits[e] = ed[k].units;
        }
    }
    csr_in_parts = false;
  }

  bool load(const uint8_t* data, size_t len) {
    std::map<std::string, Blob> m;
    if (!read_flyb(data, len, m)) return false;
    auto nn = take<int64_t>(m, "n", 5);
    if (nn.size() != 1) { g_error = "missing n"; return false; }
    n = (int)nn[0];
    ptr = take<int64_t>(m, "ptr", 5);
    post = take<int32_t>(m, "post", 4);
    auto weight = take<float>(m, "weight", 6);     // FLYB 1: mV per synapse
    auto wq = take<int16_t>(m, "wq", 3);           // FLYB 2: signed contact count, exact
    auto wqu = take<double>(m, "w_quantum", 7);    //         mV per contact
    auto rest = take<float>(m, "rest", 6);
    auto kc = take<uint8_t>(m, "kc_mask", 1);
    modmask = take<uint8_t>(m, "modulation_mask", 1);
    retina = take<int32_t>(m, "retina", 4);
    retina_uv = take<float>(m, "retina_uv", 6);
    lamina = take<int32_t>(m, "lamina", 4);
    sugar = take<int32_t>(m, "sugar", 4);
    r8 = take<int32_t>(m, "r8", 4);
    r8_uv = take<float>(m, "r8_uv", 6);
    r8ch = take<int32_t>(m, "r8_channel", 4);
    cloud = take<int32_t>(m, "cloud", 4);
    {
      auto nc = take<int32_t>(m, "eye_ncol", 4);
      auto mv = take<float>(m, "eye_mv", 6);
      eye_ncol = nc.size() == 1 ? nc[0] : 0;
      if (mv.size() == 2) { eye_mv_lam = mv[0]; eye_mv_med = mv[1]; }
      for (int t = 0; t < EYE_T; t++) {
        eye_cells[t] = take<int32_t>(m, std::string("eye:cells:") + EYE_NAME[t], 4);
        eye_col[t] = take<int32_t>(m, std::string("eye:col:") + EYE_NAME[t], 4);
        if (eye_cells[t].size() != eye_col[t].size()) eye_ncol = 0;
      }
      if (eye_ncol > 0) eye_raw.assign(eye_ncol, 128);
    }
    order = take<int32_t>(m, "order", 4);
    old_of = take<int32_t>(m, "old_of", 4);
    init_active = take<int32_t>(m, "init_active", 4);
    if ((int)order.size() != n) { order.clear(); old_of.clear(); }
    auto ad = take<float>(m, "adaptation", 6);
    kc_inh_edge = take<int64_t>(m, "kc_inh_edges", 5);   // ADR 67, absent in a pre-15.09 file
    kc_inh_base = take<float>(m, "kc_inh_base", 6);
    if (kc_inh_edge.size() != kc_inh_base.size()) { kc_inh_edge.clear(); kc_inh_base.clear(); }
    pl_edge = take<int64_t>(m, "plastic_edges", 5);
    pl_pre = take<int32_t>(m, "plastic_pre", 4);
    dan = take<int32_t>(m, "dan", 4);
    pl_gain = take<float>(m, "plastic_gain", 6);
    pl_base = take<float>(m, "plastic_baseline", 6);
    auto rule = take<double>(m, "rule", 7);
    if (rule.size() == 7) {
      tr_kc = rule[0]; tr_dan = rule[1]; mem_tau = rule[2]; w_tau = rule[3];
      min_frac = rule[4]; max_frac = rule[5]; eta = rule[6];
    }
    if (pl_pre.size() != pl_edge.size() || pl_base.size() != pl_edge.size() || pl_gain.size() != dan.size() * pl_edge.size()) {
      pl_edge.clear(); pl_pre.clear(); dan.clear(); pl_gain.clear(); pl_base.clear();  // brain file without plasticity
    }
    // A saved memory is a list of per-edge numbers, so it only means anything against the SAME
    // plastic edge set. brain_c0 and brain_hot renumber the neurons (export.py --order hot), so
    // their pl_edge indices differ: this fingerprint makes a cross-file load fail loudly (ADR 62).
    {
      uint32_t h = 2166136261u;
      auto mix = [&h](uint32_t v) { h = (h ^ v) * 16777619u; };
      mix((uint32_t)pl_edge.size());
      mix((uint32_t)dan.size());
      for (int64_t e : pl_edge) { mix((uint32_t)e); mix((uint32_t)(e >> 32)); }
      for (float w : pl_base) { uint32_t b; memcpy(&b, &w, 4); mix(b); }
      for (int32_t d : dan) mix((uint32_t)d);
      mem_fp = h;
    }
    const bool v2 = !wq.empty() && wqu.size() == 1;   // FLYB 2: integer contacts, never widened to f32
    const size_t wcount = v2 ? wq.size() : weight.size();
    if ((int)ptr.size() != n + 1 || post.size() != wcount || (int64_t)post.size() != ptr[n] ||
        (int)rest.size() != n || (int)kc.size() != n || (int)modmask.size() != n ||
        retina_uv.size() != retina.size() * 2 || r8_uv.size() != r8.size() * 2 || r8ch.size() != r8.size() || ad.size() != 2) {
      g_error = "inconsistent arrays";
      return false;
    }
    adapt_jump = ad[0];
    adapt_tau = ad[1];
    if (!weight_scale(v2 ? nullptr : weight.data(), v2 ? wq.data() : nullptr, (int64_t)wcount,
                      v2 ? wqu[0] : 0.0)) return false;
    { std::vector<float>().swap(weight); std::vector<int16_t>().swap(wq); }  // 100 / 50 MB, not needed again
    for (auto& kv : m) {
      const std::string& k = kv.first;
      if (k.rfind("sense:", 0) == 0) {
        size_t c2 = k.rfind(':');
        std::string name = k.substr(6, c2 - 6), side = k.substr(c2 + 1);
        auto ix = take<int32_t>(m, k, 4);
        Sense& s = senses_ix[name];
        if (side == "L") { s.L = ix; s.sided = true; }
        else if (side == "R") { s.R = ix; s.sided = true; }
        else s.both = ix;
      } else if (k.rfind("read:", 0) == 0) {
        reads.push_back({k.substr(5), take<int32_t>(m, k, 4)});
      } else if (k.rfind("region:", 0) == 0) {
        regions.push_back({k.substr(7), take<int32_t>(m, k, 4)});
      }
    }
    build_tables();
    rest0 = rest;
    S.resize(n);
    huge_pages(S);
    huge_pages(post);
    huge_pages(wunits);
    for (int i = 0; i < n; i++) S[i].kc = kc[i];
    reset_state();
    J neutral;
    neutral.k = J::OBJ;
    J light;
    light.k = J::NUM;
    light.num = REST_LIGHT;
    neutral.obj.emplace_back("light", light);
    senses = neutral;
    release_memory();  // the blob's copies and a v1 file's f32 weights are gone: hand the pages back
    return true;
  }

  // DETERMINISM.md / ADR 82. Turn the file's float weights into exact integers.
  //   quantum: the connectome's own weight step -- the file's `w_quantum` if it has one, else the
  //            smallest non-zero |w| (for the MaleCNS exports that is 0.275 mV, one synaptic contact);
  //   w_k:     units per quantum, the largest power of two that keeps the worst conceivable one-tick
  //            sum (every in-edge of the busiest cell delivering at once) inside 2^30. No tick can
  //            overflow an int32 accumulator, by construction, whatever the brain file.
  // With an integer weight a tick's deliveries into one cell add associatively, so the sum does not
  // depend on the order the kernels visit them in, and the CPU and the GPU agree by construction
  // instead of by reproducing each other's float summation order.
  bool weight_scale(const float* w32, const int16_t* wq, int64_t E, double quantum) {
    if (E <= 0 || (!w32 && !wq)) { g_error = "no edges"; return false; }
    auto W = [&](int64_t e) { return w32 ? (double)w32[e] : (double)wq[e] * quantum; };
    double lo = 0;
    for (int64_t e = 0; e < E; e++) {
      const double a = std::fabs(W(e));
      if (a > 0 && (lo == 0 || a < lo)) lo = a;
    }
    if (lo == 0) { g_error = "every weight is zero"; return false; }
    if (!(quantum > 0)) quantum = lo;
    // the worst per-tick sum, in quanta, over every cell
    std::vector<double> in((size_t)n, 0.0);
    for (int64_t e = 0; e < E; e++) in[(size_t)post[e]] += std::fabs(W(e)) / quantum;
    double worst = 1.0;
    for (double x : in) worst = std::max(worst, x);
    int k = 1;
    while (k < (1 << 16) && (double)(k * 2) * worst < (double)(1 << 30)) k *= 2;
    w_quantum = quantum;
    w_k = k;
    w_unit = (float)(quantum / (double)k);
    // On the grid, the unit count is the CONTACT count times k -- computed from the integer, never
    // from w / w_unit, which would be a rounding of a rounding and could land one unit out.
    wunits.resize((size_t)E);
    int64_t off_grid = 0;
    for (int64_t e = 0; e < E; e++) {
      const double w = W(e);
      const double c = std::fabs(w) / quantum;
      const double rc = std::nearbyint(c);
      if (std::fabs(c - rc) <= 1e-4) {
        const int64_t u = (int64_t)rc * (int64_t)k;
        wunits[(size_t)e] = (int32_t)(w < 0 ? -u : u);
      } else {
        off_grid++;
        wunits[(size_t)e] = (int32_t)std::llrint(w / (double)w_unit);
      }
    }
    w_exact = off_grid == 0;
    acc.assign((size_t)n, Acc{0, 0});
    touched.assign((size_t)n, 0);
    acc_gen = 0;
    return true;
  }

  void build_tables() {
    tab = vkbrain::build_decay_tables(DT, adapt_tau);
    ticks_per_chunk = (int)std::lround(CHUNK_MS / DT);
  }

  // Coarser tick (approximation, disclosed): same neurons, synapses, weights and delays; only the
  // integration step changes. Allowed before warm-up only; resets the state.
  void set_dt(double dt) {
    if (!(dt > 0.02 && dt <= 1.0) || warmed) return;
    DT = (float)dt;
    build_tables();
    reset_state();
  }

  void reset_state() {
    // Brain.__init__ / MemoryBrain.__init__ initial values
    for (int i = 0; i < n; i++) {
      Cell& c = S[i];
      c.last = -1;
      c.rest = rest0[i];
      c.v = rest0[i];
      c.g = 0;
      c.adapt = 0;
      c.drive = 0;
      c.refr = 0;
      c.flag = 0;
    }
    prev_drive.assign(n, 0.0f);
    drive.assign(n, 0.0f);
    luminance.assign(retina.size(), 0.0f);
    r8_light.assign(r8.size(), 0.0f);
    counts.assign(n, 0);
    const int delay = (int)std::lround(1.8f / DT);
    ring.assign(delay + 1, {});
    active.assign(n, 0);
    std::vector<int32_t> init;
    if (!init_active.empty()) {
      init = init_active;  // reference order, exported
    } else {
      init.insert(init.end(), retina.begin(), retina.end());
      init.insert(init.end(), lamina.begin(), lamina.end());
      init.insert(init.end(), sugar.begin(), sugar.end());
      std::sort(init.begin(), init.end());
      init.erase(std::unique(init.begin(), init.end()), init.end());
    }
    nactive = (int32_t)init.size();
    for (size_t k = 0; k < init.size(); k++) {
      active[k] = init[k];
      S[init[k]].flag = 1;
    }
    clock = 0;
    // MemoryBrain.reset(keep_memory=False): traces and memory to zero, plastic weights back to baseline
    rate_kc.assign(pl_edge.size(), 0.0);
    rate_dan.assign(dan.size(), 0.0);
    mem_u.assign(pl_edge.size(), 0.0);
    mem_w.assign(pl_edge.size(), 0.0);
    rewards = punishes = 0;
    last_change_ms = -1;
    write_weights();  // every mem_w is 0 here, so this is "back to baseline"
    write_kc_inh();   // ADR 67: the APL gain is a property of the brain, not of the memory
    if (threads > 1 && !fq.empty()) std::fill(fq_count.begin(), fq_count.end(), 0);
  }

  // rule.advance for one 10 ms bin (float64, same expressions and order), then MemoryBrain.step's
  // weight write. Traces always run (as in the original, frozen or not); weights move only when learning.
  void plasticity() {
    const size_t E = pl_edge.size(), D = dan.size();
    if (!E) return;
    const double h = CHUNK_MS / 1000.0;
    kc_hz.resize(E); dan_hz.resize(D); kmid.resize(E); dmid.resize(D);
    for (size_t e = 0; e < E; e++) kc_hz[e] = (double)(counts[pl_pre[e]] - pre_before[e]) / h;
    for (size_t d = 0; d < D; d++) dan_hz[d] = (double)(counts[dan[d]] - dan_before[d]) / h - 0.0;
    const double ak = std::exp(-h / tr_kc), ad = std::exp(-h / tr_dan);
    const double sak = std::sqrt(ak), sad = std::sqrt(ad);
    for (size_t e = 0; e < E; e++) kmid[e] = rate_kc[e] * sak + kc_hz[e] * (1 - sak);
    for (size_t d = 0; d < D; d++) dmid[d] = rate_dan[d] * sad + dan_hz[d] * (1 - sad);
    for (size_t e = 0; e < E; e++) rate_kc[e] = rate_kc[e] * ak + kc_hz[e] * (1 - ak);
    for (size_t d = 0; d < D; d++) rate_dan[d] = rate_dan[d] * ad + dan_hz[d] * (1 - ad);
    if (!learning) return;  // weights_frozen
    const double tu = mem_tau, tw = w_tau;
    const double eu = std::exp(-h / tu), ew = std::exp(-h / tw);
    const double c = tu / (tu - tw) * (eu - ew);
    const double lo = min_frac - 1, hi = max_frac - 1;
    for (size_t e = 0; e < E; e++) {
      double g_dmid = 0.0, g_dan = 0.0;
      for (size_t d = 0; d < D; d++) {
        const double gd = (double)pl_gain[d * E + e];
        g_dmid += gd * dmid[d];
        g_dan += gd * dan_hz[d];
      }
      const double drive = eta * (kc_hz[e] * g_dmid - g_dan * kmid[e]);
      if (drive != 0.0) last_change_ms = clock * (double)DT;  // the board's "time since the last change"
      const double old_u = mem_u[e];
      mem_u[e] = old_u * eu + drive * tu * (-std::expm1(-h / tu));
      mem_w[e] = mem_w[e] * ew + old_u * c + drive * tu * (-std::expm1(-h / tw) - c);
      mem_u[e] = std::min(hi, std::max(lo, mem_u[e]));
      mem_w[e] = std::min(hi, std::max(lo, mem_w[e]));
      const int32_t nu = units_of((double)pl_base[e] * (1.0 + mem_w[e]));
      if (!csr_in_parts && !csr_in_gpu) wunits[pl_edge[e]] = nu;
      if (csr_in_gpu) vk->set_units(pl_edge[e], nu);
      if (!pl_part.empty()) part_edges[pl_part[e].first][pl_part[e].second].units = nu;
    }
  }

  // ---------------------------------------------------------------- memory: save / load / clear --
  // ADR 62. What the lens stores between sessions is exactly the state the rule needs to resume:
  // mem_u, mem_w, rate_kc per plastic edge and rate_dan per DAN cell, all float64 (the rule runs in
  // float64, so anything narrower would not round-trip). Only the edges that ever moved are written
  // -- a KC that never fired leaves drive exactly 0, so its three numbers stay exactly 0 -- which is
  // lossless AND small: 26 bytes per changed edge instead of 24 x 7,835.
  static void put32(std::vector<uint8_t>& o, uint32_t v) { for (int i = 0; i < 4; i++) o.push_back((uint8_t)(v >> (8 * i))); }
  static void put16(std::vector<uint8_t>& o, uint16_t v) { o.push_back((uint8_t)v); o.push_back((uint8_t)(v >> 8)); }
  static void putf64(std::vector<uint8_t>& o, double v) { uint64_t b; memcpy(&b, &v, 8); for (int i = 0; i < 8; i++) o.push_back((uint8_t)(b >> (8 * i))); }
  static uint32_t get32(const uint8_t* p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
  static uint16_t get16(const uint8_t* p) { return (uint16_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8)); }
  static double getf64(const uint8_t* p) { uint64_t b = 0; for (int i = 7; i >= 0; i--) b = (b << 8) | p[i]; double v; memcpy(&v, &b, 8); return v; }

  static constexpr int MEM_HDR = 56;

  // compact = the cross-session form: mem_u only, 10 bytes per moved synapse instead of 26.
  // What it leaves out is what the gap destroys anyway, and the maths is exact, not approximate:
  //   - the two 1 s rate traces are multiplied by exp(-gap / 1 s) on load, so after ~40 s off they
  //     are below 1e-17 of their value;
  //   - mem_w's own contribution to its future is w0 * exp(-gap / 0.05 s), which is below 1e-16
  //     after 2 s. Everything else about mem_w is a function of mem_u, and the load computes it.
  // So for a brain that was switched off, compact and full give bit-identical state (verified in
  // memtest.py). Only the same-instant `echo` needs the full form. The lens stores compact because
  // the device's persistent store is 100 KB in total.
  std::string memory_save(bool compact = false) const {
    const size_t E = pl_edge.size(), D = dan.size();
    std::vector<uint32_t> nz;
    for (size_t e = 0; e < E; e++)
      if (mem_u[e] != 0.0 || mem_w[e] != 0.0 || (!compact && rate_kc[e] != 0.0)) nz.push_back((uint32_t)e);
    std::vector<uint8_t> o;
    o.reserve(MEM_HDR + nz.size() * 26 + D * 8 + 8);
    o.push_back('F'); o.push_back('M'); o.push_back('E'); o.push_back('M');
    put16(o, 1);                                   // version
    put16(o, (uint16_t)((learning ? 1 : 0) | (compact ? 0 : 6)));  // flags: bit0 learning, bit1 traces, bit2 mem_w
    put32(o, (uint32_t)E);
    put32(o, (uint32_t)D);
    put32(o, mem_fp);
    put32(o, (uint32_t)nz.size());
    putf64(o, clock * (double)DT);                 // brain clock at save
    putf64(o, last_change_ms < 0 ? -1.0 : clock * (double)DT - last_change_ms);  // brain ms since a weight last moved
    putf64(o, (double)rewards);
    putf64(o, (double)punishes);
    for (uint32_t e : nz) put16(o, (uint16_t)e);
    while (o.size() % 8) o.push_back(0);
    for (uint32_t e : nz) putf64(o, mem_u[e]);
    if (!compact) {
      for (uint32_t e : nz) putf64(o, mem_w[e]);
      for (uint32_t e : nz) putf64(o, rate_kc[e]);
      for (size_t d = 0; d < D; d++) putf64(o, rate_dan[d]);
    }
    // deflate it: these are float64 arrays of small, similar numbers, so zlib roughly halves them,
    // and the lens has to carry the result over a relay and into a persistent store.
    uLongf zn = compressBound((uLong)o.size());
    std::vector<uint8_t> z(zn + 8);
    if (compress2(z.data() + 8, &zn, o.data(), (uLong)o.size(), 6) == Z_OK && zn + 8 < o.size()) {
      z[0] = 'F'; z[1] = 'M'; z[2] = 'E'; z[3] = 'Z';
      const uint32_t raw = (uint32_t)o.size();
      for (int i = 0; i < 4; i++) z[4 + i] = (uint8_t)(raw >> (8 * i));
      z.resize(zn + 8);
      return b64(z);
    }
    return b64(o);
  }

  // elapsed_s > 0 = the glasses were off that long. The rule's own decay with no spikes is an exact
  // closed form (u and w are a two-stage filter), so this is not an approximation of the rule, it IS
  // the rule advanced over that gap with zero KC and zero DAN activity.
  bool memory_load(const std::string& b64s, double elapsed_s, std::string& err) {
    const size_t E = pl_edge.size(), D = dan.size();
    if (!E) { err = "this brain file has no plastic synapses"; return false; }
    std::vector<uint8_t> d;
    if (!b64_decode(b64s, d)) { err = "bad base64"; return false; }
    if (d.size() > 8 && memcmp(d.data(), "FMEZ", 4) == 0) {  // deflated form
      uLongf raw = get32(&d[4]);
      if (raw > (48u << 20)) { err = "memory too large"; return false; }
      std::vector<uint8_t> u(raw);
      if (uncompress(u.data(), &raw, d.data() + 8, (uLong)(d.size() - 8)) != Z_OK) { err = "inflate failed"; return false; }
      u.resize(raw);
      d.swap(u);
    }
    if (d.size() < (size_t)MEM_HDR) { err = "too short to be a memory"; return false; }
    if (memcmp(d.data(), "FMEM", 4) != 0) { err = "not a FMEM blob"; return false; }
    if (get16(&d[4]) != 1) { err = "unknown memory version"; return false; }
    if (get32(&d[8]) != (uint32_t)E || get32(&d[12]) != (uint32_t)D) { err = "edge/dan count mismatch"; return false; }
    if (get32(&d[16]) != mem_fp) { err = "memory belongs to a different brain file"; return false; }
    const uint32_t nz = get32(&d[20]);
    if (nz > E) { err = "bad edge count"; return false; }
    const uint16_t flags = get16(&d[6]);
    const bool traces = (flags & 2) != 0, has_w = (flags & 4) != 0;
    size_t idx0 = MEM_HDR, f0 = idx0 + nz * 2;
    f0 = (f0 + 7) & ~(size_t)7;
    const size_t per = 8 + (has_w ? 8 : 0) + (traces ? 8 : 0);
    if (d.size() < f0 + (size_t)nz * per + (traces ? D * 8 : 0)) { err = "blob truncated"; return false; }
    const size_t off_w = f0 + 8 * nz, off_k = off_w + (has_w ? 8 * nz : 0), off_d = off_k + (traces ? 8 * nz : 0);
    // nothing is written until every index is known good
    std::vector<uint32_t> ix(nz);
    for (uint32_t k = 0; k < nz; k++) {
      ix[k] = get16(&d[idx0 + 2 * k]);
      if (ix[k] >= E) { err = "edge index out of range"; return false; }
    }
    const double eu = elapsed_s > 0 ? std::exp(-elapsed_s / mem_tau) : 1.0;
    const double ew = elapsed_s > 0 ? std::exp(-elapsed_s / w_tau) : 1.0;
    const double c = mem_tau / (mem_tau - w_tau) * (eu - ew);
    const double ek = elapsed_s > 0 ? std::exp(-elapsed_s / tr_kc) : 1.0;
    const double ed = elapsed_s > 0 ? std::exp(-elapsed_s / tr_dan) : 1.0;
    const double lo = min_frac - 1, hi = max_frac - 1;
    rate_kc.assign(E, 0.0);
    mem_u.assign(E, 0.0);
    mem_w.assign(E, 0.0);
    for (uint32_t k = 0; k < nz; k++) {
      const double u = getf64(&d[f0 + 8 * k]);
      // w0 only ever reaches the future through w0 * ew, so a blob without it is exact once the gap
      // is a few times w_tau (0.05 s). `approx` in the reply says when it was not.
      const double w = has_w ? getf64(&d[off_w + 8 * k]) : 0.0;
      mem_u[ix[k]] = std::min(hi, std::max(lo, u * eu));
      mem_w[ix[k]] = std::min(hi, std::max(lo, w * ew + u * c));
      if (traces) rate_kc[ix[k]] = getf64(&d[off_k + 8 * k]) * ek;
    }
    rate_dan.assign(D, 0.0);
    if (traces)
      for (size_t j = 0; j < D; j++) rate_dan[j] = getf64(&d[off_d + 8 * j]) * ed;
    mem_approx = !has_w && elapsed_s < 2.0;  // a compact blob loaded without a real gap
    write_weights();
    rewards = (int64_t)getf64(&d[40]);
    punishes = (int64_t)getf64(&d[48]);
    const double since = getf64(&d[32]);
    last_change_ms = since < 0 ? -1 : clock * (double)DT - (since + elapsed_s * 1000.0);
    return true;
  }

  void memory_clear() {
    rate_kc.assign(pl_edge.size(), 0.0);
    rate_dan.assign(dan.size(), 0.0);
    mem_u.assign(pl_edge.size(), 0.0);
    mem_w.assign(pl_edge.size(), 0.0);
    rewards = punishes = 0;
    last_change_ms = -1;
    write_weights();
  }

  // ADR 67: weight = kc_inh_base * kc_inh_gain, into whichever copy of the edge array is live.
  // At gain 1.0 this writes each edge its own file value back, so it is a no-op by construction.
  void write_kc_inh() {
    for (size_t e = 0; e < kc_inh_edge.size(); e++) {
      const int32_t nu = units_of((double)kc_inh_base[e] * kc_inh_gain);
      if (!csr_in_parts && !csr_in_gpu) wunits[kc_inh_edge[e]] = nu;
      if (csr_in_gpu) vk->set_units(kc_inh_edge[e], nu);
      if (!kc_inh_part.empty()) part_edges[kc_inh_part[e].first][kc_inh_part[e].second].units = nu;
    }
  }

  // weight = pl_base * (1 + mem_w), into whichever copy of the edge array is live
  void write_weights() {
    for (size_t e = 0; e < pl_edge.size(); e++) {
      const int32_t nu = units_of((double)pl_base[e] * (1.0 + mem_w[e]));
      if (!csr_in_parts && !csr_in_gpu) wunits[pl_edge[e]] = nu;
      if (csr_in_gpu) vk->set_units(pl_edge[e], nu);
      if (!pl_part.empty()) part_edges[pl_part[e].first][pl_part[e].second].units = nu;
    }
  }

  std::string memory_msg(const char* op, const char* err) const {
    std::string o = std::string("{\"t\":\"memory\",\"fly\":") + std::to_string(fly) + ",\"op\":\"" + op + "\"";
    o += std::string(",\"ok\":") + (err && *err ? "false" : "true");
    if (err && *err) o += std::string(",\"err\":\"") + err + "\"";
    o += ",\"edges\":" + std::to_string(pl_edge.size());
    double eff = 0.0;
    int changed = 0;
    for (size_t e = 0; e < mem_w.size(); e++) { eff += 1.0 + mem_w[e]; changed += mem_w[e] != 0.0; }
    num(o, "mean_efficacy", mem_w.empty() ? 1.0 : eff / mem_w.size(), 6);
    o += ",\"changed\":" + std::to_string(changed);
    o += ",\"rewards\":" + std::to_string(rewards) + ",\"punishes\":" + std::to_string(punishes);
    num(o, "sim_ms", clock * (double)DT, 1);
    return o;
  }

  void kernel(int steps) {
    if (vk && gpu_frac > 0) {
      gpu_acc += gpu_frac;
      if (gpu_acc >= 1.0 - 1e-9) {
        gpu_acc -= 1.0;
        if (!on_gpu) { const int64_t t = now_ns(); gpu_push(); prof.push += now_ns() - t; on_gpu = true; }
        if (gpu_chunk(steps)) return;
        const int64_t t = now_ns();
        gpu_pull();  // the GPU failed (overflow / device lost): back to the CPU for good, gpu_err says why
        prof.pull += now_ns() - t;
        on_gpu = false;
        gpu_frac = 0;
      }
    }
    if (on_gpu) { const int64_t t = now_ns(); gpu_pull(); prof.pull += now_ns() - t; on_gpu = false; }
    cpu_chunks++;
    prof.cpu_chunks++;
    const int64_t t0 = now_ns();
    if (threads > 1) kernel_par(steps);
    else kernel_serial(steps);
    prof.cpu += now_ns() - t0;
  }

  // Switch kernels without losing the in-flight spikes: the ring and the flat queue hold the same
  // slots in the same order, so converting between them is exact.
  void set_threads(int t) {
    t = std::max(1, std::min(8, t));
    if (vk) t = 1;  // the partitions would need a second copy of the edges
    if (t == threads && (t == 1 || !part_ptr.empty())) return;
    rebuild_csr_from_parts();
    const int delay = (int)std::lround(1.8f / DT), slots = delay + 1;
    if (threads > 1 && !fq.empty()) {  // flat -> ring
      ring.assign(slots, {});
      for (int s = 0; s < slots; s++) ring[s].assign(fq.begin() + (int64_t)s * n, fq.begin() + (int64_t)s * n + fq_count[s]);
      fq.clear(); fq.shrink_to_fit(); fq_count.clear();
    }
    threads = t;
    part_ptr.clear(); part_edges.clear(); pl_part.clear(); kc_inh_part.clear();
    if (t == 1) return;
    fq.assign((size_t)slots * n, 0);
    fq_count.assign(slots, 0);
    for (int s = 0; s < slots; s++) {
      fq_count[s] = (int32_t)ring[s].size();
      std::copy(ring[s].begin(), ring[s].end(), fq.begin() + (int64_t)s * n);
    }
    part_ptr.assign(t, std::vector<int64_t>(n + 1, 0));
    part_edges.assign(t, {});
    // plastic edge lookup by a linear merge (edges are visited in increasing order per thread)
    // ADR 67: the APL->KC edges ride the same merge, tagged by a negative index (the two classes
    // are disjoint -- different presynaptic cells -- so an edge still matches at most once)
    std::vector<std::pair<int64_t, int32_t>> plastic_sorted(pl_edge.size() + kc_inh_edge.size());
    for (size_t p = 0; p < pl_edge.size(); p++) plastic_sorted[p] = {pl_edge[p], (int32_t)p};
    for (size_t p = 0; p < kc_inh_edge.size(); p++)
      plastic_sorted[pl_edge.size() + p] = {kc_inh_edge[p], -(int32_t)p - 1};
    std::sort(plastic_sorted.begin(), plastic_sorted.end());
    pl_part.assign(pl_edge.size(), {0, 0});
    kc_inh_part.assign(kc_inh_edge.size(), {0, 0});
    for (int r = 0; r < t; r++) {
      auto& sp = part_ptr[r];
      int64_t cnt = 0;
      for (int i = 0; i < n; i++) {
        sp[i] = cnt;
        for (int64_t e = ptr[i]; e < ptr[i + 1]; e++) if ((post[e] / BLOCK) % t == r) cnt++;
      }
      sp[n] = cnt;
      auto& ed = part_edges[r];
      ed.resize(cnt);
      int64_t k = 0;
      size_t ps = 0;
      for (int i = 0; i < n; i++)
        for (int64_t e = ptr[i]; e < ptr[i + 1]; e++) {
          while (ps < plastic_sorted.size() && plastic_sorted[ps].first < e) ps++;
          if ((post[e] / BLOCK) % t == r) {
            if (ps < plastic_sorted.size() && plastic_sorted[ps].first == e) {
              const int32_t q = plastic_sorted[ps].second;
              if (q >= 0) pl_part[q] = {r, k}; else kc_inh_part[-q - 1] = {r, k};
            }
            ed[k++] = {post[e], wunits[e], (int32_t)(e - ptr[i])};
          }
        }
    }
    ring.assign(slots, {});
    post.clear(); post.shrink_to_fit();
    wunits.clear(); wunits.shrink_to_fit();
    csr_in_parts = true;
    for (auto& ed : part_edges) huge_pages(ed);
  }

  // kernel_batch.cpp par_advance: neurons owned block-cyclically, deliveries in global queue order,
  // active lists ordered by (awakening time, global delivery sequence) -> identical spikes to serial.
  void kernel_par(int steps) {
    const int R = threads, BL = BLOCK;
    const int delay = (int)std::lround(1.8f / DT), rfc = (int)std::lround(2.2f / DT), slots = delay + 1;
    const float tau = adapt_tau;
    const float* T = tab.data();
    const bool FMA = acc_fma;
    Cell* S_ = S.data();
    const int64_t clock0 = clock;
    struct Local {
      std::vector<int32_t> act; std::vector<uint64_t> key;
      std::vector<int32_t> sp[2]; std::vector<uint64_t> spk[2];
      std::vector<int32_t> touch; std::vector<uint64_t> tkey;  // this tick's delivery targets, in order
      int nt = 0;                                             // plain arrays, sized once: push_back in the
                                                              // delivery loop cost 27 % at 2 threads
    };
    std::vector<Local> locals(R);
    for (int r = 0; r < R; r++) {
      Local& L = locals[r];
      L.act.reserve(n / R + BL); L.key.reserve(n / R + BL);
      L.touch.resize((size_t)(n / R + 2 * BL)); L.tkey.resize((size_t)(n / R + 2 * BL));  // a thread owns ~n/R targets
    }
    for (int k = 0; k < nactive; k++) {
      const int i = active[k];
      Local& L = locals[(i / BL) % R];
      L.act.push_back(i);
      L.key.push_back((uint64_t)k);
    }
    auto merge = [&](const std::vector<const std::vector<int32_t>*>& ids, const std::vector<const std::vector<uint64_t>*>& keys, auto emit) {
      size_t pos[64] = {0};
      for (;;) {
        int best = -1; uint64_t bk = 0;
        for (int r = 0; r < R; r++)
          if (pos[r] < ids[r]->size()) { const uint64_t k = (*keys[r])[pos[r]]; if (best < 0 || k < bk) { best = r; bk = k; } }
        if (best < 0) return;
        emit((*ids[best])[pos[best]++]);
      }
    };
    auto flush = [&](int buf, int64_t clk) {
      fq_count[clk % slots] = 0;
      const int fs = (int)((clk + delay) % slots);
      int32_t* qf = fq.data() + (int64_t)fs * n;
      int32_t base = fq_count[fs];
      std::vector<const std::vector<int32_t>*> ids(R);
      std::vector<const std::vector<uint64_t>*> keys(R);
      for (int r = 0; r < R; r++) { ids[r] = &locals[r].sp[buf]; keys[r] = &locals[r].spk[buf]; }
      merge(ids, keys, [&](int32_t i) { qf[base++] = i; });
      fq_count[fs] = base;
    };
    std::atomic<int> bar_count{0};
    std::atomic<int> bar_gen{0};
    auto bar_wait = [&]() {
      const int g0 = bar_gen.load(std::memory_order_acquire);
      if (bar_count.fetch_add(1, std::memory_order_acq_rel) == R - 1) {
        bar_count.store(0, std::memory_order_relaxed);
        bar_gen.fetch_add(1, std::memory_order_release);
        return;
      }
      for (int spin = 0; bar_gen.load(std::memory_order_acquire) == g0; spin++) {
        if (spin < 4000) {
#if defined(__aarch64__)
          __asm__ volatile("yield");
#endif
        } else std::this_thread::yield();
      }
    };
    const uint8_t* MM = modmask.data();
    Acc* ACC = acc.data();
    const float WUNIT = w_unit;
    if (acc_gen > 2000000000) { std::fill(acc.begin(), acc.end(), Acc{0, 0}); acc_gen = 0; }
    const int32_t gen0 = acc_gen + 1;
    acc_gen += steps;
    auto body = [&](int r) {
      Local& L = locals[r];
      auto evolve = [&](Cell& c, int64_t now, float current) {
        if (FMA) evolve_cell<true>(c, now, current, T, tau);
        else evolve_cell<false>(c, now, current, T, tau);
      };
      for (int b0 = r * BL; b0 < n; b0 += R * BL)
        for (int i = b0, e = std::min(b0 + BL, n); i < e; i++)
          if (drive[i] != prev_drive[i]) {
            evolve(S_[i], clock0 - 1, prev_drive[i]);
            prev_drive[i] = drive[i];
            S_[i].drive = drive[i];
            if (!S_[i].flag) { S_[i].flag = 1; L.act.push_back(i); L.key.push_back((uint64_t(1) << 32) | (uint64_t)(old_of.empty() ? i : old_of[i])); }
          }
      const std::vector<int64_t>& sptr = part_ptr[r];
      const PEdge* ed = part_edges[r].data();
      const int64_t ecount = (int64_t)part_edges[r].size();
      for (int t = 0; t < steps; t++) {
        const int64_t clk = clock0 + t;
        const int slot = (int)(clk % slots);
        if (r == 0 && t > 0) flush((t - 1) & 1, clk - 1);
        std::vector<int32_t>& SP = L.sp[t & 1];
        std::vector<uint64_t>& SK = L.spk[t & 1];
        SP.clear(); SK.clear();
        size_t kept = 0;
        const size_t original = L.act.size();
        for (size_t k = 0; k < original; k++) {
          if (k + 12 < original) __builtin_prefetch(&S_[L.act[k + 12]], 1);
          const int i = L.act[k];
          Cell& c = S_[i];
          evolve(c, clk, c.drive);
          if (c.refr == 0 && c.v > -45.f) {
            SP.push_back(i); SK.push_back(L.key[k]); counts[i]++;
            if (c.kc) c.adapt += adapt_jump;
          }
          const float gap = -45.f - c.rest;
          const bool can_fire = c.v > -45.f || c.drive > gap || c.drive + c.g > gap;
          if (can_fire) { L.act[kept] = i; L.key[kept] = L.key[k]; kept++; }
          else c.flag = 0;
        }
        L.act.resize(kept); L.key.resize(kept);
        // deliveries: sum the integer units per target (order-free), remember the first hit's key
        const uint64_t T = uint64_t(2 + t) << 32;
        uint64_t prefix = 0;
        const int qc = fq_count[slot];
        const int32_t* qs = fq.data() + (int64_t)slot * n;
        L.nt = 0;
        int32_t* TOU = L.touch.data();
        uint64_t* TKE = L.tkey.data();
        const int32_t gen = gen0 + t;
        for (int q = 0; q < qc; q++) {
          const int i = qs[q];
          if (!MM[i]) {
            const int64_t e0 = sptr[i], e1 = sptr[i + 1];
            for (int64_t e = e0; e < e1; e++) {
              if (e + 12 < ecount) __builtin_prefetch(&ACC[ed[e + 12].post], 1);
              const int j = ed[e].post;
              Acc& a = ACC[j];
              if (a.gen != gen) {
                a.gen = gen; a.sum = ed[e].units;
                TOU[L.nt] = j; TKE[L.nt] = T | (prefix + (uint64_t)ed[e].off); L.nt++;
                __builtin_prefetch(&S_[j], 1);
              } else a.sum += ed[e].units;
            }
          }
          prefix += (uint64_t)(ptr[i + 1] - ptr[i]);
        }
        for (int k = 0; k < L.nt; k++) {  // one float add per target, in queue order
          if (k + 8 < L.nt) __builtin_prefetch(&S_[TOU[k + 8]], 1);
          const int j = TOU[k];
          const int32_t a = ACC[j].sum;
          Cell& c = S_[j];
          evolve(c, clk, c.drive);
          if (c.refr == 0) {
            add_units(c.g, a, WUNIT);
            if (!c.flag) { c.flag = 1; L.act.push_back(j); L.key.push_back(TKE[k]); }
          }
        }
        for (const int i : SP) { Cell& c = S_[i]; c.v = c.rest; c.g = 0.f; c.refr = (int16_t)rfc; }
        bar_wait();
      }
      if (r == 0 && steps > 0) flush((steps - 1) & 1, clock0 + steps - 1);
      const int64_t end = clock0 + steps - 1;
      for (int b0 = r * BL; b0 < n; b0 += R * BL)
        for (int i = b0, e = std::min(b0 + BL, n); i < e; i++) evolve(S_[i], end, S_[i].drive);
    };
    std::vector<std::thread> th;
    for (int r = 1; r < R; r++) th.emplace_back([&, r] { body(r); });
    body(0);
    for (auto& x : th) x.join();
    clock = clock0 + steps;
    int32_t na = 0;
    std::vector<const std::vector<int32_t>*> ids(R);
    std::vector<const std::vector<uint64_t>*> keys(R);
    for (int r = 0; r < R; r++) { ids[r] = &locals[r].act; keys[r] = &locals[r].key; }
    merge(ids, keys, [&](int32_t i) { active[na++] = i; });
    nactive = na;
  }

  // kernel_batch.cpp fast_advance, frozen weights, state kept in S between calls.
  void kernel_serial(int steps) {
    const int delay = (int)std::lround(1.8f / DT), rfc = (int)std::lround(2.2f / DT), slots = delay + 1;
    const float tau = adapt_tau;
    const float* T = tab.data();
    const bool FMA = acc_fma;
    Cell* s = S.data();
    auto evolve = [&](Cell& c, int64_t now, float current) {
      if (FMA) evolve_cell<true>(c, now, current, T, tau);
      else evolve_cell<false>(c, now, current, T, tau);
    };
    int32_t* act = active.data();
    auto awaken = [&](int i) {
      if (!s[i].flag) { s[i].flag = 1; act[nactive++] = i; }
    };
    for (int k = 0; k < n; k++) {
      const int i = order.empty() ? k : order[k];  // reference (old-index) scan order
      if (drive[i] != prev_drive[i]) {
        evolve(s[i], clock - 1, prev_drive[i]);
        prev_drive[i] = drive[i];
        s[i].drive = drive[i];
        awaken(i);
      }
    }
    const int64_t E = ptr[n];
    const int64_t* P = ptr.data();
    const int32_t* PO = post.data();
    const int32_t* WU = wunits.data();
    const uint8_t* MM = modmask.data();
    Acc* ACC = acc.data();
    int32_t* TO = touched.data();
    const float WUNIT = w_unit;
    if (acc_gen > 2000000000) { std::fill(acc.begin(), acc.end(), Acc{0, 0}); acc_gen = 0; }  // stamp wrap
    const vkbrain::Edge* ED = gpu_edges();  // set: the CSR lives in the GPU's buffer (same values, interleaved)
    for (int t = 0; t < steps; t++, clock++) {
      const int slot = (int)(clock % slots), future = (int)((clock + delay) % slots);
      std::vector<int32_t>& fq = ring[future];
      int kept = 0, original = nactive;
      for (int k = 0; k < original; k++) {
        if (k + 12 < original) __builtin_prefetch(&s[act[k + 12]], 1);
        const int i = act[k];
        Cell& c = s[i];
        evolve(c, clock, c.drive);
        if (c.refr == 0 && c.v > -45.f) {
          fq.push_back(i);
          counts[i]++;
          if (c.kc) c.adapt += adapt_jump;
        }
        const float gap = -45.f - c.rest;
        const bool can_fire = c.v > -45.f || c.drive > gap || c.drive + c.g > gap;
        if (can_fire) act[kept++] = i;
        else c.flag = 0;
      }
      nactive = kept;
      // deliveries: sum the integer units per target (associative, so no order to reproduce), then
      // ONE float add per target, in the queue's order -- the CPU and the GPU agree by construction
      std::vector<int32_t>& q = ring[slot];
      int nt = 0;
      const int32_t gen = ++acc_gen;
      for (size_t qi = 0; qi < q.size(); qi++) {
        const int i = q[qi];
        if (MM[i]) continue;
        const int64_t e1 = P[i + 1];
        if (ED) {
          for (int64_t e = P[i]; e < e1; e++) {
            if (e + 12 < E) __builtin_prefetch(&ACC[ED[e + 12].post], 1);
            const int j = ED[e].post;
            Acc& a = ACC[j];
            if (a.gen != gen) { a.gen = gen; a.sum = ED[e].units; TO[nt++] = j; __builtin_prefetch(&s[j], 1); }
            else a.sum += ED[e].units;
          }
          continue;
        }
        for (int64_t e = P[i]; e < e1; e++) {
          if (e + 12 < E) __builtin_prefetch(&ACC[PO[e + 12]], 1);
          const int j = PO[e];
          Acc& a = ACC[j];
          if (a.gen != gen) { a.gen = gen; a.sum = WU[e]; TO[nt++] = j; __builtin_prefetch(&s[j], 1); }
          else a.sum += WU[e];
        }
      }
      q.clear();
      for (int k = 0; k < nt; k++) {
        if (k + 8 < nt) __builtin_prefetch(&s[TO[k + 8]], 1);
        const int j = TO[k];
        const int32_t a = ACC[j].sum;
        Cell& c = s[j];
        evolve(c, clock, c.drive);
        if (c.refr == 0) {
          add_units(c.g, a, WUNIT);
          awaken(j);
        }
      }
      for (int32_t i : fq) {
        Cell& c = s[i];
        c.v = c.rest;
        c.g = 0.f;
        c.refr = (int16_t)rfc;
      }
    }
    for (int i = 0; i < n; i++) evolve(s[i], clock - 1, s[i].drive);
  }

  // channels.build_stim, in the sense dict's order; then R8 last (rgb_step appends it last)
  void stimulate(const J& ch) {
    for (auto& kv : ch.obj) {
      auto it = senses_ix.find(kv.first);
      if (it == senses_ix.end()) continue;
      const Sense& s = it->second;
      auto apply = [&](const std::vector<int32_t>& cells, double value) {
        float v = (float)std::min(1.5, std::max(0.0, value));
        if (!cells.empty() && v > 0) {
          const float amp = MAX_MV * v;  // numpy: python float * float32 -> float32
          for (int32_t i : cells) drive[i] += amp;
        }
      };
      const J& val = kv.second;
      if (val.k == J::OBJ) {
        for (const char* side : {"L", "R"}) {
          const J* x = val.get(side);
          double v = x && x->k == J::NUM ? x->num : 0.0;
          const std::vector<int32_t>* cells = nullptr;
          if (s.sided) cells = side[0] == 'L' ? &s.L : &s.R;
          else cells = &s.both;
          apply(*cells, v);
        }
      } else if (val.k == J::NUM) {
        if (s.sided) { apply(s.L, val.num); apply(s.R, val.num); }
        else apply(s.both, val.num);
      }
    }
  }

  // eye.build_eye: base64 of eye_ncol bytes (128 = no change) -> float32 contrast in [-1, 1]
  // -> ON into L5/Mi1, OFF into L1/L2/Tm1/Tm2/Tm9, in eye.py's type order. A column whose byte is
  // exactly 128 is skipped on both sides (an integer test), so a still scene costs nothing.
  void eye_inject(const J& ch) {
    if (eye_ncol <= 0) return;
    const J* p = ch.get("eye");
    if (!p || p->k != J::STR) return;
    if (p->str != eye_cache) {
      std::vector<uint8_t> dec;
      if (!b64_decode(p->str, dec) || (int)dec.size() != eye_ncol) { eye_cache.clear(); return; }
      eye_raw.swap(dec);
      eye_cache = p->str;
    }
    const float inv = 1.0f / 127.0f;
    for (int t = 0; t < EYE_T; t++) {
      const float mv = t < 3 ? eye_mv_lam : eye_mv_med;
      const int sg = EYE_SIGN[t];
      const int32_t* cells = eye_cells[t].data();
      const int32_t* col = eye_col[t].data();
      const size_t cnt = eye_cells[t].size();
      for (size_t k = 0; k < cnt; k++) {
        const uint8_t b = eye_raw[col[k]];
        if (b == 128) continue;
        const float c = ((float)b - 128.0f) * inv;
        const float v = sg > 0 ? c : -c;
        if (v <= 0.0f) continue;  // numpy maximum(x, 0) then a += of 0.0 -> the same drive
        drive[cells[k]] += mv * v;
      }
    }
  }

  static float srgb(float v) { return v <= 0.04045f ? v / 12.92f : std::pow((v + 0.055f) / 1.055f, 2.4f); }

  // one 10 ms chunk: VisualMemoryBrain.rgb_step -> MemoryBrain.step -> _neural_step -> kernel
  void chunk(const uint8_t* frame, int h, int w, const J& ch) {
    const int64_t t_sense = now_ns();
    const float f = (float)(1.0 - std::exp(-ticks_per_chunk * (double)DT / 10.0));  // == 1-exp(-1) at the reference tick
    // R8 adapter
    for (size_t k = 0; k < r8.size(); k++) {
      int x = std::min((int)(r8_uv[2 * k] * (w - 1)), w - 1);
      int y = std::min((int)(r8_uv[2 * k + 1] * (h - 1)), h - 1);
      float v = frame[(y * w + x) * 3 + r8ch[k]] / 255.0f;
      r8_light[k] += f * (srgb(v) - r8_light[k]);
    }
    // retinal samples (R1-R6 luminance)
    for (size_t k = 0; k < retina.size(); k++) {
      int x = std::max(0, std::min((int)(retina_uv[2 * k] * (w - 1)), w - 1));
      int y = std::max(0, std::min((int)(retina_uv[2 * k + 1] * (h - 1)), h - 1));
      const uint8_t* px = frame + (y * w + x) * 3;
      float lum = srgb(px[0] / 255.0f) * 0.2126f + srgb(px[1] / 255.0f) * 0.7152f + srgb(px[2] / 255.0f) * 0.0722f;
      lum = std::min(1.0f, std::max(0.0f, lum));
      luminance[k] += f * (lum - luminance[k]);
    }
    std::fill(drive.begin(), drive.end(), 0.0f);
    for (int32_t i : lamina) drive[i] = 12.0f;
    for (size_t k = 0; k < retina.size(); k++) drive[retina[k]] = 30.0f * luminance[k] / (0.02f + luminance[k]);
    stimulate(ch);
    eye_inject(ch);  // worker: stim = build_stim(...) + build_eye(...), then rgb_step appends R8
    for (size_t k = 0; k < r8.size(); k++) drive[r8[k]] += 30.0f * r8_light[k] / (0.02f + r8_light[k]);
    pre_before.resize(pl_edge.size());
    dan_before.resize(dan.size());
    for (size_t e = 0; e < pl_edge.size(); e++) pre_before[e] = counts[pl_pre[e]];
    for (size_t d = 0; d < dan.size(); d++) dan_before[d] = counts[dan[d]];
    prof.sense += now_ns() - t_sense;
    kernel(ticks_per_chunk);
    const int64_t t_pl = now_ns();
    plasticity();
    prof.plast += now_ns() - t_pl;
  }

  // worker.frame()
  void make_frame(std::vector<uint8_t>& img) {
    img.assign(8 * 16 * 3, 0);
    const J* retina_j = senses.get("retina");
    if (retina_j && retina_j->k == J::ARR && retina_j->arr.size() == 16 * 8 * 3) {
      for (size_t i = 0; i < img.size(); i++) img[i] = (uint8_t)std::min(255.0, std::max(0.0, retina_j->arr[i].num));
      return;
    }
    double l = REST_LIGHT, r = REST_LIGHT;
    const J* light = senses.get("light");
    if (light && light->k == J::OBJ) {
      const J* a = light->get("L");
      const J* b = light->get("R");
      l = a ? a->num : REST_LIGHT;
      r = b ? b->num : REST_LIGHT;
    } else if (light && light->k == J::NUM) {
      l = r = light->num;
    }
    auto q = [](double x) { return (uint8_t)std::nearbyint(255.0 * std::min(1.0, std::max(0.0, x))); };
    uint8_t lv = q(l), rv = q(r);
    for (int y = 0; y < 8; y++)
      for (int x = 0; x < 16; x++)
        for (int c = 0; c < 3; c++) img[(y * 16 + x) * 3 + c] = x < 8 ? lv : rv;
  }

  // worker.advance(ms): counts over round(ms / 10) chunks
  void advance(double ms) {
    const int64_t t_c0 = now_ns();
    std::fill(counts.begin(), counts.end(), 0);
    if (on_gpu) vk->set_counts(counts.data());
    prof.counts += now_ns() - t_c0;
    std::vector<uint8_t> img;
    int chunks = (int)std::lround(ms / CHUNK_MS);
    for (int c = 0; c < chunks; c++) {
      const int64_t t_s0 = now_ns();
      J ch = senses;
      for (auto& p : pulses)
        if (p.second > 0) {
          J one;
          one.k = J::NUM;
          one.num = 1.0;
          bool found = false;
          for (auto& kv : ch.obj)
            if (kv.first == p.first) { kv.second = one; found = true; }
          if (!found) ch.obj.emplace_back(p.first, one);
        }
      make_frame(img);
      prof.sense += now_ns() - t_s0;
      chunk(img.data(), 8, 16, ch);
      for (auto& p : pulses) p.second = std::max(0.0, p.second - CHUNK_MS);
    }
  }

  // The hop's phase table, in ms. Published by fb_prof (the module's stats(), which the LENS row
  // already prints as `core=`) and inside the step message.
  std::string prof_json() const {
    auto ms = [](int64_t ns) { return ns / 1e6; };
    std::string o = "{";
    num(o, "gpu", ms(prof.gpu), 1, false);
    num(o, "busy", prof.busy, 1);
    num(o, "drive", ms(prof.drive), 1);
    num(o, "counts", ms(prof.counts), 1);
    num(o, "push", ms(prof.push), 1);
    num(o, "pull", ms(prof.pull), 1);
    num(o, "cpu", ms(prof.cpu), 1);
    num(o, "sense", ms(prof.sense), 1);
    num(o, "plast", ms(prof.plast), 1);
    num(o, "read", ms(prof.read), 1);
    num(o, "msg", ms(prof.msg), 1);
    o += ",\"gc\":" + std::to_string(prof.gpu_chunks) + ",\"cc\":" + std::to_string(prof.cpu_chunks);
    num(o, "step", last_wall_ms, 1);
    return o + "}";
  }

  void rates(double ms, std::vector<double>& out) {
    const double s = ms / 1000.0;
    out.resize(reads.size());
    for (size_t k = 0; k < reads.size(); k++) {
      int64_t sum = 0;
      for (int32_t i : reads[k].ix) sum += counts[i];
      out[k] = (double)sum / ((double)std::max<size_t>(1, reads[k].ix.size()) * s);
    }
  }

  int read_index(const char* name) const {
    for (size_t k = 0; k < reads.size(); k++)
      if (reads[k].name == name) return (int)k;
    return -1;
  }

  void handle(const std::string& raw) {
    J m;
    if (!parse_json(raw.c_str(), m) || m.k != J::OBJ) return;
    if (const J* s = m.get("senses"); s && s->k == J::OBJ) {
      J next;
      next.k = J::OBJ;
      const J* light = senses.get("light");
      J lightv;
      if (light) lightv = *light;
      else { lightv.k = J::NUM; lightv.num = REST_LIGHT; }
      next.obj.emplace_back("light", lightv);
      for (auto& kv : s->obj) {
        bool found = false;
        for (auto& nk : next.obj)
          if (nk.first == kv.first) { nk.second = kv.second; found = true; }
        if (!found) next.obj.push_back(kv);
      }
      senses = std::move(next);
      senses_fresh = SENSES_STALE_STEPS;
    }
    if (const J* c = m.get("cloud"); c && c->k == J::BOOL) cloud_on = c->b;
    if (const J* l = m.get("learning"); l && l->k == J::BOOL) learning = l->b;
    // ADR 67: scale the APL->KC synapses. 1.0 = the file exactly; higher = a sparser odour code.
    if (const J* g = m.get("kc_inh_gain"); g && g->k == J::NUM) {
      kc_inh_gain = std::max(0.0, std::min(64.0, g->num));
      write_kc_inh();
    }
    // DETERMINISM.md: which evolve both kernels run. "plain" (default) needs nothing but correctly
    // rounded +, - and *; "fma" is the pre-16.09 fused form, for A/B on a driver that fails the check.
    if (const J* a = m.get("acc"); a && a->k == J::STR && (a->str == "plain" || a->str == "fma")) {
      const bool want = a->str == "fma";
      if (want != acc_fma) {
        acc_fma = want;
        if (vk) { if (on_gpu) { gpu_pull(); on_gpu = false; } vk->set_acc(acc_fma ? 1 : 0); }
      }
    }
    if (const J* t = m.get("threads"); t && t->k == J::NUM) set_threads((int)t->num);
    if (const J* d = m.get("dt"); d && d->k == J::NUM) set_dt(d->num);
    if (const J* u = m.get("duty"); u && u->k == J::NUM) duty = std::max(0.1, std::min(1.0, u->num));
    if (const J* p = m.get("pause"); p && p->k == J::BOOL) paused.store(p->b);
    if (const J* g = m.get("gpu"); g && g->k == J::NUM) set_gpu(g->num);
    if (const J* g = m.get("gpu_check"); g && g->k == J::NUM) {
      // the check brings the backend up if needed and leaves the engine choice as it was (a lens
      // that asked from the GPU stays on the GPU; the Mac test that asked from the CPU stays there)
      const double keep = gpu_frac;
      if (!vk) set_gpu(1.0);
      if (vk) gpu_check((int)g->num);
      gpu_frac = vk ? keep : 0;
      if (gpu_frac >= 1.0) gpu_acc = 1.0;
    }
    if (const J* p = m.get("pulse"); p && p->k == J::STR) {
      // the US: 200 ms of current into the channel's own cells. "reward" = PAM11, "punish" = PPL101
      // (channels.py); both are modulatory, so they deliver no synaptic current and can only act
      // through the learning rule. Any other name is still accepted: it is just a sense channel.
      pulses[p->str] = 200.0;
      if (p->str == "reward") rewards++;
      else if (p->str == "punish") punishes++;
    }
    // ADR 62: the plastic state as a portable blob. get -> a queued {"t":"memory"} message the host
    // reads with the same fb_take; set -> load it (optionally aged by `elapsed_s` seconds of being
    // switched off); clear -> back to a naive fly without touching the rest of the brain.
    if (const J* mm = m.get("memory"); mm && mm->k == J::STR) {
      if (mm->str == "get") {
        const J* c = m.get("compact");
        const std::string data = memory_save(c && c->k == J::BOOL && c->b);
        std::string o = memory_msg("get", "");
        o += ",\"bytes\":" + std::to_string(data.size() * 3 / 4);
        o += ",\"data\":\"" + data + "\"}";
        publish_q(o);
      } else if (mm->str == "echo") {
        // the memory's own self-check, the twin of gpu_check: save and load back in the SAME instant.
        // If the blob carried everything, nothing in the brain moves and every later spike is the
        // spike the uninterrupted run would have had. That is the round-trip proof (ADR 62).
        std::string err, data = memory_save();
        memory_load(data, 0.0, err);
        std::string o = memory_msg("echo", err.c_str());
        o += ",\"bytes\":" + std::to_string(data.size() * 3 / 4) + "}";
        publish_q(o);
      } else if (mm->str == "clear") {
        memory_clear();
        publish_q(memory_msg("clear", "") + "}");
      } else if (mm->str == "set") {
        const J* d = m.get("data");
        const J* el = m.get("elapsed_s");
        std::string err;
        if (!d || d->k != J::STR) err = "no data";
        else if (!memory_load(d->str, el && el->k == J::NUM ? std::max(0.0, el->num) : 0.0, err)) { /* err set */ }
        std::string o = memory_msg("set", err.c_str());
        num(o, "elapsed_s", el && el->k == J::NUM ? el->num : 0.0, 1);
        o += std::string(",\"approx\":") + (mem_approx ? "true" : "false");
        publish_q(o + "}");
      }
    }
    if (const J* r = m.get("reset"); r && r->k == J::BOOL && r->b) {
      reset_state();
      advance(200);
      smooth = base;
    }
  }

  void drain() {
    std::vector<std::string> msgs;
    {
      std::lock_guard<std::mutex> lk(in_mu);
      msgs.swap(inbox);
    }
    for (auto& s : msgs) handle(s);
  }

  static void num(std::string& o, const char* key, double v, int dec, bool comma = true) {
    char buf[64];
    double p = std::pow(10.0, dec);
    double r = std::nearbyint(v * p) / p;
    if (r == 0) r = 0;  // no "-0"
    snprintf(buf, sizeof buf, "%s\"%s\":%.*f", comma ? "," : "", key, dec, r);
    o += buf;
  }

  static std::string b64(const std::vector<uint8_t>& in) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string o;
    o.reserve((in.size() + 2) / 3 * 4);
    size_t i = 0;
    for (; i + 2 < in.size(); i += 3) {
      uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
      o += T[(v >> 18) & 63]; o += T[(v >> 12) & 63]; o += T[(v >> 6) & 63]; o += T[v & 63];
    }
    if (i < in.size()) {
      uint32_t v = in[i] << 16;
      if (i + 1 < in.size()) v |= in[i + 1] << 8;
      o += T[(v >> 18) & 63]; o += T[(v >> 12) & 63];
      o += i + 1 < in.size() ? T[(v >> 6) & 63] : '=';
      o += '=';
    }
    return o;
  }

  const char* warmup() {
    drain();
    advance(800);
    advance(500);
    rates(500, base);
    smooth = base;
    warmed = true;
    release_memory();  // again once everything has settled: an allocator defers the big reclaims
    std::string o = "{\"t\":\"ready\",\"fly\":" + std::to_string(fly) + ",\"gpu\":\"" + (vk ? vk->device_name() : gpu_err.empty() ? "off" : gpu_err) +
                    "\",\"acc\":\"" + (acc_fma ? "fma" : "plain") + "\",\"wk\":" + std::to_string(w_k) +
                    ",\"wq\":" + std::to_string(w_quantum) + ",\"wexact\":" + (w_exact ? "true" : "false") + ",\"baseline\":{";
    for (size_t k = 0; k < reads.size(); k++) num(o, reads[k].name.c_str(), base[k], 1, k > 0);
    o += "},\"channels\":{";
    bool first = true;
    for (auto& kv : senses_ix) {
      o += (first ? "\"" : ",\"") + kv.first + "\":{";
      first = false;
      if (kv.second.sided)
        o += "\"L\":" + std::to_string(kv.second.L.size()) + ",\"R\":" + std::to_string(kv.second.R.size());
      else
        o += "\"both\":" + std::to_string(kv.second.both.size());
      o += "}";
    }
    o += "},\"engine\":\"native\"}";
    last_msg = o;
    return last_msg.c_str();
  }

  static double peak(const J* v) {
    if (!v) return 0.0;
    if (v->k == J::NUM) return v->num;
    if (v->k == J::OBJ) {
      double m = 0.0;
      bool any = false;
      for (auto& kv : v->obj)
        if (kv.second.k == J::NUM) { m = any ? std::max(m, kv.second.num) : kv.second.num; any = true; }
      return any ? std::max(0.0, m) : 0.0;
    }
    return 0.0;
  }

  const char* step() {
    if (!warmed) warmup();
    drain();
    prof.clear();
    gpu_hop_ms = 0;
    auto t0 = std::chrono::steady_clock::now();
    advance(step_ms);
    auto t1 = std::chrono::steady_clock::now();
    const int64_t t_read = now_ns();
    if (senses_fresh > 0 && --senses_fresh == 0) {  // ADR 104: the packet went stale -> the room is quiet
      J n; n.k = J::OBJ;
      J l; l.k = J::NUM; l.num = REST_LIGHT;
      n.obj.emplace_back("light", l);
      senses = std::move(n);
    }
    rates(step_ms, rate);
    const double alpha = 1.0 - std::exp(-step_ms / SMOOTH_MS);
    for (size_t k = 0; k < smooth.size(); k++) smooth[k] += alpha * (rate[k] - smooth[k]);
    std::map<std::string, double> act;
    decode(act);
    const bool frozen = peak(senses.get("odor")) > ATTRACT_FREEZE;
    const double kb = step_ms / BASE_TAU_MS;
    for (size_t k = 0; k < base.size(); k++) {
      const std::string& nm = reads[k].name;
      const bool attract = nm == "DNp66_L" || nm == "DNp66_R" || nm == "appetite" || nm == "feed";
      // ADR 100 (21.09): the grooming pool is a LOAD readout -- GROOM_RANGE_HZ was measured as DNg12's
      // rise over its ~1.4 Hz rest -- not a change detector. Habituating it made `groom` a high-pass of
      // the bristle load: 433 telemetry rows with the bristles full read groom 0.02, peaks 0.1-0.27 only
      // on the load's rising edge, gone in ~10 s (the 8 s BASE_TAU). Its baseline stays at the warm-up
      // rest, exactly as the attract readouts do near odour.
      const bool load = nm == "groom_L" || nm == "groom_R";
      if (!(frozen && attract) && !load) base[k] += (smooth[k] - base[k]) * kb;
    }
    auto t2 = std::chrono::steady_clock::now();
    prof.read += now_ns() - t_read;
    const int64_t t_msg = now_ns();
    const double seconds = step_ms / 1000.0;
    int64_t spikes = 0;
    for (int32_t c : counts) spikes += c;
    const double adv_ms = std::chrono::duration<double, std::milli>(t1 - t0).count();
    last_wall_ms = std::chrono::duration<double, std::milli>(t2 - t0).count();

    std::string o;
    o.reserve(8192);
    o += "{\"t\":\"brain\",\"fly\":" + std::to_string(fly);
    num(o, "sim_ms", clock * (double)DT, 1);
    num(o, "wall_ms", last_wall_ms, 0);
    o += ",\"prof\":{";
    num(o, "adv", adv_ms, 0, false);
    num(o, "dec", std::chrono::duration<double, std::milli>(t2 - t1).count(), 0);
    o += "},\"act\":{";
    bool first = true;
    for (auto& kv : act) { num(o, kv.first.c_str(), kv.second, 3, !first); first = false; }
    auto sm = [&](const char* k) { int i = read_index(k); return i < 0 ? 0.0 : smooth[i]; };
    o += "},\"neural\":{";
    num(o, "arousal_hz", (double)spikes / (n * seconds), 2, false);
    num(o, "reward_hz", sm("reward"), 1);
    num(o, "stress_hz", sm("stress"), 1);
    num(o, "fear", std::max(act["escape_L"], act["escape_R"]), 3);
    num(o, "appetite", act["appetite"], 3);
    num(o, "feeding", act["feed"], 3);
    num(o, "attention", act["orient"], 3);
    o += ",\"spikes\":" + std::to_string(spikes);
    o += "},\"hz\":{";
    for (size_t k = 0; k < reads.size(); k++) num(o, reads[k].name.c_str(), smooth[k], 1, k > 0);
    o += "},\"regions\":{";
    for (size_t k = 0; k < regions.size(); k++) {
      int64_t sum = 0;
      for (int32_t i : regions[k].ix) sum += counts[i];
      num(o, regions[k].name.c_str(), (double)sum / ((double)std::max<size_t>(1, regions[k].ix.size()) * seconds), 2, k > 0);
    }
    o += "}";
    if (cloud_on && !cloud.empty()) {
      std::vector<uint8_t> bits((cloud.size() + 7) / 8, 0);
      for (size_t k = 0; k < cloud.size(); k++)
        if (counts[cloud[k]] > 0) bits[k >> 3] |= (uint8_t)(0x80 >> (k & 7));
      o += ",\"cloud\":\"" + b64(bits) + "\"";
    }
    if (!pl_edge.empty()) {  // memory state for the board / telemetry
      double eff = 0.0;
      int changed = 0;
      for (size_t e = 0; e < mem_w.size(); e++) {
        eff += 1.0 + mem_w[e];
        changed += mem_w[e] != 0.0;
      }
      o += std::string(",\"memory\":{\"learning\":") + (learning ? "true" : "false");
      num(o, "mean_efficacy", eff / mem_w.size(), 4);
      o += ",\"changed\":" + std::to_string(changed) + ",\"edges\":" + std::to_string(mem_w.size());
      // >>> ADR 67 (trainer agent): the memory OF THE CUE THAT IS ON RIGHT NOW. `mean_efficacy`
      // averages all 7,835 synapses, of which more than half are never driven by any one odour, so
      // a cue-specific change disappears into it. `eff_on` is the mean over just the plastic edges
      // whose presynaptic Kenyon cell spiked in this step, and `n_on` how many that was. Presenting
      // CS+ and CS- in turn and reading this is the direct test of cue-specific memory. <<<
      double eon = 0.0;
      int non = 0;
      for (size_t e = 0; e < mem_w.size(); e++)
        if (counts[pl_pre[e]] > 0) { eon += 1.0 + mem_w[e]; non++; }
      num(o, "eff_on", non ? eon / non : 1.0, 5);
      o += ",\"n_on\":" + std::to_string(non);
      o += ",\"rewards\":" + std::to_string(rewards) + ",\"punishes\":" + std::to_string(punishes);
      num(o, "since_ms", last_change_ms < 0 ? -1.0 : clock * (double)DT - last_change_ms, 0);
      o += "}";
    }
    num(o, "dt", DT, 2);
    num(o, "gpu", gpu_frac, 2);
    o += std::string(",\"gpu_on\":") + (on_gpu ? "true" : "false");
    num(o, "gpu_ms", gpu_hop_ms, 0);        // the WHOLE hop on the GPU (was: the last 10 ms chunk only)
    num(o, "gpu_chunk_ms", gpu_last_ms, 0); // the last chunk, what `gpu_ms` used to mean
    o += ",\"phases\":" + prof_json();  // where the hop went, ms (fb_prof / stats())
    if (!gpu_err.empty()) o += ",\"gpu_err\":\"" + gpu_err + "\"";
    if (!gpu_check_json.empty()) { o += ",\"gpu_check\":" + gpu_check_json; gpu_check_json.clear(); }
    o += ",\"thr\":" + std::to_string(threads);
    o += std::string(",\"acc\":\"") + (acc_fma ? "fma" : "plain") + "\"";
    num(o, "duty", duty, 2);
    if (!kc_inh_edge.empty()) num(o, "kc_inh", kc_inh_gain, 2);  // ADR 67: the APL->KC gain in force
    o += ",\"paused\":"; o += paused.load() ? "true" : "false";
    o += ",\"engine\":\"native\"}";
    prof.msg += now_ns() - t_msg;
    last_msg.swap(o);
    return last_msg.c_str();
  }

  // channels.decode, line for line (Python floats = double)
  void decode(std::map<std::string, double>& out) {
    std::map<std::string, double> d;
    for (size_t k = 0; k < reads.size(); k++) d[reads[k].name] = smooth[k] - base[k];
    auto g = [&](const char* k) { auto it = d.find(k); return it == d.end() ? 0.0 : it->second; };
    auto clip = [](double x, double lo = 0.0, double hi = 1.0) { return std::min(hi, std::max(lo, x)); };
    auto dead = [](double x, double zone) { return std::fabs(x) < zone ? 0.0 : (x - zone * (x > 0 ? 1 : -1)) / (1 - zone); };
    const double esc_l = clip(g("esc_L") / 100), esc_r = clip(g("esc_R") / 100);
    const double stop = clip(g("stop") / 80);
    const double appetite = clip(g("appetite") / 40);
    const double turn = dead(clip((g("DNa02_R") - g("DNa02_L")) / 60, -1, 1), 0.35);
    const double orient = dead(clip((g("DNp66_R") - g("DNp66_L")) / 50, -1, 1), 0.2);
    const double avoid = dead(clip((g("DNp03_L") - g("DNp03_R")) / 120.0, -1, 1), 0.15);
    const double sacc_r = g("DNa15_R") - g("DNb01_R");
    const double sacc_l = g("DNa15_L") - g("DNb01_L");
    const double ves = clip(g("VES041") / 40.0);
    const double sacc = dead(clip((sacc_r - sacc_l) / 60.0, -1, 1), 0.2) * (1.0 - ves);
    const double approach = std::max(appetite, 0.8 * std::fabs(orient));
    const double back = std::fabs(orient) < 0.2 ? clip(g("back") / 20) : 0.0;
    const double power = (g("power_L") + g("power_R")) / 2;
    auto pool = [&](const std::string& nm) { return (g((nm + "_L").c_str()) + g((nm + "_R").c_str())) / 2; };
    // ADR 106 (21.09): 12 Hz was the isolated probe's rise; in the live brain a full bristle load lifts
    // DNg12 ~3.5 Hz over rest (BODY_SIG groom 0.23-0.34 at dust 1.0 with ADR 100). 5 Hz = full load ~0.7.
    const double groom = clip(pool("groom") / 5.0);
    const double neck = dead(clip((g("neck_R") - g("neck_L")) / 8.0, -1, 1), 0.15);
    const double ant = clip(pool("ant") / 18.0, -1, 1);
    const double prob = clip(pool("prob") / 10.0);
    const double abd = clip(pool("abd") / 6.0, -1, 1);
    const double legs = clip((pool("legf") + pool("legm") + pool("legh")) / (3 * 3.0), -1, 1);
    const double fixation = clip(((g("DNp66_L") + g("DNp66_R")) / 2) / 50.0);
    const double drive_ = std::max(fixation, 0.8 * std::fabs(orient));
    double thrust;
    if (d.count("power_L")) thrust = clip(0.45 + 0.65 * drive_ + power / 48.0 + g("dng02") / 20.0);
    else thrust = clip(0.25 + 0.75 * approach);
    out["turn"] = turn;
    out["orient"] = orient;
    out["avoid"] = avoid;
    out["steer"] = clip(turn + orient + avoid, -1, 1);
    out["sacc"] = sacc;
    out["escape_L"] = esc_l;
    out["escape_R"] = esc_r;
    out["stop"] = stop;
    out["back"] = back;
    out["feed"] = clip(g("feed") / 30);
    out["appetite"] = appetite;
    out["thrust"] = thrust;
    out["forward"] = clip(thrust - stop - std::max(esc_l, esc_r));
    out["groom"] = groom;
    out["neck"] = neck;
    out["ant"] = ant;
    out["prob"] = prob;
    out["abd"] = abd;
    out["legs"] = legs;
    for (const char* k : {"legf_L", "legf_R", "legm_L", "legm_R", "legh_L", "legh_R"}) out[k] = clip(g(k) / 3.0, -1, 1);
  }

  // On a Linux host the brain thread runs at nice +10 so the host's own threads win every contest for
  // a core: set on the loop thread, inherited by the per-chunk workers (a thread is a task there).
  // The Mac host is unaffected.
  static void lower_thread_priority() {
#if defined(__linux__)
    setpriority(PRIO_PROCESS, (id_t)syscall(SYS_gettid), 10);
#endif
  }

  void loop() {
    lower_thread_priority();
    const char* msg = warmup();
    publish(msg);
    while (running.load()) {
      if (paused.load()) { // the page is the brain: zero CPU here, the state stays warm for the takeover
        drain();  // the inbox is ONLY read here and in step(): without this, {"pause":false} never arrives
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        continue;
      }
      msg = step();
      publish(msg);
      // duty cycle: sleep so that the brain's share of wall time is `duty`
      if (duty < 1.0 && running.load())
        std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(last_wall_ms * (1.0 / duty - 1.0)));
    }
  }

  void publish(const char* msg) {
    std::lock_guard<std::mutex> lk(out_mu);
    outbox = msg;
    out_new = true;
  }

  /** A message that must survive to the next fb_take (a memory blob): queued, never overwritten. */
  void publish_q(const std::string& msg) {
    std::lock_guard<std::mutex> lk(out_mu);
    if (outq.size() > 8) outq.pop_front();  // a host that never reads must not grow the queue
    outq.push_back(msg);
  }
};

extern "C" {

const char* fb_last_error(void) { return g_error.c_str(); }

fb_brain* fb_create(const uint8_t* data, size_t len, double step_ms, int fly) {
  // zlib-compressed brain file (export.py writes <name>.flyb.z, ~37 % of the size for the Wi-Fi fetch)
  std::vector<uint8_t> inflated;
  if (len > 2 && data[0] == 0x78 && memcmp(data, "FLYB", 4) != 0) {
    z_stream zs{};
    if (inflateInit(&zs) != Z_OK) { g_error = "inflateInit failed"; return nullptr; }
    inflated.resize(len * 3);
    zs.next_in = (Bytef*)data;
    zs.avail_in = (uInt)len;
    int rc = Z_OK;
    while (rc != Z_STREAM_END) {
      if (zs.total_out >= inflated.size()) inflated.resize(inflated.size() + inflated.size() / 2);
      zs.next_out = inflated.data() + zs.total_out;
      zs.avail_out = (uInt)(inflated.size() - zs.total_out);
      rc = inflate(&zs, Z_NO_FLUSH);
      if (rc != Z_OK && rc != Z_STREAM_END) { inflateEnd(&zs); g_error = "brain file inflate failed"; return nullptr; }
    }
    inflated.resize(zs.total_out);
    inflateEnd(&zs);
    data = inflated.data();
    len = inflated.size();
  }
  auto* b = new fb_brain;
  b->step_ms = step_ms > 0 ? step_ms : 50.0;
  b->fly = fly;
  if (!b->load(data, len)) {
    delete b;
    return nullptr;
  }
  return b;
}

void fb_destroy(fb_brain* b) {
  if (!b) return;
  fb_stop(b);
  delete b;
}

void fb_post(fb_brain* b, const char* json) {
  if (!b || !json) return;
  std::lock_guard<std::mutex> lk(b->in_mu);
  b->inbox.emplace_back(json);
}

const char* fb_warmup(fb_brain* b) { return b ? b->warmup() : ""; }
const char* fb_step(fb_brain* b) { return b ? b->step() : ""; }

int fb_start(fb_brain* b) {
  if (!b || b->running.load()) return 0;
  b->running = true;
  b->th = std::thread([b] { b->loop(); });
  return 1;
}

void fb_stop(fb_brain* b) {
  if (!b || !b->running.load()) return;
  b->running = false;
  if (b->th.joinable()) b->th.join();
}

int fb_take(fb_brain* b, char* buf, int cap) {
  if (!b) return 0;
  std::lock_guard<std::mutex> lk(b->out_mu);
  if (!b->outq.empty()) {  // queued messages (memory blobs) go first and are never dropped
    const int need = (int)b->outq.front().size() + 1;
    if (need > cap) return need;
    memcpy(buf, b->outq.front().c_str(), need);
    b->outq.pop_front();
    return need - 1;
  }
  if (!b->out_new) return 0;
  const int need = (int)b->outbox.size() + 1;
  if (need > cap) return need;
  memcpy(buf, b->outbox.c_str(), need);
  b->out_new = false;
  return need - 1;
}

void fb_set_threads(fb_brain* b, int threads) {
  if (b) b->set_threads(threads);
}

/** The last step's spikes as a bitset over ALL n neurons, MSB-first (the same packing the `cloud`
 *  bits use). Returns the byte count needed; writes only if `out` is non-null and `cap` is enough.
 *  Read-only — it touches no model state, so a host may call it after every fb_step. The web page
 *  uses it to light all 166,700 neurons instead of the 16,000-neuron `cloud` sample (ADR 61). */
int fb_spikes_all(fb_brain* b, unsigned char* out, int cap) {
  if (!b) return 0;
  const int need = (int)((b->n + 7) / 8);
  if (!out || cap < need) return need;
  for (int i = 0; i < need; i++) out[i] = 0;
  for (int32_t i = 0; i < b->n; i++)
    if (b->counts[i] > 0) out[i >> 3] |= (unsigned char)(0x80 >> (i & 7));
  return need;
}

/** The last hop's phase table as JSON (see fb_brain::prof_json). Read-only; the module puts it in
 *  stats(), so it rides the LENS telemetry row that already prints `core=`. */
int fb_prof(fb_brain* b, char* out, int cap) {
  if (!b) return 0;
  const std::string s = b->prof_json();
  const int need = (int)s.size() + 1;
  if (!out || cap < need) return need;
  memcpy(out, s.c_str(), need);
  return need - 1;
}

void fb_stats(fb_brain* b, double* out4) {
  if (!b || !out4) return;
  out4[0] = b->n;
  out4[1] = (double)b->ptr[b->n];
  out4[2] = b->nactive;
  out4[3] = b->last_wall_ms;
}

}  // extern "C"
