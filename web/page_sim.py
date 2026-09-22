"""A "web page" without a browser: the brain on this Mac joins a lens's room by PIN (ADR 55).

    cd "$CYBERFLY_RUNTIME/fly-wirehead" && uv run --with websockets python <repo>/web/page_sim.py \
        --pin 4821 --relay ws://localhost:8795 --flyb <repo>/core/brain_export/out/brain_c0.flyb.z

Same protocol as web/app.html (Phoenix broadcast on topic realtime:fly-<pin>): `hello` on join,
`brain` events with the core's messages; `lens` events carry the lens's senses/select/pulse/reset/
learning, posted to the core as they arrive. Runs the native core (libflybrain_host.dylib, 2 threads
or the GPU with --gpu) as fast as it can, like server.py --engine native. Also the reference client
for a Supabase relay: pass --relay wss://<ref>.snapcloud.dev/realtime/v1/websocket --key <anon key>
(a Snap Cloud project; <ref>.supabase.co for one made at supabase.com).
"""
import argparse
import asyncio
import ctypes as C
import json
import time
from pathlib import Path

import websockets

REPO = Path(__file__).resolve().parents[1]


def load_core(lib_path: str):
    lib = C.CDLL(lib_path)
    lib.fb_create.restype = C.c_void_p
    lib.fb_create.argtypes = [C.c_char_p, C.c_size_t, C.c_double, C.c_int]
    lib.fb_last_error.restype = C.c_char_p
    for f in ("fb_warmup", "fb_step"):
        getattr(lib, f).restype = C.c_char_p
        getattr(lib, f).argtypes = [C.c_void_p]
    lib.fb_post.argtypes = [C.c_void_p, C.c_char_p]
    lib.fb_set_threads.argtypes = [C.c_void_p, C.c_int]
    # ADR 63/68: the core QUEUES its memory answers; `fb_step` never returns them, so a page that
    # does not drain `fb_take` silently swallows every `memory get`. brain_worker.js drains it too.
    lib.fb_take.restype = C.c_int
    lib.fb_take.argtypes = [C.c_void_p, C.c_char_p, C.c_int]
    return lib


