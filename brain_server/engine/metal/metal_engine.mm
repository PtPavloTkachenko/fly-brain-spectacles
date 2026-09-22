// Host side of the Metal brain kernel (see brain.metal, RESULTS.md). Called from Python via ctypes.
//
//   mtl_create : compile brain.metal, upload the shared connectome, allocate per-fly buffers
//   mtl_field  : CPU pointer of a per-fly state field buffer (Python makes numpy views of it,
//                so the fly's brain.fields ARE the GPU buffers: unified memory, zero copy)
//   mtl_run    : advance a batch of flies by `steps` ticks each in ONE command buffer
//                (begin + 2 dispatches per 0.1 ms tick + end), then replay the float64
//                KC eligibility trace on the CPU with the CPU kernel's exact expression.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>

namespace {
struct Edge { int32_t post; float w; };
struct FlyCall { int64_t clock0; int32_t steps; int32_t fly; };
enum {
  P_PTR, P_EDGES, P_MODMASK, P_KC, P_REST, P_AV, P_AG, P_AA, P_MTAB,
  P_V, P_G, P_REFR, P_DRIVE, P_PREV, P_QUEUE, P_QCOUNT, P_COUNTS, P_ACTIVE, P_FLAGS,
  P_NACTIVE, P_LAST, P_MOD, P_MLAST, P_ADAPT,
  P_CELLS, P_KEY, P_ACT, P_SPKEY, P_SPID, P_PREFIX, P_HEAD, P_TOUCHED, P_NXT, P_RECV,
  P_KCLOG, P_SORTK, P_SORTID, P_CTR, P_CALL, P_SCR, P_COUNT
};
struct Globals {
  uint64_t p[P_COUNT];
  int32_t n, slots, delay, rfc, TA, TM, NP, kcap, CS, MAXT, ga1, ga2, gb1, nblk;
  uint32_t E;
  float adapt_jump, tau, tau20;
  int32_t scap, pad2;
};
static_assert(sizeof(Globals) == 8 * P_COUNT + 20 * 4, "Globals layout");
constexpr int SCAP = 1 << 22;  // per-fly scratch for sorting multi-hit targets' deliveries (per tick)
constexpr int MAXT = 1024;
constexpr int TGS = 256;
constexpr int LOCALSORT = 2048;

struct Engine {
  id<MTLDevice> dev;
  id<MTLCommandQueue> queue;
  id<MTLComputePipelineState> kbegin, ka, kb, kend, kblk, krank;
  id<MTLBuffer> buf[P_COUNT];
  id<MTLBuffer> gbuf;
  int n = 0, nfly = 0, slots = 19, delay = 18, rfc = 22, NP = 0, kcap = 0, CS = 0, TA = 0, TM = 0;
  uint32_t E = 0;
  int ga1 = 64, ga2 = 64, gb1 = 64;
  float tab_dt = 0, tab_tau = 0;
  std::mutex run_mutex;
};

id<MTLBuffer> make(Engine* e, size_t bytes, bool shared) {
  return [e->dev newBufferWithLength:std::max<size_t>(bytes, 16)
                             options:shared ? MTLResourceStorageModeShared : MTLResourceStorageModePrivate];
}

int envint(const char* k, int d) { const char* s = getenv(k); return s ? atoi(s) : d; }

void set_err(char* err, int len, const char* msg) { if (err && len > 0) snprintf(err, len, "%s", msg); }

// Exp tables with the CPU kernel's exact expressions, extended until they reach 0.0f
// (the CPU uses the same expression for d >= 1024, so a longer table is the same function).
void build_tables(Engine* e, float dt, float adaptation_tau) {
  if (e->TA && dt == e->tab_dt && adaptation_tau == e->tab_tau) return;
  std::vector<float> av, ag, aa, mt;
  for (int i = 0;; i++) {
    av.push_back(std::exp(-dt * i / 20.f)); ag.push_back(std::exp(-dt * i / 5.f)); aa.push_back(std::exp(-dt * i / adaptation_tau));
    if (i >= 1024 && av.back() == 0.f && ag.back() == 0.f && aa.back() == 0.f) break;
  }
  for (int64_t d = 0;; d++) { mt.push_back(std::exp(-dt * d / 100.f)); if (d >= 1024 && mt.back() == 0.f) break; }
  e->TA = (int)av.size(); e->TM = (int)mt.size();
  e->buf[P_AV] = [e->dev newBufferWithBytes:av.data() length:4 * av.size() options:MTLResourceStorageModeShared];
  e->buf[P_AG] = [e->dev newBufferWithBytes:ag.data() length:4 * ag.size() options:MTLResourceStorageModeShared];
  e->buf[P_AA] = [e->dev newBufferWithBytes:aa.data() length:4 * aa.size() options:MTLResourceStorageModeShared];
  e->buf[P_MTAB] = [e->dev newBufferWithBytes:mt.data() length:4 * mt.size() options:MTLResourceStorageModeShared];
  e->tab_dt = dt; e->tab_tau = adaptation_tau;
}
}  // namespace

