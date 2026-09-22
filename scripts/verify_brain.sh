#!/usr/bin/env bash
# CyberFly: end-to-end check of the brain side, no glasses needed.
# Starts a one-fly brain server, drives it with brain_server/fake_lens.py, checks the fly reacts the
# way the connectome should, stops the server. Exit 0 = PASS.
#
#   scripts/verify_brain.sh            Metal kernel when available, CPU otherwise
#   METAL=0 scripts/verify_brain.sh    force the CPU kernel
#
# Needs scripts/setup_mac.sh to have run first. Refuses to run while another server holds port 8790.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CYBERFLY_RUNTIME="${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}"
FW="$CYBERFLY_RUNTIME/fly-wirehead"
[[ -d "$FW" ]] || { echo "FAIL: no runtime at $FW, run scripts/setup_mac.sh first" >&2; exit 1; }
if lsof -nP -iTCP:8790 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "FAIL: port 8790 is busy (a brain server is already running); stop it: pkill -f brain_server/server.py" >&2; exit 1
fi

OUT="$(mktemp -t cyberfly_verify)"
BG=1 "$REPO/scripts/run_server.sh" --flies 1 >"$OUT"
LOG="$(sed -n 's/^log: //p' "$OUT")"
# the port was free above, so any brain_server/server.py now is the one we started (paths may contain regex characters)
cleanup() { pkill -f "brain_server/server.py" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "waiting for the brain (first run compiles the kernels)..."
for _ in $(seq 1 120); do
  grep -q "ready baseline" "$LOG" 2>/dev/null && break
  if ! pgrep -f "brain_server/server.py" >/dev/null; then echo "FAIL: server exited, log: $LOG" >&2; tail -20 "$LOG" >&2; exit 1; fi
  sleep 2
done
grep -q "ready baseline" "$LOG" || { echo "FAIL: no 'ready baseline' after 240 s, log: $LOG" >&2; exit 1; }

TABLE="$(cd "$FW" && uv run --with websockets python "$REPO/brain_server/fake_lens.py" --fly 0 --secs 3)"
echo "$TABLE"

# columns: scenario turn orient escape_L escape_R stop back feed appetite forward wall_ms cloud%
check() { # name awk-condition description
  if echo "$TABLE" | awk -v s="$1" '$1==s {'"$2"' {ok=1}} END {exit ok?0:1}'; then echo "  ok    $3"
  else echo "  FAIL  $3" >&2; FAILED=1; fi
}
FAILED=0
check food_left  'if ($3 <= -0.5)' "food on the left orients the fly left"
check food_right 'if ($3 >=  0.5)' "food on the right orients the fly right"
check loom_left  'if ($4 >=  0.5)' "a looming threat on the left fires the left escape"
check loom_right 'if ($5 >=  0.5)' "a looming threat on the right fires the right escape"
check bitter     'if ($6 >=  0.5)' "bitter taste makes the fly stop"
step="$(echo "$TABLE" | awk '$1=="neutral" {print $11}')"
echo "  info  wall time per 50 ms brain step: ${step:-?} ms (log: $LOG)"

[[ "$FAILED" == 0 ]] && echo "PASS" || { echo "FAIL" >&2; exit 1; }