async def main(a):
    lib = load_core(a.lib)
    data = Path(a.flyb).read_bytes()
    brain = lib.fb_create(data, len(data), 50.0, 0)
    if not brain:
        raise SystemExit("fb_create: " + lib.fb_last_error().decode())
    del data
    if a.gpu:
        lib.fb_post(brain, b'{"gpu":1}')
    elif a.threads > 1:
        lib.fb_set_threads(brain, a.threads)
    topic = "realtime:fly-" + a.pin
    url = a.relay + (("?apikey=" + a.key + "&vsn=1.0.0") if a.key else "")
    ref = 0

    def phx(event, payload, t=topic):
        nonlocal ref
        ref += 1
        return json.dumps({"topic": t, "event": event, "payload": payload, "ref": str(ref)})

    async with websockets.connect(url, max_size=4 * 1024 * 1024) as ws:
        join = {"config": {"broadcast": {"self": False, "ack": False}}}
        if a.key:
            join["access_token"] = a.key
        await ws.send(phx("phx_join", join))
        print("joined", topic, flush=True)
        await ws.send(phx("broadcast", {"type": "broadcast", "event": "hello", "payload": {"name": a.name}}))
        ready = json.loads(lib.fb_warmup(brain))
        print("warm, gpu:", ready.get("gpu"), flush=True)
        await ws.send(phx("broadcast", {"type": "broadcast", "event": "brain", "payload": ready}))

        async def inbox():
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if m.get("event") != "broadcast":
                    continue
                p = m.get("payload") or {}
                if p.get("event") != "lens":
                    continue
                msg = p.get("payload") or {}
                t = msg.get("t")
                if t == "senses":
                    lib.fb_post(brain, json.dumps({"senses": msg.get("ch", {})}).encode())
                elif t == "select":
                    lib.fb_post(brain, json.dumps({"cloud": msg.get("fly") == 0}).encode())
                elif t == "pulse":
                    lib.fb_post(brain, json.dumps({"pulse": msg.get("kind")}).encode())
                elif t == "reset":
                    lib.fb_post(brain, b'{"reset":true}')
                elif t == "learning":
                    lib.fb_post(brain, json.dumps({"learning": bool(msg.get("on"))}).encode())
                    print("learning", bool(msg.get("on")), flush=True)
                elif t == "memory":
                    # the lens keeps the canonical copy; we only pass the command in and the
                    # core's answer back out (drained in `loop`), exactly as app.js does
                    q = {"memory": msg.get("op")}
                    for k in ("data", "elapsed_s", "compact"):
                        if msg.get(k) is not None:
                            q[k] = msg[k]
                    lib.fb_post(brain, json.dumps(q, separators=(",", ":")).encode())
                elif t == "welcome":
                    lib.fb_post(brain, json.dumps({"learning": bool(msg.get("learning")), "cloud": True}).encode())
                    print("welcome learning:", bool(msg.get("learning")), flush=True)

        async def heartbeat():
            while True:
                await asyncio.sleep(25)
                await ws.send(phx("heartbeat", {}, t="phoenix"))

        takebuf = C.create_string_buffer(1 << 21)

        async def loop():
            n = 0
            t0 = time.time()
            while True:
                text = await asyncio.to_thread(lib.fb_step, brain)
                await ws.send(phx("broadcast", {"type": "broadcast", "event": "brain", "payload": json.loads(text)}))
                while True:  # the core's queued messages (memory blobs) go back as `brain` frames
                    got = lib.fb_take(brain, takebuf, len(takebuf))
                    if got <= 0 or got > len(takebuf):
                        break
                    await ws.send(phx("broadcast", {"type": "broadcast", "event": "brain",
                                                    "payload": json.loads(takebuf[:got].decode())}))
                n += 1
                if n % 40 == 0:
                    print(f"steps {n}  {(time.time() - t0) / n * 1000:.0f} ms/step", flush=True)

        async def orders():
            """ADR 68: drive a teaching session from here, the way the real page will."""
            if not a.cmd and not a.lesson:
                return
            await asyncio.sleep(a.cmd_after)
            packet = {"t": "cmd", "cmd": a.cmd} if a.cmd else None
            if a.cmd == "train":
                packet.update({"mode": a.mode, "cs": a.cs, "bouts": a.bouts})
                if a.cs_minus:
                    packet["csMinus"] = a.cs_minus
            if packet:
                await ws.send(phx("broadcast", {"type": "broadcast", "event": "cmd", "payload": packet}))
                print("sent cmd:", packet, flush=True)
            # ADR 71: drive the lesson's wizard the way the page's chips will
            for spec in (a.lesson or "").split(","):
                spec = spec.strip()
                if not spec:
                    continue
                wait, _, key = spec.partition(":")
                await asyncio.sleep(float(wait))
                pk = {"t": "cmd", "cmd": "lesson_choice", "key": key}
                await ws.send(phx("broadcast", {"type": "broadcast", "event": "cmd", "payload": pk}))
                print("sent lesson_choice:", key, flush=True)

        await asyncio.gather(inbox(), heartbeat(), loop(), orders())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pin", required=True)
    ap.add_argument("--relay", default="ws://localhost:8795")
    ap.add_argument("--key", default="")
    ap.add_argument("--name", default="mac page")
    ap.add_argument("--flyb", default=str(REPO / "core/brain_export/out/brain_c0.flyb.z"))
    ap.add_argument("--lib", default=str(REPO / "core/build/libflybrain_host.dylib"))
    ap.add_argument("--threads", type=int, default=2)
    # ADR 68: the lens accepts `{t:"cmd"}` on the same socket — train / train_stop / reset / memory_set
    ap.add_argument("--cmd", default="", choices=["", "train", "train_stop", "reset"])
    ap.add_argument("--cmd-after", type=float, default=25.0, dest="cmd_after")
    ap.add_argument("--mode", default="food")
    ap.add_argument("--cs", default="sugar cube")
    ap.add_argument("--cs-minus", default="", dest="cs_minus")
    ap.add_argument("--bouts", type=int, default=2)
    # ADR 71: "8:go,6:food,6:thing:sugar cube,6:hand,6:quick" = seconds to wait, then the choice key
    ap.add_argument("--lesson", default="")
    ap.add_argument("--gpu", action="store_true")
    asyncio.run(main(ap.parse_args()))
