#!/usr/bin/env bash
# CyberFly: one-time, idempotent setup of the brain runtime on a Mac.
#
#   scripts/setup_mac.sh             check prerequisites, clone fly-wirehead (pinned) into $CYBERFLY_RUNTIME,
#                                    uv sync, download + verify the MaleCNS data (~1.1 GB, SHA-256 checked)
#   DRY_RUN=1 scripts/setup_mac.sh   checks only; print the commands it would run
#
# Env: CYBERFLY_RUNTIME  runtime folder (default ~/cyberfly_runtime; keep it out of Dropbox/iCloud)
#      FLYWIREHEAD_REF    fly-wirehead commit or branch (default: the commit brain_server/engine is tested on)
# Re-running is safe: a clone at the right commit, a synced venv and prepared data are kept
# (`flywirehead prepare` then only verifies the data).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}"
FW="$RUNTIME/fly-wirehead"
FLYWIREHEAD_URL="https://github.com/mattyhempstead/fly-wirehead"
# brain_server/engine clones VisualMemoryBrain's fields and matches the package kernel bit for bit:
# bump deliberately, then run engine/test_equality.py and engine/metal/test_metal.py (ADR 25).
FLYWIREHEAD_REF="${FLYWIREHEAD_REF:-fcefe9441f80e25aab713411ebced53f5e5ea172}"
DRY="${DRY_RUN:-0}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*" >&2; }
die()  { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
run()  { if [[ "$DRY" == 1 ]]; then printf '  [dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi; }

say "== Prerequisites"
[[ "$(uname -s)" == Darwin ]] || die "macOS only (Metal GPU kernel, Apple clang builds)"
METAL_OK=1
if [[ "$(uname -m)" == arm64 ]]; then ok "Apple Silicon"; else warn "not Apple Silicon: no GPU kernel, start the server with METAL=0"; METAL_OK=0; fi
MACOS="$(sw_vers -productVersion)"
if (( ${MACOS%%.*} >= 15 )); then ok "macOS $MACOS"; else warn "macOS $MACOS: the GPU kernel needs macOS 15+, start the server with METAL=0"; METAL_OK=0; fi
if xcode-select -p >/dev/null 2>&1 && command -v c++ >/dev/null 2>&1; then ok "Xcode command line tools"
else die "Xcode command line tools missing (native brain kernels compile on first run): xcode-select --install"; fi
command -v git >/dev/null 2>&1 || die "git missing (comes with the Xcode command line tools)"
if command -v uv >/dev/null 2>&1; then ok "uv $(uv --version | awk '{print $2}')"; else die "uv missing: brew install uv"; fi

LS_FOUND=""
for app in /Applications/*.app; do
  case "$app" in *"Lens Studio"*|*/LS\ *) ;; *) continue ;; esac
  v="$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
  [[ -n "$v" ]] && LS_FOUND+="$v "
done
if [[ " $LS_FOUND" == *" 5.15.4"* ]]; then ok "Lens Studio 5.15.4"
else warn "Lens Studio 5.15.4 not found in /Applications (found: ${LS_FOUND:-none}). The lens project needs exactly 5.15.4"; fi

d="$RUNTIME"; while [[ ! -d "$d" ]]; do d="$(dirname "$d")"; done
free_gb="$(df -g "$d" | awk 'NR==2 {print $4}')"
if [[ ! -f "$FW/data/graph.npz" ]] && (( free_gb < 5 )); then warn "only ${free_gb} GB free on $d: the runtime needs ~2 GB (+1.1 GB download)"; fi

say "== fly-wirehead -> $FW (ref ${FLYWIREHEAD_REF:0:12})"
run mkdir -p "$RUNTIME/logs"
if [[ ! -d "$FW/.git" ]]; then
  run git clone --quiet --filter=blob:none "$FLYWIREHEAD_URL" "$FW"
  run git -C "$FW" checkout --quiet --detach "$FLYWIREHEAD_REF"
else
  head="$(git -C "$FW" rev-parse HEAD)"
  if [[ "$head" == "$FLYWIREHEAD_REF" ]]; then
    ok "clone exists, at the pinned commit ${head:0:7}"
  elif [[ -n "$(git -C "$FW" status --porcelain --untracked-files=no)" ]]; then
    warn "local changes in $FW: staying at ${head:0:7}, not switching to ${FLYWIREHEAD_REF:0:12}"
  else
    run git -C "$FW" fetch --quiet --depth 1 origin "$FLYWIREHEAD_REF"
    run git -C "$FW" checkout --quiet --detach FETCH_HEAD
  fi
fi

say "== Python env + MaleCNS data"
if [[ -f "$FW/data/graph.npz" ]]; then ok "MaleCNS graph present: prepare will only verify it"; fi
if [[ "$DRY" == 1 ]]; then
  say "  [dry-run] (cd $(printf '%q' "$FW") && uv sync && uv run flywirehead prepare)"
else
  (cd "$FW" && uv sync && uv run flywirehead prepare)
fi

say ""
say "== Next"
prefix=""; kernel=metal
if [[ "$METAL_OK" != 1 ]]; then prefix="METAL=0 "; kernel=fast; fi
if [[ "$RUNTIME" != "$HOME/cyberfly_runtime" ]]; then
  say "Add to your shell profile (server and tools read it):  export CYBERFLY_RUNTIME=$(printf '%q' "$RUNTIME")"
fi
say "Start the brain server:"
say "  ${prefix}scripts/run_server.sh"
say "  (= cd $(printf '%q' "$FW") && uv run --with websockets --with zeroconf python $(printf '%q' "$REPO/brain_server/server.py") --flies 2 --cloud 16000 --engine batch --kernel $kernel)"
say "Then open Spectacles/Spectacles.esproj in Lens Studio 5.15.4 (README.md, 'Quick start')."
