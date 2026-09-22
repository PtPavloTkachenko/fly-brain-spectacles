# CLAUDE.md

Read `AGENTS.md` first: it is the single source of agent instructions for this repo (what the pieces are, what only a human can do, hard rules, gotchas, repo map).

Then the Knowledge OS, in this order, at the start of every session: `docs/knowledge/INDEX.md` → `DECISIONS.md` → `RUNBOOK.md` → `COMPONENTS.md`. Update them in place while working (a decision → an ADR; a gotcha → a RUNBOOK row; a contract → COMPONENTS); tighten, don't grow.

Short version:

1. The brain is a web page (`web/`), joined by a 4-digit PIN over a relay; the glasses are senses and body. `core/` is the C++ brain core the page (WASM + WebGPU) and the Mac server compile from.
2. Two Lens Studio projects with one feature state: `Spectacles-5.15/` (5.15.4, the build for Spectacles 2024) and `Spectacles-5.23/` (5.23, the LEAF tests). Never move packages or scenes between them.
3. Motion and learning come from the brain. Every engineered input or override is a disclosed `ADR NN` in `docs/knowledge/DECISIONS.md`. No brain, no fly.
4. Never commit a token or a key: `git diff Spectacles-5.15/Assets/Scene.scene Spectacles-5.23/Assets/Scene.scene` must show the three token fields empty; `python3 web/lens_key.py --clear` before a commit; `.mcp.json` is never committed.
5. Shaders: never name an input `color` (or a GLSL built-in, or with `Input` in it, or starting with `float`); ASCII only; grep the Lens Studio log for `CrossCompiler error` after every send. The display is additive: bright text on dim plates.
6. Logging through SIK `NativeLogger`, never `print()`. Perf by attribution (`LENS_PERF` / `PERF_ROW` rows), not guesses.
7. Keep every brain kernel bit-exact (`core/tools/compare.py`, `gpu_check`, `test_metal.py`), and re-export the brain file after a `channels.py` change.
