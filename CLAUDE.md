# CLAUDE.md

Read `AGENTS.md` first: it is the single source of agent instructions for this repo (deploy steps, what only a human can do, hard rules, gotchas, repo map).

Short version for Claude Code:

1. `scripts/setup_mac.sh`
2. `scripts/verify_brain.sh` must print `PASS`
3. `BG=1 scripts/run_server.sh`
4. Hand the human the Lens Studio steps from `AGENTS.md` (Lens Studio 5.15.4, their own Remote Service Gateway Google Token, Send to Spectacles).

Never commit a token: check `git diff Spectacles/Assets/Scene.scene` before every commit.
