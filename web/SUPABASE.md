# Supabase for CyberFly — the exact setup, for a person and for an AI agent

> **Shipped (15.09):** the project is `fly` on **Snap Cloud** — ref `zggswrzfsxuixvkaunnv`, host `snapcloud.dev`,
> Supabase CLI profile `snap`. It is the author's demo backend; a fork creates its own project and passes it to `release.sh --sb`. Read `supabase.co` below as `snapcloud.dev`, prefix every CLI command with
> `--profile snap`, and see DEPLOY.md §1 for the Snap Cloud limits and the Cloudflare note. Otherwise identical.

Read this once, top to bottom. Every step has a command or a click, and a way to verify it. If you
are an AI agent doing this for someone: run the commands in the "Agent runbook" at the end, in order,
and stop at the first FAIL; the fix for every FAIL is in "If something fails".

## What Supabase does here (30 seconds)

- **Realtime (Broadcast)** is the *relay*: the Spectacles lens and the web page meet in a room named
  `realtime:fly-<PIN>` and exchange small JSON messages (senses up, brain messages down, the scene
  feed). Nothing is stored. No tables are needed for this part.
- **Two tables** hold the fly's *memory* and its *saved brain versions* (the plastic state of the
  7,835 learning synapses plus the fly's identity). Optional, but this is what makes the fly remember
  a user across sessions and devices.
- The **anon public key** is used by the lens and the page. It is public by design. The **service-role
  key is never used anywhere** — if you see it in a config, that is a mistake.

## What you get from Supabase (write these two values down)

1. `<ref>`: the project ref, the first label of the project URL `https://<ref>.snapcloud.dev`.
2. `<anon>`: Project Settings → API → "anon public".

Everything below is those two values in four places (page config, two tables, lens config).

## Step 1 — create the project (dashboard, 3 minutes)

1. https://supabase.com → New project. Name: `cyberfly`. Region: the one closest to the users
   (Frankfurt for Europe). Database password: anything, it is not used by us.
2. Wait for "Project is ready" (about 2 minutes).
3. Project Settings → API: copy the **Project URL** (gives `<ref>`) and the **anon public** key.

## Step 2 — Realtime (nothing to configure, one thing NOT to do)

Realtime is on by default in every project. We use public Broadcast channels only.
- Do **not** enable "Private channels only" under Realtime → Settings (an anonymous join would be refused).
- Nothing else to set.

## Step 3 — the two tables (SQL editor, 1 minute)

Dashboard → SQL Editor → New query → paste the output of this command and Run:

```bash
python3 web/check_supabase.py --create
```

It prints the full SQL for `public.fly_memory` and `public.fly_brain_versions` with their row-level
security policies and indexes (the same SQL is in `web/DEPLOY.md` §1b and §1c). Run it once; it is
idempotent (`create ... if not exists`), so running it twice is harmless.

## Step 4 — verify the project (terminal, 20 seconds)

```bash
python3 web/check_supabase.py <ref> <anon>
```

Expected: only `PASS` lines. It checks Realtime (two sockets join a room and a broadcast echoes
between them), both tables exist, and the policies behave (a throwaway row is inserted, read,
updated and deleted; a foreign row is not listable). It refuses a service-role key on purpose.

## Step 5 — the web page (build the bundle with the project baked in)

```bash
web/release.sh --sb <ref> --key <anon>          # writes web/site/ with config.js, _headers, README.txt
```

Upload the whole `web/site/` directory to a static host (Netlify / Cloudflare Pages / Vercel /
GitHub Pages / nginx). HTTPS is mandatory (WebGPU needs a secure context). Then put the brain file
`brain_c0.flyb.z` (75 MB, from the `brain-v2` release of the public `fly-brain-spectacles` repo) next
to `index.html` on the host. `web/site/README.txt` repeats this. Details and headers: `web/DEPLOY.md` §2.

Check: open the page over https, the header must reach `LENS WAITING` or `ROOM …` with
`ENGINE APPLE METAL-3 / D3D12 / …` (not `CPU (WASM)`), and the console shows no 404.

## Step 6 — the lens (four values, then one flag)

