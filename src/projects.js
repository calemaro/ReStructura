// The project chooser: list, create, import, export, open.
//
// Shown on start (nothing else is usable until a project is open) and again
// from the toolbar. `onOpen(project)` is the callback into the map screen.

import * as api from "./api.js";
import { t, currentLanguage } from "./i18n.js";
import { setStatus, showError, formatWhen } from "./ui.js";

const LAST_KEY = "planfloorviewer.lastProject";
const $ = (s) => document.querySelector(s);
const el = $("#chooser");
let onOpen = null;
let onShow = null;         // tells the map screen to hide its chrome
let currentSlug = null;

export function init(openCallback, showCallback) {
  onOpen = openCallback;
  onShow = showCallback;
  $("#new-project").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#new-project-name");
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      const p = await api.createProject(name);
      input.value = "";
      await opened(p);
    } catch (err) { showError(err); }
  });
  $("#btn-import-project").addEventListener("click", async () => {
    try {
      const zip = await api.pickZip(t("chooser.import"));
      if (!zip) return;
      const p = await api.importProject(zip);
      setStatus(t("chooser.imported", { name: p.name }));
      await refresh();
    } catch (err) { showError(err); }
  });
  document.addEventListener("languagechange", () => { if (!el.hidden) refresh(); });
}

/** The main menu: a full screen, not a popup. Leaving it means opening a project. */
export async function show() {
  el.hidden = false;
  onShow?.();
  await refresh();
  $("#new-project-name").focus();
}
export function hide() { el.hidden = true; }

/** On start: always the main menu. The last project is only highlighted, never auto-opened. */
export async function start() {
  try { currentSlug = localStorage.getItem(LAST_KEY); } catch (_) {}
  await show();
}

async function opened(p) {
  currentSlug = p.slug;
  try { localStorage.setItem(LAST_KEY, p.slug); } catch (_) {}
  hide();
  await onOpen?.(p);
}

async function refresh() {
  const list = $("#project-list");
  list.innerHTML = "";
  let projects = [];
  try { projects = await api.listProjects(); } catch (err) { showError(err); }
  if (!projects.length) {
    const li = document.createElement("li");
    li.className = "chooser-empty"; li.textContent = t("chooser.empty");
    list.append(li);
  }
  for (const p of projects) {
    const li = document.createElement("li");
    if (p.slug === currentSlug) li.classList.add("current");
    const main = document.createElement("div"); main.className = "p-main";
    const name = document.createElement("div"); name.className = "p-name"; name.textContent = p.name;
    const meta = document.createElement("div"); meta.className = "p-meta";
    meta.textContent = t("chooser.modified", { when: formatWhen(p.modifiedAt, currentLanguage()) });
    main.append(name, meta);

    if (p.slug === currentSlug) {
      const cur = document.createElement("span"); cur.className = "p-current"; cur.textContent = t("chooser.current");
      name.append(cur);
    }
    const actions = document.createElement("div"); actions.className = "p-actions";
    const open = document.createElement("button"); open.type = "button"; open.className = "primary"; open.textContent = t("chooser.open");
    open.onclick = async () => { try { await opened(await api.openProject(p.slug)); } catch (err) { showError(err); } };
    const exp = document.createElement("button"); exp.type = "button"; exp.textContent = t("chooser.export");
    exp.onclick = async () => {
      try {
        const dest = await api.pickSavePath(t("chooser.export"), `${p.slug}.planfloor.zip`);
        if (!dest) return;
        await api.exportProject(p.slug, dest);
        setStatus(t("chooser.exported", { path: dest }));
      } catch (err) { showError(err); }
    };
    const del = document.createElement("button"); del.type = "button"; del.className = "danger"; del.textContent = t("chooser.delete");
    del.onclick = async () => {
      if (!confirm(t("chooser.deleteConfirm", { name: p.name }))) return;
      try {
        await api.deleteProject(p.slug);
        if (p.slug === currentSlug) { currentSlug = null; try { localStorage.removeItem(LAST_KEY); } catch (_) {} }
        setStatus(t("chooser.deleted", { name: p.name }));
        await refresh();
      } catch (err) { showError(err); }
    };
    actions.append(open, exp, del);
    li.append(main, actions);
    list.append(li);
  }
  try { $("#chooser-where").textContent = t("chooser.where", { dir: await api.projectsDir() }); } catch (_) {}
}
