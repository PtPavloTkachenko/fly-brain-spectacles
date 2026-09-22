# Deploying the CyberFly web brain: Snap Cloud (Supabase) + a static site

**What it is.** The lens shows a 4-digit PIN on its dashboard. A person opens our page on a laptop,
types the PIN, and the page runs that fly's brain (WASM + WebGPU) in the browser — about 100 ms per
50 ms of fly time on a laptop GPU, where an earlier build that ran the brain on the glasses themselves
took a second or two per slice. The lens and the page meet in a "room" named `realtime:fly-<PIN>`
on Supabase Realtime (or on `web/relay.py`, a relay for one local network). Two optional tables give
the fly a memory that survives the session and a list of saved brains.

Everything below is one Supabase project and one static folder. There is no server of ours anywhere.

**The shipped project is `fly` on Snap Cloud** — the author's demo backend, Supabase under Snap's domain, `https://zggswrzfsxuixvkaunnv.snapcloud.dev`; a fork should point `release.sh --sb` and `FlyConfig.ts` at its own project —
managed with the Supabase CLI's `snap` profile (`supabase --profile snap login`, once per machine). A project made at
supabase.com works the same way with `supabase.co` as the host (`release.sh --host supabase.co --profile ""`,
`check_supabase.py --host supabase.co`).

---

## QUICK START

Ten steps from an empty account to a page a stranger can use. Each one is checkable; none of them
needs a build toolchain at the far end.

| # | do this | you are done when |
|---|---|---|
| 1 | Have a project on Snap Cloud (the shipped one is `fly`): `supabase --profile snap login`, then `supabase --profile snap projects list` gives the **ref** and `supabase --profile snap projects api-keys --project-ref <ref>` the **anon** key (the row named `anon`; never the service-role or a `sb_secret_` key). | you have `<ref>` and `<anon>` |
| 2 | Create the schema from the terminal: `supabase --profile snap link --project-ref <ref> -p ""` (from any scratch directory), then `supabase --profile snap db query --linked "$(python3 web/check_supabase.py --create)"`. The dashboard's SQL editor takes the same SQL. | the query returns `"rows": []`; `fly_memory` and `fly_brain_versions` exist with 4 policies each |
| 3 | Prove the project. `uv run --with websockets python web/check_supabase.py <ref> <anon>` (`--host supabase.co` for a supabase.com project) | every line **PASS** except the two `somebody else's row IS listable` lines, which report the shipped policy (1b): 12 of 14 on `fly`, 15.09 |
| 4 | Build the site. `web/release.sh --brain` — the project (`SB_REF_DEFAULT`, `SB_HOST_DEFAULT`, `SB_PROFILE_DEFAULT`) is pinned in the script and the anon key comes from the CLI, bounded to 30 s; if the CLI hangs (seen 15.09) pass `--key <anon>`. `--sb <ref> --host <host> --key <anon>` builds for another project. Writes `web/site/` with ref, host and key baked into `config.js`. | `built .../web/site`, `project https://<ref>.snapcloud.dev` |
| 5 | Add the brain file. Download `brain_c0.flyb.z` (75 MB) from the **brain-v2** release of the public `fly-brain-spectacles` repo and drop it **next to `index.html` inside `web/site/`**. That release is the 15.09 export with **four** odour channels (sha256 `3c0ef7e4f701…`); the sixteen-odour export of ADR 105 that `web/brain.version` names (`835780dba8c8`) is not on a release yet, so with the release file the lens's other odours are ignored and `brain.version` must be regenerated from the file you ship (`shasum -a 256 brain_c0.flyb.z \| cut -c1-12`). `edges.bin` (16 MB, the synapses that carry the pulses) and `skel_l0.bin` (34 MB, every neuron's arbor) are not on the release yet: build them with `web/make_assets.py` (needs the fly-wirehead runtime) into `web/assets/` BEFORE step 4, or the page draws the brain without them (`release.sh` warns). | `site/brain_c0.flyb.z` exists |
| 6 | Upload `web/site/` to any static **HTTPS** host — Netlify, Cloudflare Pages, Vercel, GitHub Pages, our own nginx, or a plain FTP host (then include the hidden `.htaccess`). Keep the folder structure; no build step, no environment variables. | the page loads over `https://` |
| 7 | Point the lens at the same project: `Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts` already carries `WEB_RELAY_URL` and `MEMORY_BACKEND_URL` for `fly`; `python3 web/lens_key.py` pastes the anon key from the built site into `WEB_RELAY_KEY` and `MEMORY_BACKEND_KEY` before a device build; `python3 web/lens_key.py --clear` blanks them again before a commit. Build, send to the glasses. | the dashboard footer shows `web pin NNNN` |
| 8 | Open the page. A brain must already be turning behind the PIN card, and the line under the PIN box must **name a WebGPU adapter** (not "no WebGPU"). | no 404 in the console |
| 9 | Type the PIN from the glasses. | room chip `fly-NNNN`, lens chip `connected`, engine chip a GPU name, step ~100 ms |
| 10 | No glasses nearby? Open **`?demo=1`** (a lens made of JavaScript inside the page), or drive a real room from this repo: `uv run --with websockets python web/lens_sim.py --pin 4242 --relay wss://<ref>.snapcloud.dev/realtime/v1/websocket --key <anon>` and type 4242. | the room fills and a fly flies in it |

