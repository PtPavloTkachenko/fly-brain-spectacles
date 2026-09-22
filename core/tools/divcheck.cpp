// Is "q = x*inv; r = fma(-q, y, x); q = fma(r, inv, q)" the correctly rounded x / y for EVERY float x?
// The GPU kernel divides by 3 and by (tau - 20) = 180 only; Vulkan's FDiv is not required to be
// correctly rounded, fma is. Exhaustive over all 2^32 bit patterns (finite x). Build + run:
//   clang++ -O2 -ffp-contract=off -std=c++17 divcheck.cpp -o divcheck && ./divcheck
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

static uint64_t check(float y) {
  const float inv = 1.0f / y;
  uint64_t bad = 0, tested = 0;
  float first_bad = 0;
  for (uint64_t bits = 0; bits < (1ull << 32); bits++) {
    float x;
    uint32_t b = (uint32_t)bits;
    memcpy(&x, &b, 4);
    if (!std::isfinite(x)) continue;
    if (std::fabs(x) > 0 && std::fabs(x) < 1.17549435e-38f) continue;  // denormal inputs: the GPU flushes them anyway
    const float ref = x / y;
    if (std::fabs(ref) < 1.17549435e-38f) continue;  // a denormal quotient: the GPU flushes it to zero either way
    volatile float q0 = x * inv;
    const float r = std::fma(-q0, y, x);
    const float q = std::fma(r, inv, q0);
    tested++;
    if (memcmp(&q, &ref, 4) != 0 && !(q == ref)) {  // -0 vs +0 is fine
      if (!bad) first_bad = x;
      bad++;
    }
  }
  printf("y=%g: tested %llu, wrong %llu%s\n", y, (unsigned long long)tested, (unsigned long long)bad, bad ? " (first shown below)" : "");
  if (bad) printf("  first bad x = %.9g (bits %08x)\n", first_bad, *(uint32_t*)&first_bad);
  return bad;
}

int main() {
  uint64_t bad = check(3.0f) + check(180.0f);
  return bad ? 1 : 0;
}