In `Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts`:

```ts
WEB_RELAY_URL: "wss://<ref>.snapcloud.dev/realtime/v1/websocket",
WEB_RELAY_KEY: "<anon>",
MEMORY_BACKEND: true,
MEMORY_BACKEND_URL: "https://<ref>.snapcloud.dev",
MEMORY_BACKEND_KEY: "<anon>",
```

Then, because the relay is now `wss://` and no plain `ws://` LAN endpoint is used, the project's
**Experimental APIs** flag can be turned off (Lens Studio → Project Settings; it was only needed for
the local `ws://` relay). Build and send the lens to the glasses.

Never commit these keys: this repository is public. `python3 web/lens_key.py --clear` before every
commit; the values live only in the release bundle and the local lens build.

## Step 7 — smoke test (2 minutes, with the glasses)

1. Put on the glasses, open the lens, scan the room, finish with DONE SCANNING.
2. The board header shows `PIN NNNN`.
3. On a laptop with WebGPU, open the deployed page, type the PIN → header `ROOM FLY-NNNN`,
   `LENS CONNECTED`; the board header on the glasses reads `BRAIN: ON YOUR WEB PAGE` and the page's header pill `PAGE ON`.
4. The room panel on the page fills with the scanned mesh and the named things.
5. Open `app.html?tab=training` on the page and start a session (FOOD is the simplest). When it ends, the page's session strip
   shows the conclusions, and in Supabase → Table Editor → `fly_memory` a row with your (hashed)
   user id appears; saving a version from the page adds a row in `fly_brain_versions`.

## If something fails

| symptom | cause | fix |
|---|---|---|
| `FAIL that looks like a service-role key` | wrong key copied | use the anon public key |
| Realtime join FAIL / `phx_reply status error` | "Private channels only" enabled, or a typo in the ref | disable it under Realtime → Settings; re-check the ref |
| tables FAIL: relation does not exist | Step 3 not run | run `check_supabase.py --create` and paste the SQL |
| policy FAIL: foreign row listable | policies edited by hand | re-run the generated SQL (drop the policies first if they were renamed) |
| page: `ENGINE CPU (WASM)` | no WebGPU in this browser / not https | Chrome/Edge 113+, https; Opera needs `opera://flags/#enable-unsafe-webgpu` |
| page: `NO GLASSES FOUND FOR PIN nnnn` | the lens is on another relay (LAN) or the PIN is stale | Step 6 values in the lens; read the PIN from the board header |
| lens: `BRAIN OFFLINE` and no page | expected without a page on the glasses (no page, no brain) | open the page with the PIN |
| `MEMORY_BACKEND_PUSH` never logs | `MEMORY_BACKEND` false, or the lens build predates the keys | set the five values and rebuild |

Security note, plainly: with only the anon key the database cannot prove who is asking; the user id
(random, never displayed) is the secret that protects a row. For a public launch, enable Supabase
Auth anonymous sign-in and change the policies to `auth.uid()`; `web/DEPLOY.md` §1b shows the exact
policy lines to swap.

## Agent runbook (copy, run in order, stop at the first FAIL)

```bash
# 0. you need: <ref> and <anon> from the dashboard (Steps 1 and 3 are dashboard clicks)
cd "<repo>"
python3 web/check_supabase.py --create            # paste this SQL into the Supabase SQL editor, Run
python3 web/check_supabase.py <ref> <anon>        # all PASS? if not, see "If something fails"
web/release.sh --sb <ref> --key <anon>            # builds web/site/
(cd web/site && python3 -m http.server 8798)      # local check: http://localhost:8798/ loads, no 404 in the console
# upload web/site/ to the host; put brain_c0.flyb.z next to index.html on the host
# edit Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts: the five values from Step 6
# Lens Studio: Project Settings -> Experimental APIs off; build; send to the glasses
# Step 7 smoke test with a person wearing the glasses
```

Files this touches: `web/check_supabase.py`, `web/release.sh`, `web/site/` (generated, not in git),
`Spectacles-5.15/Assets/Scripts/Fly/FlyConfig.ts`. Nothing else needs a change.
