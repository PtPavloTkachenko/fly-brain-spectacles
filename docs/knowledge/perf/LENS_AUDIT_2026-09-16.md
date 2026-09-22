# CyberFly lens UI — polish audit (16.09, LS 5.23)

> **Status after the fix pass (same session).** Items **1–19, 21–25** are APPLIED and compiling
> (`RecompileTypeScriptTool: succeeded`); the start card is verified in **C2** (same call as C1).
> Left open on purpose: **20** (guide occluder = +1 draw), **26** (additive corner caps = a look
> call), **12's** space reclaim, and the two FlySwarm-side allocations, which are not my files.
> C1 → C2 diff on the start card: corner caps 4.0 → 2.35 cm and the header tab 10 → 5.9 cm (the frame
> is proportional now), the provenance line went from `MalwCNS v1.0 connuctumu // 188,700 nuurunx`
> to legible, and `FlyStart.worldScale` went 1.0 → 0.85 (queried live).


Scope: `Spectacles-5.15/Assets/Scripts/Fly/{FlyBoard,FlyStart,FlyScan,FlyGuide,UIBatch,UICard,FlyMotion}.ts`
plus the copy that `FlyTrainer.ts` publishes into the guide. Judged against
a UI-polish checklist (five laws + sweeps; a working note, not in this repo) and ADR 58/59/66/69/71/73.

## Captures referenced

| id | how to reproduce |
|---|---|
| **C1** | `CaptureRuntimeViewTool { uniqueIds:[<FlyStart>], viewAngle:"front", detail:"high", isolate:true, previewName:"Preview 1" }` — the start card, 1024×768, card spans y 128…640 |

The board, the guide and the scan card are **not capturable without driving the preview** (the intro
waits on a DONE SCANNING press; LEAF and `PreviewInteractTool` were off limits for this pass). Those
items are measured from the layout arithmetic, which is given per item so it can be checked.

Measurement constant used throughout: batched-text cap height `cm = scale × BOARD_TEXT_SCALE(1.15) ×
BOARD_LINE_CM(1.55) × BOARD_TEXT_CAP(0.7) = scale × 1.248`; from C1 the advance is
**0.754 cm of width per character per cm of cap** → **≈0.40 cm/char at T_SMALL 0.42**, 0.43 at 0.46.

---

# TOP 10

### 1. A 4.7 s hole between SOLO and the scan card — the worst hard cut in the lens
*Law 1 (no hard cuts) · §3 (mask latency with ceremony).*
`FlyStart.choose()` writes `"STARTING"` / `"JOINING …"` into `this.note` and then calls `this.hide()`
**on the same line** — the note is never read. The scan card only appears when Sync Kit's session is
ready, which the 15.09 LEAF run measured at **4.97 s after SOLO** (`TESTING.md`, `start_to_board`).
So: press → 0.25 s slip-out → ~4.7 s of empty air → card pops.
*Files:* `FlyStart.choose/hide`, `FlyBoard.showScan`.
*Fix:* the card stays up and becomes the loading screen — the chosen key stays lit, the other dims,
the keys' hit boxes go off, the note types the live state and a 2-quad bar sweeps under it;
`FlyBoard.showScan()` already hides the start card, so it owns the handoff. Needs a `tick(dt)` on
`FlyStart`, driven from `FlyBoard.setScan()` (already called every intro frame).
*Cost:* +2 quads in the card's existing batch, 0 draw calls, ~6 `ui.set` per 15 Hz tick.

