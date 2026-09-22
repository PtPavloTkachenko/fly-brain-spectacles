"""Hold a page open as the lens's brain, joining whatever PIN the lens is currently offering.

    web/pagebrain.py <port> <seconds> [--train]      (web/serve.sh page  -> port 8796)

Dev harness (21.09): headless Chrome with WebGPU, the page served from web/, the relay taken from the
BUILT site's config (web/site/config.js: run web/release.sh once) and handed to the page as a full
?relay= url with the anon key inside (the ?sb= path assumes supabase.co; this project is on
snapcloud.dev). Needs `websockets` (uv run --with websockets python web/pagebrain.py ...).

It watches the Lens Studio log for the newest WEB_RELAY_OPEN pin, opens the page on that PIN with
its own WebGPU brain, and keeps it there. With --train it also presses the session's START once the
page is genuinely able to (the button is disabled until a lens is seen and the room is named), and
reports the gate's own words when it cannot.
"""
import asyncio, json, os, re, subprocess, sys, time, urllib.request
import websockets

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = sys.argv[1]
SECS = float(sys.argv[2])
TRAIN = "--train" in sys.argv
LOGDIR = os.path.expanduser("~/Library/Preferences/Snap/Lens Studio/logs")


def newest_pin():
    fs = [os.path.join(LOGDIR, f) for f in os.listdir(LOGDIR) if f.startswith("LensStudioLog-")]
    if not fs:
        return None
    log = max(fs, key=os.path.getmtime)
    # read the WHOLE log: the lens writes hundreds of KB of retina telemetry after it opens its
    # room, so a tail window silently loses the PIN
    with open(log, "rb") as f:
        txt = f.read().decode("utf-8", "replace")
    m = re.findall(r"WEB_RELAY_OPEN pin=(\d{4})", txt)
    return m[-1] if m else None


def tail_log(n=200000):
    """the last slice of the lens log, for the scenario's own markers"""
    fs = [os.path.join(LOGDIR, f) for f in os.listdir(LOGDIR) if f.startswith("LensStudioLog-")]
    if not fs:
        return ""
    log = max(fs, key=os.path.getmtime)
    with open(log, "rb") as f:
        try:
            f.seek(max(0, os.path.getsize(log) - n))
        except Exception:
            pass
        return f.read().decode("utf-8", "replace")


STATE = """(() => {
  // open TRAINING first: its gate line and its START button are only refreshed while that tab is
  // the visible one, so reading them from the closed tab reports the state the page had at load.
  const tabs = [...document.querySelectorAll('.tb')];
  const tr = tabs.find(b => /TRAINING/i.test(b.textContent));
  if (tr && !tr.classList.contains('on')) tr.click();
  const t = (id) => { const e = document.getElementById(id); return e ? (e.textContent||'').trim() : null; };
  return JSON.stringify({
    engine: t('chipEngine'), step: t('chipStep'), room: t('chipRoom'), lens: t('chipLens'),
    gate: t('designGate'), state: t('designState'),
    startDisabled: (document.getElementById('trStart')||{}).disabled,
    gateCls: (document.getElementById('gate')||{}).className, goDis: (document.getElementById('go')||{}).disabled, pinVal: (document.getElementById('pin')||{}).value,
    cs: (document.getElementById('csPlus')||{}).value,
  });
})()"""

PRESS = """(() => {
  const go = document.getElementById('trStart');
  if (!go) return 'no button';
  if (go.disabled) return 'DISABLED: ' + ((document.getElementById('designGate')||{}).textContent || '?');
  const tabs = [...document.querySelectorAll('.tb')];
  const tr = tabs.find(b => /TRAINING/i.test(b.textContent));
  if (tr) tr.click();
  const b = document.getElementById('bouts'); if (b) b.value = '6';
  // pick a real thing in the room, not a hand: the picker lists everything the lens advertises,
  // including the wearer's hands, and the trainer will not take a hand as a cue.
  const pick = (sel, skipIdx) => {
    if (!sel) return;
    const opts = [...sel.options].filter(o => o.value && !/hand|fly|you|— /i.test(o.value));
    if (opts.length) sel.value = opts[Math.min(skipIdx, opts.length - 1)].value;
  };
  pick(document.getElementById('csPlus'), 0);
  pick(document.getElementById('csMinus'), 1);
  go.click();
  return 'PRESSED cs=' + ((document.getElementById('csPlus')||{}).value || '?');
})()"""


