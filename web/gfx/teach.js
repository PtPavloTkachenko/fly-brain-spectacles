/**
 * The seven kinds of session, straight out of docs/TEACHING.md — same names, same numbers.
 *
 * This is a DATA table, not a lesson. The page no longer walks anyone through teaching a fly: the
 * mirrored nine-step LESSON panel and the HOW TO TEACH cards are gone, training runs by itself and
 * the TRAINING tab reads its data. What is left here is the three fields the session designer
 * actually asks for — the name it offers, the one line that says what the session does, and how
 * many bouts it defaults to. The full description of each session lives in docs/TEACHING.md.
 */
export const MODES = [
  { id: "FOOD", trials: 6,
    why: "This thing's smell means food. The fly is made hungry first, then on landing sixteen pulses of reward dopamine go into its 15 PAM11 cells." },
  { id: "DANGER", trials: 6,
    why: "This thing's smell means trouble. On arrival a shape rushes the fly and sixteen pulses of punishment dopamine go into its two PPL101 cells." },
  { id: "FORGET", trials: 6,
    why: "The same smell, paying nothing. Extinction is not an off switch — the fly learns that the cue no longer pays." },
  { id: "TEST", trials: 3,
    why: "Has it learned? Plasticity is off for the whole session, so measuring cannot teach." },
  { id: "CHOICE", trials: 6,
    why: "Which smell does it pick? Both at once, equally strong, wherever the two things are in your room." },
  { id: "TRANSFER", trials: 3,
    why: "What does it still remember? A TEST that first reads what was restored when the glasses went on." },
  { id: "RESET", trials: 0,
    why: "Forget everything. Every plastic synapse goes back to where it started and the stored copy is wiped. There is no undo." },
];
