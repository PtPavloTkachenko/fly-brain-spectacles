# Teaching the fly

The fly in front of you is not an animation. Its every move comes from a reconstructed fruit-fly
brain — 166,700 neurons, 25.6 million synapses — running live. Among those synapses are **7,835**
that connect the mushroom body's Kenyon cells to two of its output neurons. Those are the ones a
real fly changes when it learns, and they are the ones you can change here.

This page is the whole procedure. It takes about ten minutes and it is a real experiment, so it can
fail: the fly may simply refuse to go where you want it. That is not a bug. Nothing in this lens
pushes the fly around.

---

## What the fly can actually learn

One thing: **that a thing in your room means something**.

And here is the end result, in one sentence, because it is the point of everything below:

> **Pick up the cup and a trained fly comes and lands on it in your hand within seconds.
> A fly that has not been taught ignores it. A fly you taught the other way flees when you lift it.**

**Showing it a thing is a physical act.** Put your hand on the cup, or pick it up: hold it for half a
second and the dashboard says `SHOWING · CUP`. That is the fly smelling it — the thing's own smell
switches on, and while you hold it the smell goes where your hand goes, which is why a trained fly
can land on the cup *in your hand*. Put it down and the smell fades over about three seconds, the way
a smell does.

It cannot learn words, tricks, or your name. It has no gut, no language and no idea you exist.

---

## Where the teaching happens

**On the page, not on the glasses.** The glasses show you the fly; the page is where you teach it.

That is not a preference, it is arithmetic. On the glasses alone there is no brain at all (an earlier
build ran one there, and one 50 ms slice of the fly's brain cost a second or two of yours — a six-trial
session would have taken an hour of standing still). The page runs the same brain in about 100 ms per
slice: a session takes minutes, and the numbers mean something.

In the shipped build the dashboard has no TEACH key at all (`LESSON_ENABLED` is off: the fly learns
by itself, and the guided lesson and the on-glasses picker went with it). A session is started from
the page: open `app.html?tab=training` (the TRAINING tab is a hidden experiment tool, not offered in
the default tab strip), pick a session, the cue and the control from the things the room scan found,
the number of bouts, and press START SESSION. The page keeps your fly's brain versions and shows
every row as it lands; the lens runs the session and reports back.

## Before you start

1. **Scan the room.** Walk around until the scan card says DONE SCANNING. The fly needs surfaces to
   land on and the room scan needs to have found some things to use as cues.
2. **Let it find at least two things.** The dashboard's scan line counts them. One becomes the cue
   you teach; the second is the control the fly is never paid for. With only one thing the session
   still runs, but the result means less (see *Reading the result*).
3. **Open the page.** Type the PIN from the board on a laptop: the page is the fly's brain, and
   nothing moves until it is connected.

---

## Start a session

On the page's TRAINING tab (`app.html?tab=training`) there are seven sessions: FOOD, DANGER, FORGET,
TEST, CHOICE, TRANSFER, RESET. Pick one, choose the cue (CS+) and the control (CS−) from the scanned
things, set the bouts, press START SESSION; the guide card on the glasses follows the session and the
page's session strip shows every row. (A guided nine-step first lesson and an on-glasses picker exist
in the code and are switched off — `LESSON_ENABLED` — because the fly now learns by itself from what
happens to it; the sessions below are for running a real experiment on purpose.)

## The seven sessions

### FOOD — this thing means food

| | |
|---|---|
| **The cue (CS+)** | the thing you name |
| **The control (CS−)** | another thing the scan found, shown just as often, never paid |
| **The outcome (US)** | on landing, sixteen pulses of reward dopamine into the fly's 15 PAM11 cells |
| **Trials** | 6 |
| **The test** | how hard it steers toward the cue, before and after, with nothing following |
| **Success** | the cue's turn goes UP more than the control's. The card prints both and their difference |

1. Pick **FOOD** on the page, choose the cue and the control, START SESSION.
2. Stand still for the two before-measurements. This is the zero everything is compared to; it is
   tempting to skip and it is the most important part.
3. Six times: the cue comes on, the fly flies there **on its own brain**, lands, and three seconds
   later the dopamine arrives. Then the control thing is shown briefly, paying nothing.
4. The two after-measurements. Then read the card.

### DANGER — this thing means trouble

The same four steps with the outcome reversed. On arrival a shape rushes the fly — you will see its
escape fire — and sixteen pulses go into the two PPL101 cells, the stress dopamine. **Trials** 6.
**Success** is the mirror image: the cue's turn goes DOWN relative to the control. This is the
version closest to the original laboratory experiment, which used a shock and these same cells.

### FORGET — the thing, paying nothing

| | |
|---|---|
| **The cue** | the same thing you taught |
| **The outcome** | none, ever |
| **Trials** | 6 |
| **Success** | the turn toward the cue falls back toward where it started, and the synapse number climbs back toward 100 % |

Extinction is not the off switch — the synapses stay free the whole time. The fly is learning
something new: that the cue no longer pays. Use it after a FOOD session to watch the memory come
apart, which takes about as long as putting it in.

### TEST — has it learned?