async def evaluate(ws, expr, n):
    await ws.send(json.dumps({"id": n, "method": "Runtime.evaluate",
                              "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    t0 = time.time()
    while time.time() - t0 < 25:
        m = json.loads(await ws.recv())
        if m.get("id") == n:
            return m.get("result", {}).get("result", {}).get("value")
    return None


async def main():
    pin = None
    t0 = time.time()
    while pin is None and time.time() - t0 < 120:
        pin = newest_pin()
        if pin is None:
            await asyncio.sleep(3)
    if pin is None:
        print("NO PIN in the lens log"); return
    print(f"joining pin {pin}", flush=True)

    # 21.09: the dev server serves web/config.js (empty relay), so the page would fall back to the LAN
    # relay while the lens sits on Snap Cloud. Take the public anon ref/key from the BUILT site's config
    # (never printed) and hand them to the page the way DEPLOY.md documents (?sb=&sbkey=).
    sb = ""
    try:
        cfg = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "config.js"), encoding="utf-8").read()
        ref = re.search(r'ref:\s*"([^"]+)"', cfg); anon = re.search(r'anon:\s*"([^"]+)"', cfg)
        host = re.search(r'host:\s*"([^"]+)"', cfg)
        h = host.group(1) if host else "snapcloud.dev"  # the project is on Snap Cloud; the page's ?sb= default host is supabase.co
        # ?relay= is taken as the socket URL verbatim (no key appended -- it is meant for the LAN relay), so
        # the apikey rides INSIDE it, url-encoded; sbkey still feeds the channel join.
        from urllib.parse import quote
        if ref and anon:
            full = f"wss://{ref.group(1)}.{h}/realtime/v1/websocket?apikey={anon.group(1)}&vsn=1.0.0"
            sb = f"&relay={quote(full, safe='')}&sbkey={anon.group(1)}"; print(f"relay: wss://<ref>.{h} + apikey (from the built site config)", flush=True)
    except Exception as e:
        print("relay: no built site config ->", e, flush=True)
    url = f"http://localhost:{PORT}/app.html?pin={pin}&auto=1{sb}"
    proc = subprocess.Popen(
        [CHROME, "--headless=new", "--use-angle=metal", "--enable-unsafe-webgpu",
         "--window-size=1500,950", "--remote-debugging-port=9381",
         "--user-data-dir=/tmp/pagebrain_profile", "--no-first-run", "--disable-gpu-vsync", url],
        stdout=subprocess.DEVNULL, stderr=open("/tmp/pagebrain_chrome.log", "ab"))
    try:
        ws_url = None
        for _ in range(160):
            try:
                for t in json.load(urllib.request.urlopen("http://localhost:9381/json")):
                    if t.get("type") == "page" and t.get("url", "").startswith("http"):
                        ws_url = t["webSocketDebuggerUrl"]; break
                if ws_url: break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        if not ws_url:
            print("NO TAB"); return

        async with websockets.connect(ws_url, max_size=None) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
            n = 10
            pressed = False
            last_press = 0.0
            presses = 0
            last = ""
            last_go = ""
            end = time.time() + SECS
            while time.time() < end:
                n += 1
                raw = await evaluate(ws, STATE, n)
                st = json.loads(raw) if raw else {}
                line = f"engine={st.get('engine')} step={st.get('step')} lens={st.get('lens')} gate={st.get('gate')!r} gateCls={st.get('gateCls')!r} goDis={st.get('goDis')} pin={st.get('pinVal')!r}"
                if line != last:
                    print(f"[{time.time()-t0:6.0f}s] {line}", flush=True)
                    last = line
                # 21.09: the page no longer auto-joins from `auto=1` (the gate flow was rebuilt), so press
                # CONNECT ourselves whenever the gate is up and the PIN field is filled -- what a wearer does.
                n += 1
                pressed_go = await evaluate(ws, """(() => {
                  const g = document.getElementById('gate'); const go = document.getElementById('go');
                  const pin = document.getElementById('pin');
                  if (!g || g.classList.contains('gone') || !go || !pin || !pin.value) return 'no-gate';
                  if (go.disabled) return 'go-disabled';
                  go.click(); return 'GO pin=' + pin.value;
                })()""", n)
                if str(pressed_go) != last_go:
                    last_go = str(pressed_go)
                    print(f"[{time.time()-t0:6.0f}s] connect attempt: {pressed_go}", flush=True)
                # the lens takes a NEW PIN every time its scene restarts, and a page left on the old
                # one sits there with a healthy brain and no lens. Follow it, the way a wearer would
                # by reading the new PIN off the glasses.
                live = newest_pin()
                if live and live != pin:
                    print(f"[{time.time()-t0:6.0f}s] the lens moved to pin {live}; following", flush=True)
                    pin = live
                    n += 1
                    await evaluate(ws, f"location.href = 'http://localhost:{PORT}/app.html?pin={pin}&auto=1{sb}'; 'go'", n)
                    await asyncio.sleep(12)
                    continue
                # press whenever a session is POSSIBLE and none is running. Latching on the first
                # press meant an early attempt — before the lens had been driven past its cards —
                # used up the only try, and the scenario then waited for a TRAIN_START that nobody
                # was going to send.
                # do not gate on the page's own "RUNNING": an early press made the page believe a
                # session was live while the lens, still on its start card, had dropped the order.
                # The trainer treats a fresh `train` as replacing whatever was running, so repeating
                # is safe and is what a person jabbing START would do.
                # Press only while the LENS reports no live session. `trainPhase` comes from the
                # lens's own train packet, so it is the lens's opinion, not the page's. Pressing on
                # a timer alone restarted the session every 12 s and it never got past its first
                # probe -- 215 s of TRAIN_CS and zero trials.
                phase = (st.get("trainPhase") or "").strip().lower()
                live = phase not in ("", "-", "\u2014", "done", "menu", "off")
                ready = st.get("startDisabled") is False and not live
                # A HARD CAP. The page cannot tell whether a session is live — the lens's train
                # packet and the fields this page reads were never reconciled, so `trainPhase` stays
                # blank and every retry looked justified. Retrying then restarted the session over
                # and over and it never got past its first probe. Two presses, 25 s apart, is enough
                # to catch the lens once it is past its cards, and cannot trample a running session.
                # Press ON THE SCENARIO'S CUE, not on a timer. TrainFoodSessionScenario marks
                # `s4_web_on` when it has the page as the brain and is ready for the order; that is
                # the moment the runner it was written for would start page_sim with --cmd train.
                # Pressing earlier wastes the try on a lens still behind its cards, and pressing on
                # a repeat timer restarts the session forever.
                asked = TRAIN and "s4_web_on" in tail_log() and presses < 1
                if asked and ready and (time.time() - last_press) > 5:
                    last_press = time.time()
                    presses += 1
                    n += 1
                    r = await evaluate(ws, PRESS, n)
                    print(f"[{time.time()-t0:6.0f}s] {r}", flush=True)
                    if str(r).startswith("PRESSED"):
                        pressed = True
                await asyncio.sleep(3)
    finally:
        proc.terminate()

asyncio.run(main())
