"""Fly brain server: N MaleCNS brains (one process each) behind one WebSocket.

    scripts/run_server.sh            # = the command below with the live defaults, logs to $CYBERFLY_RUNTIME/logs
    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run --with websockets --with zeroconf \
        python "<repo>/brain_server/server.py" --flies 5 --cloud 16000 --engine batch --kernel metal

Lens connects to ws://flybrain.local:8790 (mDNS) or ws://<mac-ip>:8790.
CYBERFLY_RUNTIME (default ~/cyberfly_runtime) holds fly-wirehead, its data and the kernel builds.
"""

import argparse
import asyncio
import json
import logging
import multiprocessing as mp
import os
import sys
import threading
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
RUNTIME = Path(os.environ.get("CYBERFLY_RUNTIME", Path.home() / "cyberfly_runtime")).expanduser()
os.environ.setdefault("FLYWIREHEAD_DATA", str(RUNTIME / "fly-wirehead/data"))

import mdns  # noqa: E402
import protocol  # noqa: E402
from worker import run as worker_run  # noqa: E402

log = logging.getLogger("flybrain")
CLOUD_FILE = HERE.parent / "brain/results/cloud_subset.npz"
POINTCLOUD = HERE.parent / "brain/results/pointcloud.npz"


def cloud_subset(n):
    """Fixed, shared (server <-> lens) sample of neurons shown in the hand hologram:
    stratified by superclass so small classes (DNs, sensory) stay visible."""
    if CLOUD_FILE.exists():
        with np.load(CLOUD_FILE) as f:
            if len(f["idx"]) == n:
                return f["idx"]
    with np.load(POINTCLOUD) as p:
        xyz, sc, names = p["xyz"], p["superclass"], p["superclass_names"]
    rng = np.random.default_rng(7)
    total = len(sc)
    picks = []
    for code in np.unique(sc):
        members = np.flatnonzero(sc == code)
        k = max(min(len(members), 64), int(round(n * len(members) / total)))
        picks.append(rng.choice(members, size=min(k, len(members)), replace=False))
    idx = np.unique(np.concatenate(picks))
    if len(idx) > n:
        idx = np.sort(rng.choice(idx, size=n, replace=False))
    idx = idx.astype(np.int32)
    np.savez_compressed(CLOUD_FILE, idx=idx, xyz=xyz[idx], superclass=sc[idx], superclass_names=names)
    return idx