### 2. The guide's whole text mesh is rebuilt once per second for the entire session
*§12 (polish costs zero frames) · ADR 69 (draw-and-RAM bound).*
`FlyGuide.keyOf()` puts `t.elapsed` (integer seconds) in the rebuild key, and the header /
lesson step line render `clockOf(tr.elapsed)` into the batched mesh. A FOOD session ran **196 s**
(TESTING.md) → ~196 full `TextBatch` rebuilds (begin + ~40 `add` + hash + `updateMesh`) of a card
carrying several hundred glyphs. On top of that `keyOf` **allocates a concatenated string every
frame**, including `t.lesson.options.map(…).join(",")` (array + string per frame) — ADR 39 forbids
exactly this.
*Files:* `FlyGuide.keyOf/rebuild/set`.
*Fix:* the clock leaves the mesh and lives in its own small mono `Text` in the header; the rebuild
key drops `elapsed`; `keyOf` is replaced by a zero-allocation scalar comparison.
*Cost:* +1 `Component.Text` (the guide already has one live Text), −195 mesh rebuilds per session,
−1 string/frame.

### 3. ASK and TEACH each cost their own draw call, because they are built lazily
*§12 · ADR 69.* `COMPONENTS.md` lists `AskNeon` and `LearnNeon` as separate `RenderMeshVisual`s:
`showAskButton` / `showLearnButton` build their key **after** `BoardNeon` has flushed, so the quads
cannot join it ("a lazily created key cannot join an already-flushed NeonBatch").
*Files:* `FlyBoard.showAskButton/showLearnButton`, `FlyBoard` constructor.
*Fix:* build both keys in the constructor with `sink = this.ui`, hidden (`visible:false`,
`so.enabled=false`); the show/hide methods only toggle visibility.
*Cost:* **−2 draw calls** (22 → 20 enabled visuals), +12 quads inside the existing board mesh.

### 4. The board hard-cuts out of view
*Law 1.* `update()`: `s = BOARD_SCALE × (0.6 + 0.4·shown)` and `content.enabled = revealed && shown >
0.02`. Looking away shrinks the board to **0.6 × BOARD_SCALE and then it vanishes** — a 60 %-size pop
to nothing, every time the head turns past `BOARD_VIEW_COS` (0.5).
*Files:* `FlyBoard.update` (the `shown`/`s` block).
*Fix:* keep 0.6→1.0 over the useful range but collapse the last 25 % of `shown` to zero
(`s *= min(1, shown/0.25)`), so the disable lands at scale ≈0.
*Cost:* one multiply per frame.

### 5. Everything is 18 % bigger before DONE SCANNING than after
`update()` returns at `if (!on) return` before any transform is written, and `shownScale` starts at
−1, so the `FlyBoard` root sits at **scale 1.0** while the start and scan cards are up, then snaps to
`BOARD_SCALE = 0.85` at reveal. Confirmed live: `FlyStart.worldScale = {1,1,1}`.
*Files:* `FlyBoard.update`.
*Fix:* write the root scale once before the early return.

