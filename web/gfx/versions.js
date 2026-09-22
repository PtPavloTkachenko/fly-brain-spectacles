/**
 * Versions — this fly's saved selves (ADR 61 v3).
 *
 * The blob is the page's OWN plastic state: the core answers `{"memory":"get","compact":true}` with
 * it, so a version is exactly what the brain in this tab is, not a copy of something else. Loading
 * one sets it here AND tells the lens to set its canonical copy, so the two never drift.
 *
 * With Supabase configured (config.js, or ?sb=<ref>&sbkey=<anon>) the list lives in
 * `fly_brain_versions`, keyed by the user key the LENS reports in `mem.key` — which this page never
 * displays. Without it, the same blob downloads and uploads as a file, and the panel says exactly
 * what is missing.
 *
 * The column names are ADR 68's and DEPLOY.md 1c's: `user_id` + `version_id`. The list aliases
 * `version_id` to `id` in the query itself, so the panel keeps one word for "which version".
 */
export class Versions {
  constructor(base, anon) {
    this.base = base || "";  // https://<ref>.<host> (config.js sbBase); empty = no cloud
    this.anon = anon || "";
    this.key = "";           // the user key, from the lens; never rendered
    this.rows = [];
  }

  get on() { return !!(this.base && this.anon); }
  get url() { return this.base + "/rest/v1/fly_brain_versions"; }
  get head() { return { apikey: this.anon, Authorization: "Bearer " + this.anon, "Content-Type": "application/json" }; }

  async list() {
    if (!this.on || !this.key) return (this.rows = []);
    const q = `?select=id:version_id,name,created_at,bytes,changed,mean_efficacy,sessions&user_id=eq.${encodeURIComponent(this.key)}&order=created_at.desc&limit=40`;
    const r = await fetch(this.url + q, { headers: this.head });
    if (!r.ok) throw new Error("list HTTP " + r.status);
    return (this.rows = await r.json());
  }

  async save(name, blobB64, meta) {
    if (!this.on || !this.key) throw new Error("no supabase");
    const body = JSON.stringify([{ user_id: this.key, name: name, blob: blobB64,
      bytes: meta.bytes | 0, changed: meta.changed | 0, mean_efficacy: meta.mean_efficacy || null,
      sessions: meta.sessions || null, summary: meta.summary || null }]);
    const r = await fetch(this.url, { method: "POST", headers: Object.assign({ Prefer: "return=representation" }, this.head), body });
    if (!r.ok) throw new Error("save HTTP " + r.status);
    return (await r.json())[0];
  }

  async load(id) {
    const r = await fetch(this.url + `?select=blob,name&version_id=eq.${encodeURIComponent(id)}`, { headers: this.head });
    if (!r.ok) throw new Error("load HTTP " + r.status);
    const j = await r.json();
    if (!j.length) throw new Error("gone");
    return j[0];
  }

  async remove(id) {
    const r = await fetch(this.url + `?version_id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: this.head });
    if (!r.ok) throw new Error("delete HTTP " + r.status);
  }

  /** what changed between two saved selves, in the numbers the card already shows */
  static diff(a, b) {
    if (!a || !b) return "";
    const d = (x, y, f) => (y === null || x === null || y === undefined || x === undefined ? "?" : f(y - x));
    return "VS " + a.name + " → " + b.name + "  ·  SYNAPSES "
      + d(a.changed, b.changed, (v) => (v >= 0 ? "+" : "") + v.toLocaleString())
      + "  ·  MEAN EFFICACY " + d(a.mean_efficacy, b.mean_efficacy, (v) => (v >= 0 ? "+" : "") + v.toFixed(4))
      + "  ·  SESSIONS " + d(a.sessions, b.sessions, (v) => (v >= 0 ? "+" : "") + v);
  }
}
