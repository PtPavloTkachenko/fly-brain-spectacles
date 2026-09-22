// Vulkan host for brain.comp (see vkbrain.h). Vulkan 1.1 core only: no extensions the small mobile
// GPUs may lack (no buffer device address, no int64, no subgroup ops), storage-buffer ranges kept
// under 64 MB (the edge array is one buffer bound as up to four slices), one descriptor set with 15
// bindings, push constant = the tick. All memory HOST_VISIBLE | HOST_COHERENT.
#include "vkbrain.h"

#include <dlfcn.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>

#include "brain_spv.h"

namespace vkbrain {
namespace {

constexpr uint32_t TG = 256;
constexpr int MAXT = 1024;
constexpr uint32_t LOCALSORT = 2048;
constexpr uint32_t EPART = 1u << 23;
constexpr int NBIND = 15;

#define VK_FUNCS(X)                                                                                           \
  X(vkCreateInstance) X(vkDestroyInstance) X(vkEnumerateInstanceExtensionProperties) X(vkEnumeratePhysicalDevices)  \
  X(vkGetPhysicalDeviceProperties) X(vkGetPhysicalDeviceQueueFamilyProperties) X(vkGetPhysicalDeviceMemoryProperties)  \
  X(vkEnumerateDeviceExtensionProperties) X(vkCreateDevice) X(vkDestroyDevice) X(vkGetDeviceQueue) X(vkCreateBuffer)      \
  X(vkDestroyBuffer) X(vkGetBufferMemoryRequirements) X(vkAllocateMemory) X(vkFreeMemory) X(vkBindBufferMemory)        \
  X(vkMapMemory) X(vkCreateShaderModule) X(vkDestroyShaderModule) X(vkCreateDescriptorSetLayout)                       \
  X(vkDestroyDescriptorSetLayout) X(vkCreatePipelineLayout) X(vkDestroyPipelineLayout) X(vkCreateComputePipelines)     \
  X(vkDestroyPipeline) X(vkCreateDescriptorPool) X(vkDestroyDescriptorPool) X(vkAllocateDescriptorSets)               \
  X(vkUpdateDescriptorSets) X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers)               \
  X(vkResetCommandPool) X(vkBeginCommandBuffer) X(vkEndCommandBuffer) X(vkCmdBindPipeline) X(vkCmdBindDescriptorSets) \
  X(vkCmdPushConstants) X(vkCmdDispatch) X(vkCmdPipelineBarrier) X(vkQueueSubmit) X(vkCreateFence) X(vkDestroyFence)   \
  X(vkWaitForFences) X(vkResetFences) X(vkDeviceWaitIdle)                                                     \
  X(vkCreateQueryPool) X(vkDestroyQueryPool) X(vkCmdResetQueryPool) X(vkCmdWriteTimestamp) X(vkGetQueryPoolResults)

struct Fn {
#define X(name) PFN_##name name = nullptr;
  VK_FUNCS(X)
#undef X
  PFN_vkGetInstanceProcAddr gipa = nullptr;
  PFN_vkGetDeviceProcAddr gdpa = nullptr;
};

struct Buf {
  VkBuffer b = VK_NULL_HANDLE;
  VkDeviceMemory m = VK_NULL_HANDLE;
  void* map = nullptr;
  VkDeviceSize size = 0;
};

enum { B_PARAMS, B_PTR, B_E0, B_E1, B_E2, B_E3, B_NC, B_TAB, B_CELLS, B_IO, B_W, B_ACC, B_Q, B_SCR, B_CTR };

struct ParamsUBO {
  int32_t n, slots, delay, rfc, TA, NP, CS, MAXT_;
  int32_t ga1, ga2, gb1, nblk;
  uint32_t upad0, upad1; float w_unit; uint32_t acc;
  float adapt_jump, tau, tau20, inv_tau20;
  uint32_t o_key, o_act, o_active, o_spkey, o_spid, o_prefix, o_head, o_touched;
  int32_t steps, slot0, na0, ipad;
};
static_assert(sizeof(ParamsUBO) == 32 * 4, "ParamsUBO layout must match brain.comp");

struct NConst { float rest; uint32_t kc, oldof, mod; };
struct IO { float prev, drive; int32_t counts, pad; };

}  // namespace