| | |
|---|---|
| **The cue / control** | both, three times each, in turn |
| **The outcome** | none. **Plasticity is switched off for the whole session** and handed back after |
| **Trials** | 3 repeats |
| **Success** | the cue's average turn is higher than the control's. The card prints both and the gap |

Run this when you want a number you can trust. Because the weights cannot move, a TEST can be
repeated as often as you like without changing what it is measuring — unlike the after-measurement
inside a FOOD session, which is itself a presentation of the cue.

### CHOICE — which one does it pick?

| | |
|---|---|
| **The cue and the control** | **both at once**, equally strong, wherever they are in your room |
| **The outcome** | none; plasticity off |
| **Trials** | 6 |
| **Success** | it reaches the cue first in more than half of them. The card prints the count and the percentage |

The honest two-alternative test, and the one that matches how you would judge a pet. Two cautions,
both handled and both worth knowing: only one of the two things can hold the lens's landing gate at
a time, so it **swaps every trial**; and the two things are wherever your room put them, so a trial
that starts much closer to one of them is visible in the log as its starting distance. A fly that
refuses both is counted as a refusal, not as a vote.

### TRANSFER — what does it still remember?

A TEST, with one addition: before it starts it reads what was restored when the glasses were put
on — how many synapses came back and how old they are — and says so on the card. Use it at the
start of a session on another day, or on another pair of glasses: the fly's memory travels with its
owner, and the decay is real: it fades over about three hours, so a night away leaves almost nothing and
half an hour leaves most of it.

### RESET — forget everything

One key, no session. Every plastic synapse goes back to exactly where it started and the stored copy
is wiped. The card tells you how many synapses had moved before you pressed it. There is no undo.

---

## What the page tells you afterwards

When a session ends the lens packs up everything it measured — every trial's turning, latency, the
synapse numbers for the cue and for the control, whether plasticity was even on — and asks Gemini to
read it back to you in three sentences. Two things about that are worth knowing.

It is **not allowed to invent a number.** Every figure it quotes has to come from the pack, it has to
name the control next to the cue, and if the run was frozen it has to say the run could not have
learned anything. And it is a **reader, not a judge**: the pack travels next to its verdict, so you
can always check a sentence against the numbers it came from. If it cannot be reached you get the
numbers stated flatly instead, and the summary says which of the two you are looking at.

The verdict, the pack, and what your fly has been taught before all travel with the fly — so on
another day, or another pair of glasses, a TRANSFER session can tell you what it still remembers.

## Reading the result

The guide prints one line:

```
BIAS -0.08 -> 0.41 (+0.49)  //  LATENCY 22s -> 9s  //  SYNAPSES -3.65%, 3580 MOVED
```

- **BIAS** — how hard the fly steered toward the cue, from −1 (always away) to +1 (always toward),
  measured before and after. This is the number that matters, and it is measured the way the
  original experiment measured it: the fly's turning toward the smell, against its own
  before-training value. A positive change after appetitive training, or a negative one after
  aversive training, is the result.
- **LATENCY** — how many seconds it took to reach the cue, before and after. Easier to feel than the
  bias, but noisier: a fly that happened to start closer arrives sooner.
- **SYNAPSES** — how far the 7,835 plastic synapses moved from where they started, and how many of
  them moved at all. This is the brain's own readout, not an inference. The dashboard footer shows
  the same number live, as `memory learning …%`.
  **The number goes DOWN, and that is what learning looks like.** The rule weakens a Kenyon-cell
  synapse when that cell fires just before its dopamine neuron does, so the footer falls from 100 %
  as the session works. It is not a score. A run that stays at exactly 100.0 % with zero synapses
  moved did not learn anything — usually because plasticity was never switched on, and the result
  line will say so.

**Where it works, and where it does not — measured, not guessed.** Inside the brain the memory is
real and it belongs to the thing you taught: the synapses that carry *your cue* end up measurably
weaker than the ones that carry the control thing, every session we have run, while a frozen brain
shows exactly zero difference. That is on the card as `ON THE CUE … vs ON THE CONTROL …`.

What does not follow yet is the **behaviour**. The turn toward the cue moves around from session to
session, and the control's turn moves with it, so a bias change on its own is not proof of anything.
The gap is somewhere between the mushroom body's output and the neurons that steer — a piece of this
fly we have not finished reading. So: trust the synapse line, treat the bias line as a hint, and
always read the control next to the cue. We would rather tell you that than dress up a number.

---

## Where this comes from

The learning rule is not ours. It is the one published in Huang, Luo et al., *Dopamine-mediated
interactions between short- and long-term memory dynamics*, **Nature 634:1141 (2024)**, running here
as fly-wirehead implements it (its reward extension included) on the real synapses of the MaleCNS v1.0 connectome. The session structure — a measurement
before, six paired bouts with an unpaired control between them, the same measurement after — is that
paper's own experiment, moved off the laboratory trackball and into your room.

What we changed to fit a room and ten minutes, and what the model cannot do, is listed honestly in
`docs/knowledge/DECISIONS.md`, ADR 62. Nothing in this lens fakes a behaviour.
