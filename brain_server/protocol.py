"""WS protocol: JSON text frames with discriminator `t`.

Lens -> Mac : hello, senses, select, pulse, reset, ping
Mac  -> Lens: welcome, ready, brain, pong, dead
"""

from __future__ import annotations

import json
from typing import Any

_REQUIRED: dict[str, tuple[str, ...]] = {
    # lens -> mac
    "hello": ("role", "proto"),
    "senses": ("fly", "ch"),  # ch = {channel: value | {"L": v, "R": v}}, values 0..1
    "select": ("fly",),  # which fly's brain cloud to stream
    "pulse": ("fly", "kind"),  # one-shot 200 ms current: "reward" | "punish"
    "reset": ("fly",),
    "ping": ("ts",),
    "dbg": ("flies",),  # lens telemetry rows, logged by the server (debug channel)
    # mac -> lens
    "welcome": ("proto", "flies", "cloud"),
    "ready": ("fly",),
    "brain": ("fly", "sim_ms", "act", "neural"),
    "pong": ("ts",),
    "dead": ("fly",),
}


class ProtocolError(ValueError):
    pass


def _validate(msg: Any) -> dict[str, Any]:
    if not isinstance(msg, dict) or "t" not in msg:
        raise ProtocolError("missing discriminator 't'")
    required = _REQUIRED.get(msg["t"])
    if required is None:
        raise ProtocolError(f"unknown message type {msg['t']!r}")
    missing = [k for k in required if k not in msg]
    if missing:
        raise ProtocolError(f"{msg['t']}: missing fields {missing}")
    return msg


def decode_many(text: str) -> list[dict[str, Any]]:
    """One WS frame may hold SEVERAL concatenated JSON objects (Lens Studio coalesces rapid
    sends) AND trailing garbage bytes: the LS 5.15 preview WebSocket appends junk like
    '\\x08\\x1f\\ufffd\\n\\x01' after a valid object. Parse every object, skip everything else."""
    decoder = json.JSONDecoder()
    out, idx, n = [], 0, len(text)
    while idx < n:
        start = text.find("{", idx)
        if start < 0:
            break
        try:
            obj, idx = decoder.raw_decode(text, start)
        except json.JSONDecodeError:
            idx = start + 1  # junk that happens to contain '{'
            continue
        # After a truncated message the scan resumes INSIDE it and finds nested objects such as
        # {"L":0,"R":1}. They have no 't'; raising here dropped the whole frame, good messages
        # included (11.09: 36 'missing discriminator' drops). A fragment is skipped, not fatal.
        if isinstance(obj, dict) and "t" not in obj:
            continue
        out.append(_validate(obj))
    return out


def encode(msg: dict[str, Any]) -> str:
    return json.dumps(_validate(msg), separators=(",", ":"))