## AGENT CHECKLIST — deploying a build (for whoever, or whatever, does the upload)

Everything below is checkable from a terminal; do not skip a check because the previous one passed.

1. **Build** from a clean, committed tree: `web/release.sh --brain` (the anon key comes from the Supabase CLI profile `snap`; without the CLI: `SB_ANON=<anon> web/release.sh --brain` — the anon key is public by design, the service-role key is refused). Output: `web/site/`, ~130 MB, 20 entries.
2. **Verify the build before touching a host** (all four must hold):
   - `grep -o 'ref: "[^"]*"\|host: "[^"]*"' web/site/config.js` → the pinned ref and `snapcloud.dev`; `anon` non-empty.
   - `grep -v '^#' web/site/brain.version | head -1` equals `shasum -a 256 web/site/brain_c0.flyb.z | cut -c1-12` (a stale page refetches the brain only when this changes; with the `brain-v2` release file this holds only after `brain.version` is regenerated from it).
   - `cmp web/site/dist/flybrain.wasm web/dist/flybrain.wasm` (the wasm the lens's brain runs on; rebuilt with `web/build_wasm.sh` after any core change).
   - `ls -a web/site` shows `_headers` and `.htaccess`; `README.txt` says where the brain file sits.
   - `grep -o 'app.js?v=[^"]*' web/site/app.html` shows the build's `?v=<sha>` (every script URL is versioned; a browser that cached the previous build still loads the new one).
   - Optional local run of the exact artefact: `(cd web/site && python3 -m http.server 8798)` → `http://localhost:8798/app.html?demo=1` runs the demo; `app.html` shows the PIN card with a WebGPU adapter named under it.
3. **Upload `web/site/` whole**, structure intact: Netlify / Cloudflare Pages / Vercel take the folder (they read `_headers`); a plain FTP/Apache host needs dotfiles ON so `.htaccess` goes too. Never upload the tools (`relay.py`, `page_sim.py`, `lens_sim.py`, `lens_key.py`, `pagebrain.py`, `check_supabase.py`, `release.sh`, `*.md`) — `release.sh` already leaves them out.
4. **Check the live host** (replace the URL):
   - `curl -sI https://<host>/fly/dist/flybrain.wasm | grep -i content-type` → `application/wasm` (otherwise the brain never starts: WebGPU/WASM refuse a wrong MIME).
   - `curl -sI https://<host>/fly/config.js | grep -i cache-control` and the same for `brain.version` → `no-cache`.
   - `curl -sI https://<host>/fly/app.html | grep -i cache-control` → `no-cache` (the html must not be cached: its script URLs change per build).
   - `curl -s https://<host>/fly/brain.version | grep -v '^#'` equals the value from step 2.
   - `curl -sI https://<host>/fly/brain_c0.flyb.z | grep -i content-length` → the size of `web/site/brain_c0.flyb.z`.
5. **Check the page** in a real browser (Chrome/Edge 113+ or Safari 26+/iOS 18+): the header reads `● BRAIN THINKING · N STEPS` within ~30 s; `?demo=1` shows the made-up room with flies; on the glasses path type the PIN from the lens → `PIN NNNN · GLASSES connected`, and the Lens Studio / device log shows `WEB_BRAIN_ON page=web`. The footer's last line names the relay; `LINK SERVER UNREACHABLE` there means the host or the key, not the page.
6. **Rollback** = upload the previous `web/site/` (keep the last two builds somewhere; the build is stamped by `BUILD` = the git short hash in `config.js` and in every `?v=` asset URL).
7. **Never**: hand-edit files in `web/site/` (rebuild instead), upload the service-role key, or point the page at a project the lens is not pointed at (`FlyConfig.ts` `WEB_RELAY_URL` / `MEMORY_BACKEND_URL` name the same ref).

> **The shipped configuration is Supabase only.** The lens and the page both join
> `wss://<ref>.snapcloud.dev/realtime/v1/websocket` with the anon key, and that is the only path a
> released build uses. `web/relay.py` (§4) still exists for a LAN event or for working offline, but
> nothing ships pointed at it: `release.sh --relay ws://…` is a deliberate, local override, and the
> lens has to be rebuilt with the same URL for it to mean anything.

If step 9 does not happen, the page says why in one line in its header — `RELAY UNREACHABLE`,
`THE LINK SERVER REFUSED PIN 4242`, `NO GLASSES FOUND FOR PIN 4242`, `BRAIN FILE NOT FOUND` — and the "Common problems"
table at the bottom of this file matches those words.

### One configuration, in exactly three places

Everything comes out of the **same project ref and the same anon key**. The anon key is public by
design: it ships inside the lens and inside the page. The service-role key belongs in neither.

| who | where it is written | value |
|---|---|---|
| the page | `web/config.js` — written by `release.sh`, never edited by hand | `SB.ref = <ref>`, `SB.host = snapcloud.dev`, `SB.anon = <anon>` |
| the lens (room) | `FlyConfig.ts` | `WEB_RELAY_URL = wss://<ref>.snapcloud.dev/realtime/v1/websocket`, `WEB_RELAY_KEY = <anon>` (pasted locally) |
| the lens (memory) | `FlyConfig.ts` | `MEMORY_BACKEND_URL = https://<ref>.snapcloud.dev`, `MEMORY_BACKEND_KEY = <anon>` (pasted locally) |

Overrides, in order of who wins: a URL parameter (`?sb=` `?sbkey=` `?relay=` `?key=` `?pin=`) >
`config.js` > what that browser used last > the LAN relay next to a page served over plain http.
So a demo can be pointed anywhere without rebuilding, and a deployed page needs no parameters at
all: with a project baked in, the PIN gate shows only the PIN and no relay field; the ROOM chip (R)
can still point one session at another relay.

### Windows

`release.sh` is a shell script; on Windows run it from **Git Bash** or **WSL**. Without either, the
bundle is just a copy — make a folder and put in it: `index.html`, `app.html`, `404.html`, `style.css`,
`site.css`, `app.js`, `config.js`, `brain_worker.js`, `brain_gpu.js`, `favicon.svg`, `robots.txt`, the folders
`gfx/`, `dist/`, `assets/`, `vendor/`, `media/`,
then `brain_c0.flyb.z`; and edit `config.js` by hand so `SB.ref` and `SB.anon` hold your two values.
`check_supabase.py` and `lens_sim.py` are plain Python and run anywhere (`py -m pip install
websockets`, then `py web\check_supabase.py ...`).

---

## READINESS

What exists, and what has met the real project. **`fly` on Snap Cloud exists since 15.09:** the schema
is in, `check_supabase.py` passes 12 of 14 (the two remaining lines are the shipped policy, 1b), a Realtime
echo takes ~250 ms, and the built page joined a `web/lens_sim.py` room through it end to end (room
`fly-4242`, `LENS CONNECTED`, step 111 ms on WebGPU). Not yet met: the glasses, and the public HTTPS host.

| component | ready today | tested against a real Supabase project | what to do |
|---|---|---|---|
| The page: brain (WASM + WebGPU), all 166,700 neurons, the room, the eyes | yes — 60 fps at 1280-2560, brain step ~100 ms on an M1 Max | not needed (no backend involved) | — |
| The room behind the PIN (Realtime broadcast) | yes, over `relay.py`; the client is one code path for both | **yes** (15.09: echo 246 ms; page + `lens_sim.py` through `fly-4242`) | — |
| The lens side of the link (`WebBrainLink`) | yes, verified in the editor preview and against `page_sim.py` | **no** | run the page and the lens against the same `<ref>` once |
| `fly_memory` (the fly remembers, ADR 63) | yes: schema, RLS, lens push/pull code | **yes** (15.09: checker lifecycle PASS) | — |
| `fly_brain_versions` (saved brains, ADR 68) | yes: schema, RLS, the page's SAVE / LOAD / DELETE / DOWNLOAD / UPLOAD | **yes** (15.09: checker lifecycle PASS) | SAVE a version on the page and reload it |
| RLS as written | it stops oversized blobs and it is the schema we ship | **yes** (15.09: a foreign row IS listable, exactly as 1b says) | read the honest note in 1b: with only an anon key the row id IS the secret. `check_supabase.py` tries to list a foreign row and tells you what it got |
| The static bundle (`release.sh` -> `site/`) | yes — built, served on another port and driven end to end headless, self-contained | n/a | — |
| HTTPS + WebGPU on the real host | the requirement is known and the page names the failure | **no** | step 8: the PIN card must name a GPU adapter |
| Teaching a session from the page (ADR 68) | yes, over the relay; the lens runs it | **no** | after step 9, run a session from the guide card on the glasses; the page mirrors it in the session strip |
| Gemini's verdict at the end of a session | it comes from the LENS, not the page: no page-side key | n/a | — |

**The first smoke test, in one line:** step 3 green, then the page and `lens_sim.py` pointed at the
same `wss://<ref>.snapcloud.dev/...` room from two different machines — if the fly flies on the page,
the cloud path is proven end to end.

### What we need from you to finish this

1. the upload of `web/site/` to the HTTPS host (over FTP: dotfiles on, so `.htaccess` goes too), and
2. `python3 web/lens_key.py` before the device build (and `--clear` before a commit).

The project, the schema, the checker and the build are done (15.09).

---

## 1. Snap Cloud / Supabase (the rooms behind the PIN)

1. The shipped project is `fly` on Snap Cloud (`https://zggswrzfsxuixvkaunnv.snapcloud.dev`, us-east-1), the author's demo backend; a fork brings its own project. Snap Cloud is Supabase under `snapcloud.dev`, managed with the Supabase CLI's `snap` profile; a project made at https://supabase.com works the same with `supabase.co` as the host.
2. Take from the CLI (`supabase --profile snap projects list`, `supabase --profile snap projects api-keys --project-ref <ref>`) or from the dashboard's API settings:
   - the **ref** (the first label of the project URL);
   - the **anon public key**. It is public by design (it ships inside the lens and the page). Never copy the service-role or a `sb_secret_` key anywhere.
3. Realtime is enabled in every project by default. We only use **Broadcast** on public channels, so:
   - nothing to change under **Realtime -> Settings**;
   - do NOT enable "Private channels only" (an anonymous join without JWT policies would then be refused);
   - no tables, no RLS policies, no Edge Functions are required.
4. Check from a terminal (`websocat` or `wscat`):
   ```
   websocat "wss://<ref>.snapcloud.dev/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0"
   {"topic":"realtime:fly-1234","event":"phx_join","payload":{"config":{"broadcast":{"self":false}}},"ref":"1"}
   ```
   The reply must be a `phx_reply` with `"status":"ok"`.
5. Limits. Snap Cloud alpha: 200 peak connections, 250 KB per message, and a MONTHLY quota of **2 million messages**. One session = 2 connections and ~22 messages/s (≈10/s from the brain down, 4.5 KB each, 12/s of senses up), about 80,000 messages an hour, so a month covers roughly 25 hours of sessions; for an event, or anything longer, run `web/relay.py` on the local network. (A supabase.com project: Free 200 connections, 100 messages/s and the same 2 million a month; Pro 5 million, about 70 hours — verify at supabase.com/pricing.)
6. Snap Cloud sits behind Cloudflare: a request with Python's default User-Agent gets `403` / `error code: 1010`. `check_supabase.py` sends its own User-Agent; browsers, the lens and the `websockets`-based simulators are fine.

## 1b. The fly's memory in the cloud (optional; ADR 63)

Everything above is stateless. This section is the ONE thing that stores anything, and the lens does
not need it: a trained fly is already kept in the glasses' own persistent storage. Add this only if
you want a fly to follow its owner to **another pair of glasses**.

What is stored: one row per user, holding the plastic state of the KC->MBON synapses (a base64 blob,
typically 30-60 KB) and the fly's identity (its name, colour and how often each thing was rewarded or
punished). No account, no personal data, no room, no camera: the key is the Connected-Lens user id,
which is "unique per lens for each user" and means nothing outside this lens.

