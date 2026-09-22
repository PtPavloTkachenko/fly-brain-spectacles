#!/usr/bin/env python3
"""Differential perf sweep in the Lens Studio 5.23 editor (CLAD specs-lens-perf-attribution method,
PERF_ROW instrument: the editor preview trace writes 0 bytes on 5.23.2, see RUNBOOK).

    LS_MCP_TOKEN=<bearer> [LS_MCP_URL=http://localhost:50040/mcp] [LS_LOG=<LensStudioLog path>] \
        python3 perf/sweep.py [stage ...]

Every stage = FlyConfig.ts switches applied to a PRISTINE copy (flags never accumulate) -> recompile
through the MCP -> wait for the page brain to re-join (WEB_BRAIN_ON) -> LEAF start_to_board -> settle
-> a PERF_ROW window -> perf_rows.py summary. FlyConfig.ts is restored from the backup at the end,
whatever happens (it carries the pasted relay key: never commit it from here).
"""
import json, os, re, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, "Spectacles-5.23/Assets/Scripts/Fly/FlyConfig.ts")  # the sweep drives LS 5.23 over MCP
OUT = os.path.join(ROOT, "perf/sweep_2026-09-21")
URL = os.environ.get("LS_MCP_URL", "http://localhost:50040/mcp")
TOK = os.environ["LS_MCP_TOKEN"]
LOG = os.environ.get("LS_LOG") or max((os.path.join(os.path.expanduser("~/Library/Preferences/Snap/Lens Studio/logs"), f)
                                        for f in os.listdir(os.path.expanduser("~/Library/Preferences/Snap/Lens Studio/logs")) if f.startswith("LensStudioLog-")), key=os.path.getmtime)
SETTLE_S, WINDOW_S, BRAIN_WAIT_S = 25, 45, 150

STAGES = [
    ("01_full", {}),
    ("02_no_scan", {"SCAN_ENABLED": "false"}),
    ("03_no_vision", {"VISION_ENABLED": "false", "MOTION_ENABLED": "false"}),
    ("04_eyes_slow", {"EYE_HZ": "1", "RETINA_HZ": "1", "EYE_PANEL_HZ": "2"}),
    ("05_no_sound", {"SOUND_ENABLED": "false"}),
    ("06_no_gemini_weather", {"NARRATE_ENABLED": "false", "WEATHER_ENABLED": "false"}),
    ("07_board_slow", {"BOARD_DATA_HZ": "5", "MINI_MIRROR_HZ": "15"}),
    ("08_webscene_slow", {"WEB_SCENE_HZ": "1", "WEB_SCENE_EYE_HZ": "1"}),
]


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def rpc(method, params=None, id_=1, timeout=900):
    body = json.dumps({"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}).encode()
    h = {"Authorization": "Bearer " + TOK, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    r = urllib.request.urlopen(urllib.request.Request(URL, data=body, headers=h, method="POST"), timeout=timeout)
    raw = r.read().decode()
    if "data:" in raw[:80]:
        raw = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")][-1]
    return json.loads(raw)


def mcp(name, args=None, timeout=900):
    rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "sweep", "version": "0"}}, 1, 60)
    res = rpc("tools/call", {"name": name, "arguments": args or {}}, 3, timeout)
    out = res.get("result", res)
    return "\n".join(c.get("text", "") for c in out.get("content", []) if isinstance(c, dict)) if isinstance(out, dict) else str(out)


def log_size():
    return os.path.getsize(LOG)


def log_since(off):
    with open(LOG, "rb") as f:
        f.seek(off)
        return f.read().decode("utf-8", "replace")


