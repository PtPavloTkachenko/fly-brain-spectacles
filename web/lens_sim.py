"""A "lens" without the glasses: drives the web page's room panel over the relay (ADR 61).

    uv run --with websockets python web/lens_sim.py --pin 4821 --relay ws://localhost:8795

The mirror of `page_sim.py` (which is a page without a browser). This one speaks the LENS half of
the protocol: it answers a page's `hello` with `welcome`, sends `senses` at 8 Hz (including a real
`eye` byte string, so the page's compound-eye panel and the brain's optic lobe both get driven) and
the `scene` packet of ADR 61 at WEB_SCENE_HZ. The room is synthetic and says so — it exists to test
and to demo the page when no Spectacles are around. It is NOT a model of anything.
"""
import argparse
import asyncio
import base64
import json
import math
import random
import time

import websockets

EYE_N = 1767
NAMES = ["NOVA", "PIP", "ZIGGY"]
THINGS = [
    ("pizza", "food", -90, 74, 120, 24), ("banana", "food", 140, 70, -40, 14),
    ("coffee", "scent", 60, 76, 150, 11), ("monstera", "scent", -170, 40, -150, 60),
    ("laptop", "object", 0, 74, 40, 34), ("keys", "object", 95, 73, 90, 8),
    ("bin", "bad", -200, 20, 60, 40), ("speaker", "object", 180, 30, 130, 26),
]


