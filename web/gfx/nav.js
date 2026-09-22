/**
 * NAV — the one navigation both pages share, and the small-screen gate.
 *
 * Three destinations: HOME (the landing), DASHBOARD (the live page) and CREDITS. The landing draws
 * all three as a bar; the app draws only HOME and CREDITS, because it IS the dashboard.
 *
 * There is no TRAINING item any more (21.09): the fly learns by itself, continuously, and the
 * training tab is a hidden experiment tool (`?tab=training`), never a destination offered to a
 * visitor.
 *
 * Link targets are literal: the landing is `index.html` (the front door, `/`), the app is `app.html`.
 *
 * The small-screen gate lives here too, because it is a navigation fact: on a phone the dashboard
 * folds to one column (style.css, "THE PHONE") and the brain runs slower, so the app says so first —
 * and still opens if asked. It is a notice, not a refusal: the link that opens it anyway keeps every parameter of the address (a `?demo=1` used
 * to be dropped by it, which sent "watch it think" to the PIN screen).
 */
/** The nav's look lives in site.css, which the landing loads and the app does not. Rather than keep
 *  a second copy of those rules in style.css, the module pulls its own stylesheet in once. */
function ensureSiteCss() {
  if (document.querySelector('link[href$="site.css"]')) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = "site.css";
  document.head.appendChild(l);
}

const ITEMS = [
  { id: "home", label: "HOME", href: "index.html" },
  { id: "dash", label: "DASHBOARD", href: "app.html" },
  { id: "credits", label: "CREDITS", href: "index.html#credits" },
];

/**
 * @param {HTMLElement} host   where the bar goes
 * @param {object} o
 * @param {string} o.active    which item is the current page ("home" | "dash" | "teach")
 * @param {boolean} o.compact  the app's two-item version
 * @param {(id:string)=>boolean} [o.intercept]  return true to handle a click in-page
 */
export function buildNav(host, { active = "", compact = false, intercept = null } = {}) {
  ensureSiteCss();
  const nav = document.createElement("nav");
  nav.className = "nav" + (compact ? " compact" : "");
  nav.setAttribute("aria-label", "sections");
  const mark = document.createElement("a");
  mark.className = "brand";
  mark.href = "index.html";
  mark.innerHTML = "CYBERFLY <b>// FLY BRAIN LINK</b>";
  nav.appendChild(mark);
  const list = document.createElement("div");
  list.className = "navlist";
  for (const it of ITEMS) {
    if (compact && (it.id === "dash" || it.id === "teach")) continue;
    const a = document.createElement("a");
    a.className = "navitem" + (it.id === active ? " on" : "");
    a.href = it.href;
    a.textContent = it.label;
    if (it.id === active) a.setAttribute("aria-current", "page");
    if (intercept) {
      a.addEventListener("click", (e) => { if (intercept(it.id)) e.preventDefault(); });
    }
    list.appendChild(a);
  }
  nav.appendChild(list);
  host.appendChild(nav);
  return nav;
}

/**
 * The dashboard is laid out for a wide window: three columns, 166,700 points, a WebGPU kernel. On a
 * phone it is cramped and slower, so say that first — but never refuse. `force` skips the notice
 * (`?force=1`, or the caller already knows better).
 */
export function smallScreenGate({ force = false } = {}) {
  ensureSiteCss();
  const narrow = window.matchMedia("(max-width: 860px)").matches;
  if (force || !narrow) return false;
  // the same address, with force=1 added: every other parameter survives the click
  const q = new URLSearchParams(location.search);
  q.set("force", "1");
  const anyway = location.pathname.split("/").pop() + "?" + q.toString() + location.hash;
  const d = document.createElement("div");
  d.id = "tooSmall";
  d.innerHTML =
    '<div class="card"><h1>CYBERFLY <b>// A REAL FLY BRAIN</b></h1>'
    + "<p>This page runs a whole fruit-fly brain on your graphics card and draws all 166,700 of its "
    + "neurons. On a phone the brain runs <b>slower</b>; turn it sideways for more room.</p>"
    + '<p class="small">It needs WebGPU: Chrome or Edge 113+, Safari 26+ (iOS 18+). Without it the brain '
    + "runs on the CPU, about eight times slower.</p>"
    + '<div class="acts"><a class="btn pri" href="' + anyway + '">OPEN IT ANYWAY</a>'
    + '<a class="btn ghost" href="index.html">READ WHAT IT IS</a></div></div>';
  document.body.appendChild(d);
  document.documentElement.classList.add("gated");
  return true;
}