async def main(args):
    ctx = mp.get_context("spawn")
    subset = cloud_subset(args.cloud)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    inboxes = []
    batch_ends = []  # --engine batch: every fly's pipe ends go to ONE process (engine/batch_worker.py)
    for fly in range(args.flies):
        to_worker, worker_in = ctx.Pipe(duplex=False)  # (reader, writer) order: recv end first
        worker_out, from_worker = ctx.Pipe(duplex=False)
        if args.engine == "batch":
            batch_ends.append((fly, to_worker, from_worker))
        else:
            p = ctx.Process(target=worker_run, args=(fly, to_worker, from_worker, subset, args.step_ms), daemon=True)
            p.start()
        inboxes.append(worker_in)

        def reader(fly=fly, conn=worker_out):
            while True:
                try:
                    msg = conn.recv()
                except EOFError:
                    loop.call_soon_threadsafe(queue.put_nowait, {"t": "dead", "fly": fly})
                    return
                loop.call_soon_threadsafe(queue.put_nowait, msg)

        threading.Thread(target=reader, daemon=True).start()

    if batch_ends:
        from engine.batch_worker import run as batch_run

        ctx.Process(target=batch_run, args=(batch_ends, subset, args.step_ms, args.kernel), daemon=True).start()

    clients = set()
    selected = {"fly": 0}
    inboxes[0].send({"cloud": True})

    async def handler(ws):
        clients.add(ws)
        log.info(f"client connected {ws.remote_address} ({len(clients)} total)")
        await ws.send(protocol.encode({"t": "welcome", "proto": 1, "flies": args.flies, "cloud": len(subset)}))
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    msgs = protocol.decode_many(raw)
                except protocol.ProtocolError as e:
                    log.warning(f"bad message: {e} | raw[:300]={raw[:300]!r}")
                    continue
                for m in msgs:
                    t = m["t"]
                    fly = m.get("fly")
                    if fly is not None and not 0 <= fly < args.flies:
                        continue
                    if t == "senses":
                        inboxes[fly].send({"senses": m["ch"]})
                    elif t == "select" and fly != selected["fly"]:
                        inboxes[selected["fly"]].send({"cloud": False})
                        inboxes[fly].send({"cloud": True})
                        selected["fly"] = fly
                    elif t == "pulse" and m["kind"] in ("reward", "punish"):
                        inboxes[fly].send({"pulse": m["kind"]})
                    elif t == "reset":
                        inboxes[fly].send({"reset": True})
                    elif t == "dbg":
                        rows = " | ".join(
                            f"{i}:{r.get('st')} {r.get('a')} d={r.get('d')} dy={r.get('dy')} v={r.get('v')} e={r.get('e')}"
                            for i, r in enumerate(m["flies"])
                        )
                        log.info(f"LENS sel={m.get('sel')} step={m.get('wall')}ms cloud=[{m.get('cloud')}] scan=[{m.get('scan')}] board={m.get('board')} {rows}")
                    elif t == "ping":
                        await ws.send(protocol.encode({"t": "pong", "ts": m["ts"]}))
        except Exception:
            pass
        finally:
            clients.discard(ws)
            log.info(f"client left ({len(clients)} total)")

    steps = {"n": 0}

    async def broadcast():
        while True:
            msg = await queue.get()
            # where a step actually goes (12.09: the GPU kernel is only ~18 ms of an 85-104 ms step)
            if msg["t"] == "brain" and msg.get("fly") == selected["fly"] and msg.get("prof"):
                steps["n"] += 1
                if steps["n"] % 20 == 0:
                    pr = msg["prof"]
                    log.info(f"STEP fly={msg['fly']} wall={msg.get('wall_ms')}ms "
                             f"advance={pr.get('adv')} decode={pr.get('dec')} cloud={pr.get('msg')} total={pr.get('out')}")
            if msg["t"] in ("ready", "dead"):
                log.info(f"fly {msg['fly']} {msg['t']}" + (f" baseline {msg.get('baseline')}" if msg["t"] == "ready" else ""))
            if clients:
                text = json.dumps(msg, separators=(",", ":"))
                await asyncio.gather(*(c.send(text) for c in list(clients)), return_exceptions=True)

    from websockets.asyncio.server import serve

    responder = mdns.Responder(mdns.lan_ip(), args.port)
    # zeroconf's sync API refuses to run on the event loop thread.
    await asyncio.to_thread(responder.start)
    async with serve(handler, "0.0.0.0", args.port, ping_interval=None, max_size=2**20):
        log.info(f"listening on :{args.port} with {args.flies} flies, step {args.step_ms} ms, cloud {len(subset)}")
        try:
            await broadcast()
        finally:
            responder.stop()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--flies", type=int, default=5)
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--step-ms", type=float, default=50.0)
    ap.add_argument("--cloud", type=int, default=16384)
    # Off by default: "batch" = all flies in one process, one shared connectome, one thread per
    # fly (engine/batch_worker.py, bit-identical spikes — see engine/RESULTS.md).
    ap.add_argument("--engine", choices=["process", "batch"], default="process")
    ap.add_argument("--kernel", choices=["orig", "fast", "par2", "par3", "metal"], default="fast",
                    help="batch engine only; parN = each fly on N threads; metal = all flies on the GPU "
                         "(engine/metal/RESULTS.md)")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    asyncio.run(main(ap.parse_args()))
