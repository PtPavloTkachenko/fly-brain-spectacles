"""Dev relay for the web brain (ADR 55): a minimal Phoenix-compatible WebSocket server.

    uv run --with websockets python web/relay.py --port 8795

Speaks the subset of the Phoenix / Supabase Realtime protocol (vsn 1.0.0 JSON) that the lens
(`WebBrainLink.ts`) and the page (`web/app.html`) use, so the SAME client code talks to this relay
on the Mac and to Supabase Realtime in the cloud (only the URL and the apikey change):

    join       {"topic":"realtime:fly-4821","event":"phx_join","payload":{...},"ref":"1"}
    reply      {"topic":..., "event":"phx_reply","payload":{"status":"ok","response":{}},"ref":"1"}
    broadcast  {"topic":..., "event":"broadcast","payload":{"type":"broadcast","event":"brain","payload":{...}},"ref":null}
               -> forwarded to every OTHER member of the topic
    heartbeat  {"topic":"phoenix","event":"heartbeat","payload":{},"ref":"7"} -> reply ok

A room is a topic; the lens's PIN makes the topic name. Nothing is stored.
"""
import argparse
import asyncio
import json
import logging
import time

import websockets

log = logging.getLogger("relay")
rooms: dict[str, set] = {}


async def handle(ws):
    joined: set[str] = set()
    peer = ws.remote_address
    log.info("connect %s", peer)
    try:
        async for raw in ws:
            try:
                m = json.loads(raw)
            except Exception:
                continue
            topic, event, ref = m.get("topic", ""), m.get("event", ""), m.get("ref")
            if event == "heartbeat":
                await ws.send(json.dumps({"topic": "phoenix", "event": "phx_reply", "payload": {"status": "ok", "response": {}}, "ref": ref}))
            elif event == "phx_join":
                rooms.setdefault(topic, set()).add(ws)
                joined.add(topic)
                log.info("join %s %s (%d in room)", peer, topic, len(rooms[topic]))
                await ws.send(json.dumps({"topic": topic, "event": "phx_reply", "payload": {"status": "ok", "response": {}}, "ref": ref}))
            elif event == "phx_leave":
                rooms.get(topic, set()).discard(ws)
                joined.discard(topic)
                await ws.send(json.dumps({"topic": topic, "event": "phx_reply", "payload": {"status": "ok", "response": {}}, "ref": ref}))
            elif event == "broadcast":
                out = json.dumps({"topic": topic, "event": "broadcast", "payload": m.get("payload", {}), "ref": None})
                others = [c for c in rooms.get(topic, ()) if c is not ws]
                if others:
                    await asyncio.gather(*(c.send(out) for c in others), return_exceptions=True)
    except websockets.ConnectionClosed:
        pass
    finally:
        for t in joined:
            rooms.get(t, set()).discard(ws)
            if not rooms.get(t):
                rooms.pop(t, None)
        log.info("leave %s", peer)


async def main(port: int):
    # no permessage-deflate: the lens's WebSocket client negotiates it and then drops the larger frames
    async with websockets.serve(handle, "0.0.0.0", port, max_size=4 * 1024 * 1024, ping_interval=20, compression=None):
        log.info("relay on :%d", port)
        await asyncio.Future()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8795)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    asyncio.run(main(a.port))