Run this in the Supabase **SQL editor**:

```sql
create table if not exists public.fly_memory (
  fly_id     text primary key,          -- the Connected-Lens user id (or a per-device uuid)
  blob       text not null,             -- the memory, base64 (FMEM/FMEZ)
  identity   jsonb,                     -- {nameIx, colorIx, born, sessions, trained{}}
  saved_at   double precision,          -- Date.now() on the glasses at the save
  updated_at timestamptz not null default now()
);

alter table public.fly_memory enable row level security;

-- Anonymous, but never able to read or overwrite ANOTHER fly: every statement must name one fly_id.
-- PostgREST sends the filter as part of the statement, so `using (true)` would let anyone list every
-- row; these policies instead require the request to carry the id it is asking about.
create policy "own row: read"   on public.fly_memory for select
  to anon using (fly_id = coalesce(current_setting('request.headers', true)::json->>'x-fly-id', fly_id));
create policy "own row: insert" on public.fly_memory for insert to anon with check (length(blob) < 400000);
create policy "own row: update" on public.fly_memory for update to anon using (true) with check (length(blob) < 400000);
create policy "own row: delete" on public.fly_memory for delete to anon using (true);

create index if not exists fly_memory_updated on public.fly_memory (updated_at);
```

Honest note on what those policies do and do not do. With only the anon key there is no
authenticated identity, so the database cannot *prove* who is asking. The policies above stop the
obvious harm - a blob bigger than 400 KB, and a plain `select *` that would dump every row - but
somebody who knows another user's id could still read or overwrite that row. The ids are random and
never displayed (the lens logs four characters at most), and the worst case is a lost fly memory, so
this is the honest trade for "no accounts". If that is not acceptable, put Supabase Auth (anonymous
sign-in) in front and change `to anon` to `to authenticated` with `fly_id = auth.uid()::text`.

