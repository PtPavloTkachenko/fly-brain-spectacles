#!/bin/bash
# The brain core for the web page: flybrain.cpp + webbrain.cpp (WebGPU backend through brain_gpu.js)
# -> web/dist/flybrain.js + flybrain.wasm (ADR 55). Asyncify because WebGPU readback is async.
#   web/build_wasm.sh            release
#   DEBUG=1 web/build_wasm.sh    assertions + names
#   OUT=<dir> OPT="-O3 -msimd128" web/build_wasm.sh    a variant, for A/B (see DEPLOY.md)
#
# SIMD / LTO, measured 17.09 and NOT adopted. Tried because the page was thought to be CPU-bound; it
# is not. Three INTERLEAVED sets of the 1300 ms warm-up (260 hops) in node on an M1 Max, each set
# three rounds, vs `-O3` in the same set:
#   -O3                    baseline              304 KB
#   -O3 -msimd128          +1.0 %, -0.1 %        309 KB   -> nothing, inside the noise
#   -O3 -flto                      +2.1 %        340 KB   -> the whole effect is LTO's
#   -O3 -msimd128 -flto    +2.1 %, +1.6 %, +2.5 % 344 KB  -> same as -flto alone
# So the flag that pays is `-flto`, ~2 %, for 36 KB; `-msimd128` buys nothing, which is what you
# expect when the kernel is a random-access scatter over a 200 MB edge array -- there is nothing
# there to vectorise. Still not adopted, because 2 % is 2 % of the WASM CPU side, and the phase table
# shows that side is ~4 % of a hop on the page's real engine (WebGPU): 0.08 % end to end. It matters
# only to a visitor with no WebGPU, who falls back to the CPU kernel entirely. Pavlo's call.
# Every variant, and the native CPU, produce BIT-IDENTICAL spike counts (64315/60548/65370), so the
# flags are numerically safe -- `plain` arithmetic is +, - and * per lane, and the one float
# reduction (the DAN loop in `plasticity`) cannot be vectorised without `-ffast-math`, which we do
# not use. Left as a one-env-var experiment (`OPT=...`), not a default.
# MEASURE BEFORE BELIEVING, twice over: the first run of this A/B said SIMD was 30 % SLOWER (that was
# three headless Chromes competing for the machine), and the second said SIMD was worth 1.5 % (that
# was LTO, in the same build). Interleave the variants, repeat the set, and change one flag at a time.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CORE="$HERE/../core"
OUT="${OUT:-$HERE/dist}"
mkdir -p "$OUT"
OPT="${OPT:--O3}"
EXTRA="${EXTRA:-}"
if [ "${DEBUG:-0}" = "1" ]; then OPT="-O1 -g"; EXTRA="$EXTRA -sASSERTIONS=1"; fi
em++ $OPT -std=c++17 -fno-exceptions -fno-rtti \
  -I"$CORE/include" -I"$CORE/src" \
  "$CORE/src/flybrain.cpp" "$CORE/src/gpu/webbrain.cpp" \
  --js-library "$HERE/brain_gpu.js" \
  -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sINITIAL_MEMORY=64MB \
  -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=65536 \
  -sASYNCIFY_IMPORTS='["wgpu_create","wgpu_run","wgpu_fetch_all"]' \
  -sEXPORTED_FUNCTIONS='["_fb_create","_fb_last_error","_fb_destroy","_fb_post","_fb_warmup","_fb_step","_fb_take","_fb_set_threads","_fb_stats","_fb_prof","_fb_spikes_all","_malloc","_free"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8","HEAP8","HEAPF64","UTF8ToString","stringToUTF8","lengthBytesUTF8"]' \
  -sMODULARIZE=1 -sEXPORT_NAME=createFlyBrain -sENVIRONMENT=worker,web \
  -sSTACK_SIZE=1MB $EXTRA \
  -o "$OUT/flybrain.js"
cp "$CORE/src/gpu/brain.wgsl" "$OUT/brain.wgsl"
ls -la "$OUT"
