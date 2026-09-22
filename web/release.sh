#!/bin/bash
# Build web/site/ — exactly the files to upload to a static host, with this deployment's Supabase
# project baked in. No bundler, no build step at the other end: whatever lands in site/ IS the site.
#
#   web/release.sh                                             the pinned project (SB_REF_DEFAULT), anon key from the Supabase CLI
#   web/release.sh --sb <project-ref> --key <anon-key>          another project, or a machine without the CLI
#   web/release.sh --host supabase.co --profile ""              a supabase.com project instead of Snap Cloud
#   SB_REF=abcd SB_ANON=<anon> web/release.sh                   the same, from the environment
#   web/release.sh --relay ws://flybrain.local:8795             a LAN relay instead of Supabase
#   web/release.sh --brain                                     also copy the 75 MB brain file in
#
# What it does, and nothing else:
#   1. copies the page and its data into web/site/ (a clean directory every time),
#   2. writes site/config.js with the ref + anon key, so nobody has to type a URL parameter,
#   3. writes site/_headers   (Netlify / Cloudflare Pages) and site/.htaccess (Apache, i.e. a plain
#      FTP host): wasm MIME + cache rules,
#   4. writes site/README.txt (where the brain file goes, and how to check the upload worked).
#
# The anon key is public by design — it ships inside the lens too. The service-role key must never
# reach this directory; the script refuses one that looks like it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/site"
BUILD="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M)"   # stamps config.js; asset URLs carry it
# an uncommitted tree gets a time suffix: otherwise two builds from the same commit share one ?v=
# and a browser keeps the earlier one (21.09)
if ! git -C "$HERE" diff --quiet -- . 2>/dev/null; then BUILD="$BUILD-$(date -u +%m%d%H%M)"; fi
# The deployment's Supabase project, written down ONCE: the page takes it from here (config.js) and
# the lens carries the same ref in FlyConfig.ts WEB_RELAY_URL. `--sb` / SB_REF build for another one.
# Snap Cloud = Supabase under <ref>.snapcloud.dev, managed with the Supabase CLI's "snap" profile.
SB_REF_DEFAULT="zggswrzfsxuixvkaunnv"   # the project named "fly" on Snap Cloud: the author's demo backend; a fork passes its own with --sb
SB_HOST_DEFAULT="snapcloud.dev"          # supabase.co for a project made at supabase.com
SB_PROFILE_DEFAULT="snap"                # the CLI profile that owns it (`supabase --profile snap login`); "" = the default profile
REF="${SB_REF:-$SB_REF_DEFAULT}"
HOST="${SB_HOST:-$SB_HOST_DEFAULT}"
PROFILE="${SB_PROFILE-$SB_PROFILE_DEFAULT}"
ANON="${SB_ANON:-}"
RELAY="${RELAY_URL:-}"
WITH_BRAIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --sb) REF="$2"; shift 2 ;;
    --key) ANON="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --relay) RELAY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --brain) WITH_BRAIN=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$ANON" in
  *service_role*) echo "refusing: that is the SERVICE-ROLE key. Use the anon (public) key." >&2; exit 2 ;;
esac
if [ -n "$REF" ] && [ -z "$ANON" ] && [ -z "$RELAY" ]; then
  # no key given: ask the Supabase CLI (`supabase login` once). The key we want is the one named "anon".
  # bounded: the management API has been seen to hang the CLI for minutes; a build must not wait on it
  if command -v supabase >/dev/null 2>&1; then
    ANON="$(REF="$REF" PROFILE="$PROFILE" python3 - <<'PY' 2>/dev/null || true
import json, os, re, subprocess
cmd = ["supabase"] + (["--profile", os.environ["PROFILE"]] if os.environ.get("PROFILE") else []) + ["projects", "api-keys", "--project-ref", os.environ["REF"], "-o", "json"]
try:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL).stdout
    m = re.search(r"\[.*\]", out, re.S); ks = json.loads(m.group(0)) if m else []
    print(next((k.get("api_key", "") for k in ks if k.get("name") == "anon"), ""))
except Exception:
    pass
PY
)"
  fi
  if [ -z "$ANON" ]; then
    echo "no anon key for project $REF: pass --key <anon>, or 'supabase${PROFILE:+ --profile $PROFILE} login' so this script can fetch it" >&2
    exit 2
  fi
fi
if [ -z "$REF" ] && [ -z "$RELAY" ]; then
  echo "note: no --sb <ref> and no --relay, so the page will ask for a relay URL on the PIN screen."
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$HERE"

# ---------------------------------------------------------------- 1. the site
# the landing (index.html, the front door), the app (app.html), the 404, and everything they load
for f in index.html app.html 404.html style.css site.css app.js brain_worker.js brain_gpu.js \
         brain.version favicon.svg favicon.ico favicon.png robots.txt; do
  [ -f "$f" ] && cp "$f" "$OUT/"
