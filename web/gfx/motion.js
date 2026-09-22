/** One motion vocabulary for the whole page (ADR 61; the lens's FlyMotion, in the browser).
 *  Everything that moves uses these — never a raw assignment, never a linear fade. */

/** fps-independent exponential approach: v -> target with a half-life of `rate` per second */
export const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));

export const Ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inQuad: (t) => t * t,
  bell: (t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t))),
};

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** staggered entrance: every plate arrives on its own beat, never all at once */
export function stagger(nodes, step = 60, delay = 90) {
  nodes.forEach((n, i) => setTimeout(() => n && n.classList.add("in"), delay + i * step));
}

/** a one-shot brightness kick on a node whose value just changed (never a hard swap) */
export function kick(node) {
  if (!node) return;
  node.classList.remove("pulse");
  void node.offsetWidth;
  node.classList.add("pulse");
}

/** write text only when it actually changed (diff-cache: a DOM write is never free) */
const shownText = new WeakMap();
const shownStyle = new WeakMap();
export function setText(node, text, pulseOnChange = false) {
  if (!node || shownText.get(node) === text) return false;
  shownText.set(node, text);
  node.textContent = text;
  if (pulseOnChange) kick(node);
  return true;
}
export function setStyle(node, prop, value) {
  if (!node) return;
  let m = shownStyle.get(node);
  if (!m) shownStyle.set(node, (m = {}));
  if (m[prop] === value) return;
  m[prop] = value;
  node.style[prop] = value;
}
