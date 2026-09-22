// Vulkan compute backend of the brain core: the exact kernel of brain.comp on one fly, with every
// state buffer host-visible (unified memory on a mobile GPU and on Apple silicon), so the CPU kernel
// and the GPU kernel take turns on the same brain chunk by chunk (the load policy's CPU/GPU balance).
// libvulkan is dlopen'ed: a machine without it just gets create() == nullptr and a reason.
#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace vkbrain {

struct Cell { int32_t last; int32_t spk; float v, g, adapt, rest, drive; int32_t pk; };  // pk = refr | flag << 16 | kc << 24
// The synaptic weight as an EXACT integer (DETERMINISM.md). The connectome's weight is
// sign * quantum * contacts with an integer contact count (measured on brain_c0: 25,147,397 edges,
// 100 % integral within one f32 ULP, 1..2591 contacts, quantum 0.275 mV). `units` counts
// quantum / W_K, so a synapse is an exact integer and a tick's deliveries into one cell add with
// integer arithmetic: associative, order-free, and identical on every CPU and GPU by construction.
// The scale is derived from the file at load (fb_brain::weight_scale), never hard-coded.
struct Edge { int32_t post; int32_t units; };

// ------------------------------------------------------------------ decay tables (DETERMINISM.md)
// ONE source for the per-gap constants every kernel reads, so the CPU and the GPU can never build
// them from two slightly different expressions. Five blocks of TA floats, in this order:
//   0: av  = exp(-DT k / 20)          membrane decay
//   1: ag  = exp(-DT k / 5)           conductance decay
//   2: aa  = exp(-DT k / adapt_tau)   adaptation decay
//   3: ab3 = (av - ag) / 3            the conductance term's coefficient, division done HERE
//   4: adk = tau/(tau-20) (aa - av)   the adaptation term's coefficient, divisions done HERE
// Pre-dividing is what lets `evolve` run on nothing but +, - and *, which IEEE-754 and the Vulkan
// spec both require to be correctly rounded on every implementation. A GPU whose fma() is really an
// unfused mad, or whose divide is the allowed 2.5 ULP, can then still be bit-exact with the CPU.
// ab3 / adk are rounded once from double, so they are the correctly rounded value of the constant.
// TA is fixed (not "extended until it underflows"): a gap is at most `steps + 1` ticks and a call is
// at most 1024 ticks, so index 8191 is unreachable and both sides clamp identically anyway.
constexpr int TAB_N = 8192;
constexpr int TAB_BLOCKS = 5;

inline std::vector<float> build_decay_tables(float DT, float adapt_tau) {
  std::vector<float> t((size_t)TAB_N * TAB_BLOCKS);
  const double tau = (double)adapt_tau, k20 = tau / (tau - 20.0);
  for (int i = 0; i < TAB_N; i++) {
    const float a = std::exp(-DT * i / 20.f), b = std::exp(-DT * i / 5.f), c = std::exp(-DT * i / adapt_tau);
    t[i] = a;
    t[TAB_N + i] = b;
    t[2 * TAB_N + i] = c;
    t[3 * TAB_N + i] = (float)(((double)a - (double)b) / 3.0);
    t[4 * TAB_N + i] = (float)(k20 * ((double)c - (double)a));
  }
  return t;
}

struct Params {
  int n = 0;
  int64_t E = 0;
  const int64_t* ptr = nullptr;
  const int32_t* post = nullptr;
  const int32_t* units = nullptr;   // per edge, parallel to `post`
  const uint8_t* modmask = nullptr;
  const uint8_t* kc = nullptr;
  const float* rest = nullptr;
  const int32_t* old_of = nullptr;  // reference index of each neuron when renumbered (nullptr = identity)
  const float* tab = nullptr;       // build_decay_tables(DT, adapt_tau), owned by the core
  float DT = 0.1f, adapt_tau = 200.0f, adapt_jump = 8.0f;
  float w_unit = 1.0f;        // mV per weight unit: g += float(sum of units) * w_unit, once per tick
  int slots = 19, delay = 18, rfc = 22;
  int acc_fma = 0;            // 0 = the plain (fma-free) evolve, 1 = the legacy fused one; see DETERMINISM.md
};

class Brain {
 public:
  static Brain* create(const Params& p, std::string& err);
  ~Brain();

  // host-visible state (valid between calls)
  Cell* cells();
  Edge* edges();                       // the whole CSR, interleaved; the CPU kernel reads it too, learning writes it
  void set_drive(const float* drive);  // per chunk, before run()
  void set_prev(const float* prev);
  void get_prev(float* prev) const;
  void set_counts(const int32_t* counts);
  void get_counts(int32_t* counts) const;
  int32_t* queue(int slot);            // n entries
  int32_t& qcount(int slot);
  uint32_t* active();                  // n entries, in the CPU's order
  uint32_t nactive() const;
  void set_nactive(uint32_t na);

  // one call = `steps` ticks starting at queue slot `slot0`. false = overflow or device failure (see err()).
  bool run(int steps, int slot0);
  // backends whose state is NOT host-visible (WebGPU): the core calls these around its host-side
  // reads/writes of cells / queue / active; no-ops on Vulkan (unified memory)
  void upload_all();  // after the host wrote cells / queue / active (gpu_push)
  void fetch_all();   // before the host reads them (gpu_pull, gpu_check)
  void set_units(int64_t e, int32_t units);  // a plastic synapse changed (learning): both copies stay in step
  void set_acc(int acc_fma);            // switch the evolve form between calls (the CPU switches with it)
  double last_gpu_ms() const { return gpu_ms_; }            // wall: record + submit + wait on the fence
  double last_gpu_busy_ms() const { return gpu_busy_ms_; }  // GPU-side timestamps, 0 = unavailable
  const std::string& err() const { return err_; }
  std::string device_name() const { return device_name_; }

 private:
  struct Impl;
  Impl* im_ = nullptr;
  double gpu_ms_ = 0, gpu_busy_ms_ = 0;
  std::string err_, device_name_;
  Brain() = default;
};

}  // namespace vkbrain
