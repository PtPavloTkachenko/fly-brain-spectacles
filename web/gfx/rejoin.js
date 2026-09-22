/**
 * Rejoin — the ROOM chip is a control, not a readout (Pavlo: "there is no way to go back").
 *
 * Until now the PIN was a one-way door: the gate took it once, and a wrong PIN (or a lens that was
 * restarted into a new one) left the page with nothing to press. The chip that already SAYS which
 * room this is now also changes it: click it (or press R) and a compact form opens under it with the
 * PIN, the relay and the key already filled in, RECONNECT and LEAVE ROOM.
 *
 * Two things this must not do, and does not:
 *  - it never touches the brain. The worker keeps stepping through a reconnect and through LEAVE, so
 *    the 75 MB core is loaded once per tab, no matter how many rooms it visits.
 *  - it never reloads the page. LEAVE ROOM brings the gate back over a brain that is still turning,
 *    which is exactly what the gate was designed to sit on top of.
 *
 * The one refusal that has no other way out — `GLASSES LOST`, the lens WAS there and went quiet — grows
 * a CHANGE PIN button next to the fault line after 30 s, because by then "waiting for it to come
 * back" has stopped being advice.
 *
 * Owns: the chip's affordances, the form, the R/Escape keys, the lost-for-too-long button.
 * Asks app.js for: the state object and two callbacks (rejoin, leave). Nothing else.
 */
const DEV_FIELDS = new URLSearchParams(location.search).has("relay") || !!(document.getElementById("app") && document.getElementById("app").classList.contains("lab"));
import { setText, kick } from "./motion.js";

const LOST_OFFER_S = 30; // after this much silence, "waiting" is no longer an answer