def room_points(n=1500):
    """floor + four walls + a table top, as int16 cm, exactly the shape the lens sends"""
    out = []
    W, D, H = 460, 420, 250
    for _ in range(n):
        r = random.random()
        if r < 0.42:
            x, y, z = random.uniform(-W / 2, W / 2), 0, random.uniform(-D / 2, D / 2)
        elif r < 0.52:
            x, y, z = random.uniform(-60, 120), 72, random.uniform(20, 170)
        else:
            s = random.randrange(4)
            t = random.uniform(-1, 1)
            y = random.uniform(0, H)
            x, z = ((W / 2) * t, (D / 2)) if s == 0 else ((W / 2) * t, -(D / 2)) if s == 1 else ((W / 2), (D / 2) * t) if s == 2 else (-(W / 2), (D / 2) * t)
        out += [int(x), int(y), int(z)]
    b = bytearray()
    for v in out:
        v = max(-32767, min(32767, v))
        b += (v & 0xFFFF).to_bytes(2, "little")
    return base64.b64encode(bytes(b)).decode(), [-W // 2, 0, -D // 2, W // 2, H, D // 2]


def room_surface(tris_target=9500):
    """The room as a TRIANGLE surface, in exactly the shape FlySceneFeed.buildSurface sends:
    int16 cm vertices + uint16 indices, base64, joined by '|' and cut into chunks."""
    W, D, H = 460, 420, 250
    verts: list[tuple[int, int, int]] = []
    index: dict[tuple[int, int, int], int] = {}
    tri: list[int] = []

    def v(x, y, z):
        k = (int(round(x)), int(round(y)), int(round(z)))
        i = index.get(k)
        if i is None:
            i = len(verts)
            index[k] = i
            verts.append(k)
        return i

    def grid(f, nu, nv):
        for iu in range(nu):
            for iv in range(nv):
                a = v(*f(iu / nu, iv / nv)); b = v(*f((iu + 1) / nu, iv / nv))
                c = v(*f((iu + 1) / nu, (iv + 1) / nv)); d = v(*f(iu / nu, (iv + 1) / nv))
                tri.extend((a, b, c, a, c, d))

    grid(lambda u, w: (-W / 2 + u * W, 0, -D / 2 + w * D), 34, 30)                      # floor
    grid(lambda u, w: (-W / 2 + u * W, w * H, -D / 2), 34, 16)                          # walls
    grid(lambda u, w: (-W / 2 + u * W, w * H, D / 2), 34, 16)
    grid(lambda u, w: (-W / 2, w * H, -D / 2 + u * D), 30, 16)
    grid(lambda u, w: (W / 2, w * H, -D / 2 + u * D), 30, 16)
    grid(lambda u, w: (-60 + u * 180, 72, 20 + w * 150), 12, 10)                        # a table top
    import array
    vb = array.array("h")
    for (x, y, z) in verts:
        vb.extend((x, y, z))
    ib = array.array("H", tri)
    payload = base64.b64encode(vb.tobytes()).decode() + "|" + base64.b64encode(ib.tobytes()).decode()
    return payload, len(verts), len(tri) // 3, [-W // 2, 0, -D // 2, W // 2, H, D // 2], verts


def surface_colors(verts, frac=1.0):
    """A stand-in for FlySceneFeed.surfaceColors(): RGBA per vertex, in the SAME order as the
    merged vertex list, alpha 255 where "the camera saw it" and 0 where it never did. There is no
    scan here, so the colour is a gradient and the seen/unseen split is a wedge that grows with
    `frac` — enough to exercise the page's `surfc` path end to end (--paint)."""
    W, D, H = 460, 420, 250
    out = bytearray(len(verts) * 4)
    for i, (x, y, z) in enumerate(verts):
        o = 4 * i
        # a plain, obviously-synthetic gradient: warm along +X, green with height, cool along +Z
        out[o] = int(60 + 190 * (x + W / 2) / W)
        out[o + 1] = int(50 + 150 * min(1.0, y / H))
        out[o + 2] = int(70 + 170 * (z + D / 2) / D)
        # the painted wedge sweeps round the room, so "not seen yet" is visible next to "seen"
        ang = (math.atan2(z, x) + math.pi) / (2 * math.pi)
        out[o + 3] = 255 if ang <= frac else 0
    return base64.b64encode(bytes(out)).decode()


def eye_image(t):
    """what the ommatidia sampled: a lit wall, a dark floor and a bright window drifting past —
    a stand-in for FlyRetina.image(), same EYE_N x RGB layout, so the IMAGE map is testable"""
    a = bytearray(EYE_N * 3)
    for c in range(EYE_N):
        u = (c % 60) / 60.0
        v = ((c // 60) % 30) / 30.0
        g = 0.22 + 0.5 * (1.0 - v)
        if abs(u - (0.5 + 0.35 * math.sin(t * 0.25))) < 0.09 and v < 0.55:
            g = 0.95
        o = 3 * c
        a[o] = int(255 * g * 0.92)
        a[o + 1] = int(255 * g * 0.97)
        a[o + 2] = int(255 * min(1.0, g * 1.05))
    return base64.b64encode(bytes(a)).decode()


def eye_bytes(t):
    """a drifting grating across both eyes: real ON/OFF bytes, 128 = no change"""
    a = bytearray([128]) * EYE_N
    for c in range(EYE_N):
        v = math.sin(c * 0.11 - t * 5.0) * math.sin(c * 0.013 + t * 0.7)
        if abs(v) > 0.55:
            a[c] = max(1, min(255, 128 + int(90 * v)))
    return base64.b64encode(bytes(a)).decode()


def quat_y(yaw):
    return [0.0, math.sin(yaw / 2), 0.0, math.cos(yaw / 2)]


# --- a fake training session, in exactly the fields the trainer adds to the scene packet
# (ADR 61 follow-up). It exists so the page's TRAINING and MEMORY panels can be built and judged
# before the real fields land; every key here must map 1:1 to the real one.
TRAIN_CS_PLUS = "pizza"
TRAIN_CS_MINUS = "coffee"
BOUTS = 8
T_PROBE = 7.0
T_BOUT = 4.0


def fake_train(t: float, mode: str, cs: str = TRAIN_CS_PLUS, csm: str = TRAIN_CS_MINUS, bouts: int = BOUTS):
    """probe -> BOUTS pairings -> probe -> done, on a wall clock that starts at t=0"""
    BOUTS = bouts
    TRAIN_CS_PLUS, TRAIN_CS_MINUS = cs, csm
    eff0, gain = 1.0, (0.0 if mode == "control" else 0.0085)
    b0 = 0.06
    if t < T_PROBE:
        return {"mode": mode, "phase": "probe", "n": 0, "N": BOUTS, "csPlus": TRAIN_CS_PLUS, "csMinus": TRAIN_CS_MINUS,
                "biasBefore": round(b0 + 0.01 * math.sin(t), 3), "eff": round(eff0, 5), "startedAt": 0}
    tb = t - T_PROBE
    if tb < BOUTS * T_BOUT:
        n = int(tb // T_BOUT) + 1
        eff = eff0 + gain * (tb / T_BOUT)
        return {"mode": mode, "phase": "bout", "n": n, "N": BOUTS, "csPlus": TRAIN_CS_PLUS, "csMinus": TRAIN_CS_MINUS,
                "biasBefore": b0, "eff": round(eff, 5), "startedAt": 0,
                "mbon": {"MBON07": round(14.0 - 0.9 * n + random.uniform(-0.4, 0.4), 1),
                         "MBON11": round(5.0 + 0.35 * n + random.uniform(-0.2, 0.2), 1)}}
    tp = tb - BOUTS * T_BOUT
    eff = eff0 + gain * BOUTS
    b1 = b0 + (0.0 if mode == "control" else 0.41)
    if tp < T_PROBE:
        return {"mode": mode, "phase": "probe2", "n": BOUTS, "N": BOUTS, "csPlus": TRAIN_CS_PLUS, "csMinus": TRAIN_CS_MINUS,
                "biasBefore": b0, "biasAfter": round(b1 * (tp / T_PROBE), 3), "eff": round(eff, 5), "startedAt": 0,
                "mbon": {"MBON07": 6.9, "MBON11": 7.8}}
    return {"mode": mode, "phase": "done", "n": BOUTS, "N": BOUTS, "csPlus": TRAIN_CS_PLUS, "csMinus": TRAIN_CS_MINUS,
            "biasBefore": b0, "biasAfter": round(b1, 3), "eff": round(eff, 5), "startedAt": 0,
            "mbon": {"MBON07": 6.9, "MBON11": 7.8},
            "result": "control" if mode == "control" else "learned"}


# --- the nine-step LESSON, branching, in exactly the shape the page renders
# (`train.mode == "lesson"` plus a `lesson` block). The WORDS here are stand-ins: on the glasses the
# trainer writes them, and the page prints whatever it is sent, verbatim. What this plays faithfully
# is the SHAPE and the BRANCHING -- which later steps quote which earlier answer, and the fact that a
# step only moves when the lens says so, never when the page clicks.
LESSON_N = 9


def lesson_step(st: dict, things: list, t: float) -> dict:
    """st = the sim's lesson state; returns the `lesson` block for the current step"""
    n = st["step"]
    kind = st.get("kind", "food")
    cue = st.get("cue", "")
    ctrl = st.get("ctrl", "")
    bouts = st.get("bouts", 6)
    how = {"hand": "picking it up", "say": "saying its name", "treat": "putting a treat on it"}.get(st.get("how", "hand"), "showing it")

    if n == 1:
        return {"step": 1, "of": LESSON_N, "title": "MEET YOUR FLY",
                "line": "A reconstructed fruit-fly brain is flying that body: 166,700 neurons, 25.6 million "
                        "synapses, running live. Nothing it does is scripted, which is also why it can refuse you.",
                "action": "Watch it for a moment.",
                "options": [{"key": "go", "label": "Let's go", "hint": "nine steps, about five minutes"}]}
    if n == 2:
        return {"step": 2, "of": LESSON_N, "title": "WHAT TO TEACH",
                "line": "A fly can learn that a thing in your room means something. It cannot learn words, "
                        "tricks or your name.",
                "action": "Pick what the thing should come to mean.",
                "options": [
                    {"key": "food", "label": "Food", "hint": "reward dopamine on landing - it should go there sooner"},
                    {"key": "danger", "label": "Danger", "hint": "stress dopamine and a shape that rushes it"},
                    {"key": "test", "label": "Just test it", "hint": "ask only: the synapses are frozen while we measure"}]}
    if n == 3:
        opts = [{"key": th[0], "label": th[0].upper(), "hint": "%s, %d cm away" % (th[1], abs(th[2]) + abs(th[4]))}
                for th in things[:3]]
        return {"step": 3, "of": LESSON_N, "title": "WHICH THING",
                "line": "These are what the glasses have named in your room. The one you pick becomes the cue; "
                        "the next one becomes the control, shown as often and never paid.",
                "action": "Pick the cue.", "options": opts}
    if n == 4:
        return {"step": 4, "of": LESSON_N, "title": "HOW TO SHOW IT",
                "line": "The fly finds the %s by smell and by shape. You can make it easier to find." % cue,
                "action": "Pick how you will present the %s." % cue,
                "options": [
                    {"key": "hand", "label": "Pick it up", "hint": "hold it where the fly can see it"},
                    {"key": "say", "label": "Say its name", "hint": "the glasses hear you and lure the fly"},
                    {"key": "treat", "label": "Put a treat on it", "hint": "a treat the fly can land on"}]}
    if n == 5:
        return {"step": 5, "of": LESSON_N, "title": "HOW MANY TIMES",
                "line": "Each pairing is the cue, the trip, and %s. More pairings, more to measure - and more "
                        "standing still." % ("no payment at all" if kind == "test" else "the dopamine"),
                "action": "Pick how many.",
                "options": [{"key": "3", "label": "Three", "hint": "quicker, and noisier"},
                            {"key": "6", "label": "Six", "hint": "the number the original experiment used"}]}
    if n == 6:
        return {"step": 6, "of": LESSON_N, "title": "MEASURE FIRST",
                "line": "Before anything is taught the fly is asked twice: how hard does it steer toward the %s, "
                        "and toward the %s? That pair is the zero everything after it is compared to." % (cue, ctrl),
                "action": "Stand still for about twenty seconds.",
                "options": [{"key": "ready", "label": "I'm ready", "hint": "the two measurements start now"}]}
    if n == 7:
        done = st.get("bout", 0)
        return {"step": 7, "of": LESSON_N, "title": "THE LESSONS",
                "line": "Pairing %d of %d. The %s comes on, the fly flies there on its own brain, and %s." % (
                    max(1, done), bouts, cue,
                    "nothing follows - this is a measurement" if kind == "test"
                    else "three seconds after it lands, sixteen pulses of %s dopamine arrive" % ("reward" if kind == "food" else "stress")),
                "action": "You are %s. Between pairings the %s is shown and paid nothing." % (how, ctrl),
                "options": [{"key": "skip", "label": "Skip the rest", "hint": "go straight to the second measurement"}]}
    if n == 8:
        return {"step": 8, "of": LESSON_N, "title": "MEASURE AGAIN",
                "line": "The same two questions, in the same words, so the answers can be put side by side.",
                "action": "Stand still once more.",
                "options": [{"key": "verdict", "label": "Show me the verdict", "hint": "the numbers, and what they mean"}]}
    learned = kind != "test"
    return {"step": 9, "of": LESSON_N, "title": "THE VERDICT",
            "line": ("The fly turns toward the %s sooner than it did, and the %s did not move. The synapses that "
                     "carry it are measurably weaker - which is what learning looks like in this rule." % (cue, ctrl))
                    if learned else
                    ("Nothing could have changed: the synapses were frozen for the whole session. That is what "
                     "a test is for - it can be repeated without teaching anything."),
            "action": "What now?",
            "options": [{"key": "opposite", "label": "Teach the opposite", "hint": "the same thing, the other outcome"},
                        {"key": "forget", "label": "Make it forget", "hint": "extinction: the cue, paying nothing"},
                        {"key": "save", "label": "Save this brain", "hint": "keep this version of the fly"},
                        {"key": "done", "label": "Done", "hint": "leave it be"}]}


def lesson_answer(st: dict, key: str) -> None:
    """what each answer does. This is the branching: later steps quote these."""
    n = st["step"]
    st["chosen"] = key
    if n == 2:
        st["kind"] = key if key in ("food", "danger", "test") else "food"
    elif n == 3:
        st["cue"] = key
        names = [th[0] for th in THINGS]
        st["ctrl"] = next((x for x in names if x != key), "the other one")
    elif n == 4:
        st["how"] = key
    elif n == 5:
        st["bouts"] = 3 if key == "3" else 6
        st["bouts_n"] = st["bouts"]
    elif n == 7 and key == "skip":
        st["step"] = 8
        st["chosen"] = ""
        st["at"] = time.time()
        return
    elif n == 9:
        if key == "done":
            st["over"] = True
        return
    st["step"] = min(LESSON_N, n + 1)
    st["chosen"] = ""      # the echo belonged to the step that just closed
    st["at"] = time.time()
    if st["step"] == 7:
        st["bout"] = 1
        st.setdefault("bouts_n", st.get("bouts", 6))


def lesson_summary(st: dict) -> dict:
    """the same evidence-pack shape the real trainer sends, so CONCLUSIONS fills in on step 9"""
    kind = st.get("kind", "food")
    cue, ctrl = st.get("cue", "the cue"), st.get("ctrl", "the control")
    learned = kind != "test"
    return {
        "learned": "yes" if learned else "no",
        "confidence": "medium" if learned else "high",
        "what": ("It steers toward the %s sooner than before, and not toward the %s." % (cue, ctrl)) if learned
                else "Nothing could move: the synapses were frozen for the whole session.",
        "evidence": {"bias_before": 0.06, "bias_after": 0.47 if learned else 0.06,
                     "delta": 0.41 if learned else 0.0, "bouts": st.get("bouts", 6),
                     "mean_efficacy": 1.0 - (0.0085 * st.get("bout", 0) if learned else 0),
                     "MBON07": 6.9, "MBON11": 7.8, "plasticity": "on" if learned else "frozen"},
        "caveats": "%d pairings is few, and this model's absolute rates are not claimed to be accurate"
                   % st.get("bouts", 6),
        "next": "run a TEST for a number that measuring cannot change",
        "text": ("After %d pairings the fly turns toward the %s sooner than it did, while the %s did not move. "
                 "The synapses that carry it are %.2f %% away from where they started."
                 % (st.get("bouts", 6), cue, ctrl, 100 * 0.0085 * st.get("bout", 0))) if learned else
                ("The before and after measurements overlap, and they had to: plasticity was off for the whole "
                 "session. That is what a test is for."),
    }


# what the person wearing the glasses would press at each step, for a sim that runs alone
LESSON_DEFAULT = {1: "go", 2: "food", 4: "hand", 5: "3", 6: "ready", 8: "verdict", 9: "done"}


def lesson_tick(st: dict, things: list, dwell: float) -> None:
    """Advance the lesson the way the GLASSES would: show the options, then answer them.

    The page cannot answer -- by design (Pavlo, 15.09: the site shows the data, not the setup) -- so
    the sim plays the person: it waits `dwell`, echoes a `chosen` key so the page can light that row,
    and a moment later moves on. `lesson_choice` off the wire still works, for protocol tests.
    """
    if st.get("over") or st["step"] == 7:
        return
    el = time.time() - st["at"]
    key = LESSON_DEFAULT.get(st["step"]) or (things[0][0] if st["step"] == 3 else "go")
    if el > dwell + 1.6 and st.get("chosen"):
        lesson_answer(st, st["chosen"])
    elif el > dwell and not st.get("chosen"):
        st["chosen"] = key


def lesson_train(st: dict, things: list, t: float) -> dict:
    """the whole `train` packet while a lesson runs: the normal fields PLUS the lesson block"""
    kind = st.get("kind", "food")
    bouts = st.get("bouts", 6)
    n = st["step"]
    phase = "idle" if n < 6 else "probe" if n == 6 else "bout" if n == 7 else "probe2" if n == 8 else "done"
    eff = 1.0 if kind == "test" else round(1.0 - 0.0085 * st.get("bout", 0), 5)
    out = {"mode": "lesson", "phase": phase, "n": st.get("bout", 0), "N": bouts,
           "csPlus": st.get("cue", ""), "csMinus": st.get("ctrl", ""), "eff": eff,
           "lesson": lesson_step(st, things, t)}
    if st.get("chosen"):
        out["lesson"]["chosen"] = st["chosen"]
    if n >= 6:
        out["biasBefore"] = 0.06
    if n >= 8:
        out["biasAfter"] = 0.06 if kind == "test" else 0.47
        out["mbon"] = {"MBON07": 6.9, "MBON11": 7.8}
    if n == 9:
        out["result"] = "control" if kind == "test" else "learned" if kind == "food" else "aversive"
    return out


def fake_mem(t: float, mode: str):
    saved = time.time() - (t % 47)
    return {"keySource": "user", "keyShort": "9695", "synced": t > 20, "bytes": 8192 + int(t * 37),
            "savedAt": round(saved, 1), "changedSinceSave": (t % 47) > 20,
            "mean_efficacy": round(1.0 + (0.0 if mode == "control" else 0.0085 * min(BOUTS, max(0, (t - T_PROBE) / T_BOUT))), 5),
            "changed": int(min(BOUTS, max(0, (t - T_PROBE) / T_BOUT)) * 161),
            "history": [0.02, -0.05, 0.11, 0.33, 0.28, 0.41]}


async def main(a):
    topic = "realtime:fly-" + a.pin
    url = a.relay + (("?apikey=" + a.key + "&vsn=1.0.0") if a.key else "")
    ref = 0

    def phx(event, payload, t=topic):
        nonlocal ref
        ref += 1
        return json.dumps({"topic": t, "event": event, "payload": payload, "ref": str(ref)})

    def cast(ev, payload):
        return phx("broadcast", {"type": "broadcast", "event": "lens", "payload": payload})

    mesh, box = room_points(a.points)
    surf_payload, surf_n, surf_t, surf_box, surf_verts = room_surface()
    CHUNK = 40000
    surf_chunks = [surf_payload[o:o + CHUNK] for o in range(0, len(surf_payload), CHUNK)]
    print(f"surface: {surf_t} tris, {surf_n} verts, {len(surf_payload)} B base64, {len(surf_chunks)} chunks", flush=True)
    async with websockets.connect(url, max_size=4 * 1024 * 1024) as ws:
        await ws.send(phx("phx_join", {"config": {"broadcast": {"self": False, "ack": False}}}))
        print("lens sim in", topic, flush=True)
        state = {"page": False, "seq": 0, "sent_mesh": False, "inv": 0}

        async def inbox():
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except Exception:
                    continue
                if m.get("event") != "broadcast":
                    continue
                p = m.get("payload") or {}
                if p.get("event") == "cmd":
                    c = p.get("payload") or {}
                    k = c.get("cmd")
                    print("cmd:", k, c.get("mode") or "", c.get("cs") or "", flush=True)
                    if k == "train" and (c.get("mode") or "").lower() == "lesson":
                        # the guided door: a nine-step branching lesson the PAGE walks through
                        state["lesson"] = {"step": 1, "bout": 0, "chosen": "", "at": time.time()}
                        state.pop("tr", None)
                        state["summary_sent"] = False
                        print("lesson: started", flush=True)
                    elif k == "lesson_choice":
                        ls = state.get("lesson")
                        key = str(c.get("key") or "")
                        if ls:
                            lesson_answer(ls, key)
                            state.pop("tr", None)
                            print(f"lesson: step {ls['step']} after choosing {key!r}", flush=True)
                    elif k == "train":
                        state["train_t0"] = time.time()
                        state["train_mode"] = "control" if c.get("mode") == "TEST" else "associative"
                        state["cs"] = c.get("cs") or TRAIN_CS_PLUS
                        state["csm"] = c.get("csMinus") or TRAIN_CS_MINUS
                        state["bouts"] = int(c.get("bouts") or BOUTS)
                        state["summary_sent"] = False
                        state.pop("tr", None)
                    elif k == "train_stop":
                        state["train_t0"] = None
                    elif k == "reset":
                        state["reset_at"] = time.time()
                    continue
                if p.get("event") == "hello":
                    state["page"] = True
                    state["sent_mesh"] = False
                    state["inv"] = 0
                    state.pop("tr", None)  # a fresh page missed every diff: resend (FlySceneFeed.resend)
                    state.pop("mt", None)
                    state.pop("sp", None)
                    print("page joined:", (p.get("payload") or {}).get("name"), flush=True)
                    if a.train == "lesson" and not state.get("lesson"):
                        # --train lesson: the guided session is already waiting when the page arrives,
                        # so the wizard can be walked through without a lens and without a click
                        state["lesson"] = {"step": 1, "bout": 0, "chosen": "", "at": time.time()}
                        state["summary_sent"] = False
                        print("lesson: armed by --train lesson", flush=True)
                    await ws.send(cast("welcome", {"t": "welcome", "flies": 1, "learning": False}))

        async def senses():
            t0 = time.time()
            while True:
                await asyncio.sleep(1 / 8)
                if not state["page"]:
                    continue
                t = time.time() - t0
                ch = {"eye": eye_bytes(t), "odor": {"L": 0.2 + 0.2 * math.sin(t * 0.4), "R": 0.2 + 0.2 * math.cos(t * 0.35)},
                      "object": {"L": abs(math.sin(t * 0.6)) * 0.5, "R": abs(math.cos(t * 0.55)) * 0.5},
                      "sweet": max(0.0, math.sin(t * 0.17)) * 0.6}
                await ws.send(cast("senses", {"t": "senses", "fly": 0, "ch": ch}))

        async def scene():
            t0 = time.time()
            while True:
                await asyncio.sleep(1 / a.hz)
                if not state["page"]:
                    continue
                t = time.time() - t0
                state["seq"] += 1
                flies = []
                for i in range(a.flies):
                    ph = t * (0.45 + 0.13 * i) + i * 2.1
                    rad = 110 + 40 * math.sin(t * 0.3 + i)
                    x, z = rad * math.cos(ph), rad * math.sin(ph)
                    y = 95 + 35 * math.sin(t * 0.8 + i * 1.7)
                    yaw = ph + math.pi / 2
                    body = [0, 60 + 30 * abs(math.sin(t + i)), 0.8, 0.02, 0.45 + 0.4 * abs(math.sin(t * 0.2 + i)), 0, 0, 0, 0]
                    body += [0.6, 0.2 * math.sin(t * 1.3 + i), 0, 0, 0, 0.1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0]
                    flies.append([i, NAMES[i % len(NAMES)], int(x), int(y), int(z)] + [round(v, 3) for v in quat_y(yaw)] + [round(v, 2) for v in body])
                hy = 0.55 * math.sin(t * 0.12)
                msg = {"t": "scene", "n": state["seq"], "hz": a.hz,
                       "h": [int(60 * math.sin(t * 0.09)), 165, int(150 + 20 * math.cos(t * 0.11))] + [round(v, 3) for v in quat_y(math.pi + hy)],
                       "s": 0, "f": flies}
                if int(t) % 17 == 3 and state.get("th") != int(t) // 17:
                    state["th"] = int(t) // 17
                    msg["th"] = random.choice([
                        "Something sweet, to the left. Worth the trip.",
                        "That shape got bigger, fast. Not staying for it.",
                        "The table is warm. Good place to clean my feet.",
                        "Nothing smells of anything. I will keep circling.",
                    ])
                if not state["sent_mesh"]:
                    state["sent_mesh"] = True
                    msg["mesh"] = {"v": 1, "p": mesh, "b": box}
                    state["inv"] = 1
                    msg["inv"] = [[n + "_1", n, cls, x, y, z, s, 1] for (n, cls, x, y, z, s) in THINGS]
                sp = state.get("sp", 0)
                if sp < len(surf_chunks):  # one chunk per tick, as the lens hands them over
                    state["sp"] = sp + 1
                    msg["surf"] = {"v": 1, "part": sp, "parts": len(surf_chunks), "n": surf_n,
                                   "t": surf_t, "b": surf_box, "s": surf_chunks[sp]}
                # the room as the scan painted it, once the geometry is all in and then again
                # while it "keeps painting" — the same shape and the same cadence as the lens
                if a.paint and sp >= len(surf_chunks) and t - state.get("pc", -99) > 4.0:
                    state["pc"] = t
                    state["pf"] = min(1.0, state.get("pf", 0.34) + 0.22)
                    msg["surfc"] = {"v": 1, "c": surface_colors(surf_verts, state["pf"])}
                msg["mv"] = 1 if state["sent_mesh"] else 0
                msg["iv"] = state["inv"]
                if a.eyeimg and int(t * 2) != state.get("ei"):
                    state["ei"] = int(t * 2)
                    msg["eyeimg"] = eye_image(t)
                # a lesson the page started over the relay: nine steps, branching on the answers
                if state.get("lesson"):
                    ls = state["lesson"]
                    if a.train == "lesson":
                        lesson_tick(ls, THINGS, a.lesson_dwell)
                    if ls["step"] == 7:  # the pairings run on their own clock until they are done
                        per = 3.0
                        want = min(ls.get("bouts_n", 6), int((time.time() - ls["at"]) / per) + 1)
                        if want != ls.get("bout"):
                            ls["bout"] = want
                        if time.time() - ls["at"] > per * ls.get("bouts_n", 6):
                            ls["step"] = 8
                            ls["chosen"] = ""
                    tr = lesson_train(ls, THINGS, t)
                    if tr != state.get("tr"):
                        state["tr"] = tr
                        msg["train"] = tr
                    if tr.get("result") and not state.get("summary_sent"):
                        state["summary_sent"] = True
                        msg["train_summary"] = lesson_summary(ls)
                elif state.get("train_t0"):
                    tt = time.time() - state["train_t0"]
                    tr = fake_train(tt, state["train_mode"], state["cs"], state["csm"], state["bouts"])
                    if tr != state.get("tr"):
                        state["tr"] = tr
                        msg["train"] = tr
                    if tr.get("result") and not state.get("summary_sent"):
                        state["summary_sent"] = True
                        learned = tr["result"] == "learned"
                        msg["train_summary"] = {
                            "learned": "yes" if learned else "no",
                            "confidence": "medium" if learned else "high",
                            "what": ("It steers toward %s sooner than before, and not toward %s." % (state["cs"], state["csm"]))
                                    if learned else "Nothing moved outside the probe's own spread.",
                            "evidence": {"bias_before": tr["biasBefore"], "bias_after": tr.get("biasAfter"),
                                         "delta": round((tr.get("biasAfter") or 0) - tr["biasBefore"], 3),
                                         "bouts": tr["N"], "mean_efficacy": tr["eff"],
                                         "MBON07": tr.get("mbon", {}).get("MBON07"), "MBON11": tr.get("mbon", {}).get("MBON11")},
                            "caveats": "six pairings is few, and this LIF model's absolute rates are not claimed to be accurate",
                            "next": "run TEST for a number that measuring cannot change",
                            "text": ("After six pairings the fly turns toward the %s sooner than it did, while the %s "
                                     "did not move. The KC->MBON synapses that carry it are %.2f%% away from where they "
                                     "started." % (state["cs"], state["csm"], 100 * (tr["eff"] - 1)))
                                    if learned else
                                    ("The before and after measurements overlap. That is a real answer: this fly did not "
                                     "learn the %s in %d pairings." % (state["cs"], tr["N"])),
                        }
                elif a.train and a.train != "lesson":
                    tr = fake_train(t, a.train)
                    if tr != state.get("tr"):  # "only on change", exactly like the real feed
                        state["tr"] = tr
                        msg["train"] = tr
                # a fly has a memory whether or not it is being trained right now
                if int(t) != state.get("mt"):
                    state["mt"] = int(t)
                    msg["mem"] = fake_mem(t, a.train or "associative")
                await ws.send(cast("scene", msg))

        async def heartbeat():
            while True:
                await asyncio.sleep(25)
                await ws.send(phx("heartbeat", {}, t="phoenix"))

        await asyncio.gather(inbox(), senses(), scene(), heartbeat())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pin", required=True)
    ap.add_argument("--relay", default="ws://localhost:8795")
    ap.add_argument("--key", default="")
    ap.add_argument("--hz", type=float, default=4)
    ap.add_argument("--flies", type=int, default=3)
    ap.add_argument("--points", type=int, default=1500)
    ap.add_argument("--lesson-dwell", type=float, default=6.0, dest="lesson_dwell",
                    help="seconds a lesson step stays open before the sim answers it (--train lesson)")
    ap.add_argument("--eyeimg", action="store_true", help="send a stand-in ommatidial IMAGE map")
    ap.add_argument("--paint", action="store_true",
                    help="send `surfc` — RGBA per surface vertex, a synthetic stand-in for the "
                         "scan's own colours, growing every 4 s as a real bake would")
    ap.add_argument("--train", nargs="?", const="associative", default="",
                    help="play a fake training session: 'associative' (default), 'control', or "
                         "'lesson' (the nine-step branching wizard; it waits for the page's "
                         "lesson_choice at every step)")
    asyncio.run(main(ap.parse_args()))
