#!/usr/bin/env bash
# CyberFly: start the brain server (brain_server/server.py) from the fly-wirehead runtime.
#
#   scripts/run_server.sh              live config: --flies 3 --cloud 16000 --engine batch --kernel metal
#   scripts/run_server.sh --flies 1    extra flags pass through (the last value of a flag wins)
#   METAL=0 scripts/run_server.sh      CPU kernel (--kernel fast); automatic without Apple Silicon + macOS 15
#   NATIVE=1 scripts/run_server.sh     one fly on core/, the C++ core the web page runs (preview = page code)
#   BG=1 scripts/run_server.sh         run in the background, print PID and log path
#   DRY_RUN=1 scripts/run_server.sh    print the command, start nothing
#
# Log: $CYBERFLY_RUNTIME/logs/brain_server_<date>.log (CYBERFLY_RUNTIME default ~/cyberfly_runtime).
# Stop: pkill -f "brain_server/server.py"
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CYBERFLY_RUNTIME="${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}"
FW="$CYBERFLY_RUNTIME/fly-wirehead"
LOGS="$CYBERFLY_RUNTIME/logs"

kernel=metal
if [[ "${METAL:-1}" == 0 ]]; then
  kernel=fast
elif [[ "$(uname -m)" != arm64 ]] || (( $(sw_vers -productVersion | cut -d. -f1) < 15 )); then
  echo "note: the Metal kernel needs Apple Silicon + macOS 15; using --kernel fast" >&2
  kernel=fast
fi

port=8790
prev=""
for a in "$@"; do
  case "$prev" in --port) port="$a" ;; esac
  case "$a" in --port=*) port="${a#--port=}" ;; esac
  prev="$a"
done

if [[ "${NATIVE:-0}" == 1 ]]; then
  CMD=(uv run --with websockets --with zeroconf python "$REPO/brain_server/server.py"
       --flies 1 --cloud 16000 --engine native --flyb "$REPO/core/brain_export/out/brain_c0_od16.flyb.z" "$@")
else
  CMD=(uv run --with websockets --with zeroconf python "$REPO/brain_server/server.py"
       --flies 3 --cloud 16000 --engine batch --kernel "$kernel" "$@")
fi
LOG="$LOGS/brain_server_$(date +%Y%m%d_%H%M%S).log"
busy=0
if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then busy=1; fi

if [[ "${DRY_RUN:-0}" == 1 ]]; then
  printf 'cd %q &&' "$FW"; printf ' %q' "${CMD[@]}"; printf ' 2>&1 | tee %q\n' "$LOG"
  if [[ "$busy" == 1 ]]; then echo "note: port $port is in use right now (a brain server is running)" >&2; fi
  exit 0
fi

[[ -d "$FW" ]] || { echo "no fly-wirehead at $FW: run scripts/setup_mac.sh first" >&2; exit 1; }
command -v uv >/dev/null 2>&1 || { echo "uv missing: brew install uv" >&2; exit 1; }
if [[ "$busy" == 1 ]]; then
  echo "port $port is busy: a brain server is probably running already (a second one would also claim flybrain.local)." >&2
  echo "stop it first: pkill -f \"brain_server/server.py\"" >&2
  exit 1
fi
mkdir -p "$LOGS"
cd "$FW"
echo "log: $LOG"
if [[ "${BG:-0}" == 1 ]]; then
  nohup "${CMD[@]}" >"$LOG" 2>&1 &
  echo "brain server started in the background, pid $! (stop: pkill -f brain_server/server.py)"
else
  "${CMD[@]}" 2>&1 | tee "$LOG"
fi