done
cp -R gfx "$OUT/gfx"
cp -R dist "$OUT/dist"
cp -R assets "$OUT/assets"
# edges.bin and skel_l0.bin are not shipped (build them with web/make_assets.py --edges-only / --lod):
# the page works without them (no pulses along synapses, no arbors), so a missing one is a warning, not a failure
for big in edges.bin skel_l0.bin; do
  [ -f "assets/$big" ] || echo "NOTE: web/assets/$big is not here (build it with web/make_assets.py); the page will run without it" >&2
done
cp -R vendor "$OUT/vendor"
[ -d media ] && cp -R media "$OUT/media"   # the hero video, its poster and the Open Graph image
# the sources of the page's data, and the two simulators, are not part of a deployment
rm -f "$OUT"/gfx/*.py "$OUT"/dist/*.map

# ---------------------------------------------------------------- 1b. cache-busting (21.09 Pavlo saw
# the previous build's chip after a deploy: browsers keep app.js / gfx/*.js / the worker for days).
# Every script URL the site loads carries ?v=<build>, so a new build is a new URL everywhere and an
# old one can stay cached forever. The HTML files themselves are no-cache (.htaccess below).
python3 - "$OUT" "$BUILD" <<'PYEOF'
import pathlib, re, sys
out, build = pathlib.Path(sys.argv[1]), sys.argv[2]
v = "?v=" + build
def stamp(path, pairs):
    t = path.read_text(encoding="utf-8"); n = t
    for pat, rep in pairs: n = re.sub(pat, rep, n)
    if n != t: path.write_text(n, encoding="utf-8")
for html in ("index.html", "app.html", "404.html"):
    f = out / html
    if f.exists():
        stamp(f, [(r'(src|href)="((?:app|gfx/[^"?]+)\.js|(?:style|site)\.css)"', r'\1="\2' + v + '"')])
for js in [out / "app.js", *sorted((out / "gfx").glob("*.js"))]:
    stamp(js, [(r'(from\s+"\./[^"?]+\.js)"', r'\1' + v + '"'),
               (r'(import\(\s*"\./[^"?]+\.js)"', r'\1' + v + '"'),
               (r'new Worker\("brain_worker\.js"\)', 'new Worker("brain_worker.js' + v + '")')])
w = out / "brain_worker.js"
if w.exists():
    stamp(w, [(r'importScripts\("([^"?]+)"\)', r'importScripts("\1' + v + '")'),
              (r'locateFile:\s*\(p\)\s*=>\s*"dist/"\s*\+\s*p', 'locateFile: (p) => "dist/" + p + "' + v + '"')])
g = out / "brain_gpu.js"
if g.exists():
    stamp(g, [(r'fetch\("dist/brain\.wgsl"\)', 'fetch("dist/brain.wgsl' + v + '")')])
print("  cache-bust     ?v=" + build + " on every script the site loads")
PYEOF

# ---------------------------------------------------------------- 2. this deployment's config
cat > "$OUT/config.js" <<EOF
/**
 * ONE Supabase config for the whole page — WRITTEN BY web/release.sh, do not edit by hand.
 * Built $(date -u +"%Y-%m-%dT%H:%M:%SZ").
 *
 * The room behind the PIN, the fly's memory and the brain-versions table all live in the same
 * Supabase project. The anon key is public by design (it ships inside the lens as well); the
 * service-role key never appears here. A URL parameter (?sb= ?sbkey= ?relay= ?key=) still wins.
 */
export const SB = {
  ref: "${REF}",
  host: "${HOST}",
  anon: "${ANON}",
  relay: "${RELAY}",
};