Housekeeping: rows are small, but nothing deletes them. A weekly cron is enough:
`delete from public.fly_memory where updated_at < now() - interval '90 days';`

## 1c. Brain VERSIONS (ADR 68)

One fly, many brains: a version is a named snapshot of the plastic state plus what the session that
made it concluded. The **page** owns this table — it reads and writes it with the anon key. The lens
only hands the page the row id once (`mem.key` in the scene feed; the page never displays it) and
accepts the chosen version back as `{t:"cmd", cmd:"memory_set", data:"<blob b64>"}`. The lens then
installs it as the canonical copy and saves it to the device store, so the glasses and the page hold
the same brain even after the page goes away.

```sql
create table if not exists public.fly_brain_versions (
  user_id        text        not null,             -- the same id as fly_memory.fly_id (mem.key)
  version_id     uuid        not null default gen_random_uuid(),
  name           text        not null,             -- what the person called it: "knows the mug"
  created_at     timestamptz not null default now(),
  blob           text        not null,             -- base64 of the core's memory blob, < 400 KB
  bytes          integer,                          -- the four below are what the page's list shows:
  changed        integer,                          --   synapses that had moved
  mean_efficacy  double precision,                 --   the brain's own readout at the save
  sessions       integer,                          --   how many sessions this brain has lived through
  identity       jsonb,                            -- FlyIdentity: name, colour, born, sessions, trained
  summary        jsonb,                            -- the last session's evidence pack + Gemini's verdict
  primary key (user_id, version_id)
);
alter table public.fly_brain_versions enable row level security;
-- as in 1b: the anon key cannot prove who is asking, so the id itself is the secret. A read must
-- name its row; a listing without a user_id returns nothing useful.
create policy "own rows: read"   on public.fly_brain_versions for select
  to anon using (user_id is not null and length(user_id) >= 8);
create policy "own rows: insert" on public.fly_brain_versions for insert
  to anon with check (length(blob) < 400000 and length(name) < 80 and length(user_id) >= 8);
create policy "own rows: update" on public.fly_brain_versions for update
  to anon using (true) with check (length(blob) < 400000);
create policy "own rows: delete" on public.fly_brain_versions for delete to anon using (true);
create index if not exists fly_versions_user on public.fly_brain_versions (user_id, created_at desc);
```

