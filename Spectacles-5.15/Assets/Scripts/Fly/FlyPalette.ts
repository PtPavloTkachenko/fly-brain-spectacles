/**
 * FlyPalette — ONE set of colours for every card the lens draws.
 *
 * 20.09 Pavlo: "кольори на вебсайті взяти для кольорів панелей" — take the website's colours for
 * the panels. They were already close, because both were drawn to the same taste, but they were
 * five copy-pasted blocks (FlyBoard, FlyBoot, FlyScan, FlyGuide, FlyStart) with no single source,
 * so any change had to be made five times and one of them would be missed.
 *
 * THE ONE RULE THAT STOPS THIS BEING A COPY-PASTE OF web/style.css: the glasses are an ADDITIVE
 * display. Black is not dark, it is TRANSPARENT, and a colour is added to whatever the wearer is
 * already looking at. So a value that reads as "dim" in a browser reads as "invisible" on a lit
 * wall. Where the website's value is already bright enough it is used exactly; where it is a dark-
 * background value it is LIFTED, and the comment says by how much and why. Nothing here is a guess
 * at what the site does — each line carries the hex it came from.
 *
 * sRGB hex -> linear-ish 0..1 is deliberately NOT gamma-corrected: these feed vertex colours on
 * unlit additive materials, where the existing cards were authored by eye against the same site.
 *
 * THE RULE IS ONE-DIRECTIONAL. Unifying five copies may never cost light: where the site's value
 * would be DIMMER — or harder to tell apart from its neighbour — than what a card already drew, the
 * CARD's value is what this file carries, and the line says by how much and why. Four lines below
 * are such lines (FRAME, LIVE, OFF, BODY); the rest are the site's, exactly.
 *
 * Imported by the five cards and nothing else: FlyBoard, FlyBoot, FlyScan, FlyGuide, FlyStart.
 * The flies' own colours stay where they are (FlyConfig.FLY_COLORS) — those are identities, not ink.
 */

/** --cyan: the frame, the rules, anything that says "this is the instrument". NOT the site's #5fd8f5
 *  = (0.373, 0.847, 0.961): that is 1.9 % less light and a whiter, less cyan line. The frame is drawn
 *  down to 0.18 intensity (the bar tracks, the rules), and a line that thin is the last thing allowed
 *  to lose brightness on glass, so the cards' cyan is what all five keep. */
export const FRAME = new vec4(0.25, 0.9, 1.0, 1)

/** #cfeaf3 --text, lifted to 0.95+ green/blue: primary text. On additive glass the site's exact
 *  value loses its edge against a bright room, and text is the one thing that may never be soft. */
export const TXT = new vec4(0.86, 0.95, 1.0, 1)

/** #4e8ea1 --cyan-dim is a CAPTION colour on a near-black page (4.7:1 there). Straight onto glass
 *  it disappears, so it is lifted about 1.4x to the value the cards have used since 15.09. */
export const TXT2 = new vec4(0.45, 0.74, 0.86, 1)

/** #6a909d --dim: labels and settled rows. The site's value is already bright enough to survive
 *  the additive display, so this one is used as it is. */
export const DIM = new vec4(0.416, 0.565, 0.616, 1)

/** Pavlo's own plate, 15.09: saturated, solid corner to corner. NOT the site's --plate-bg
 *  (#0b1b25) — a dark plate on an additive display is simply not there. Do not "fix" this to
 *  match the website; the website has a background to sit on and the glasses do not.
 *  12.09 Pavlo, the look it is going for: the device body reads as TINTED GLASS, not a colourless
 *  sheet — and ONE flat fill, no gradient ("I'd fill it with a solid colour, less noise"). */
export const PLATE = new vec4(0.08, 0.36, 0.70, 1)

/** text on a lit plate: the selected tab, DONE */
export const WHITE = new vec4(1, 1, 1, 1)

/** alive, connected, this is working. NOT the site's --fly0 #33ff73 = (0.2, 1.0, 0.451): that is
 *  8.3 % less light AND a pure green, and LIVE's job is a label on a LIT plate immediately next to
 *  WHITE (FlyBoard's TEACH THE FLY / LEARNING ON, FlyBoot's DONE lamp). On that plate the mint's
 *  whiteness is the whole difference between "on" and "off" — a saturated green reads as neither.
 *  Keeping the mint also keeps LIVE (a status) distinct from FlyConfig.FLY_COLORS[0] (the fly's own
 *  accent, the TRAINING banner): two meanings that should not collapse into one green. */
export const LIVE = new vec4(0.45, 1.0, 0.7, 1)

/** #ffcf5a --gold: waiting, not yet, hold on. The site's value and the cards' value already agreed
 *  to two decimal places — kept exactly as the site has it. */
export const WAIT = new vec4(1.0, 0.812, 0.353, 1)

/** off, failed, refused. The cards used a flat red (1, .38, .38) and the site's --warn #ff8a5c
 *  = (1.0, 0.541, 0.361) is 22 % brighter — a win on glass, and it separates from LIVE's green better
 *  than red did. But --warn as it stands lands on top of WAIT: same red, same blue, only green 0.54
 *  against 0.81. One text field carries the brain's state by colour alone (FlyBoard's header: NO BRAIN
 *  / BRAIN OFFLINE / BRAIN WAKING), and red-vs-gold was one glance where orange-vs-gold, at caption
 *  size, is not. So --warn is pulled back in green: still an orange, still ~9 % brighter than the old
 *  red, and the gap to WAIT is a gap again. */
export const OFF = new vec4(1.0, 0.45, 0.3, 1)

/** #16323d --track lifted: the unfilled part of a bar. It must read as a groove, not as ink. */
export const TRACK = new vec4(0.3, 0.55, 0.65, 1)

/** #9e6bff --fly4: Gemini's own colour, the one section that is not the fly's */
export const GEM = new vec4(0.62, 0.42, 1.0, 1)

/** the body section (its caption and the ENERGY / SPEED bars). The site's --fly3 #ffb833
 *  = (1.0, 0.722, 0.2) is a more saturated amber and 0.8 % less light — a hair, but the rule above is
 *  one-directional, so the cards' amber is what stays. */
export const BODY = new vec4(1.0, 0.72, 0.3, 1)

/** editor-only dark ink. INVISIBLE on the glasses by design — never use it on a device path. */
export const INK = new vec4(0.02, 0.06, 0.08, 1)