extern "C" void* mtl_create(const char* metal_path, int n, int64_t E, const int64_t* ptr, const int32_t* post,
                            const float* weight, const uint8_t* modmask, const uint8_t* kc, const float* rest,
                            int nfly, int kcap, char* err, int errlen) {
  @autoreleasepool {
    if (E >= 0x7FFFFFFF) { set_err(err, errlen, "too many edges"); return nullptr; }
    auto* e = new Engine;
    e->dev = MTLCreateSystemDefaultDevice();
    if (!e->dev) { set_err(err, errlen, "no Metal device"); delete e; return nullptr; }
    NSError* nerr = nil;
    NSString* src = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:metal_path]
                                              encoding:NSUTF8StringEncoding error:&nerr];
    if (!src) { set_err(err, errlen, "cannot read brain.metal"); delete e; return nullptr; }
    MTLCompileOptions* opt = [MTLCompileOptions new];
    opt.mathMode = MTLMathModeSafe;
    opt.mathFloatingPointFunctions = MTLMathFloatingPointFunctionsPrecise;
    opt.languageVersion = MTLLanguageVersion3_2;
    id<MTLLibrary> lib = [e->dev newLibraryWithSource:src options:opt error:&nerr];
    if (!lib) { set_err(err, errlen, [[nerr description] UTF8String]); delete e; return nullptr; }
    auto pipe = [&](const char* name) -> id<MTLComputePipelineState> {
      NSError* pe = nil;
      id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:name]];
      id<MTLComputePipelineState> ps = fn ? [e->dev newComputePipelineStateWithFunction:fn error:&pe] : nil;
      if (!ps) set_err(err, errlen, pe ? [[pe description] UTF8String] : name);
      return ps;
    };
    e->kbegin = pipe("k_begin"); e->ka = pipe("k_tickA"); e->kb = pipe("k_tickB");
    e->kend = pipe("k_end"); e->kblk = pipe("k_blksort"); e->krank = pipe("k_rank");
    if (!e->kbegin || !e->ka || !e->kb || !e->kend || !e->kblk || !e->krank) { delete e; return nullptr; }
    e->queue = [e->dev newCommandQueue];
    e->n = n; e->nfly = nfly; e->E = (uint32_t)E; e->kcap = kcap;
    e->NP = 1; while (e->NP < n) e->NP <<= 1;
    e->CS = 5 * (MAXT + 1) + 8;
    e->ga1 = envint("MTL_GA1", 64); e->ga2 = envint("MTL_GA2", 128); e->gb1 = envint("MTL_GB1", 64);
    const size_t F = nfly, N = n;
    // shared connectome; rows of modulatory neurons carry |w|/.275f (the CPU's modulation increment)
    std::vector<uint32_t> p32(N + 1);
    for (size_t i = 0; i <= N; i++) p32[i] = (uint32_t)ptr[i];
    e->buf[P_PTR] = [e->dev newBufferWithBytes:p32.data() length:4 * (N + 1) options:MTLResourceStorageModeShared];
    e->buf[P_EDGES] = make(e, sizeof(Edge) * (size_t)E, true);
    Edge* ed = (Edge*)[e->buf[P_EDGES] contents];
    for (size_t i = 0; i < N; i++)
      for (int64_t k = ptr[i]; k < ptr[i + 1]; k++) ed[k] = {post[k], modmask[i] ? std::abs(weight[k]) / .275f : weight[k]};
    e->buf[P_MODMASK] = [e->dev newBufferWithBytes:modmask length:N options:MTLResourceStorageModeShared];
    e->buf[P_KC] = [e->dev newBufferWithBytes:kc length:N options:MTLResourceStorageModeShared];
    e->buf[P_REST] = [e->dev newBufferWithBytes:rest length:4 * N options:MTLResourceStorageModeShared];
    // per-fly fields (numpy views on the Python side)
    e->buf[P_V] = make(e, 4 * N * F, true); e->buf[P_G] = make(e, 4 * N * F, true);
    e->buf[P_REFR] = make(e, 2 * N * F, true); e->buf[P_DRIVE] = make(e, 4 * N * F, true);
    e->buf[P_PREV] = make(e, 4 * N * F, true); e->buf[P_QUEUE] = make(e, 4 * e->slots * N * F, true);
    e->buf[P_QCOUNT] = make(e, 4 * e->slots * F, true); e->buf[P_COUNTS] = make(e, 4 * N * F, true);
    e->buf[P_ACTIVE] = make(e, 4 * N * F, true); e->buf[P_FLAGS] = make(e, N * F, true);
    e->buf[P_NACTIVE] = make(e, 4 * F, true); e->buf[P_LAST] = make(e, 8 * N * F, true);
    e->buf[P_MOD] = make(e, 4 * N * F, true); e->buf[P_MLAST] = make(e, 8 * N * F, true);
    e->buf[P_ADAPT] = make(e, 4 * N * F, true);
    // GPU-only scratch
    e->buf[P_CELLS] = make(e, 32 * N * F, false); e->buf[P_KEY] = make(e, 8 * N * F, false);
    e->buf[P_ACT] = make(e, 4 * 2 * N * F, false); e->buf[P_SPKEY] = make(e, 8 * N * F, false);
    e->buf[P_SPID] = make(e, 4 * N * F, false); e->buf[P_PREFIX] = make(e, 4 * (N + 1) * F, false);
    e->buf[P_HEAD] = make(e, 4 * N * F, false); e->buf[P_TOUCHED] = make(e, 4 * N * F, false);
    e->buf[P_NXT] = make(e, 4 * (size_t)E * F, false); e->buf[P_RECV] = make(e, 4 * (size_t)E * F, false);
    e->buf[P_KCLOG] = make(e, 8 * (size_t)kcap * F, true);
    e->buf[P_SORTK] = make(e, 8 * (size_t)e->NP * F, false); e->buf[P_SORTID] = make(e, 4 * (size_t)e->NP * F, false);
    e->buf[P_CTR] = make(e, 4 * (size_t)e->CS * F, true); e->buf[P_CALL] = make(e, sizeof(FlyCall) * F, true);
    e->buf[P_SCR] = make(e, 4 * (size_t)SCAP * F, false);
    e->gbuf = make(e, sizeof(Globals), true);
    for (int k = 0; k < P_COUNT; k++)
      if (!e->buf[k] && k != P_AV && k != P_AG && k != P_AA && k != P_MTAB) { set_err(err, errlen, "buffer allocation failed"); delete e; return nullptr; }
    id<MTLCommandBuffer> cb = [e->queue commandBuffer];
    id<MTLBlitCommandEncoder> bl = [cb blitCommandEncoder];
    [bl fillBuffer:e->buf[P_HEAD] range:NSMakeRange(0, 4 * N * F) value:0xFF];  // empty target lists
    [bl endEncoding]; [cb commit]; [cb waitUntilCompleted];
    return e;
  }
}