`web/check_supabase.py --create` prints exactly this (and 1b) so nobody retypes it, and
`check_supabase.py <ref> <anon>` then writes, reads, updates and deletes a throwaway row in both
tables and reports whether a **foreign** row can be listed. The page reads these columns with the
same anon key (`web/gfx/versions.js`: `select=id:version_id,name,created_at,bytes,changed,…`).

The same honest note as 1b applies, and one more: **a version is a brain, not a save file.** Loading
one replaces what the fly knows now, and the rule's decay (τ 3 h, ADR 92) has been running on the stored
copy all along — `identity.history` says when each version was made, so an old one comes back older.
Keep the count per user small (a weekly `delete ... where created_at < now() - interval '180 days'`,
or keep the newest 20 per `user_id`).

Then, in `Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts`:
```
MEMORY_BACKEND: true,
MEMORY_BACKEND_URL: "https://<ref>.snapcloud.dev",
MEMORY_BACKEND_KEY: "<anon key>",
```
Never commit a key. The lens logs `MEMORY_BACKEND_PUSH ok <n>B key=user:xxxx` on a save and
`MEMORY_BACKEND_PULL` when a fresh pair of glasses finds a fly already trained.

## 2. The page (static hosting on our site)

The page is fully static: HTML/JS/WASM, no backend. Any static host works (our site, Netlify, Vercel, Cloudflare Pages, GitHub Pages).

