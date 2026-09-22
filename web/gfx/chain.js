/**
 * Chains — "who does this population talk to?" (ADR 61 v3).
 *
 * Built ONCE at load from the same edge table the pulses travel on: for every class, the set of
 * neurons it reaches in 1, 2 and 3 hops, following the strongest connections first. Hovering only
 * flips a mask texture, so the cost per hover is one 262 KB upload and nothing else.
 *
 * Honest about what it is: the hops are real synapses and the order is real; the LATENCY printed
 * beside them is the page's display hop time, not a measurement — this model's synaptic delay is
 * a flat 1.8 ms for every edge.
 */
const MAX_PER_HOP = 24000; // a cascade wider than this stops being a picture of anything

export class Chains {
  /** pre/post are the edge table (already grouped by pre), classOf is one class per neuron */
  constructor(n, pre, post, w, classOf, nClass) {
    this.n = n;
    this.pre = pre;
    this.post = post;
    this.w = w;
    this.classOf = classOf;
    this.nClass = nClass;
    // the edge file lists every neuron's own edges together, so one pass gives the offsets
    const off = new Uint32Array(n + 1);
    for (let i = 0; i < pre.length; i++) off[pre[i] + 1]++;
    for (let i = 0; i < n; i++) off[i + 1] += off[i];
    this.off = off;
    this.members = null;
    this.cache = new Map();
  }

  /** the neurons of every class, once */
  byClass() {
    if (this.members) return this.members;
    const m = [];
    for (let c = 0; c < this.nClass; c++) m.push([]);
    for (let i = 0; i < this.n; i++) m[this.classOf[i]].push(i);
    this.members = m.map((a) => Uint32Array.from(a));
    return this.members;
  }

  /** mask: 255 for the seed population, 3/2/1 for one, two and three hops downstream */
  mask(classIndex, seedList) {
    const key = classIndex + ":" + (seedList ? seedList.length : 0);
    if (this.cache.has(key)) return this.cache.get(key);
    const seeds = seedList || this.byClass()[classIndex];
    const mask = new Uint8Array(this.n);
    for (const s of seeds) mask[s] = 255;
    let frontier = seeds;
    const reach = [];
    for (let hop = 1; hop <= 3 && frontier.length; hop++) {
      const cand = [];
      const cw = [];
      for (const v of frontier) {
        for (let e = this.off[v]; e < this.off[v + 1]; e++) {
          const t = this.post[e];
          if (mask[t]) continue;
          cand.push(t);
          cw.push(Math.abs(this.w[e]));
        }
      }
      let take = cand;
      if (cand.length > MAX_PER_HOP) { // the strongest connections carry the story
        const ord = Array.from(cand.keys()).sort((a, b) => cw[b] - cw[a]).slice(0, MAX_PER_HOP);
        take = ord.map((i) => cand[i]);
      }
      const lvl = 4 - hop; // 3, 2, 1 — brighter the closer to the source
      const next = [];
      const hit = new Array(this.nClass).fill(0);
      for (const t of take) {
        if (mask[t]) continue;
        mask[t] = lvl;
        next.push(t);
        hit[this.classOf[t]]++;
      }
      reach.push(hit);
      frontier = next;
    }
    const out = { mask, reach, seeds: seeds.length };
    this.cache.set(key, out);
    return out;
  }
}
