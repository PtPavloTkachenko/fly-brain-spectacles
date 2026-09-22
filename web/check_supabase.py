"""Does this Supabase project actually carry the fly? One command, PASS/FAIL lines, no guessing.

    uv run --with websockets python web/check_supabase.py <project-ref> <anon-key>          # snapcloud.dev
    uv run --with websockets python web/check_supabase.py <ref> <anon> --host supabase.co     # a supabase.com project
    uv run --with websockets python web/check_supabase.py --create        # print the SQL, run nothing

What it proves, in the order the deployment needs it:

  1. REST answers with this anon key at all.
  2. REALTIME: two independent sockets join `realtime:fly-<pin>` and one hears the other's
     broadcast. This is the room behind the PIN; nothing else about the page matters if it fails.
  3. The two tables exist: `fly_memory` (the fly's memory, DEPLOY.md 1b) and `fly_brain_versions`
     (its saved selves, 1c). Missing ones print their CREATE statement.
  4. RLS, tested by doing it: insert a throwaway row, read it back, update it, and delete it -- and
     then ask the one question the policies are FOR: with a second row under a different owner, can
     a plain listing with no filter see somebody else's row?

Everything it writes is a row whose id starts with `zzcheck-`, and it deletes both rows at the end
(`--keep` leaves them). It never asks for the service-role key and refuses one that looks like it.

Exit code 0 only if every check passed.
"""
from __future__ import annotations

import argparse
import json
import random
import string
import sys
import time
import urllib.error
import urllib.request

# ------------------------------------------------------------------------------- the SQL, verbatim
# Kept identical to DEPLOY.md 1b/1c on purpose: one schema, written down once, printed from here so
# the person deploying never has to retype it out of a document.
SQL_MEMORY = """
-- the fly's memory: one row per user (DEPLOY.md 1b)
create table if not exists public.fly_memory (
  fly_id     text primary key,          -- the Connected-Lens user id (or a per-device uuid)
  blob       text not null,             -- the memory, base64 (FMEM/FMEZ)
  identity   jsonb,                     -- {nameIx, colorIx, born, sessions, trained{}}
  saved_at   double precision,          -- Date.now() on the glasses at the save
  updated_at timestamptz not null default now()
);
alter table public.fly_memory enable row level security;

create policy "own row: read"   on public.fly_memory for select
  to anon using (fly_id = coalesce(current_setting('request.headers', true)::json->>'x-fly-id', fly_id));
create policy "own row: insert" on public.fly_memory for insert to anon with check (length(blob) < 400000);
create policy "own row: update" on public.fly_memory for update to anon using (true) with check (length(blob) < 400000);
create policy "own row: delete" on public.fly_memory for delete to anon using (true);

create index if not exists fly_memory_updated on public.fly_memory (updated_at);
"""

SQL_VERSIONS = """
-- the fly's saved selves: many rows per user (DEPLOY.md 1c)
-- user_id / version_id are ADR 68's names; the four numeric columns are what the page's list shows.
create table if not exists public.fly_brain_versions (
  user_id        text        not null,             -- the same id as fly_memory.fly_id (mem.key)
  version_id     uuid        not null default gen_random_uuid(),
  name           text        not null,             -- what the person called it: "knows the mug"
  created_at     timestamptz not null default now(),
  blob           text        not null,             -- base64 of the core's memory blob, < 400 KB
  bytes          integer,                          -- the four below are the page's own columns:
  changed        integer,                          --   synapses that had moved
  mean_efficacy  double precision,                 --   the brain's own readout at the save
  sessions       integer,                          --   how many sessions this brain has lived through
  identity       jsonb,                            -- FlyIdentity: name, colour, born, sessions, trained
  summary        jsonb,                            -- the last session's evidence pack + the verdict
  primary key (user_id, version_id)
);
alter table public.fly_brain_versions enable row level security;

create policy "own rows: read"   on public.fly_brain_versions for select
  to anon using (user_id is not null and length(user_id) >= 8);
create policy "own rows: insert" on public.fly_brain_versions for insert
  to anon with check (length(blob) < 400000 and length(name) < 80 and length(user_id) >= 8);
create policy "own rows: update" on public.fly_brain_versions for update
  to anon using (true) with check (length(blob) < 400000);
create policy "own rows: delete" on public.fly_brain_versions for delete to anon using (true);

create index if not exists fly_versions_user on public.fly_brain_versions (user_id, created_at desc);
"""