### 6. `T_SMALL 0.42` is below the legibility floor, and is only 9 % from `T_CAPTION`
*§13 (hi-res or you're guessing) · §3 (one type hierarchy).*
**C1 @ (185,350,660,22)** — the line `MaleCNS v1.0 connectome // 166,700 neurons // fly-wirehead`
renders as `MalwCNS v1.0 connuctumu // 188,700 nuurunx // fly-wirwhwad`: the MSDF breaks down at cap
0.52 cm while `a real fly brain on your Specs` (0.56 → cap 0.70 cm) directly above it is crisp. On the
additive display this tier is worse, not better. Six tiers with a 9 % step (0.46 vs 0.42) is not a
hierarchy.
*Files:* the `T_SMALL` / `T_CAPTION` constants in `FlyBoard`, `FlyGuide`, `FlyStart`, `FlyScan`.
*Fix:* collapse to **five tiers**, smallest 0.46 — paired with item 7 so the wider lines still fit.

### 7. Guide copy overflows the card, and is not measured
*ADR 71 put `fitText` in exactly for this; the `TEACH` block bypasses it.*
The guide's text column is `CARD_W − 3.0 = 24 cm`. At T_SMALL these `TEACH` lines exceed it:
`its mushroom body links what it sees and smells there to the outcome` (68 ch ≈ 27 cm),
`3  landing = a dopamine reward pulse (PAM). repeat two or three times` (69 ch ≈ 27.5 cm),
`fades in about 30 minutes. LEARNING off freezes it, RESET wipes it` (66 ch ≈ 26 cm).
They are drawn with the raw `st()`, so nothing warns and nothing wraps — they run off the plate.
*Files:* `FlyGuide.TEACH`, `FlyGuide.rebuild` (the `else if (learning)` branch).
*Fix:* every line ≤ 53 characters, and route the block through `this.fit(...)` so a later edit warns
instead of sliding off. Exact new strings in §"Copy" below — the meaning (what it can learn / the four
steps of a food place / the danger place / the memory) is kept intact.

### 8. Two "live" feedback pulses are dead code — ASK never animates while it listens
*Law 2 (every input answers).* `showScanButton`/`showAskButton` both set
`ui.set(this.scanBtn|askBtn, {visible:false})` because the kit key draws its own plate, but
`update()` still guards its pulses on `this.ui.get(this.askBtn).visible` — **always false**. So
`setAskLabel(s, live=true)` changes the words to `LISTENING…` and nothing moves; the same for the
DONE SCANNING invite pulse.
*Files:* `FlyBoard.update` (lines ~1090–1097), `FlyBoard.setAskLabel`.
*Fix:* delete the two orphan quads, give `kitButton` a `live(k)` setter that raises the key's own idle
level, and drive it from the data tick while `askLive`.

### 9. Two pulses fire on a clock, not on a change — they read as a tic
*§4 (attention micro-pulses), §2 (randomize the periodic).*
- `FlyScan.tick`: the counter string is `"<n> S  //  <m> FOUND"`, so it changes **every second**, and
  `Anim.pulse("scan.count", …)` fires every second for the whole scan once `found > 0`.
- `FlyGuide.set`: `instruction` carries a countdown (`"TRIAL 1 / 3  //  12s"`), so the live line
  pulses on **every data tick** for the whole ~200 s session.
*Fix:* pulse only when the meaningful part changes (`found` for the scan card; the text before the
last `//` for the guide).

### 10. The `?` hint is one-way, and a fast double-toggle can hide the guide with `shown === true`
*Law 2 · §11 (interruptibility).*
- `guide.onDismiss = () => { this.guideHint.textFill.color = TXT }` — once dismissed the `?` stays lit
  forever, including while the guide is open; it also bypasses the `fill()` diff-cache.
- `FlyGuide.show(true)` enables the root and un-hides the quads **and then** calls `Anim.popIn`, which
  internally does `Anim.stop(key, land=true)` → the pending `slipOut`'s `done()` runs and re-disables
  the root and re-hides every quad. A quick `?`-`?` leaves the card invisible while `this.shown` is
  `true`, so the next press is a no-op.
*Files:* `FlyBoard` (`GuideHit` handler, `guide.onDismiss`), `FlyGuide.show`.
*Fix:* drive the hint colour from `guide.visible` through `fill()`; guard the `done` callbacks with a
sequence token.

---

# The rest, ranked

### 11. The corner-bracket frame does not scale with the card
`addFrame` uses absolute `cap = 4.0`, header tab 10 cm, echo 6 cm, clip tick 2.4 for every plate:
the board (50×46), start (36×27), scan (36×24), guide (27×45). On the guide the "header tab" is 37 %
of the card width vs 20 % on the board; **C1 @ (0,120,1024,80)** shows the corner caps eating a third
of the start card's top edge. One visual language (§3) means the same *proportions*, not the same
centimetres. *Fix:* `cap`/tab/echo × `clamp(min(w,h)/46, 0.6, 1)` — the board is unchanged.

### 12. With `FLY_COUNT = 1` the tab strip is one 24.2 cm-wide control that selects the only fly
`pitch = (VAL_X − RX)/FLY_COUNT = 24.8`. A full-width tab plate plus a `1` that can never change.
*Fix:* hide the tab quad, its number and its hit box when `FLY_COUNT === 1` (the header already names
the fly). Reclaiming the 1.9 cm for the right column is a follow-up — it shifts 12 rows and I cannot
see the board to judge it.

### 13. `NEURAL // MEASURED SPIKES, HZ` promises numbers that are not drawn
`BOARD_ROW_VALUES: false` (commit *"Drop the row Hz texts"*) — there are no Hz values on the NEURAL
rows any more. *Fix:* `NEURAL  //  MEASURED SPIKES`.

### 14. The row hover highlight does not cover the row
Hit strip: x −1 … 25 (`W/2 − RX` wide). Highlight quad `hl`: x −1.2 … 9.7 (label only). Hovering the
bar or the value lights a backdrop that is nowhere near the cursor. *Fix:* widen `hl` to the hit strip.

### 15. Header collision risk with the long fly names
`"FLY 1  ZIGGY"` at T_TITLE from x −14 ends at ≈ +6; `WEB PIN 8812` is right-aligned to 11.5
and starts at ≈ +5.3. *Fix:* with one fly the header is the name alone.

### 16. The PIN is printed three times
Header (`WEB PIN 8812`), footer (`| web pin 8812`), guide live line (`WEB PIN 8812`). ADR 59's own
rule is one clear place. *Fix:* drop it from the footer (the header is the one Pavlo asked for).

### 17. `this.thought.text` is the one Text write with no diff-guard
Written on every 15 Hz data tick while the narrator types; `Math.floor(thoughtShown)` is unchanged on
most ticks, so an identical string re-tessellates the glyphs. Every other board Text is guarded.
*Fix:* cache the last written string.

### 18. The guide's step blocks group the wrong way
Lines sit at `0 / −1.9 / −3.3` inside a `STEP_PITCH 5.0` group → internal pitch 1.9 and 1.4, gap to
the next group **1.7**. The second line is further from its own title than from the next step's.
*Fix:* `0 / −1.6 / −2.9` → group gap 2.1 > internal 1.6.

### 19. A refused TEACH press says nothing at the moment of the press, and the refused key looks armed
`FlyBoard.teach()` returns early with no signal; the hint under the key already carries the reason
(`TEACHING NEEDS THE WEB BRAIN // open the page, PIN 1234`) but it is static, and the key's plate is
at `BTN_IDLE` — identical to a live key. *Fix:* the refused key idles dim, and a refused press pulses
the hint line.

### 20. The guide card has no occluder; the board has one
`makeOccluder` is built into `Content` at the board's size only. Flies and the world mesh draw through
the 27×45 guide. *Left open on purpose:* a depth-only quad is +1 draw call and the brief is zero.

### 21. The TEACH hint is a 76–85 character line at the smallest tier, unplated, outside the frame
`LEARN_HINT_ON` is 85 characters at T_SMALL, right-aligned at x 24.5 / y 24.5 — i.e. **above the
board's top frame**, over the room, with no plate behind it. *Fix:* ≤ 53 characters (below).

### 22. The start card has no idle life
*Law 3.* It is a completely static frame for as long as the user reads it. The scan card at least has
its chevron sweep. *Fix:* a slow bell on the accent quads `addFrame` already returns (`brackets`),
driven from the new `tick()` — 12 `ui.set` per 15 Hz tick, zero draws.

### 23. DONE SCANNING is a primary key from t = 0 s
Pressing it immediately gives an unscanned room, and the guide's step 1 says *"look around slowly,
then press DONE SCANNING"*. *Fix* (never gate a tap, §3): the key idles **secondary** until surfaces
or a Gemini hit arrive, then lifts to primary with one flash — the same two-phase live-signal rule the
instruction line already follows.

### 24. `FlyScan` marks 5 quads dirty and calls `updateMesh()` every frame
The chevron intensity is a continuous cosine, so `NeonBatch.set`'s change check never skips.
*Fix:* quantise to 0.05 — most frames then skip the upload entirely.

### 25. `kitButton`'s press flash cuts its colour at t = 0.5
`setPlate(idle() + 0.9·bell(t), t < 0.5 ? WHITE : PLATE)` — a hard WHITE→PLATE switch in the middle of
a 0.25 s flash. *Fix:* lerp the colour on the same `bell(t)` that drives the intensity. (A press
depress in Z is the remaining §4 gap; left out because it means re-writing 6 quad rects per frame.)

### 26. Additive corner caps sit **on** the outer line, so every corner is ~2.7× the line's brightness
`addFrame` draws the accent caps at z 0.05 over a line already at 0.9 with `BlendMode.Add`. The ADR
says "overlay"; additively that is "add". Visible in **C1 @ (0,120,120,80)**. Judgement call for
Pavlo — on the glasses these become the brightest thing on the card. Not changed.

### 27. Dead / guarded-dead code worth knowing about
`makeRetina` / `uploadRetina` / `setRetina` / `this.eyes` are unreachable while
`RETINA_EYES && EYE_PANEL` (both true) — kept, they are the other config's path.
`showScanButton` returns immediately (`if (this.scan) return`) and `scanHit`/`scanLabel`/`scanKit`
are unreachable — kept, called from `FlySwarm`. `INK` is unused. The `scanBtn`/`askBtn` quads are
removed as part of item 8.

---

# Copy — the exact cuts

The brief: the guide must still say how to teach. Meaning kept, length cut to the 24 cm column
(≤ 53 characters at the new T_SMALL 0.46).

**`FlyGuide.TEACH`** (13 lines, 3 of them currently off the plate):
```
WHAT IT CAN LEARN
a thing in your room can come to mean food, or danger
its mushroom body ties the smell to what happened
TEACH IT A FOOD PLACE
1  ASK A FLY: "find my cup" - Gemini marks it
2  it flies there on its own brain and lands
3  landing = a reward pulse (PAM). repeat twice
4  it then goes sooner, and from further away
TEACH IT A DANGER PLACE
rush a hand at it as it feeds there: the loom fires
PPL101, the stress dopamine, and the place turns bad
MEMORY
fades in ~30 min. LEARNING off freezes it; RESET wipes
```

**`FlyBoard.LEARN_HINT_OFF`**
`turns learning on: ASK it to find a thing; landing there = a dopamine reward` (76)
→ `ASK it to find a thing; landing there = a reward pulse` (53)

**`FlyBoard.LEARN_HINT_ON`**
`learning: each rewarded landing rewires its mushroom body; the memory fades in ~30 min` (85)
→ `each rewarded landing rewires it; fades in ~30 min` (49)

**`FlyBoard` footer** — drop the duplicated PIN, shorten the memory field:
`sim 1.2 s | step 114 ms | MaleCNS v1.0 LIF | memory learning 94.3% | web pin 8812`
→ `sim 1.2 s | step 114 ms | MaleCNS v1.0 LIF | mem 94.3%`

**`FlyBoard`** `NEURAL  //  MEASURED SPIKES, HZ` → `NEURAL  //  MEASURED SPIKES` (item 13).

**`FlyStart`** note copy, now that the card stays up as the loading screen:
`STARTING` → `STARTING  //  waking the brain`, `JOINING  //  map the room with your friends` kept,
plus a named 8 s watchdog line `STILL CONNECTING  //  this can take a moment`.

---

# Not changed — for Pavlo

- **Item 26** (additive corner caps ≈2.7× the line) is a look decision.
- **Item 20** (guide occluder) costs a draw call.
- **Item 12's** space reclaim (moving the NEURAL block up 2.2 cm) needs the board on screen to judge.
- The ASK / TEACH keys float above the board's frame with no plate joining them to it
  (`SCAN_BTN_Y = H/2 + 5`); the top zone is the least resolved part of the dashboard. Design call.