struct Brain::Impl {
  void* lib = nullptr;
  Fn f;
  VkInstance inst = VK_NULL_HANDLE;
  VkPhysicalDevice pd = VK_NULL_HANDLE;
  VkDevice dev = VK_NULL_HANDLE;
  VkQueue q = VK_NULL_HANDLE;
  uint32_t qfam = 0;
  VkPhysicalDeviceMemoryProperties mem{};
  Buf bufs[NBIND];
  VkDescriptorSetLayout dsl = VK_NULL_HANDLE;
  VkPipelineLayout pl = VK_NULL_HANDLE;
  VkPipeline pipes[6] = {};
  VkShaderModule mods[6] = {};
  VkDescriptorPool pool = VK_NULL_HANDLE;
  VkDescriptorSet ds = VK_NULL_HANDLE;
  VkCommandPool cpool = VK_NULL_HANDLE;
  VkCommandBuffer cb = VK_NULL_HANDLE;
  VkFence fence = VK_NULL_HANDLE;
  // GPU-side timestamps: `run` measures the WALL time we block on the fence, which on a device whose
  // compositor shares the GPU includes the time our submission spends queued. The difference
  // between the two says whether the kernel is slow or merely waiting its turn (17.09).
  VkQueryPool qpool = VK_NULL_HANDLE;
  double ts_period = 0;  // ns per tick, 0 = the queue has no usable timestamps
  int n = 0, slots = 19, delay = 18, rfc = 22, TA = 0, NP = 0, CS = 0, ga1 = 64, ga2 = 128, gb1 = 64;
  int64_t E = 0;
  float adapt_jump = 8, tau = 200, tau20 = 180, w_unit = 1;
  uint32_t o_key = 0, o_act = 0, o_active = 0, o_spkey = 0, o_spid = 0, o_prefix = 0, o_head = 0, o_touched = 0;
  uint32_t nactive = 0;

  bool load_lib(std::string& err) {
    const char* names[] = {"libvulkan.so.1", "libvulkan.so", "/opt/homebrew/lib/libvulkan.1.dylib", "libvulkan.1.dylib", "libvulkan.dylib"};
    for (const char* nm : names) {
      lib = dlopen(nm, RTLD_NOW | RTLD_LOCAL);
      if (lib) break;
    }
    if (!lib) { err = std::string("no Vulkan loader: ") + (dlerror() ? dlerror() : "?"); return false; }
    f.gipa = (PFN_vkGetInstanceProcAddr)dlsym(lib, "vkGetInstanceProcAddr");
    if (!f.gipa) { err = "no vkGetInstanceProcAddr"; return false; }
    f.vkCreateInstance = (PFN_vkCreateInstance)f.gipa(nullptr, "vkCreateInstance");
    f.vkEnumerateInstanceExtensionProperties = (PFN_vkEnumerateInstanceExtensionProperties)f.gipa(nullptr, "vkEnumerateInstanceExtensionProperties");
    return f.vkCreateInstance != nullptr;
  }

  bool load_instance_fns() {
#define X(name) f.name = (PFN_##name)f.gipa(inst, #name);
    VK_FUNCS(X)
#undef X
    f.gdpa = (PFN_vkGetDeviceProcAddr)f.gipa(inst, "vkGetDeviceProcAddr");
    return f.vkEnumeratePhysicalDevices && f.vkCreateDevice;
  }

  bool has_instance_ext(const char* name) {
    uint32_t c = 0;
    if (!f.vkEnumerateInstanceExtensionProperties || f.vkEnumerateInstanceExtensionProperties(nullptr, &c, nullptr) != VK_SUCCESS) return false;
    std::vector<VkExtensionProperties> ex(c);
    f.vkEnumerateInstanceExtensionProperties(nullptr, &c, ex.data());
    for (auto& e : ex) if (!strcmp(e.extensionName, name)) return true;
    return false;
  }

  bool has_device_ext(const char* name) {
    uint32_t c = 0;
    if (f.vkEnumerateDeviceExtensionProperties(pd, nullptr, &c, nullptr) != VK_SUCCESS) return false;
    std::vector<VkExtensionProperties> ex(c);
    f.vkEnumerateDeviceExtensionProperties(pd, nullptr, &c, ex.data());
    for (auto& e : ex) if (!strcmp(e.extensionName, name)) return true;
    return false;
  }