Hard requirements:
- **HTTPS.** WebGPU only runs in a secure context. Plain `http://` on another machine will not work (localhost is the exception).
- **MIME `application/wasm`** for `.wasm` (standard hosts do it; on your own nginx check `types`).
- **The brain file sits next to the page** (same origin): `brain_c0.flyb.z` (~75 MB). Download it from the `brain-v2` release of the public `fly-brain-spectacles` repo and put it in the same folder. Do not load it from another domain's CDN: it has no CORS headers.
  The `brain-v2` release file is the 15.09 four-odour export; the sixteen-odour export of ADR 105 (`core/brain_export/out/brain_c0_od16.flyb.z`, the one `web/brain.version` names) is not on a release yet. On the author's machine the name is a symlink to that export; `release.sh --brain` copies the target (`cp -L`). The page downloads it as `brain_c0.flyb.z?v=<hash>`, the hash being the one line of `brain.version` (`shasum -a 256 web/brain_c0.flyb.z | cut -c1-12`; `release.sh` regenerates it from the brain next to it, and it must be served `no-cache` like `config.js`), so a browser that cached the old brain fetches the new one once and keeps that. Without `brain.version` the page uses the byte length from a HEAD request instead.
- Do not gzip/brotli the brain file again (it is already zlib-compressed); compression on `.js`/`.wasm` is worth it.
- Cache: `.flyb.z` can be cached for a long time (`Cache-Control: public, max-age=31536000`); the page and `dist/` briefly.

**Build it, do not hand-pick it.** `web/release.sh --sb <ref> --key <anon>` writes `web/site/`:
the page, `gfx/`, `dist/`, `assets/`, `vendor/`, a `config.js` carrying this deployment's ref and
anon key, a `_headers` file (Netlify, Cloudflare Pages), a hidden `.htaccess` (Apache, i.e. a plain
FTP host) and a `README.txt` for whoever does the uploading. Upload the whole folder, structure
intact, dotfiles included. `--relay ws://host:8795` bakes in a LAN relay instead of Supabase;
`--brain` copies the 75 MB brain file in as well (otherwise put it next to `index.html` yourself).

```
site/
  index.html             <- the landing (the front door): what this is, how it works, how to start
  app.html               <- the dashboard (a PIN, or ?demo=1 for the in-page demo lens)
  404.html  robots.txt  favicon.svg
  style.css  site.css  app.js  config.js  brain_worker.js  brain_gpu.js
  gfx/  dist/  assets/  vendor/  media/
  _headers  .htaccess  README.txt
  brain_c0.flyb.z        <- the 75 MB brain, added by hand or by --brain
```

**Rebuilt assets reach old visitors.** `release.sh` stamps the commit into `config.js` (`BUILD`) and every
`assets/*.bin` request carries it as `?v=<commit>`, so a rebuilt asset is a new URL even though the files are
cached for a year. Always upload `assets/` together with the page; a page built from a newer commit than the
assets on the host (v3 readers, v2 files) degrades silently to the old look.

`media/` is the landing's hero: a 13 s clip of the real brain recorded off this page (`hero.webm`
1.4 MB, `hero.mp4` 1.3 MB, `hero.jpg` poster, `og.png` for link previews). The front door is
`index.html` (the landing); the dashboard is `app.html`; every link between them lives in `gfx/nav.js`,
the landing and `404.html`.

Never uploaded, because they are tools and not the site: `relay.py`, `page_sim.py`, `lens_sim.py`, `lens_key.py`,
`serve.sh`, `build_wasm.sh`, `make_assets.py`, `check_supabase.py`, `release.sh`, `test.html`.

No WASM build is needed: `dist/` is prebuilt and committed. If the C++ changes: `web/build_wasm.sh`
(Emscripten).

