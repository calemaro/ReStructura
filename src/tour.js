// The guided tour: the real interface, one part at a time, dimmed around a spotlight
// with a short explanation next to it. Three short tours, each shown once at the
// moment it becomes relevant: the main menu (first launch), the plan (first project
// opened) and Draw mode (first time in the editor). Replayable from Help.
//
// Steps name the element they point at; their text comes from the help content, so
// it is translated like everything else. A step whose element is not on screen
// (for example the floor list when there is only one floor) is skipped.

import { t } from "./i18n.js";

export const TOURS = {
  menu: [
    { id: "menu.projects", target: "#project-list" },
    { id: "menu.new", target: "#new-project" },
    { id: "menu.help", target: "#menu-bar .btn-help" },
    { id: "menu.settings", target: "#menu-bar .btn-settings" },
  ],
  plan: [
    { id: "plan.map", target: "#plan" },
    { id: "plan.add", target: "#btn-add-menu" },
    { id: "plan.mode", target: ".mode-switch" },
    { id: "plan.legend", target: "#legend" },
    { id: "plan.scale", target: "#scale" },
    { id: "plan.search", target: "#btn-search" },
    { id: "plan.export", target: "#btn-export" },
    { id: "plan.undo", target: "#btn-undo" },
    { id: "plan.help", target: "#plan-bar .btn-help" },
  ],
  draw: [
    { id: "draw.tools", target: "#editor-tools" },
    { id: "draw.bar", target: "#editor-bar" },
    { id: "draw.plan", target: "#plan" },
    { id: "draw.back", target: "#mode-document" },
  ],
};

let running = null;
export const isRunning = () => !!running;

const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest("[hidden]");

/** Run one tour. `textFor(id)` resolves to { title, text }. `onEnd` runs when it is
 *  finished or skipped (not when a step is simply left). */
export async function run(name, textFor, onEnd) {
  if (running) return;
  const steps = (TOURS[name] ?? []).filter((s) => visible(document.querySelector(s.target)));
  if (!steps.length) return;
  const texts = await Promise.all(steps.map((s) => textFor(s.id)));

  const block = document.createElement("div");
  block.className = "tour-block";
  const spot = document.createElement("div");
  spot.className = "tour-spot";
  const card = document.createElement("div");
  card.className = "tour-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  document.body.append(block, spot, card);

  let i = 0;
  const end = () => {
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
    block.remove(); spot.remove(); card.remove();
    running = null;
    onEnd?.();
  };
  const go = (n) => { if (n < 0) return; if (n >= steps.length) { end(); return; } i = n; show(); };

  function show() {
    const last = i === steps.length - 1;
    const { title, text } = texts[i];
    card.innerHTML = `
      <h3></h3><p></p>
      <div class="tour-foot">
        <span class="tour-count"></span>
        ${last ? "" : `<button type="button" class="tour-skip"></button>`}
        ${i > 0 ? `<button type="button" class="tour-back"></button>` : ""}
        <button type="button" class="primary tour-next"></button>
      </div>`;
    card.querySelector("h3").textContent = title;
    card.querySelector("p").textContent = text;
    card.querySelector(".tour-count").textContent = t("tour.step", { i: i + 1, n: steps.length });
    const skip = card.querySelector(".tour-skip");
    if (skip) { skip.textContent = t("tour.skip"); skip.onclick = end; }
    const back = card.querySelector(".tour-back");
    if (back) { back.textContent = t("tour.back"); back.onclick = () => go(i - 1); }
    const next = card.querySelector(".tour-next");
    next.textContent = t(last ? "tour.done" : "tour.next");
    next.onclick = () => go(i + 1);
    place();
    next.focus();
  }

  /** Spotlight the element; put the card below it, or above, or beside it, or (for
   *  something as large as the plan) in its middle, always inside the window. */
  function place() {
    const el = document.querySelector(steps[i].target);
    if (!visible(el)) { go(i + 1); return; }
    const r = el.getBoundingClientRect();
    const pad = 6;
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const W = window.innerWidth, H = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    let x, y;
    if (r.width * r.height > W * H * 0.35) { x = r.left + r.width / 2 - cw / 2; y = r.top + r.height / 2 - ch / 2; }
    else if (r.bottom + gap + ch < H) { x = r.left; y = r.bottom + gap; }
    else if (r.top - gap - ch > 0) { x = r.left; y = r.top - gap - ch; }
    else if (r.right + gap + cw < W) { x = r.right + gap; y = r.top; }
    else { x = r.left - gap - cw; y = r.top; }
    card.style.left = `${Math.max(12, Math.min(W - cw - 12, x))}px`;
    card.style.top = `${Math.max(12, Math.min(H - ch - 12, y))}px`;
  }

  // While the tour is up, the keyboard belongs to it: no app shortcut fires behind it.
  function onKey(e) {
    e.stopImmediatePropagation();
    if (e.key === "Escape") { e.preventDefault(); end(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
  }
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", place);
  running = { name };
  show();
}
