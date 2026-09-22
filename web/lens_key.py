"""Put the project's anon key into the lens config, or take it out again before a commit.

    python3 web/lens_key.py            # paste the `anon` of the last web/site/config.js into FlyConfig.ts
    python3 web/lens_key.py --clear    # blank both key fields again (FlyConfig.ts must never be committed with a key)
    python3 web/lens_key.py --key <anon> [--cfg <FlyConfig.ts>]   # paste a key you have (e.g. the public page's, from its config.js)
    python3 web/lens_key.py --cfg Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts   # the 5.15 project (the default is Spectacles-5.23)

The key is public by design (it ships in the page and the lens), but the rule in FlyConfig.ts is that it
does not live in the repository: paste before a device build, clear before `git commit`. Build the site first
(`web/release.sh`), because that is where the key comes from -- this script never talks to Supabase itself.
"""
from __future__ import annotations

import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
CFG = HERE.parent / "Spectacles-5.23" / "Assets" / "Scripts" / "Fly" / "FlyConfig.ts"
SITE = HERE / "site" / "config.js"
FIELDS = ("WEB_RELAY_KEY", "MEMORY_BACKEND_KEY")


def set_key(src: str, field: str, value: str) -> tuple[str, bool]:
    pat = re.compile(r'(\b' + field + r':\s*)"[^"]*"')
    if not pat.search(src):
        return src, False
    return pat.sub(lambda m: m.group(1) + '"' + value + '"', src, count=1), True


def main() -> int:
    global CFG
    clear = "--clear" in sys.argv[1:]
    given = sys.argv[sys.argv.index("--key") + 1] if "--key" in sys.argv[1:] else ""  # an anon key given on the command line (public page users)
    if "--cfg" in sys.argv[1:]:  # the 5.15 project has its own FlyConfig.ts
        CFG = pathlib.Path(sys.argv[sys.argv.index("--cfg") + 1]).resolve()
    if clear:
        key = ""
    elif given:
        key = given
    else:
        if not SITE.exists():
            print(f"no {SITE.relative_to(HERE.parent)}: build the site first (web/release.sh)")
            return 2
        m = re.search(r'anon:\s*"([^"]*)"', SITE.read_text())
        key = m.group(1) if m else ""
        if not key:
            print("the built site has no anon key: rebuild with web/release.sh (or --key <anon>)")
            return 2
        if "service_role" in key or key.startswith("sb_secret"):
            print("refusing: that is a secret key, not the anon key")
            return 2
    src = CFG.read_text()
    done = []
    for f in FIELDS:
        src, ok = set_key(src, f, key)
        if ok:
            done.append(f)
    CFG.write_text(src)
    print(("cleared " if clear else "pasted ") + ", ".join(done) + " in " + str(CFG)
          + ("" if clear else "  (run with --clear before a commit)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