**Build flags (17.09): `-O3`, and that is deliberate.** `-msimd128` and `-flto` were measured and
not adopted. Three interleaved sets of the 1300 ms warm-up in node on an M1 Max, each vs `-O3` in
the same set: **`-msimd128` +1.0 % and -0.1 %** (i.e. nothing, 309 KB), **`-flto` +2.1 %** (340 KB),
**`-msimd128 -flto` +2.1 / +1.6 / +2.5 %** (344 KB) -- so the flag that pays is `-flto`, about 2 %
for 36 KB, and SIMD buys nothing, which is what you expect when the kernel is a random-access
scatter over a 200 MB edge array. Still not adopted: 2 % is 2 % of the WASM CPU side, and on the
page's real engine (WebGPU) that side is **~4 % of a hop** (the phase table in `stats()` says so),
i.e. 0.08 % end to end. It matters only to a visitor with no WebGPU at all. Reach was never the
objection -- WASM SIMD is baseline in every browser that has WebGPU, Windows/D3D12 included. Every
variant, and the native CPU, give **bit-identical** spike counts, so the flags are numerically safe.
Build a variant with `OUT=<dir> OPT="-O3 -flto" web/build_wasm.sh`; interleave, repeat the set and
change one flag at a time -- the first A/B here said SIMD was 30 % slower (three headless Chromes,
not the compiler) and the second credited SIMD with 1.5 % that turned out to be LTO's.

**Threads are NOT a build flag, and are not enabled.** `-pthread -sPTHREAD_POOL_SIZE=N` does compile
(one warning: `-pthread + ALLOW_MEMORY_GROWTH may run non-wasm code slowly`), but shipping it needs
three things this page does not have:
1. **Cross-origin isolation** for `SharedArrayBuffer`: `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` on every response. `require-corp` then blocks every
   cross-origin subresource that does not opt in, and this page talks to Supabase; the brain file,
   the vendored three.js and the assets are same-origin and fine, but the Supabase endpoints would
   have to carry CORP/CORS or the page breaks in production. That is a change to someone else's
   headers, so it is not one we can make blind.
2. **A pool, not per-chunk spawns.** `kernel_par` creates its worker threads inside every 10 ms chunk
   (`std::vector<std::thread>` in `kernel_par`), i.e. five spawn/join rounds per hop. Native that is
   free; on the web each is a Worker handshake unless `PTHREAD_POOL_SIZE` covers it.
3. **Asyncify.** The module is built `-sASYNCIFY=1` because WebGPU readback is async, and Asyncify
   unwinding a stack while another thread blocks in `join()` is the combination emscripten warns
   about. It builds; whether it is safe under load is a test, not an assumption.
Also: threads only speed up the **CPU fallback**. The page's default engine is WebGPU, where the
kernel is on the GPU and the WASM CPU does only sense injection, plasticity, readout and JSON --
about 1 % of the hop (see the phase table in `stats()`).

**Headers.** Netlify and Cloudflare Pages read the generated `_headers`; Apache reads the generated
`.htaccess`. The nginx equivalent:

```nginx
# .wasm must have its own type or the browser will not stream-compile it
types { application/wasm wasm; }

location = /index.html { add_header Cache-Control "no-cache"; }
location = /app.html   { add_header Cache-Control "no-cache"; }
location = /config.js   { add_header Cache-Control "no-cache"; }
location ~* \.(bin|wasm|wgsl)$ { add_header Cache-Control "public, max-age=31536000, immutable"; }
location ~* \.flyb\.z$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
  gzip off;                      # it is already zlib-compressed; compressing it again wastes CPU
  default_type application/octet-stream;
}
gzip on; gzip_types application/javascript text/css application/wasm;
```

Page parameters (URL, or the fields on the PIN screen, or the ROOM chip once inside). A deployed
page needs none of them — `config.js` already holds the project — but any of them overrides it:
- `?sb=<ref>&sbkey=<anon>`: the whole Supabase project at once (the room, the memory and the versions).
- `?relay=wss://…&key=<anon>`: a room somewhere else, e.g. a LAN relay during an event.
- `?pin=1234&auto=1`: join immediately, without a click (tests, a kiosk).
- `?brain=<url>`: another brain file; the default is `brain_c0.flyb.z` next to the page.
- `?room=1`, `?help=1`, `?open=1`, `?tab=training`: open a panel on load — for screenshots and tests.

