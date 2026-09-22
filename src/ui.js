// Small UI helpers shared by the map screen and the project chooser.
import { t } from "./i18n.js";

const statusEl = document.querySelector("#status");
export const setStatus = (msg) => { statusEl.textContent = msg; };
export const showError = (err) => {
  console.error(err);
  setStatus(t("error.generic", { msg: err?.message ?? String(err) }));
};

/** Ask for one line of text. Resolves with the string, or null if cancelled.
 *  (The webview has no window.prompt, so this is a <dialog>.) */
export function askText(title, { placeholder = "", value = "" } = {}) {
  const dlg = document.querySelector("#ask");
  const input = document.querySelector("#ask-input");
  document.querySelector("#ask-title").textContent = title;
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
