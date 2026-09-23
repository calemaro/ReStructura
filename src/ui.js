// Small UI helpers shared by the map screen and the project chooser.
import { t } from "./i18n.js";
import * as api from "./api.js";

const statusEl = document.querySelector("#status");
export const setStatus = (msg) => { statusEl.textContent = msg; };

/** Something failed: say so in the status bar and in a pop-up, and write it to the
 *  error log (with the technical detail) so it can be sent to the developer. */
export const showError = (err) => {
  console.error(err);
  const msg = err?.message ?? String(err);
  setStatus(t("error.generic", { msg }));
  api.logEvent("ERROR", err?.stack ? `${msg}\n${err.stack}` : msg).catch(() => {});
  showToast({
    kind: "error", title: t("error.title"), text: msg, note: t("error.logged"),
    actions: [
      { text: t("log.show"), action: () => revealLog() },
      { text: t("log.howTo"), action: () => onHowToReport?.() },
    ],
  });
};

let onHowToReport = null;
export function setReportHandler(fn) { onHowToReport = fn; }

export async function revealLog() {
  try {
    const path = await api.logPath();
    if (path) await api.revealInFolder(path);
  } catch (err) { console.error(err); }
}

/** A pop-up in the corner, red for errors and warnings, that stays until closed so the
 *  message cannot be missed. A new one of the same kind replaces the old one. */
export function showToast({ kind = "error", title, text, note, actions = [] }) {
  document.querySelector(`.toast.${kind}`)?.remove();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", "alert");
  el.innerHTML = `<button type="button" class="toast-close" aria-label="${t("panel.close")}">×</button>
    <strong></strong><p class="toast-text"></p>${note ? `<p class="toast-note"></p>` : ""}<div class="toast-actions"></div>`;
  el.querySelector("strong").textContent = title;
  el.querySelector(".toast-text").textContent = text;
  if (note) el.querySelector(".toast-note").textContent = note;
  const row = el.querySelector(".toast-actions");
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.text;
    b.onclick = () => { a.action(); };
    row.append(b);
  }
  el.querySelector(".toast-close").onclick = () => el.remove();
  document.body.append(el);
}

/** Ask for one line of text. Resolves with the string, or null if cancelled.
 *  (The webview has no window.prompt, so this is a <dialog>.) */
export function askText(title, { placeholder = "", value = "", hint = "" } = {}) {
  const dlg = document.querySelector("#ask");
  const input = document.querySelector("#ask-input");
  document.querySelector("#ask-title").textContent = title;
  const hintEl = document.querySelector("#ask-hint");
  hintEl.textContent = hint;
  hintEl.hidden = !hint;
  input.placeholder = placeholder;
  input.value = value;
  return new Promise((resolve) => {
    const done = (v) => { dlg.removeEventListener("close", onClose); resolve(v); };
    const onClose = () => done(dlg.returnValue === "ok" ? input.value.trim() || null : null);
    dlg.addEventListener("close", onClose);
    dlg.querySelector("#ask-cancel").onclick = () => dlg.close("cancel");
    dlg.querySelector("form").onsubmit = (e) => { e.preventDefault(); dlg.close("ok"); };
    dlg.showModal();
    input.focus(); input.select();
  });
}

export function formatWhen(iso, lang) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
}

/** In-app context menu. items: [{ text, action, enabled? }] or { separator: true }.
 *  Shown at { x, y } (CSS px in the window), kept inside the viewport, closed by
 *  choosing an entry, clicking elsewhere, Esc, or scrolling. Same look on every OS. */
export function showContextMenu(items, at) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  for (const it of items) {
    if (it.separator) { const hr = document.createElement("div"); hr.className = "ctx-sep"; menu.append(hr); continue; }
    const b = document.createElement("button");
    b.type = "button"; b.className = "ctx-item"; b.setAttribute("role", "menuitem");
    b.textContent = it.text;
    b.disabled = it.enabled === false;
    b.addEventListener("click", () => { closeContextMenu(); it.action?.(); });
    menu.append(b);
  }
  document.body.append(menu);
  // keep it on screen
  const r = menu.getBoundingClientRect();
  const x = Math.min(at.x, window.innerWidth - r.width - 6);
  const y = Math.min(at.y, window.innerHeight - r.height - 6);
  menu.style.left = `${Math.max(6, x)}px`;
  menu.style.top = `${Math.max(6, y)}px`;
  menu.querySelector(".ctx-item:not(:disabled)")?.focus();

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeContextMenu(); return; }
    const focusable = [...menu.querySelectorAll(".ctx-item:not(:disabled)")];
    const i = focusable.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusable[(i + 1) % focusable.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); focusable[(i - 1 + focusable.length) % focusable.length]?.focus(); }
  };
  const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  menu._cleanup = () => {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("wheel", closeContextMenu, true);
    window.removeEventListener("blur", closeContextMenu);
  };
  // defer so the right-click that opened it does not immediately close it
  setTimeout(() => {
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("wheel", closeContextMenu, true);
    window.addEventListener("blur", closeContextMenu);
  }, 0);
}
export function closeContextMenu() {
  const m = document.querySelector(".ctx-menu");
  if (!m) return;
  m._cleanup?.();
  m.remove();
}