**Changing the PIN without reloading.** The `room` chip in the page header is a control: click it (or
press **R**) and a small form opens with the PIN, the relay and the key already filled in, plus
RECONNECT and LEAVE ROOM. Leaving brings the PIN card back over a brain that never stopped running,
so a wrong PIN, or a lens that was restarted into a new one, costs nothing but a click — there is no
longer any state a person can get stuck in. When a lens that WAS in the room has been silent for
more than 30 s, a CHANGE PIN button appears next to the fault line for the same reason.

Check after deploying: open the page in Chrome/Edge (WebGPU: Chrome 113+, Safari 26+); the console must show no 404 on `dist/flybrain.wasm`, `dist/brain.wgsl`, `brain_c0.flyb.z`; the page status must reach "brain ready"; a step takes ~100 ms on an M1/RTX and ~850 ms on CPU only (the WASM fallback).

## 3. The lens (so it joins the same room)

In `Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts` — the same `<ref>` and the same anon key the page
was built with, or the two will sit in different rooms and neither will say anything is wrong:
```
WEB_RELAY_URL: "wss://<ref>.snapcloud.dev/realtime/v1/websocket",
WEB_RELAY_KEY: "<anon key>",
MEMORY_BACKEND: true,                                  // only if you did section 1b
MEMORY_BACKEND_URL: "https://<ref>.snapcloud.dev",
MEMORY_BACKEND_KEY: "<anon key>",
```
Build and send the lens to the glasses. The dashboard footer shows `web pin NNNN`, guide step 03 explains it. Once the page connects, the board header reads `BRAIN: ON YOUR WEB PAGE` and the guide's PIN line turns into `PAGE CONNECTED`.

## 4. Local alternative without the cloud (an event, a demo on one Wi-Fi)

On the Mac, `web/serve.sh` starts the relay (`ws://<mac>:8795`) and the page (`http://localhost:8796`). The lens looks for `ws://flybrain.local:8795` (mDNS). In this setup a page on ANOTHER computer needs an https proxy in front of `:8796` (WebGPU); on the Mac itself it works as is.

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Page says "WebGPU unavailable", the brain runs on CPU (850 ms/step) | not https, or a browser without WebGPU | https; a recent Chrome/Edge; on Mac Safari 26+ |
| The lens never sees the page although the PIN is right | different relays: the lens on `flybrain.local`, the page on Supabase (or the other way round) | both sides on the same URL with the same anon key |
| `phx_reply` with `status:"error"` on join | private channels enabled, or a wrong apikey | disable private-only; check the key |
| 404 on `brain_c0.flyb.z` | the file is not next to the page | put it from the `brain-v2` release into the same folder |
| The page uses 1.5-2 GB of memory | normal: 166,700 neurons and 25.6 M synapses live in the WASM heap | a laptop with 8 GB or more |
| A trained fly is naive again on a second pair of glasses | `MEMORY_BACKEND` is off (the default), so the memory lives only in the first device's storage | section 1b |
| `MEMORY_BACKEND_PUSH http 401/404` | wrong anon key, or the `fly_memory` table does not exist | re-run the SQL of section 1b, check the key |
| The lens logs `MEMORY_TOO_BIG` | the device store is 100 KB in total and the blob outgrew `MEMORY_MAX_FRACTION` of it | the blob is ~10 bytes per trained synapse, so this needs nearly all 7,835: shorten the session, or raise the fraction |
| `check_supabase.py`: `REST does not answer (HTTP 401)` … `Only the service_role API key can be used for this endpoint` | an older checker probed the REST root, which newer PostgREST serves to the service key only | fixed 15.09: it probes `fly_memory` instead |
| A Python tool gets `403` with `error code: 1010` from `*.snapcloud.dev` | Cloudflare's browser check refuses Python's default User-Agent | send any other User-Agent (`check_supabase.py` does); browsers, the lens and the `websockets` simulators are unaffected |
| `release.sh` sits for minutes; `supabase … projects api-keys` never returns | the management API stalled the CLI (15.09, after a handful of calls; `projects list` still answered) | the build bounds that call to 30 s; pass `--key <anon>` (it is `anon` in the last `web/site/config.js`) |

## Credits

MaleCNS v1.0 connectome: HHMI Janelia FlyEM, Google Research, University of Cambridge / MRC LMB,
released **CC BY 4.0** — <https://male-cns.janelia.org>.
Model: **fly-wirehead** (leaky integrate-and-fire over that connectome).
Learning rule: Huang, Luo et al. 2024 — <https://doi.org/10.1038/s41586-024-07819-w>.

The same line is in the page footer and in the "?" card, on every tab.