  bool make_buf(int k, VkDeviceSize size, std::string& err) {
    Buf& B = bufs[k];
    B.size = std::max<VkDeviceSize>(size, 256);
    VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    bi.size = B.size;
    bi.usage = k == B_PARAMS ? VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT : VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    if (f.vkCreateBuffer(dev, &bi, nullptr, &B.b) != VK_SUCCESS) { err = "vkCreateBuffer failed"; return false; }
    VkMemoryRequirements req{};
    f.vkGetBufferMemoryRequirements(dev, B.b, &req);
    // host-visible + coherent, device-local when the type offers it (unified memory does)
    int best = -1, bestScore = -1;
    for (uint32_t i = 0; i < mem.memoryTypeCount; i++) {
      if (!(req.memoryTypeBits & (1u << i))) continue;
      const VkMemoryPropertyFlags fl = mem.memoryTypes[i].propertyFlags;
      if (!(fl & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT) || !(fl & VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)) continue;
      int score = (fl & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT) ? 2 : 1;
      if (fl & VK_MEMORY_PROPERTY_HOST_CACHED_BIT) score += 4;  // the CPU kernel reads these too
      if (score > bestScore) { best = (int)i; bestScore = score; }
    }
    if (best < 0) { err = "no host-visible coherent memory type"; return false; }
    VkMemoryAllocateInfo ai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    ai.allocationSize = req.size;
    ai.memoryTypeIndex = (uint32_t)best;
    if (f.vkAllocateMemory(dev, &ai, nullptr, &B.m) != VK_SUCCESS) { err = "vkAllocateMemory failed (" + std::to_string(req.size >> 20) + " MB)"; return false; }
    if (f.vkBindBufferMemory(dev, B.b, B.m, 0) != VK_SUCCESS) { err = "vkBindBufferMemory failed"; return false; }
    if (f.vkMapMemory(dev, B.m, 0, VK_WHOLE_SIZE, 0, &B.map) != VK_SUCCESS) { err = "vkMapMemory failed"; return false; }
    return true;
  }

  bool make_pipeline(int k, const uint32_t* spv, size_t bytes, std::string& err) {
    VkShaderModuleCreateInfo si{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};
    si.codeSize = bytes;
    si.pCode = spv;
    if (f.vkCreateShaderModule(dev, &si, nullptr, &mods[k]) != VK_SUCCESS) { err = "vkCreateShaderModule failed"; return false; }
    VkComputePipelineCreateInfo ci{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
    ci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    ci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    ci.stage.module = mods[k];
    ci.stage.pName = "main";
    ci.layout = pl;
    if (f.vkCreateComputePipelines(dev, VK_NULL_HANDLE, 1, &ci, nullptr, &pipes[k]) != VK_SUCCESS) { err = "vkCreateComputePipelines failed for kernel " + std::to_string(k); return false; }
    return true;
  }

  void barrier() {
    VkMemoryBarrier mb{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    mb.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    mb.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT;
    f.vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, nullptr, 0, nullptr);
  }

  void dispatch(int k, uint32_t groups, int t) {
    f.vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipes[k]);
    f.vkCmdPushConstants(cb, pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &t);
    f.vkCmdDispatch(cb, groups, 1, 1);
    barrier();
  }

  ParamsUBO* params() { return (ParamsUBO*)bufs[B_PARAMS].map; }
  uint32_t* W() { return (uint32_t*)bufs[B_W].map; }
  int32_t* Q() { return (int32_t*)bufs[B_Q].map; }
  uint32_t* ctr() { return (uint32_t*)bufs[B_CTR].map; }
  IO* io() { return (IO*)bufs[B_IO].map; }

