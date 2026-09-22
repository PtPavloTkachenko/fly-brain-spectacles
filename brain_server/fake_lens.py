"""Stand-in for the lens: drive one fly through named sense scenarios and print what its
brain decides. The go/no-go check for the whole server before any Spectacles work.

    uv run --with websockets python brain_server/fake_lens.py [--url ws://localhost:8790] [--secs 6]
"""

import argparse
import asyncio
import json

import websockets

SCENARIOS = {
    "neutral": {"light": 0.627},
    "food_left": {"object": {"L": 0.8}, "odor": {"L": 0.8, "R": 0.4}},
    "food_right": {"object": {"R": 0.8}, "odor": {"L": 0.4, "R": 0.8}},
    "motion_left": {"motion": {"L": 0.8}},
    "motion_right": {"motion": {"R": 0.8}},
    "loom_left": {"loom": {"L": 1.0}},
    "loom_right": {"loom": {"R": 1.0}},
    "sweet": {"sweet": 1.0, "odor": {"L": 0.6, "R": 0.6}},
    "bitter": {"bitter": 1.0},
    "touch_back": {"touch": {"L": 1.0, "R": 1.0}},
    "hot": {"hot": 1.0},
}
KEYS = ["turn", "orient", "escape_L", "escape_R", "stop", "back", "feed", "appetite", "forward"]


async def main(url, secs, fly, only):
    async with websockets.connect(url, max_size=2**22) as ws:
        hello = json.loads(await ws.recv())
        print("welcome:", hello)
        await ws.send(json.dumps({"t": "hello", "role": "fake_lens", "proto": 1}))
        await ws.send(json.dumps({"t": "select", "fly": fly}))
        latest = {}

        async def pump():
            async for raw in ws:
                m = json.loads(raw)
                if m.get("t") == "brain" and m["fly"] == fly:
                    latest.setdefault("rows", []).append(m)
                elif m.get("t") in ("ready", "dead"):
                    print(m)

        task = asyncio.create_task(pump())
        print(f"{'scenario':<13}" + "".join(f"{k:>9}" for k in KEYS) + f"{'wall_ms':>9}{'cloud%':>8}")
        for name, ch in SCENARIOS.items():
            if only and name not in only:
                continue
            for gap_ch, dur in (({"light": 0.627}, 2.0), (ch, secs)):
                latest["rows"] = []
                t = 0.0
                while t < dur:
                    await ws.send(json.dumps({"t": "senses", "fly": fly, "ch": gap_ch}))
                    await asyncio.sleep(0.25)
                    t += 0.25
            rows = latest["rows"][len(latest["rows"]) // 2 :] or latest["rows"]
            if not rows:
                print(f"{name:<13} no brain output yet")
                continue
            mean = {k: sum(r["act"][k] for r in rows) / len(rows) for k in KEYS}
            wall = sum(r["wall_ms"] for r in rows) / len(rows)
            cloud = ""
            if "cloud" in rows[-1]:
                import base64

                bits = base64.b64decode(rows[-1]["cloud"])
                cloud = f"{100 * sum(bin(b).count('1') for b in bits) / (8 * len(bits)):.1f}"
            print(f"{name:<13}" + "".join(f"{mean[k]:9.2f}" for k in KEYS) + f"{wall:9.0f}{cloud:>8}")
        task.cancel()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://localhost:8790")
    ap.add_argument("--secs", type=float, default=6.0)
    ap.add_argument("--fly", type=int, default=0)
    ap.add_argument("--only", nargs="*")
    a = ap.parse_args()
    asyncio.run(main(a.url, a.secs, a.fly, a.only))