SQL_STRICT_NOTE = """
-- ---------------------------------------------------------------------------------------------
-- STRICTER, IF YOU WANT IT (and what it costs)
--
-- With only the anon key the database cannot prove who is asking, so the policies above make the
-- ROW ID the secret: they stop a blob bigger than 400 KB, but a listing with no filter can still
-- enumerate rows. check_supabase.py measures exactly that and says so.
--
-- To close it properly, every reader must NAME the row in a header, and the policy compares it:
--
--   drop policy "own row: read" on public.fly_memory;
--   create policy "own row: read" on public.fly_memory for select to anon
--     using (fly_id = current_setting('request.headers', true)::json->>'x-fly-id');
--
-- A request without that header then matches nothing at all -- including the LENS, which today
-- sends only `?fly_id=eq.<id>` as a filter. Do not paste this until the lens sends the header too.
--
-- The complete fix is Supabase Auth with anonymous sign-in: `to authenticated` and
-- `fly_id = auth.uid()::text`. That is a real account per device, and both clients must sign in.
-- ---------------------------------------------------------------------------------------------
"""

OK, BAD, INFO = "PASS", "FAIL", "    "
_results: list[tuple[str, str]] = []


def say(kind: str, what: str, why: str = "") -> None:
    _results.append((kind, what))
    line = f"{kind}  {what}"
    if why:
        line += f"\n      {why}"
    print(line, flush=True)


def rnd(n: int = 10) -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(n))


