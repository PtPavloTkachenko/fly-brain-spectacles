#!/bin/bash
# Serve the web brain page (http://localhost:8796) and run the dev relay (:8795) next to it.
#   web/serve.sh          both
#   web/serve.sh page     the page only (the relay is elsewhere, e.g. Supabase)
# The page's data files (web/assets/*.bin: the 166,700 neurons, the shells, the eye lattice) are
# committed; edges.bin and skel_l0.bin (the big two, optional) are built with `python web/make_assets.py`
# (needs the fly-wirehead runtime). Rebuild the committed ones with the same script after FlyRetinaData.ts or the cloud
# sample changes (needs numpy + pyarrow, e.g. $CYBERFLY_RUNTIME/fly-wirehead/.venv/bin/python).
# No lens around? `uv run --with websockets python web/lens_sim.py --pin 7777` fakes one.
# WebGPU needs a secure context: localhost is one; for another machine put an https proxy in front.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNTIME="${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}"
if [ "${1:-both}" = "both" ]; then
  (cd "$RUNTIME/fly-wirehead" && uv run --with websockets python "$HERE/relay.py" --port 8795) &
fi
cd "$HERE"
echo "page: http://localhost:8796/"
python3 -m http.server 8796 --bind 0.0.0.0