  void destroy() {
    if (dev) {
      f.vkDeviceWaitIdle(dev);
      if (qpool) f.vkDestroyQueryPool(dev, qpool, nullptr);
      if (fence) f.vkDestroyFence(dev, fence, nullptr);
      if (cpool) f.vkDestroyCommandPool(dev, cpool, nullptr);
      if (pool) f.vkDestroyDescriptorPool(dev, pool, nullptr);
      for (auto& p : pipes) if (p) f.vkDestroyPipeline(dev, p, nullptr);
      for (auto& m : mods) if (m) f.vkDestroyShaderModule(dev, m, nullptr);
      if (pl) f.vkDestroyPipelineLayout(dev, pl, nullptr);
      if (dsl) f.vkDestroyDescriptorSetLayout(dev, dsl, nullptr);
      for (auto& B : bufs) {
        if (B.b) f.vkDestroyBuffer(dev, B.b, nullptr);
        if (B.m) f.vkFreeMemory(dev, B.m, nullptr);
      }
      f.vkDestroyDevice(dev, nullptr);
    }
    if (inst && f.vkDestroyInstance) f.vkDestroyInstance(inst, nullptr);
    if (lib) dlclose(lib);
  }
};

Brain* Brain::create(const Params& p, std::string& err) {
  if (p.E >= (int64_t)4 * EPART) { err = "too many edges for four slices"; return nullptr; }
#if defined(__APPLE__)
  setenv("MVK_CONFIG_FAST_MATH_ENABLED", "0", 0);  // MoltenVK: Metal without fast math, the exactness needs it
#endif
  auto* br = new Brain;
  auto* im = new Impl;
  br->im_ = im;
  auto fail = [&](const std::string& e) { err = e; delete br; return (Brain*)nullptr; };
  if (!im->load_lib(err)) return fail(err);

  // instance (portability enumeration for MoltenVK's loader; harmless elsewhere)
  VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};
  app.pApplicationName = "FlyBrainCore";
  app.apiVersion = VK_API_VERSION_1_1;
  std::vector<const char*> iext;
  VkInstanceCreateInfo ici{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};
  if (im->has_instance_ext("VK_KHR_portability_enumeration")) {
    iext.push_back("VK_KHR_portability_enumeration");
    ici.flags |= 0x00000001;  // VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR
  }
  ici.pApplicationInfo = &app;
  ici.enabledExtensionCount = (uint32_t)iext.size();
  ici.ppEnabledExtensionNames = iext.data();
  VkResult r = im->f.vkCreateInstance(&ici, nullptr, &im->inst);
  if (r != VK_SUCCESS) return fail("vkCreateInstance rc=" + std::to_string((int)r));
  if (!im->load_instance_fns()) return fail("instance functions missing");

  // physical device with a compute queue
  uint32_t nd = 0;
  im->f.vkEnumeratePhysicalDevices(im->inst, &nd, nullptr);
  std::vector<VkPhysicalDevice> devs(nd);
  if (nd) im->f.vkEnumeratePhysicalDevices(im->inst, &nd, devs.data());
  if (!nd) return fail("no Vulkan physical device");
  int chosen = -1;
  uint32_t qf = 0;
  for (uint32_t d = 0; d < nd && chosen < 0; d++) {
    uint32_t nq = 0;
    im->f.vkGetPhysicalDeviceQueueFamilyProperties(devs[d], &nq, nullptr);
    std::vector<VkQueueFamilyProperties> qp(nq);
    im->f.vkGetPhysicalDeviceQueueFamilyProperties(devs[d], &nq, qp.data());
    for (uint32_t i = 0; i < nq; i++)
      if (qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { chosen = (int)d; qf = i; break; }
  }
  if (chosen < 0) return fail("no compute queue family");
  im->pd = devs[chosen];
  im->qfam = qf;
  VkPhysicalDeviceProperties props{};
  im->f.vkGetPhysicalDeviceProperties(im->pd, &props);
  br->device_name_ = props.deviceName;
  if (props.limits.maxComputeWorkGroupInvocations < TG) return fail("workgroup of 256 not supported");
  if (props.limits.maxComputeSharedMemorySize < LOCALSORT * 12 + TG * 4) return fail("not enough shared memory for the block sort");
  im->f.vkGetPhysicalDeviceMemoryProperties(im->pd, &im->mem);

  // logical device
  float prio = 1.0f;
  VkDeviceQueueCreateInfo qci{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};
  qci.queueFamilyIndex = qf;
  qci.queueCount = 1;
  qci.pQueuePriorities = &prio;
  std::vector<const char*> dext;
  if (im->has_device_ext("VK_KHR_portability_subset")) dext.push_back("VK_KHR_portability_subset");
  VkDeviceCreateInfo dci{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};
  dci.queueCreateInfoCount = 1;
  dci.pQueueCreateInfos = &qci;
  dci.enabledExtensionCount = (uint32_t)dext.size();
  dci.ppEnabledExtensionNames = dext.data();
  r = im->f.vkCreateDevice(im->pd, &dci, nullptr, &im->dev);
  if (r != VK_SUCCESS) return fail("vkCreateDevice rc=" + std::to_string((int)r));
  im->f.vkGetDeviceQueue(im->dev, qf, 0, &im->q);

  // sizes
  const int n = p.n;
  im->n = n; im->E = p.E; im->slots = p.slots; im->delay = p.delay; im->rfc = p.rfc;
  im->adapt_jump = p.adapt_jump; im->tau = p.adapt_tau; im->tau20 = p.adapt_tau - 20.f; im->w_unit = p.w_unit;
  im->NP = 1; while (im->NP < n) im->NP <<= 1;
  im->CS = 5 * (MAXT + 1) + 8;
  if (const char* s = getenv("VKB_GA1")) im->ga1 = atoi(s);
  if (const char* s = getenv("VKB_GA2")) im->ga2 = atoi(s);
  if (const char* s = getenv("VKB_GB1")) im->gb1 = atoi(s);
  // the decay tables come FROM the core (one source for both kernels, DETERMINISM.md)
  std::vector<float> owned;
  const float* tabsrc = p.tab;
  if (!tabsrc) { owned = build_decay_tables(p.DT, p.adapt_tau); tabsrc = owned.data(); }
  im->TA = TAB_N;
  const uint32_t un = (uint32_t)n;
  im->o_key = 0; im->o_act = 2 * un; im->o_active = 4 * un; im->o_spkey = 5 * un; im->o_spid = 7 * un;
  im->o_prefix = 8 * un; im->o_head = 9 * un + 1; im->o_touched = 10 * un + 1;
  const uint32_t wcount = 11 * un + 1;

  if (!im->make_buf(B_PARAMS, sizeof(ParamsUBO), err)) return fail(err);
  if (!im->make_buf(B_PTR, 4 * (size_t)(n + 1), err)) return fail(err);
  if (!im->make_buf(B_E0, sizeof(Edge) * (size_t)std::max<int64_t>(p.E, 1), err)) return fail(err);
  if (!im->make_buf(B_NC, sizeof(NConst) * (size_t)n, err)) return fail(err);
  if (!im->make_buf(B_TAB, 4 * (size_t)im->TA * TAB_BLOCKS, err)) return fail(err);
  if (!im->make_buf(B_CELLS, sizeof(Cell) * (size_t)n, err)) return fail(err);
  if (!im->make_buf(B_IO, sizeof(IO) * (size_t)n, err)) return fail(err);
  if (!im->make_buf(B_W, 4 * (size_t)wcount, err)) return fail(err);
  if (!im->make_buf(B_ACC, 4 * (size_t)n, err)) return fail(err);  // ADR 82: n ints, was a 64 MB record buffer
  if (!im->make_buf(B_Q, 4 * ((size_t)im->slots * n + im->slots), err)) return fail(err);
  if (!im->make_buf(B_SCR, 4 * (size_t)3 * im->NP, err)) return fail(err);
  if (!im->make_buf(B_CTR, 4 * (size_t)im->CS, err)) return fail(err);

  // fill the constants
  {
    auto* p32 = (uint32_t*)im->bufs[B_PTR].map;
    for (int i = 0; i <= n; i++) p32[i] = (uint32_t)p.ptr[i];
    if (p.post && p.units) {  // otherwise the caller fills edges() itself, one array at a time
      auto* ed = (Edge*)im->bufs[B_E0].map;
      for (int64_t e = 0; e < p.E; e++) ed[e] = {p.post[e], p.units[e]};
    }
    auto* nc = (NConst*)im->bufs[B_NC].map;
    for (int i = 0; i < n; i++) nc[i] = {p.rest[i], (uint32_t)p.kc[i], (uint32_t)(p.old_of ? p.old_of[i] : i), (uint32_t)(p.modmask ? p.modmask[i] : 0)};
    memcpy(im->bufs[B_TAB].map, tabsrc, 4 * (size_t)im->TA * TAB_BLOCKS);
    memset(im->bufs[B_CELLS].map, 0, im->bufs[B_CELLS].size);
    memset(im->bufs[B_IO].map, 0, im->bufs[B_IO].size);
    memset(im->bufs[B_W].map, 0, im->bufs[B_W].size);
    for (uint32_t i = 0; i < un; i++) im->W()[im->o_head + i] = 0xFFFFFFFFu;  // untouched targets
    memset(im->bufs[B_ACC].map, 0, im->bufs[B_ACC].size);
    memset(im->bufs[B_Q].map, 0, im->bufs[B_Q].size);
    memset(im->bufs[B_CTR].map, 0, im->bufs[B_CTR].size);
  }

  // descriptors: one set, binding 0 = params, 1..14 = storage
  std::vector<VkDescriptorSetLayoutBinding> lb(NBIND);
  for (int k = 0; k < NBIND; k++) {
    lb[k] = {};
    lb[k].binding = (uint32_t)k;
    lb[k].descriptorType = k == B_PARAMS ? VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER : VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    lb[k].descriptorCount = 1;
    lb[k].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
  }
  VkDescriptorSetLayoutCreateInfo dlci{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};
  dlci.bindingCount = NBIND;
  dlci.pBindings = lb.data();
  if (im->f.vkCreateDescriptorSetLayout(im->dev, &dlci, nullptr, &im->dsl) != VK_SUCCESS) return fail("descriptor set layout failed");
  VkPushConstantRange pcr{VK_SHADER_STAGE_COMPUTE_BIT, 0, 4};
  VkPipelineLayoutCreateInfo plci{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
  plci.setLayoutCount = 1;
  plci.pSetLayouts = &im->dsl;
  plci.pushConstantRangeCount = 1;
  plci.pPushConstantRanges = &pcr;
  if (im->f.vkCreatePipelineLayout(im->dev, &plci, nullptr, &im->pl) != VK_SUCCESS) return fail("pipeline layout failed");
  const uint32_t* spv[6] = {SPV_BEGIN, SPV_TICKA, SPV_TICKB, SPV_END, SPV_BLKSORT, SPV_RANK};
  const size_t spb[6] = {SPV_BEGIN_BYTES, SPV_TICKA_BYTES, SPV_TICKB_BYTES, SPV_END_BYTES, SPV_BLKSORT_BYTES, SPV_RANK_BYTES};
  for (int k = 0; k < 6; k++) if (!im->make_pipeline(k, spv[k], spb[k], err)) return fail(err);
  VkDescriptorPoolSize ps[2] = {{VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1}, {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, NBIND - 1}};
  VkDescriptorPoolCreateInfo dpci{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};
  dpci.maxSets = 1;
  dpci.poolSizeCount = 2;
  dpci.pPoolSizes = ps;
  if (im->f.vkCreateDescriptorPool(im->dev, &dpci, nullptr, &im->pool) != VK_SUCCESS) return fail("descriptor pool failed");
  VkDescriptorSetAllocateInfo dsai{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};
  dsai.descriptorPool = im->pool;
  dsai.descriptorSetCount = 1;
  dsai.pSetLayouts = &im->dsl;
  if (im->f.vkAllocateDescriptorSets(im->dev, &dsai, &im->ds) != VK_SUCCESS) return fail("descriptor set failed");
  std::vector<VkDescriptorBufferInfo> dbi(NBIND);
  std::vector<VkWriteDescriptorSet> wds(NBIND);
  for (int k = 0; k < NBIND; k++) {
    if (k >= B_E0 && k <= B_E3) {  // the edge buffer, in slices of 2^23 edges (small GPUs cap a binding's range)
      const int64_t s0 = (int64_t)(k - B_E0) * EPART;
      const int64_t cnt = std::max<int64_t>(1, std::min<int64_t>(EPART, p.E - s0));
      dbi[k] = {im->bufs[B_E0].b, (VkDeviceSize)(s0 < p.E ? s0 * sizeof(Edge) : 0), (VkDeviceSize)(cnt * sizeof(Edge))};
    } else {
      dbi[k] = {im->bufs[k].b, 0, VK_WHOLE_SIZE};
    }
    wds[k] = {VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};
    wds[k].dstSet = im->ds;
    wds[k].dstBinding = (uint32_t)k;
    wds[k].descriptorCount = 1;
    wds[k].descriptorType = k == B_PARAMS ? VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER : VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    wds[k].pBufferInfo = &dbi[k];
  }
  im->f.vkUpdateDescriptorSets(im->dev, NBIND, wds.data(), 0, nullptr);

  VkCommandPoolCreateInfo cpci{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};
  cpci.queueFamilyIndex = qf;
  cpci.flags = VK_COMMAND_POOL_CREATE_TRANSIENT_BIT;
  if (im->f.vkCreateCommandPool(im->dev, &cpci, nullptr, &im->cpool) != VK_SUCCESS) return fail("command pool failed");
  VkCommandBufferAllocateInfo cbai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
  cbai.commandPool = im->cpool;
  cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
  cbai.commandBufferCount = 1;
  if (im->f.vkAllocateCommandBuffers(im->dev, &cbai, &im->cb) != VK_SUCCESS) return fail("command buffer failed");
  VkFenceCreateInfo fci{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
  if (im->f.vkCreateFence(im->dev, &fci, nullptr, &im->fence) != VK_SUCCESS) return fail("fence failed");
  {  // timestamps, if this queue family has them (optional: a driver without them just reports 0)
    uint32_t nqf = 0;
    im->f.vkGetPhysicalDeviceQueueFamilyProperties(im->pd, &nqf, nullptr);
    std::vector<VkQueueFamilyProperties> qpf(nqf);
    im->f.vkGetPhysicalDeviceQueueFamilyProperties(im->pd, &nqf, qpf.data());
    if (qf < nqf && qpf[qf].timestampValidBits > 0 && props.limits.timestampPeriod > 0) {
      VkQueryPoolCreateInfo qi{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};
      qi.queryType = VK_QUERY_TYPE_TIMESTAMP;
      qi.queryCount = 2;
      if (im->f.vkCreateQueryPool(im->dev, &qi, nullptr, &im->qpool) == VK_SUCCESS)
        im->ts_period = props.limits.timestampPeriod;
    }
  }

  ParamsUBO* U = im->params();
  *U = {};
  U->n = n; U->slots = im->slots; U->delay = im->delay; U->rfc = im->rfc; U->TA = im->TA; U->NP = im->NP; U->CS = im->CS; U->MAXT_ = MAXT;
  U->ga1 = im->ga1; U->ga2 = im->ga2; U->gb1 = im->gb1; U->nblk = im->NP / (int)LOCALSORT;
  U->w_unit = im->w_unit; U->acc = (uint32_t)(p.acc_fma ? 1 : 0);
  U->adapt_jump = im->adapt_jump; U->tau = im->tau; U->tau20 = im->tau20; U->inv_tau20 = 1.0f / im->tau20;
  U->o_key = im->o_key; U->o_act = im->o_act; U->o_active = im->o_active; U->o_spkey = im->o_spkey; U->o_spid = im->o_spid;
  U->o_prefix = im->o_prefix; U->o_head = im->o_head; U->o_touched = im->o_touched;
  return br;
}

Brain::~Brain() {
  if (im_) { im_->destroy(); delete im_; }
}

void Brain::upload_all() {}
void Brain::fetch_all() {}
void Brain::set_units(int64_t e, int32_t u) { ((Edge*)im_->bufs[B_E0].map)[e].units = u; }
void Brain::set_acc(int acc_fma) { im_->params()->acc = (uint32_t)(acc_fma ? 1 : 0); }
Cell* Brain::cells() { return (Cell*)im_->bufs[B_CELLS].map; }
Edge* Brain::edges() { return (Edge*)im_->bufs[B_E0].map; }
void Brain::set_drive(const float* d) { IO* io = im_->io(); for (int i = 0; i < im_->n; i++) io[i].drive = d[i]; }
void Brain::set_prev(const float* pv) { IO* io = im_->io(); for (int i = 0; i < im_->n; i++) io[i].prev = pv[i]; }
void Brain::get_prev(float* pv) const { const IO* io = im_->io(); for (int i = 0; i < im_->n; i++) pv[i] = io[i].prev; }
void Brain::set_counts(const int32_t* c) { IO* io = im_->io(); for (int i = 0; i < im_->n; i++) io[i].counts = c[i]; }
void Brain::get_counts(int32_t* c) const { const IO* io = im_->io(); for (int i = 0; i < im_->n; i++) c[i] = io[i].counts; }
int32_t* Brain::queue(int slot) { return im_->Q() + (size_t)slot * im_->n; }
int32_t& Brain::qcount(int slot) { return im_->Q()[(size_t)im_->slots * im_->n + slot]; }
uint32_t* Brain::active() { return im_->W() + im_->o_active; }
uint32_t Brain::nactive() const { return im_->nactive; }
void Brain::set_nactive(uint32_t na) { im_->nactive = na; }

bool Brain::run(int steps, int slot0) {
  Impl* im = im_;
  if (steps < 1 || steps > MAXT) { err_ = "steps out of range"; return false; }
  uint32_t* c = im->ctr();
  memset(c, 0, 4 * (size_t)im->CS);
  c[0] = im->nactive;
  ParamsUBO* U = im->params();
  U->steps = steps; U->slot0 = slot0; U->na0 = (int32_t)im->nactive;
  const auto t0 = std::chrono::steady_clock::now();
  if (im->f.vkResetCommandPool(im->dev, im->cpool, 0) != VK_SUCCESS) { err_ = "vkResetCommandPool failed"; return false; }
  VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
  bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
  im->f.vkBeginCommandBuffer(im->cb, &bi);
  im->f.vkCmdBindDescriptorSets(im->cb, VK_PIPELINE_BIND_POINT_COMPUTE, im->pl, 0, 1, &im->ds, 0, nullptr);
  if (im->qpool) {
    im->f.vkCmdResetQueryPool(im->cb, im->qpool, 0, 2);
    im->f.vkCmdWriteTimestamp(im->cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, im->qpool, 0);
  }
  const uint32_t nbt = ((uint32_t)im->n + TG - 1) / TG;
  im->dispatch(0, nbt + 1, 0);
  for (int t = 0; t < steps; t++) {
    im->dispatch(1, (uint32_t)(im->ga1 + im->ga2), t);
    im->dispatch(2, (uint32_t)(im->gb1 + 1), t);
  }
  im->dispatch(3, nbt, 0);
  im->dispatch(4, (uint32_t)(im->NP / (int)LOCALSORT), 0);
  im->dispatch(5, (uint32_t)(im->NP / (int)TG), 0);
  if (im->qpool) im->f.vkCmdWriteTimestamp(im->cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, im->qpool, 1);
  im->f.vkEndCommandBuffer(im->cb);
  VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};
  si.commandBufferCount = 1;
  si.pCommandBuffers = &im->cb;
  im->f.vkResetFences(im->dev, 1, &im->fence);
  if (im->f.vkQueueSubmit(im->q, 1, &si, im->fence) != VK_SUCCESS) { err_ = "vkQueueSubmit failed"; return false; }
  const VkResult wr = im->f.vkWaitForFences(im->dev, 1, &im->fence, VK_TRUE, 60ull * 1000000000ull);
  gpu_ms_ = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  if (wr != VK_SUCCESS) { err_ = "GPU timeout or device lost (rc=" + std::to_string((int)wr) + ")"; return false; }
  gpu_busy_ms_ = 0;  // how long the GPU itself was on it, vs how long we waited for the queue
  if (im->qpool) {
    uint64_t ts[2] = {0, 0};
    if (im->f.vkGetQueryPoolResults(im->dev, im->qpool, 0, 2, sizeof ts, ts, sizeof(uint64_t),
                                    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT) == VK_SUCCESS && ts[1] > ts[0])
      gpu_busy_ms_ = (double)(ts[1] - ts[0]) * im->ts_period / 1.0e6;
  }
  im->nactive = c[5 * (MAXT + 1) + 2];
  return true;
}

}  // namespace vkbrain