# ------------------------------------------------------------------------------- REST
class Rest:
    def __init__(self, ref: str, anon: str, host: str = "snapcloud.dev"):
        self.base = f"https://{ref}.{host}/rest/v1"
        self.anon = anon

    def call(self, method: str, path: str, body=None, prefer: str = "", timeout: float = 15.0):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        # Snap Cloud sits behind Cloudflare, which answers Python's default User-Agent with 403 (error 1010)
        req.add_header("User-Agent", "Mozilla/5.0 (compatible; cyberfly-check/1)")
        req.add_header("apikey", self.anon)
        req.add_header("Authorization", "Bearer " + self.anon)
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode() or ""
                return r.status, (json.loads(raw) if raw.strip().startswith(("[", "{")) else raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode() or ""
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, raw
        except Exception as e:  # DNS, TLS, timeout
            return 0, str(e)


def err_text(payload) -> str:
    if isinstance(payload, dict):
        return " / ".join(str(payload.get(k)) for k in ("message", "hint", "details", "code") if payload.get(k))
    return str(payload)[:200]


# ------------------------------------------------------------------------------- Realtime
async def realtime(ref: str, anon: str, pin: str, host: str = "snapcloud.dev") -> tuple[bool, str]:
    """Two sockets, one room: A joins, B joins, A broadcasts, B must hear it. That is the PIN."""
    import websockets

    url = f"wss://{ref}.{host}/realtime/v1/websocket?apikey={anon}&vsn=1.0.0"
    topic = f"realtime:fly-{pin}"

    def frame(event, payload, ref_id):
        return json.dumps({"topic": topic, "event": event, "payload": payload, "ref": str(ref_id)})

    join = {"config": {"broadcast": {"self": False, "ack": False}}, "access_token": anon}
    try:
        async with websockets.connect(url, max_size=4 * 1024 * 1024, open_timeout=15) as a, \
                   websockets.connect(url, max_size=4 * 1024 * 1024, open_timeout=15) as b:
            for sock, n in ((a, 1), (b, 2)):
                await sock.send(frame("phx_join", join, n))
                deadline = time.time() + 10
                while time.time() < deadline:
                    m = json.loads(await sock.recv())
                    if m.get("event") == "phx_reply" and m.get("topic") == topic:
                        st = (m.get("payload") or {}).get("status")
                        if st != "ok":
                            return False, f"join refused: {err_text((m.get('payload') or {}).get('response'))}"
                        break
                else:
                    return False, "no phx_reply within 10 s"
            token = rnd(8)
            t0 = time.time()
            await a.send(frame("broadcast", {"type": "broadcast", "event": "lens", "payload": {"t": "check", "k": token}}, 9))
            deadline = time.time() + 10
            while time.time() < deadline:
                m = json.loads(await b.recv())
                p = m.get("payload") or {}
                if m.get("event") == "broadcast" and (p.get("payload") or {}).get("k") == token:
                    return True, f"echo in {1000 * (time.time() - t0):.0f} ms"
            return False, "the other socket never heard the broadcast (private channels enabled?)"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


# ------------------------------------------------------------------------------- the table checks
def check_table(rest: Rest, table: str, cols: str, sql: str) -> bool:
    code, body = rest.call("GET", f"/{table}?select={cols}&limit=1")
    if code == 200:
        say(OK, f"table {table} exists and the anon key may read it")
        return True
    if code in (404, 400) and "does not exist" in err_text(body).lower() or code == 404:
        say(BAD, f"table {table} is missing", "paste the SQL below into the Supabase SQL editor")
        print(sql)
        return False
    if code in (401, 403):
        say(BAD, f"table {table}: the anon key is refused ({code})", err_text(body))
        return False
    say(BAD, f"table {table}: HTTP {code}", err_text(body))
    return False


def lifecycle(rest: Rest, table: str, key_col: str, mine: dict, theirs: dict, keep: bool) -> None:
    """insert -> select own -> update -> (foreign row not listable) -> delete, each its own line"""
    mine_id, theirs_id = mine[key_col], theirs[key_col]

    code, body = rest.call("POST", f"/{table}", [mine], prefer="return=representation")
    if code not in (200, 201):
        say(BAD, f"{table}: insert a row of my own", f"HTTP {code} {err_text(body)}")
        return
    say(OK, f"{table}: insert a row of my own")

    code, body = rest.call("GET", f"/{table}?select={key_col}&{key_col}=eq.{mine_id}")
    got = isinstance(body, list) and any(r.get(key_col) == mine_id for r in body)
    say(OK if got else BAD, f"{table}: read my own row back",
        "" if got else f"HTTP {code} {err_text(body)} -- the read policy does not let the owner in")

    code, body = rest.call("PATCH", f"/{table}?{key_col}=eq.{mine_id}", {"name": "renamed by the check"} if table.endswith("versions") else {"saved_at": 1.0}, prefer="return=minimal")
    say(OK if code in (200, 204) else BAD, f"{table}: update my own row",
        "" if code in (200, 204) else f"HTTP {code} {err_text(body)}")

    # the question the policies exist for: a second owner's row, and a listing with NO filter
    code, _ = rest.call("POST", f"/{table}", [theirs], prefer="return=minimal")
    if code in (200, 201, 204):
        code, body = rest.call("GET", f"/{table}?select={key_col}&limit=200")
        leaked = isinstance(body, list) and any(r.get(key_col) == theirs_id for r in body)
        if leaked:
            say(BAD, f"{table}: somebody else's row IS listable with the anon key",
                "a plain GET with no filter returned it. The row id is the only secret: keep ids long and\n"
                "      random, or take the STRICTER policy in --create (it needs every client to send x-fly-id).")
        else:
            say(OK, f"{table}: somebody else's row is not listable")
        if not keep:
            rest.call("DELETE", f"/{table}?{key_col}=eq.{theirs_id}", prefer="return=minimal")
    else:
        say(INFO, f"{table}: could not insert a second owner's row to test listing (HTTP {code})")

    if keep:
        say(INFO, f"{table}: --keep, so {mine_id} is still there")
        return
    code, body = rest.call("DELETE", f"/{table}?{key_col}=eq.{mine_id}", prefer="return=minimal")
    say(OK if code in (200, 204) else BAD, f"{table}: delete my own row",
        "" if code in (200, 204) else f"HTTP {code} {err_text(body)} -- a throwaway row is left behind")


# ------------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="check a Supabase project against what CyberFly needs")
    ap.add_argument("ref", nargs="?", default="", help="the project ref of https://<ref>.<host>")
    ap.add_argument("--host", default="snapcloud.dev", help="the project's domain: snapcloud.dev (Snap Cloud, default) or supabase.co")
    ap.add_argument("anon", nargs="?", default="", help="the anon public key")
    ap.add_argument("--pin", default="", help="the room to test with (default: a random one)")
    ap.add_argument("--create", action="store_true", help="print the SQL for both tables and exit")
    ap.add_argument("--keep", action="store_true", help="leave the throwaway rows behind")
    a = ap.parse_args()

    if a.create or not (a.ref and a.anon):
        if not a.create:
            print(__doc__)
            print("Nothing to check without <ref> and <anon>. The SQL, for the Supabase SQL editor:\n")
        print(SQL_MEMORY)
        print(SQL_VERSIONS)
        print(SQL_STRICT_NOTE)
        return 0 if a.create else 2

    if "service_role" in a.anon or len(a.anon) > 800:
        print("FAIL  that looks like a service-role key. Use the ANON key -- it is the public one.")
        return 2

    pin = a.pin or f"{random.randrange(10000):04d}"
    print(f"project {a.ref}.{a.host}   room fly-{pin}   {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    rest = Rest(a.ref, a.anon, a.host)
    # not the root: newer PostgREST (Snap Cloud) serves the OpenAPI doc to the service_role key only.
    # A table read answers 200 (rows, maybe none) or 404 PGRST205 (no such table yet) -- both reachable.
    code, body = rest.call("GET", "/fly_memory?select=fly_id&limit=0")
    if code in (200, 404):
        say(OK, "REST answers with this anon key")
    else:
        say(BAD, f"REST does not answer (HTTP {code})", err_text(body))
        print("\nNothing else can be tested until that works: check the ref and the anon key.")
        return 1

    import asyncio
    good, why = asyncio.run(realtime(a.ref, a.anon, pin, a.host))
    say(OK if good else BAD, "REALTIME: two sockets in fly-" + pin + ", one hears the other", why)

    have_mem = check_table(rest, "fly_memory", "fly_id", SQL_MEMORY)
    have_ver = check_table(rest, "fly_brain_versions", "user_id", SQL_VERSIONS)

    if have_mem:
        me, them = "zzcheck-" + rnd(16), "zzcheck-" + rnd(16)
        lifecycle(rest, "fly_memory", "fly_id",
                  {"fly_id": me, "blob": "Y2hlY2s=", "identity": {"nameIx": 0}, "saved_at": time.time() * 1000},
                  {"fly_id": them, "blob": "Y2hlY2s=", "saved_at": time.time() * 1000}, a.keep)
    if have_ver:
        me, them = "zzcheck-" + rnd(16), "zzcheck-" + rnd(16)
        lifecycle(rest, "fly_brain_versions", "user_id",
                  {"user_id": me, "name": "check", "blob": "Y2hlY2s=", "bytes": 5},
                  {"user_id": them, "name": "check", "blob": "Y2hlY2s=", "bytes": 5}, a.keep)

    bad = [w for k, w in _results if k == BAD]
    print("\n" + ("-" * 78))
    print(f"{len(_results) - len(bad)} passed, {len(bad)} failed")
    for w in bad:
        print("  FAIL " + w)
    if not bad:
        print("\nThis project is ready. Put the ref and the anon key in:")
        print("  - web/config.js       (built by web/release.sh: ref + host pinned there, or --sb <ref> --host <host> --key <anon>)")
        print(f"  - FlyConfig.ts        WEB_RELAY_URL = wss://{a.ref}.{a.host}/realtime/v1/websocket")
        print("                        WEB_RELAY_KEY = <anon>")
        print(f"                        MEMORY_BACKEND_URL = https://{a.ref}.{a.host}, MEMORY_BACKEND_KEY = <anon>")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
