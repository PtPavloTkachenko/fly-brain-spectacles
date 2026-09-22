# CyberFly web twin — the design system

The page is the lens's board at laptop resolution. It borrows the board's language (electric blue
plates, cyan frame lines, the fly's colour as the accent, the same captions) and adds only what a
screen can carry that the glasses cannot. Every rule below is a token in `style.css`; **if a change
needs a value that is not here, add it here first.**

Two files wear this system: `app.html` (the instrument) and `index.html` (the landing, which loads
`style.css` first and then `site.css` for reading layout only).

## 1. Spacing — a 4-pt base on an 8-pt rhythm

| token | px | used for |
|---|---|---|
| `--s0` | 2 | inside a chip, a marker, a 10-px control |
| `--s1` | 4 | between a label and its bar, a stat-grid gutter |
| `--s1h` | 6 | a dense stat cell's inset |
| `--s2` | 8 | the gutter between panels, the dense plate padding |
| `--s3` | 12 | panel padding, the stage's inset furniture |
| `--s4` | 16 | between groups inside a panel |
| `--s5` | 24 | the help card's padding |
| `--s6` | 32 | the gate card's padding |

Nothing uses a raw pixel gap. Panel padding is `--s3` on every side, `--s2` on every side when the
window is short — **density is spacing, never type size** (see §2). The grid gutter is `--s2`.

The two sub-4 steps are not an exception to the grid, they are the base of it: a 10-px chip cannot
carry a 4-px inset, and pretending otherwise is how a "grid" grows fifteen off-grid literals.

## 2. Type — five roles, and no sixth

| role | token | size / weight / line | tracking | used for |
|---|---|---|---|---|
| display | `--t-display` | 19 / 600 / 1.1 | .04em | the one big value in a panel (ACTION, the verdict) |
| title | `--t-title` | 11 / 600 / 1.2 | .20em, uppercase | panel captions, the stage caption, the help heading |
| label | `--t-label` | 10 / 400 / 1.3 | .16em, uppercase | keys, chips, legend, row names, footnotes |
| | `--t-label-sm` | 9 / 400 / 1.3 | .16em, uppercase | the same role one step down: stage footnotes, hop rows |
| data | `--t-data` | 13 / 400 / 1.2 | .04em, **tabular** | every measured number |
| prose | `--t-prose` | 12 / 400 / 1.5 | 0 | a paragraph inside a panel: what a thing is, why, what next |

Two honest one-offs, declared so they are part of the contract instead of exceptions to it:
`--t-brand` (13/600/.26em — the page's own name) and `--t-pin` (26/.38em — the four digits, the one
thing anyone types).

**A role is never overridden with a bare `font-size`.** The old file carried 45 raw `font-size`
declarations, 14 of them cancelling a role on the very next property, which is how a page with four
declared roles came to render seven sizes and six trackings. Prose was the missing role: it existed
in thirteen places as `font: var(--t-data); font-size: 12px`.

`font-variant-numeric: tabular-nums` is set on `body`, so every digit is the same width and columns
of numbers line up without being told to. Data carries `--tr-data` **everywhere** — a value in a
stat cell and a value in a NEURAL row are the same role and are tracked the same.

Prose is capped at **74 ch**. A 96-character line of 12-px mono is a wall, not a paragraph.

## 3. Colour — tokens, and the contrast they are chosen for

Every text token is **>= 4.5:1 on `--plate-bg` (#0b1b25)**, measured, so all body text is WCAG AA.
`--line`, `--line-2` and `--line-hot` are **never** used for text.

| token | hex | contrast | used for |
|---|---|---|---|
| `--text` | #cfeaf3 | 14.0 | values, prose |
| `--cyan` | #5fd8f5 | 10.5 | the second half of a caption, active chrome, card headings, glossary terms |
| `--cyan-dim` | #4e8ea1 | 4.8 | the first half of a caption |
| `--dim` | #6a909d | 5.1 | keys, labels |
| `--dimmer` | #5c96a6 | 5.3 | footnotes on the stage |
| `--gold` | #ffcf5a | 12.0 | the user (YOU), US ticks, the DEMO chip |
| `--warn` | #ff8a5c | 7.6 | a refusal, an unsaved change |
| `--accent` | the selected fly's colour | — | **the only saturated accent outside the brain** |
| `--accent-ink` | #02090c | — | the ink printed ON an accent or cyan fill |

All five flies are tokens (`--fly0`..`--fly4`), because `app.js` has always had five.

**Accent discipline.** One saturated colour on the page at a time: the selected fly's, and only on
things that are **live or measured** — bars, the live value, the pinned state, the training verdict,
the session banners. Chrome that merely names something (a card heading, a glossary term, a step
number, a tab's on-state) takes `--cyan`. An accent on fifteen glossary terms is an accent on
nothing. The 13 **class colours** live only in the brain, its legend and the 4-px swatch that ties a
NEURAL row to its class — never as a fill anywhere else.

**Filled states print `--accent-ink`, not a hand-picked dark.** The old `#05161c` measured 6.4:1 on
the magenta fly and 5.3:1 on the violet one, which is thin for 10-px tracked uppercase.

## 4. Panel chrome — one of each

Every panel is a `.plate`: 1 px `--line` border, two **13 px** corner brackets in `--line-hot`
(one size, everywhere — the stage, the gate and the phone card used to invent 16 and 20), padding
`--s3`, and a `.cap` header of **title** + a right-hand status in **label**, with a hairline divider
under it. No panel invents its own header, padding or divider.

- **Two hairlines, not five.** `--line` is a panel edge; `--line-2` is every inner box (stat cells,
  teaching cards, version rows, the raster's rule). The old file had `#0f313d`, `#ffffff14`,
  `#ffffff12`, `#ffffff1f` and `#2a4b58` doing the same job.
- **The header is one line, at every width.** The title takes the room it needs and the status gives
  way; the status wraps to its own row **only in the panels where the two genuinely do not fit**,
  not at every width below a breakpoint. Neither is ever covered.
- **Bars** are 3 px, track `--track`, fill `--accent` with a 4 px glow. One height everywhere.
  A bar is **always visible at 0** — a track you cannot see turns "empty" into "absent".
  A bar and a label **never share a lane**: the text owns the top of the row, the bar owns the
  bottom, with real space between them.
- **A bar is drawn with `transform: scaleX()`**, never a percentage `width`. See §9.
- **Chips** (`.chip`, `.lg`, `.vw`, `.iv`, `.tb`) are `--s0 --s2`, 1 px border, **label** type, and
  `height: auto` — the gate's 44-px button height is for form controls only.
- **Stat cells are two columns, in every panel, at every density**, so every value in a column
  right-aligns to one of exactly two edges. `.st .k` **wraps**; it never ellipsises, because a
  clipped key costs the reader the one thing that says what the number is.
- **Class swatches are 4 px**, everywhere.

## 5. States — every control has all four

`rest` → `hover` (colour to `--cyan` or the class colour, border to `--line-hot`) →
`focus-visible` (2 px `--focus` outline, offset 2) → `active` (**1 px down, 1.18 brightness** — one
treatment, applied to every control class) → `on` (filled, text `--accent-ink`).
Disabled is 45 % opacity and `cursor: default`.

Everything reachable by pointer is reachable by Tab, and the brain also takes arrow keys. A control
that behaves like a button **is** a `<button>` — the two stage banners were divs with
`role="button"` and a click listener, which is focusable and keyboard-dead.

`outline: none` on a `:focus` rule beats the page's own `:focus-visible` on specificity. It is not
used. Form controls declare `:focus-visible` themselves and keep the ring.

A modal takes focus when it opens, traps Tab, and hands focus back to whatever opened it.

## 6. Motion — one vocabulary, as tokens

`--ease: cubic-bezier(.16, 1, .3, 1)` · `--dur-hover: .2s` · `--dur-panel: .28s` ·
`--dur-enter: .42s`. Staggered 55 ms per panel on first paint. Idle life (breathing, spin, pulses)
is real but slow. **`prefers-reduced-motion: reduce` turns all of it off** and the page still says
everything.

**Nothing switches with `display`.** Two surfaces that replace each other share a grid cell and
cross-fade — including the two tabs, which were the page's primary navigation and the one thing on
it that hard-cut. A surface that hides itself keeps `visibility` **in its transition list**, or the
exit is a cut no matter what the opacity does.

Two things that do the same job animate the same way: the two stage banners are one box with two
messages, not one that slides and one that blinks.

## 7. Layout

Three columns — 300 / 1fr / 372 at 1280-1900, 360 / 1fr / 440 to 2300, 420 / 1fr / 520 beyond —
plus a bottom row that opens only for a training session. The header row is `minmax(46px, auto)`: it
**grows a row** when it has something to say. The stage is the composition's centre and keeps the
largest area at every width.

A column that cannot fit its numbers **scrolls, and says so** — a fade and a `MORE BELOW ▾` in the
corner. It never clips one away, and it never hides one silently either: an overlay scrollbar is
invisible at rest, so "it scrolls" was the same as "it is gone".

The gate card breathes with the window (`clamp(520px, 46vw, 820px)`) like the columns do.

**The stage's top strip is one flex row** — title, then the presets, then a banner on its own line
underneath. Nothing on the stage is positioned over anything else that carries words.

## 8. Honesty labels are part of the design

Any number that is a display choice (exposure, hop time, the bloom, the detail rung) says so on
screen, next to itself, in **label-sm**. Inferred data is drawn dimmer and counted. This is not
decoration and it does not get removed to make room.

**An empty panel says what it is waiting for and what starts it** — in prose, not as an em-dash.
Twelve rows of "0.0" under a "waiting…" line are twelve numbers that look measured and are not: the
empty state **replaces** the rows, it does not sit under them. A strip with no session collapses
rather than showing seven placeholders above the panel that explains them.

## 9. Cost — a value drawn sixty times a second must not cost a layout

The page draws a whole connectome; its chrome has no right to a millisecond.

- **Never animate a percentage `width`** on a positioned element. Twelve NEURAL bars did, which is
  a layout per bar per frame. Bars scale a full-width fill with `transform`.
- **Every per-frame write is diff-cached** (`setText` / `setStyle` in `gfx/motion.js`, and the same
  discipline inside the canvas views). Quantise the value so the string only changes when the drawn
  pixel could change.
- **Panels rebuild on change, not per frame.** A function that answers the same six facts sixty
  times a second answers them once, behind a key.
- **What is not on screen is not drawn.** The two tabs share a cell now, so the brain's draw is
  gated on its own tab being the visible one.

Measured at 1440 on the BRAIN tab, 8 s windows, brain pinned to the same detail rung:

| | before | after |
|---|---|---|
| layouts / s | 75 | 59 |
| style recalcs / s | 182 | 126 |
| layout + style, share of wall time | 5.6 % | 3.3 % |
| `.mk` label writes / s | 315 | 109 |

The numbers are the rule's reason; keep them in this file when they change. Still open: the canvas
views read `clientWidth` in the same frame they write styles, which forces a layout flush per frame
— `RoomView` now caches one read per frame, `EyesView` and `Raster` do not yet.