extern "C" void* mtl_field(void* h, int id) {
  auto* e = (Engine*)h;
  if (id < 0 || P_V + id > P_ADAPT) return nullptr;
  return [e->buf[P_V + id] contents];
}

extern "C" void mtl_free(void* h) { delete (Engine*)h; }

// timing[0]=GPU ms, [1]=wall ms of the whole call, [2]=encode ms. Returns 0 on success.
extern "C" int mtl_run(void* h, int nb, const int32_t* flies, int64_t* clocks, const int32_t* steps, float dt,
                       float adapt_jump, float adapt_tau, float tau_elig_ms, double** elig, int64_t** elig_last,
                       double* timing) {
  @autoreleasepool {
    auto* e = (Engine*)h;
    std::lock_guard<std::mutex> guard(e->run_mutex);  // shared globals/call/ctr buffers: one run at a time
    const auto t0 = std::chrono::steady_clock::now();
    if (nb < 1 || nb > e->nfly) return -1;
    if (std::lround(1.8f / dt) != e->delay || std::lround(2.2f / dt) != e->rfc) return -2;
    int maxsteps = 0;
    for (int b = 0; b < nb; b++) {
      if (steps[b] < 1 || steps[b] > MAXT || flies[b] < 0 || flies[b] >= e->nfly) return -3;
      maxsteps = std::max(maxsteps, (int)steps[b]);
    }
    build_tables(e, dt, adapt_tau);
    const int n = e->n;
    auto* call = (FlyCall*)[e->buf[P_CALL] contents];
    auto* ctr = (uint32_t*)[e->buf[P_CTR] contents];
    const int32_t* nactive = (const int32_t*)[e->buf[P_NACTIVE] contents];
    for (int b = 0; b < nb; b++) {
      call[b] = {clocks[b], steps[b], flies[b]};
      uint32_t* c = ctr + (size_t)flies[b] * e->CS;
      memset(c, 0, 4 * (size_t)e->CS);
      c[0] = (uint32_t)nactive[flies[b]];
    }
    Globals G{};
    for (int k = 0; k < P_COUNT; k++) G.p[k] = e->buf[k].gpuAddress;
    G.n = n; G.slots = e->slots; G.delay = e->delay; G.rfc = e->rfc; G.TA = e->TA; G.TM = e->TM; G.NP = e->NP;
    G.kcap = e->kcap; G.CS = e->CS; G.MAXT = MAXT; G.ga1 = e->ga1; G.ga2 = e->ga2; G.gb1 = e->gb1;
    G.nblk = e->NP / LOCALSORT; G.E = e->E; G.scap = SCAP; G.adapt_jump = adapt_jump; G.tau = adapt_tau; G.tau20 = adapt_tau - 20.f;
    memcpy([e->gbuf contents], &G, sizeof G);

    // MTL_PROF=1: every role in its own dispatch + command buffer, GPU time summed per kind
    // (timing[3..9] = begin, A:phase1, A:records, B:targets, B:sort+prefix, end, empty A launch).
    // Same results (roles of one dispatch are independent); slower; diagnostics only.
    const bool prof = envint("MTL_PROF", 0) != 0;
    id<MTLResource> res[P_COUNT];
    for (int k = 0; k < P_COUNT; k++) res[k] = e->buf[k];
    const MTLSize tgs = MTLSizeMake(TGS, 1, 1);
    const int nbt = (n + TGS - 1) / TGS;
    std::vector<std::pair<int, id<MTLCommandBuffer>>> cbs;
    id<MTLCommandBuffer> cb = nil;
    id<MTLComputeCommandEncoder> enc = nil;
    auto open = [&](int kind) {
      if (enc && !prof) return;
      if (enc) { [enc endEncoding]; [cb commit]; }
      cb = [e->queue commandBuffer];
      cbs.push_back({kind, cb});
      enc = [cb computeCommandEncoderWithDispatchType:MTLDispatchTypeSerial];
      [enc setBuffer:e->gbuf offset:0 atIndex:0];
      [enc useResources:res count:P_COUNT usage:MTLResourceUsageRead | MTLResourceUsageWrite];
    };
    auto go = [&](int kind, id<MTLComputePipelineState> ps, size_t groups, const int* t, int roles) {
      open(kind);
      if (t) { [enc setBytes:t length:4 atIndex:1]; [enc setBytes:&roles length:4 atIndex:2]; }
      [enc setComputePipelineState:ps];
      [enc dispatchThreadgroups:MTLSizeMake(groups, 1, 1) threadsPerThreadgroup:tgs];
    };
    const size_t gA = (size_t)nb * (e->ga1 + e->ga2), gB = (size_t)nb * (e->gb1 + 1);
    go(0, e->kbegin, (size_t)nb * (nbt + 1), nullptr, 0);
    for (int t = 0; t < maxsteps; t++) {
      if (!prof) { go(1, e->ka, gA, &t, 3); go(3, e->kb, gB, &t, 3); continue; }
      go(1, e->ka, gA, &t, 1); go(2, e->ka, gA, &t, 2); go(6, e->ka, gA, &t, 0);
      go(3, e->kb, gB, &t, 1); go(4, e->kb, gB, &t, 2);
    }
    go(5, e->kend, (size_t)nb * nbt, nullptr, 0);
    go(5, e->kblk, (size_t)nb * (e->NP / LOCALSORT), nullptr, 0);
    go(5, e->krank, (size_t)nb * (e->NP / TGS), nullptr, 0);
    [enc endEncoding];
    const auto t1 = std::chrono::steady_clock::now();
    [cb commit];
    [cb waitUntilCompleted];
    double kind_ms[7] = {0, 0, 0, 0, 0, 0, 0};
    for (auto& [kind, c] : cbs) {
      if (c.status != MTLCommandBufferStatusCompleted) return -4;
      kind_ms[kind] += (c.GPUEndTime - c.GPUStartTime) * 1000.0;
    }
    // KC eligibility (float64; unused while learning is off): replay in tick order, CPU expression.
    const int32_t* log = (const int32_t*)[e->buf[P_KCLOG] contents];
    for (int b = 0; b < nb; b++) {
      const int f = flies[b];
      const uint32_t* c = ctr + (size_t)f * e->CS;
      const uint32_t nkc = c[5 * (MAXT + 1)], ovf = c[5 * (MAXT + 1) + 1];
      if (ovf || nkc > (uint32_t)e->kcap) return -5;
      double* el = elig[b];
      int64_t* ell = elig_last[b];
      const int32_t* L = log + 2 * (size_t)f * e->kcap;
      for (uint32_t k = 0; k < nkc; k++) {
        const int i = L[2 * k];
        const int64_t clk = clocks[b] + L[2 * k + 1];
        el[i] *= std::exp(-dt * (clk - ell[i]) / tau_elig_ms);
        el[i] += 1.;
        ell[i] = clk;
      }
      clocks[b] += steps[b];
    }
    const auto t2 = std::chrono::steady_clock::now();
    if (timing) {
      timing[0] = (cbs.back().second.GPUEndTime - cbs.front().second.GPUStartTime) * 1000.0;
      for (int k = 0; k < 7; k++) timing[3 + k] = kind_ms[k];
      timing[1] = std::chrono::duration<double, std::milli>(t2 - t0).count();
      timing[2] = std::chrono::duration<double, std::milli>(t1 - t0).count();
    }
    return 0;
  }
}
