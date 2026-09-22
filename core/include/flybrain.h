// FlyBrainCore: one MaleCNS fly brain in portable C++17, the native twin of brain_server/worker.py.
//
// The same core runs in two places (ADR 55/87):
//   - on a web page, compiled to WASM with a WebGPU kernel (web/build_wasm.sh), joined by a PIN;
//   - on the Mac, behind the WebSocket server (server.py --engine native), so the Lens Studio
//     preview can be driven by exactly the code the page runs.
//
// Messages are the server's JSON contract, so the lens code does not care which one it talks to:
//   in : {"senses":{...ch...}} | {"pulse":"reward"|"punish"} | {"reset":true} | {"cloud":true|false}
//   out: {"t":"ready",...} then {"t":"brain","fly":0,"sim_ms":..,"act":{..},"neural":{..},"hz":{..},
//        "regions":{..},"cloud":"<base64>"?,"prof":{..}}
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fb_brain fb_brain;

// Parse a "FLYB" file (core/brain_export/export.py). The bytes are copied. Returns NULL on error
// (fb_last_error() says why).
fb_brain* fb_create(const uint8_t* data, size_t len, double step_ms, int fly);
const char* fb_last_error(void);
void fb_destroy(fb_brain* b);

// Lens -> brain message (JSON, see above). Thread-safe; takes effect before the next step.
void fb_post(fb_brain* b, const char* json);

// Synchronous API (tests, WebSocket host): warm up once, then one step per call.
// Both return the JSON message they produced; the pointer stays valid until the next call.
const char* fb_warmup(fb_brain* b);
const char* fb_step(fb_brain* b);

// Background API (the lens): a thread warms up and then steps continuously.
// fb_take copies the newest pending message into buf (NUL-terminated) and returns its length,
// 0 when nothing new, or the needed size (> cap) when buf is too small. Older unread steps are dropped.
int fb_start(fb_brain* b);
void fb_stop(fb_brain* b);
int fb_take(fb_brain* b, char* buf, int cap);

// Kernel threads (1 = serial, 2+ = the exact block-partitioned kernel, same spikes). Safe any time.
void fb_set_threads(fb_brain* b, int threads);

// Numbers for telemetry: neurons, edges, active cells, last step wall ms.
void fb_stats(fb_brain* b, double* out4);

/** The last hop's phase table as JSON: where the 50 ms of brain time actually went, in ms
 *  {gpu, drive, counts, push, pull, cpu, sense, plast, read, msg, gc, cc, step}. Returns the bytes
 *  needed (write only if `out` is non-null and `cap` is enough). See DETERMINISM.md / RUNBOOK. */
int fb_prof(fb_brain* b, char* out, int cap);

// The last step's spikes, one bit per neuron, MSB first. Returns the bytes needed ((n+7)/8);
// writes them when out != null and cap >= that. Read-only, safe right after fb_step.
int fb_spikes_all(fb_brain* b, unsigned char* out, int cap);

#ifdef __cplusplus
}
#endif