export const BUILD = "$BUILD";
export const asset = (p) => (BUILD ? p + "?v=" + BUILD : p);
export const sbBase = (ref, host) => (ref ? \`https://\${ref}.\${host || SB.host || "supabase.co"}\` : "");
export const sbRealtime = (ref, host) => (SB.relay ? SB.relay : ref ? \`wss://\${ref}.\${host || SB.host || "supabase.co"}/realtime/v1/websocket\` : "");
EOF

# ---------------------------------------------------------------- 3. host headers
# Netlify and Cloudflare Pages both read _headers. The nginx equivalent is in DEPLOY.md §2.
cat > "$OUT/_headers" <<'EOF'
# The page itself must never be cached: a deploy has to be visible on the next reload.
/index.html
  Cache-Control: no-cache
/app.html
  Cache-Control: no-cache
/config.js
  Cache-Control: no-cache
/brain.version
  Cache-Control: no-cache
/
  Cache-Control: no-cache

# WebAssembly needs its own MIME type or the browser refuses to stream-compile it.
/dist/*.wasm
  Content-Type: application/wasm
  Cache-Control: public, max-age=31536000, immutable

# The data files are content-addressed by their build: safe to cache for a year.
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/vendor/*
  Cache-Control: public, max-age=31536000, immutable
/media/*
  Cache-Control: public, max-age=604800

# The brain itself (75 MB, already zlib-compressed — do not let the host compress it again).
/*.flyb.z
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/octet-stream
EOF

# Apache -- the usual host behind an FTP login -- reads .htaccess instead: the same MIME type and
# cache rules. The Header lines are guarded so a host without mod_headers does not 500 the site.
cat > "$OUT/.htaccess" <<'EOF'
AddType application/wasm .wasm
AddType application/octet-stream .z
RemoveEncoding .z
<IfModule mod_headers.c>
  <FilesMatch "^(index\.html|app\.html|config\.js|brain\.version)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <FilesMatch "\.(bin|wasm|wgsl|flyb\.z)$">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </FilesMatch>
</IfModule>
EOF

# ---------------------------------------------------------------- 4. the note for whoever uploads
BRAIN_NOTE="Download brain_c0.flyb.z (75 MB) from the brain-v2 release of the public
  fly-brain-spectacles repo and put it NEXT TO index.html, in this same directory."
if [ "$WITH_BRAIN" = "1" ] && [ -e "$HERE/brain_c0.flyb.z" ]; then
  cp -L "$HERE/brain_c0.flyb.z" "$OUT/"
  BRAIN_NOTE="brain_c0.flyb.z is already here (copied by release.sh)."
fi
# brain.version: the brain file's hash, which app.js puts on the download URL (?v=) so a browser
# that cached an older brain fetches the new one. Regenerated from the brain next to this script
# whenever there is one, so the shipped page always names the brain it ships; without one the
# checked-in web/brain.version (copied above) stands.
if [ -e "$HERE/brain_c0.flyb.z" ]; then
  BRAIN_VER="$(shasum -a 256 "$HERE/brain_c0.flyb.z" | cut -c1-12)"
  { grep '^#' "$HERE/brain.version" 2>/dev/null; echo "$BRAIN_VER"; } > "$OUT/brain.version"
  echo "  brain.version $BRAIN_VER"
fi

cat > "$OUT/README.txt" <<EOF
CyberFly web brain — what to upload
===================================
Built $(date -u +"%Y-%m-%dT%H:%M:%SZ") by web/release.sh.
Supabase project: $( [ -n "$REF" ] && echo "https://$REF.$HOST" || echo "<none: the page will ask for a relay>" )
Relay override:   ${RELAY:-<none: derived from the project ref>}

UPLOAD THE WHOLE OF THIS DIRECTORY, keeping the folder structure, INCLUDING the hidden .htaccess
(dotfiles are off by default in Finder and in some FTP clients). It is a plain static site:
no build step, no server code, no environment variables at the other end.

  index.html   the landing page: what this is, how it works, how to start   <- the front door
  app.html     the dashboard: the live brain (needs a PIN, or ?demo=1)
  404.html     for whatever your host points at it
  media/       the hero video, its poster, and the Open Graph image

ONE FILE IS NOT HERE, because it is 75 MB and does not belong in a repository:
  ${BRAIN_NOTE}

REQUIREMENTS OF THE HOST
  - HTTPS. WebGPU only runs in a secure context, and without it the brain falls back to the CPU
    and takes ~850 ms per step instead of ~100.
  - .wasm served as application/wasm (_headers does this on Netlify and Cloudflare Pages, .htaccess
    on Apache; for nginx see DEPLOY.md §2).
  - Do not re-compress *.flyb.z — it is already compressed. Compressing .js and .wasm is worth it.

CHECK IT WORKED (2 minutes)
  1. Open the page. The PIN card must appear with a brain already turning behind it.
  2. The line under the PIN box must name a WebGPU adapter, not "no WebGPU".
  3. Open the browser console: no 404 on dist/flybrain.wasm, dist/brain.wgsl, assets/*.bin,
     brain_c0.flyb.z.
  4. Type the PIN from the glasses. Within a few seconds: room chip = fly-NNNN, lens chip =
     connected, engine chip = WebGPU, step ~100 ms.
  5. No glasses around? On the machine that has this repo:
       uv run --with websockets python web/lens_sim.py --pin 4242 --relay <the same relay URL>
     then open the page and type 4242.

IF SOMETHING IS WRONG
  The page never fails silently: the header carries one line naming the fault and what to do about
  it (RELAY UNREACHABLE / THE LINK SERVER REFUSED PIN nnnn / NO GLASSES FOUND FOR PIN nnnn / BRAIN FILE NOT FOUND ...). Read that line
  first, then DEPLOY.md's "Common problems" table.
EOF

# ---------------------------------------------------------------- report
say_size() { du -sh "$1" 2>/dev/null | cut -f1; }
echo "built $OUT"
echo "  page + code   $(ls "$OUT" | wc -l | tr -d ' ') entries, total $(say_size "$OUT")"
echo "  project       $( [ -n "$REF" ] && echo "https://$REF.$HOST" || echo none )"
echo "  relay         ${RELAY:-derived from the ref}"
[ "$WITH_BRAIN" = "1" ] || echo "  brain file    NOT included — copy brain_c0.flyb.z next to index.html"
echo
echo "try it locally:  (cd $OUT && python3 -m http.server 8798)   ->  http://localhost:8798/"