def wait_for(pattern, off, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = re.search(pattern, log_since(off))
        if m:
            return m.group(0)
        time.sleep(2)
    return None


def set_flags(src, flags):
    for k, v in flags.items():
        pat = re.compile(r"^(  %s: )[^,\n]+(,)" % re.escape(k), re.M)
        src, n = pat.subn(lambda m: m.group(1) + v + m.group(2), src, count=1)
        assert n == 1, "flag not found: " + k
    return src


def main():
    os.makedirs(OUT, exist_ok=True)
    wanted = sys.argv[1:]
    stages = [s for s in STAGES if not wanted or s[0] in wanted]
    backup = open(CFG, encoding="utf-8").read()
    open(os.path.join(OUT, "FlyConfig.backup.ts"), "w", encoding="utf-8").write(backup)
    results = []
    say("log:", os.path.basename(LOG), "stages:", [s[0] for s in stages])
    try:
        for name, flags in stages:
            say("==", name, flags)
            # a stage stamp at the end of the file: a stage with no flag change (01_full) must still
            # DIFFER from what LS has, or nothing recompiles and the stage gets no window (21.09, stage 01 lost)
            open(CFG, "w", encoding="utf-8").write(set_flags(backup, flags) + "// perf sweep stage " + name + "\n")
            off = log_size()
            try:
                mcp("RecompileTypeScriptTool", {}, 120)
            except Exception as e:
                say("recompile call:", str(e)[:100])
            # wait for THIS stage's compile: first its "Starting" (a compile from an earlier write can still be
            # finishing), then the verdict after that point
            st = wait_for(r"Starting TypeScript compilation", off, 40)
            if st:
                off = log_size() - 4096
            comp = wait_for(r"TypeScript compilation succeeded|error TS\d+", off, 120)
            say("compile:", comp, "(own start seen)" if st else "(no own start seen)")
            if not comp or comp.startswith("error"):
                results.append({"label": name, "n": 0, "error": "compile " + str(comp)}); continue
            # ORDER (21.09, measured): the lens opens its relay room only after the start choice, so the
            # page brain can join only once LEAF has pressed SOLO. LEAF first, then the brain, then the fly.
            # LEAF's executeTrigger hangs now and then (ProbeKeyScenario.ts): one retry after a preview
            # refresh, or the stage measures the intro instead of the board (21.09: stages 07/08 did)
            v = None
            for attempt in (1, 2):
                off2 = log_size()
                try:
                    r = mcp("run_leaf_scenario", {"scenarioId": "start_to_board", "onDevice": False}, 300)
                    say("leaf call:", r[:80].replace("\n", " "))
                except Exception as e:
                    say("leaf call:", str(e)[:100])
                # the scenario itself takes ~75 s (cards + boot card + settle): the verdict wait must outlast it,
                # or the retry's refresh kills a run that was about to pass (21.09, stage 03 on the relaunch)
                v = wait_for(r"PASSED: start_to_board|FAILED: start_to_board", off2, 150)
                say("leaf:", v, "(attempt %d)" % attempt)
                if v and v.startswith("PASSED"):
                    break
                try:
                    mcp("PreviewPanelTool", {"action": "refresh"}, 60)
                except Exception as e:
                    say("refresh:", str(e)[:80])
                time.sleep(8)
            brain = wait_for(r"WEB_BRAIN_ON", off2, BRAIN_WAIT_S)
            say("brain:", brain)
            shown = wait_for(r"FLY_SHOWN", off2, 45)
            say("fly:", shown)
            time.sleep(SETTLE_S)
            since = time.strftime("%H:%M:%S")
            time.sleep(WINDOW_S)
            js = os.path.join(OUT, name + ".json")
            p = subprocess.run([sys.executable, os.path.join(ROOT, "perf/perf_rows.py"), "--log", LOG, "--since", since, "--label", name, "--json", js],
                               capture_output=True, text=True)
            say(p.stdout.strip() or p.stderr.strip())
            s = json.load(open(js)) if os.path.exists(js) else {"label": name, "n": 0}
            s["flags"] = flags; s["leaf"] = v; s["brain"] = brain
            results.append(s)
    finally:
        open(CFG, "w", encoding="utf-8").write(backup)
        say("FlyConfig.ts restored")
        try:
            mcp("RecompileTypeScriptTool", {}, 120)
        except Exception as e:
            say("final recompile:", str(e)[:100])
    base = next((r for r in results if r.get("label") == "01_full" and r.get("n")), None)
    lines = ["# Perf sweep (editor, LS 5.23.2, page brain) — " + time.strftime("%Y-%m-%d %H:%M"), "",
             "Instrument: `PERF_ROW` (script ms/frame per subsystem: mean over the window, worst frame) + preview fps. "
             "Deltas are stage minus `01_full`; a NEGATIVE frame-ms delta is what the switched-off system cost. Editor numbers: the Mac preview, not the glasses.", "",
             "| stage | flags | rows | fps | frame ms | Δ frame ms | worst med / max ms | scripts ms | Δ scripts | top subsystems (mean ms) |", "|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        if not r.get("n"):
            lines.append(f"| {r['label']} | {r.get('flags','')} | 0 | — | — | — | — | — | — | {r.get('error','no rows')} |"); continue
        top = ", ".join(f"{k} {v['mean_ms']:.2f}" for k, v in list(r["per"].items())[:4])
        df = f"{r['frame_ms_mean'] - base['frame_ms_mean']:+.1f}" if base else "—"
        ds = f"{r['script_mean_ms'] - base['script_mean_ms']:+.2f}" if base else "—"
        lines.append(f"| {r['label']} | {r['flags']} | {r['n']} | {r['fps_mean']} | {r['frame_ms_mean']} | {df} | {r['worst_median_ms']} / {r['worst_max_ms']} | {r['script_mean_ms']} | {ds} | {top} |")
    open(os.path.join(OUT, "SWEEP_RESULTS.md"), "w").write("\n".join(lines) + "\n")
    json.dump(results, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    say("done ->", os.path.join(OUT, "SWEEP_RESULTS.md"))


if __name__ == "__main__":
    main()