export function initRejoin({ state, chip, onRejoin, onLeave, defaults }) {
  const S = state;
  let open = false;
  let box = null, fPin = null, fRelay = null, fKey = null, note = null, where = null;

  /* ---------------------------------------------------------------- the chip is a button now */
  chip.classList.add("ctl");
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-label", "PIN — click or press R to change it, or to leave");
  chip.title = "the PIN you typed — click to change it or leave  (R)";
  chip.addEventListener("click", () => toggle());
  chip.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  /* ---------------------------------------------------------------- CHANGE PIN, when lost */
  // it lives right after the fault line, where the GLASSES LOST words already are
  const offer = document.createElement("button");
  offer.id = "pinFix";
  offer.type = "button";
  offer.textContent = "CHANGE PIN";
  offer.title = "the glasses have been silent for a while — try another PIN";
  offer.addEventListener("click", () => toggle(true));
  const fault = document.getElementById("fault");
  if (fault && fault.parentNode) fault.parentNode.insertBefore(offer, fault.nextSibling);

  /* ---------------------------------------------------------------- the form */
  function build() {
    box = document.createElement("div");
    box.id = "roomForm";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "change the room");
    box.innerHTML =
      '<div class="cap"><span>PIN <b>// WHICH GLASSES</b></span><span class="r" id="roomFormAt">&mdash;</span></div>'
      + '<div class="rf">'
      + '<label>PIN <span>the four digits on the glasses</span><input id="rfPin" maxlength="4" inputmode="numeric" autocomplete="off" placeholder="0000"></label>'
      // 21.09 Pavlo: "чому це видно людям?" -- the relay and its public key are deployment details; a
      // visitor sees only the PIN. The two fields come back for a dev page (?relay= in the address or lab mode).
      + (DEV_FIELDS ? '<label>RELAY <span>the link server (leave it unless you run your own)</span><input id="rfRelay" placeholder="wss://&hellip;"></label>'
      + '<label>KEY <span>its key; empty for a relay of your own</span><input id="rfKey" placeholder="(none)" autocomplete="off"></label>' : '<input id="rfRelay" type="hidden"><input id="rfKey" type="hidden">')
      + "</div>"
      + '<div class="acts"><button id="rfGo" class="pri">RECONNECT</button><button id="rfOut" class="danger">LEAVE</button>'
      + '<span id="rfNote">the brain in this tab keeps running — only the glasses change</span></div>';
    document.body.appendChild(box);
    fPin = box.querySelector("#rfPin");
    fRelay = box.querySelector("#rfRelay");
    fKey = box.querySelector("#rfKey");
    note = box.querySelector("#rfNote");
    where = box.querySelector("#roomFormAt");
    box.querySelector("#rfGo").addEventListener("click", go);
    box.querySelector("#rfOut").addEventListener("click", leave);
    for (const el of [fPin, fRelay, fKey]) {
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    }
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); chip.focus(); } });
  }

  function place() {
    const r = chip.getBoundingClientRect();
    // fixed, measured off the chip: no z-index war with the grid, and it cannot be clipped
    const w = Math.min(430, window.innerWidth - 24);
    box.style.width = w + "px";
    box.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left - 8)) + "px";
    box.style.top = r.bottom + 8 + "px";
  }

  function show() {
    if (!box) build();
    const d = defaults ? defaults() : {};
    fPin.value = S.pin || d.pin || "";
    fRelay.value = S.relayUrl || d.relay || "";
    fKey.value = d.key || "";
    place();
    box.classList.add("on");
    open = true;
    chip.setAttribute("aria-expanded", "true");
    setText(note, "the brain in this tab keeps running — only the glasses change");
    note.className = "";
    paint();
    fPin.focus();
    fPin.select();
  }

  function close() {
    if (!open) return;
    open = false;
    box.classList.remove("on");
    chip.setAttribute("aria-expanded", "false");
  }

  const toggle = (force) => (open && !force ? close() : show());

  function go() {
    const pin = fPin.value.trim();
    const url = fRelay.value.trim();
    if (!/^\d{4}$/.test(pin)) return bad("the PIN is the four digits on the glasses' board", fPin);
    if (!url) return bad("a link server address is needed", fRelay);
    close();
    onRejoin(pin, url, fKey.value.trim());
  }

  function leave() {
    close();
    onLeave();
  }

  function bad(why, el) {
    note.className = "warn";
    setText(note, why);
    kick(note);
    el.focus();
  }

  /* ---------------------------------------------------------------- keys */
  // Capture phase on purpose: it also stops the page's single-letter shortcuts (c / 1 / 2 / ?) from
  // firing while a field has focus — typing "1234" into a PIN box used to switch tabs.
  window.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      if (e.key !== "Escape") e.stopPropagation();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // Cmd-R is still a reload
      e.preventDefault();
      e.stopPropagation();
      toggle();
    } else if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    }
  }, true);
  window.addEventListener("resize", () => { if (open) place(); });
  // a click anywhere else closes it, the way the help card does
  window.addEventListener("pointerdown", (e) => {
    if (!open) return;
    if (box.contains(e.target) || chip.contains(e.target) || e.target === offer) return;
    close();
  });

  /* ---------------------------------------------------------------- the two live labels */
  // Off its own half-second clock, not the render loop: nothing here is worth a frame's budget,
  // and every write is diff-cached anyway.
  function paint() {
    const lost = S.lensEver && S.joined ? (performance.now() - S.lensSeen) / 1000 : 0;
    const on = lost > 0 && lost < 6;
    const show = S.joined && S.lensEver && lost > LOST_OFFER_S;
    if (offer.classList.contains("on") !== show) offer.classList.toggle("on", show);
    if (!open) return;
    setText(where, !S.joined ? "NOT LINKED"
      : on ? "PIN " + (S.pin || "") + " · GLASSES CONNECTED"
      : S.lensEver ? "PIN " + (S.pin || "") + " · GLASSES SILENT " + Math.round(lost) + " S"
      : "PIN " + (S.pin || "") + " · NO GLASSES YET");
  }
  setInterval(paint, 500);

  // ?room=1 opens the form on load — the same hook ?help=1 and ?chain= give the visual tests
  if (new URLSearchParams(location.search).get("room") === "1") setTimeout(show, 700);

  return { open: () => show(), close, paint };
}
