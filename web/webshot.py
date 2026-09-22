"""Drive headless Chrome over CDP: open a URL, wait, screenshot. Usage: webshot.py out.png url seconds [flags...]"""
# Headless capture of the page for agents and CI-style checks. Env: PORT (CDP port, one per
# concurrent capture), PROF (a Chrome profile dir of your own), WSIZE ("1600,1000": a COMMA, an "x"
# is silently ignored and Chrome opens a small default window). Flags after the seconds go to Chrome
# (--enable-unsafe-webgpu for WebGPU under headless). Chrome is ended by its own pid, never by name.
import asyncio, base64, json, subprocess, sys, time, urllib.request, os
import websockets
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
out, url, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
extra = sys.argv[4:]
port = int(os.environ.get("PORT", "9333"))
prof = os.environ.get("PROF", "/tmp/webshot_profile")
args = [CHROME, "--headless=new", "--use-angle=metal", "--hide-scrollbars", "--window-size=" + os.environ.get("WSIZE", "1600,1000"),
        f"--remote-debugging-port={port}", f"--user-data-dir={prof}", "--no-first-run", "--disable-gpu-vsync"] + extra + [url]
p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=open("/tmp/webshot_chrome.log", "ab"))
try:
    ws_url = None
    for _ in range(60):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://localhost:{port}/json"))
            for t in tabs:
                if t.get("type") == "page" and t.get("url", "").startswith("http"):
                    ws_url = t["webSocketDebuggerUrl"]; break
            if ws_url: break
        except Exception:
            pass
        time.sleep(0.5)
    if not ws_url:
        raise SystemExit("no page target")
    async def go():
        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            await ws.send(json.dumps({"id": 1, "method": "Runtime.enable"}))
            await asyncio.sleep(secs)
            await ws.send(json.dumps({"id": 2, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == 2:
                    open(out, "wb").write(base64.b64decode(m["result"]["data"])); break
            # the page's own status line, for the record
            await ws.send(json.dumps({"id": 3, "method": "Runtime.evaluate", "params": {"expression": "document.title + ' | ' + (document.querySelector('#status,.status,[data-status]')||{}).textContent", "returnByValue": True}}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("id") == 3:
                    print(m["result"].get("result", {}).get("value", "")[:200]); break
    asyncio.run(go())
    print("saved", out, os.path.getsize(out))
finally:
    p.terminate()
    try: p.wait(5)
    except Exception: p.kill()
