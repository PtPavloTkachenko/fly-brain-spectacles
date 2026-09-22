// WebGPU backend of the brain core, for the Emscripten build of the web page (ADR 55).
//
// Same vkbrain::Brain interface as the Vulkan backend, so flybrain.cpp is untouched: it pushes the
// state, runs chunks, pulls the state, checks CPU vs GPU. The difference: WebGPU memory is not host
// visible, so this backend keeps host copies in the WASM heap and JS (web/brain_gpu.js) copies them
// to and from the GPU buffers: the whole state once at upload_all / fetch_all (engine switches and
// gpu_check), and per chunk only the io block (drive in, counts out). The JS functions are async
// (WebGPU readback is), so the module is built with Asyncify and fb_step is awaited from JS.
#include "vkbrain.h"

#include <emscripten.h>

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

namespace vkbrain {
namespace {
struct NConst { float rest; uint32_t kc, oldof, mod; };
struct IO { float prev, drive; int32_t counts, pad; };
constexpr int MAXT = 1024;
}  // namespace

// implemented in web/brain_gpu.js (a --js-library); pointers are byte offsets into the WASM heap
extern "C" {
int wgpu_create(int n, int E, const void* ptr32, const void* edges, const void* nc, const void* tab, int TA, int slots, int delay, int rfc,
                float adapt_jump, float tau, float w_unit, int acc, void* cells, void* io, void* queue, void* active, char* info, int infoCap);
int wgpu_run(int steps, int slot0, int nactive);  // -> nactive after the call, or -1 (error text in `info`)
void wgpu_upload_all(void);
void wgpu_fetch_all(void);
void wgpu_units(int e);   // a host edge changed: JS re-uploads that region before the next run
void wgpu_edges_all(void);  // the whole CSR from the host copy -> the GPU's e0..e3
void wgpu_acc(int acc);   // switch evolve between the plain and the fma form (DETERMINISM.md)
}

struct Brain::Impl {
  int n = 0, slots = 19, TA = 0;
  int64_t E = 0;
  std::vector<uint32_t> ptr32;
  std::vector<Edge> edges;
  std::vector<NConst> nc;
  std::vector<float> tab;
  std::vector<Cell> cells;
  std::vector<IO> io;
  std::vector<int32_t> queue;  // slots * n, then qcount[slots]
  std::vector<uint32_t> active;
  uint32_t nactive = 0;
  // The Vulkan backend's edges() IS mapped GPU memory, so the core's post-create fill (set_gpu, one
  // array at a time) lands on the device by itself. Here edges() is only the host copy in the WASM
  // heap, and wgpu_create uploaded whatever it held at that moment -- zeros, when the core fills it
  // afterwards. Nothing else ever pushes the whole array, so the GPU ran on an all-zero CSR: every
  // delivery was `units 0` into neuron 0, no synaptic current anywhere, and only the directly driven
  // populations (optic, sensory) could spike. false = the GPU's copy is still stale; the first run
  // pushes it.
  bool edges_up = false;
  char info[256] = {0};
};

Brain* Brain::create(const Params& p, std::string& err) {
  auto* br = new Brain;
  auto* im = new Impl;
  br->im_ = im;
  const int n = p.n;
  im->n = n; im->E = p.E; im->slots = p.slots;
  im->ptr32.resize(n + 1);
  for (int i = 0; i <= n; i++) im->ptr32[i] = (uint32_t)p.ptr[i];
  im->edges.resize((size_t)p.E);
  if (p.post && p.units) {  // otherwise the caller fills edges() itself, one array at a time
    for (int64_t e = 0; e < p.E; e++) im->edges[e] = {p.post[e], p.units[e]};
    im->edges_up = true;    // filled before wgpu_create, so its upload carried them
  }
  im->nc.resize(n);
  for (int i = 0; i < n; i++) im->nc[i] = {p.rest[i], (uint32_t)p.kc[i], (uint32_t)(p.old_of ? p.old_of[i] : i), (uint32_t)(p.modmask ? p.modmask[i] : 0)};
  im->TA = TAB_N;  // the decay tables come FROM the core (one source for both kernels, DETERMINISM.md)
  if (p.tab) im->tab.assign(p.tab, p.tab + (size_t)TAB_N * TAB_BLOCKS);
  else im->tab = build_decay_tables(p.DT, p.adapt_tau);
  im->cells.assign(n, Cell{});
  im->io.assign(n, IO{});
  im->queue.assign((size_t)p.slots * n + p.slots, 0);
  im->active.assign(n, 0);
  const int ok = wgpu_create(n, (int)p.E, im->ptr32.data(), im->edges.data(), im->nc.data(), im->tab.data(), im->TA, p.slots, p.delay, p.rfc,
                             p.adapt_jump, p.adapt_tau, p.w_unit, p.acc_fma, im->cells.data(), im->io.data(), im->queue.data(), im->active.data(),
                             im->info, (int)sizeof im->info);
  if (!ok) {
    err = std::string("webgpu: ") + im->info;
    delete br;
    return nullptr;
  }
  br->device_name_ = im->info;  // JS wrote the adapter's description here on success
  return br;
}

Brain::~Brain() { delete im_; }

Cell* Brain::cells() { return im_->cells.data(); }
Edge* Brain::edges() { return im_->edges.data(); }
void Brain::set_drive(const float* d) { for (int i = 0; i < im_->n; i++) im_->io[i].drive = d[i]; }
void Brain::set_prev(const float* pv) { for (int i = 0; i < im_->n; i++) im_->io[i].prev = pv[i]; }
void Brain::get_prev(float* pv) const { for (int i = 0; i < im_->n; i++) pv[i] = im_->io[i].prev; }
void Brain::set_counts(const int32_t* c) { for (int i = 0; i < im_->n; i++) im_->io[i].counts = c[i]; }
void Brain::get_counts(int32_t* c) const { for (int i = 0; i < im_->n; i++) c[i] = im_->io[i].counts; }
int32_t* Brain::queue(int slot) { return im_->queue.data() + (size_t)slot * im_->n; }
int32_t& Brain::qcount(int slot) { return im_->queue[(size_t)im_->slots * im_->n + slot]; }
uint32_t* Brain::active() { return im_->active.data(); }
uint32_t Brain::nactive() const { return im_->nactive; }
void Brain::set_nactive(uint32_t na) { im_->nactive = na; }
void Brain::upload_all() { wgpu_upload_all(); }
void Brain::fetch_all() { wgpu_fetch_all(); }
void Brain::set_units(int64_t e, int32_t u) {
  im_->edges[e].units = u;
  wgpu_units((int)e);
}

void Brain::set_acc(int acc_fma) { wgpu_acc(acc_fma ? 1 : 0); }

bool Brain::run(int steps, int slot0) {
  if (steps < 1 || steps > MAXT) { err_ = "steps out of range"; return false; }
  // The CSR is host-side here, so it has to reach the device before the kernel reads it. Once, at
  // the first run: by then the core has finished filling edges(), and from there set_units keeps
  // the two copies in step page by page (wgpu_units).
  if (!im_->edges_up) { wgpu_edges_all(); im_->edges_up = true; }
  const double t0 = emscripten_get_now();
  const int na = wgpu_run(steps, slot0, (int)im_->nactive);
  gpu_ms_ = emscripten_get_now() - t0;
  gpu_busy_ms_ = 0;  // WebGPU gives no timestamp without the timestamp-query feature
  if (na < 0) { err_ = std::string("webgpu: ") + im_->info; return false; }
  im_->nactive = (uint32_t)na;
  return true;
}

}  // namespace vkbrain
