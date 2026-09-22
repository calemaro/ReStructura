// PlanFloorViewer — frontend entry point.
//
// The floor plan is shown with Leaflet, a map library, using one trick:
// L.CRS.Simple replaces latitude/longitude with plain x/y units, so a single
// image can be the whole "map". Zoom, pan and markers then come for free.
//
// Coordinate convention used throughout this app:
//   pins are stored in IMAGE PIXELS with the origin at the TOP-LEFT of the plan,
//   x to the right, y downwards — the same way an image editor reports them.
//   Leaflet's CRS.Simple puts the origin at the BOTTOM-left with y upwards, so
//   the two helpers below convert between the conventions. Nothing else in the
//   app should ever touch a raw Leaflet LatLng.
//
// Data comes from SQLite through Tauri commands (see src-tauri/src/lib.rs):
//   invoke("list_levels")                       -> [{ id, name, imagePath, sortOrder }]
//   invoke("list_pins",  { levelId })           -> [{ id, levelId, x, y, label, notes, createdAt }]
//   invoke("add_pin",    { levelId, x, y, label, notes }) -> the new pin
//   invoke("update_pin", { id, label, notes })  -> the updated pin
//   invoke("restore_pin", { pin })              -> the pin, re-inserted with its original id
//   invoke("delete_pin", { id })                -> true if a row was removed
//
// Every change goes through history.run(command) so it can be undone — see history.js.

import { t, setLanguage, detectLanguage, currentLanguage, SUPPORTED } from "./i18n.js";
import * as history from "./history.js";

// ---- Tauri bridge ------------------------------------------------------------------
// `window.__TAURI__` exists only inside the desktop app (tauri.conf.json:
// withGlobalTauri). Opening index.html in a plain browser gives a clear message
// instead of a cryptic failure.
const tauri = window.__TAURI__;
const invoke = tauri ? tauri.core.invoke : async () => { throw new Error(t("status.noTauri")); };

// ---- helpers: image pixels <-> Leaflet coordinates ----------------------------------
let imageHeight = 0;
const toLatLng = (x, y) => L.latLng(imageHeight - y, x);
const toPixel = (latlng) => ({ x: Math.round(latlng.lng), y: Math.round(imageHeight - latlng.lat) });

// ---- state ---------------------------------------------------------------------------
let map = null;
let bounds = null;
let level = null;                // the level currently shown
let pins = new Map();            // pin id -> { pin, marker }
let selectedId = null;           // pin open in the panel
let placing = false;             // "Add pin" mode: next click on the plan creates a pin

// ---- DOM -----------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const panelEl = $("#panel");
const planEl = $("#plan");
const addBtn = $("#btn-add");
const setStatus = (msg) => { statusEl.textContent = msg; };
const showError = (err) => { console.error(err); setStatus(t("error.db", { msg: err?.message ?? String(err) })); };

// ---- pin panel -----------------------------------------------------------------------
const labelInput = $("#pin-label");
const notesInput = $("#pin-notes");
const saveStateEl = $("#pin-save-state");

function showPin(id, { focus = false } = {}) {
  const entry = pins.get(id);
  if (!entry) return;
  const { pin } = entry;
  selectedId = id;
  labelInput.value = pin.label;
  notesInput.value = pin.notes;
  $("#pin-position").textContent = t("panel.positionValue", { x: Math.round(pin.x), y: Math.round(pin.y) });
  $("#pin-created").textContent = new Date(pin.createdAt).toLocaleString(currentLanguage());
  setSaveState("");
  panelEl.hidden = false;
  if (focus) { labelInput.focus(); labelInput.select(); }
}
function hidePanel() { flushSave(); panelEl.hidden = true; selectedId = null; }
$("#panel-close").addEventListener("click", hidePanel);

function setSaveState(kind, msg) {
  saveStateEl.textContent = msg ?? "";
  saveStateEl.className = "save-state" + (kind ? " " + kind : "");
}

// Autosave: a short pause after typing, or leaving the field, writes to SQLite.
// Only the pin that was open when typing started is written — switching pins
// mid-edit flushes the previous one first (see hidePanel / marker click).
let saveTimer = null;
let dirtyId = null;

function scheduleSave() {
  if (selectedId == null) return;
  dirtyId = selectedId;
  setSaveState("", t("panel.saving"));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (dirtyId == null) return;
  const id = dirtyId;
  dirtyId = null;
  const entry = pins.get(id);
  if (!entry) return;
  const before = { label: entry.pin.label, notes: entry.pin.notes };
  const after = { label: labelInput.value.trim(), notes: notesInput.value };
  if (before.label === after.label && before.notes === after.notes) { setSaveState(""); return; }

  const apply = async (values) => {
    const updated = await invoke("update_pin", { id, ...values });
    const e = pins.get(id);
    if (!e) return;
    e.pin = updated;
    e.marker.options.title = updated.label;
    e.marker.getElement()?.setAttribute("title", updated.label);
    if (selectedId === id) { labelInput.value = updated.label; notesInput.value = updated.notes; }
  };
  const cmd = {
    label: t("history.editPin"),
    pinId: id,
    before, after,
    do: () => apply(cmd.after),
    undo: () => apply(cmd.before),
    // consecutive edits of the same pin collapse into one history entry
    merge(next) { if (next.pinId !== id || !next.before) return false; cmd.after = next.after; return true; },
  };
  try {
    await history.run(cmd);
    if (selectedId === id) setSaveState("ok", t("panel.saved"));
  } catch (err) {
    console.error(err);
    if (selectedId === id) setSaveState("err", t("panel.saveFailed", { msg: err?.message ?? String(err) }));
  }
}
labelInput.addEventListener("input", scheduleSave);
notesInput.addEventListener("input", scheduleSave);
labelInput.addEventListener("blur", flushSave);
notesInput.addEventListener("blur", flushSave);
window.addEventListener("beforeunload", flushSave);

$("#pin-delete").addEventListener("click", async () => {
  if (selectedId == null || !confirm(t("panel.deleteConfirm"))) return;
  const id = selectedId;
  await flushSave();
  const snapshot = { ...pins.get(id).pin };           // what undo will put back
  try {
    await history.run({
      label: t("history.deletePin"),
      do: async () => {
        await invoke("delete_pin", { id });
        removeMarker(id);
        if (selectedId === id) hidePanel();
        setStatus(t("status.deleted", { id }));
      },
      undo: async () => {
        const pin = await invoke("restore_pin", { pin: snapshot });
        addMarker(pin);
        showPin(pin.id);
      },
    });
  } catch (err) { showError(err); }
});

// ---- markers -------------------------------------------------------------------------
function addMarker(pin) {
  const marker = L.marker(toLatLng(pin.x, pin.y), { title: pin.label })
    .addTo(map)
    .on("click", () => { flushSave(); showPin(pin.id); });
  pins.set(pin.id, { pin, marker });
  return marker;
}
function removeMarker(id) {
  pins.get(id)?.marker.remove();
  pins.delete(id);
}

// ---- "Add pin" mode ------------------------------------------------------------------
function setPlacing(on) {
  placing = on;
  addBtn.setAttribute("aria-pressed", String(on));
  addBtn.textContent = t(on ? "toolbar.cancel" : "toolbar.addPin");
  planEl.classList.toggle("placing", on);
  setStatus(t(on ? "toolbar.addPinActive" : "status.ready"));
}
addBtn.addEventListener("click", () => setPlacing(!placing));

// ---- undo / redo: toolbar buttons and keyboard --------------------------------------
const undoBtn = $("#btn-undo");
const redoBtn = $("#btn-redo");
let historyState = { canUndo: false, canRedo: false };
history.onChange((st) => {
  historyState = st;
  undoBtn.disabled = !st.canUndo;
  redoBtn.disabled = !st.canRedo;
});
async function doUndo() {
  if (!historyState.canUndo) return;
  const what = historyState.undoLabel;
  await flushSave();
  try { await history.undo(); setStatus(t("status.undone", { what })); } catch (err) { showError(err); }
}
async function doRedo() {
  if (!historyState.canRedo) return;
  const what = historyState.redoLabel;
  try { await history.redo(); setStatus(t("status.redone", { what })); } catch (err) { showError(err); }
}
undoBtn.addEventListener("click", doUndo);
redoBtn.addEventListener("click", doRedo);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (placing) setPlacing(false); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (history.focusIsInTextField()) {
    // While there is unsaved typing, Ctrl+Z is the text field's own undo.
    // Once it has been saved (or nothing was typed) it means the app's undo.
    if (dirtyId != null || !["z", "y"].includes(k)) return;
    document.activeElement.blur();
  }
  if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); doRedo(); }
});

async function createPinAt(latlng) {
  const { x, y } = toPixel(latlng);
  let created = null;                                  // remembered so redo keeps the same id
  try {
    await history.run({
      label: t("history.addPin"),
      get pinId() { return created?.id; },
      // Naming a pin right after placing it is part of placing it: absorb those edits.
      merge(next) { if (!created || next.pinId !== created.id || !next.after) return false; created = { ...created, ...next.after }; return true; },
      do: async () => {
        // First time: a real insert (JS -> Rust -> SQLite -> Rust -> JS). On redo: restore as it was.
        created = created
          ? await invoke("restore_pin", { pin: created })
          : await invoke("add_pin", { levelId: level.id, x, y, label: "", notes: "" });
        addMarker(created);
        setPlacing(false);
        showPin(created.id, { focus: true });
        setStatus(t("status.saved", { id: created.id, x, y }));
      },
      undo: async () => {
        created = { ...pins.get(created.id)?.pin ?? created };   // keep any edits made since
        await invoke("delete_pin", { id: created.id });
        removeMarker(created.id);
        if (selectedId === created.id) hidePanel();
      },
    });
  } catch (err) { showError(err); }
}

// ---- language switcher --------------------------------------------------------------
const langSelect = $("#lang-select");
for (const [code, name] of Object.entries(SUPPORTED)) langSelect.add(new Option(name, code));
langSelect.addEventListener("change", () => setLanguage(langSelect.value));
document.addEventListener("languagechange", () => {
  // data-i18n elements are refreshed by i18n.js; strings built here need redoing
  if (selectedId != null && dirtyId == null) showPin(selectedId);
  setPlacing(placing);
});

// ---- map -----------------------------------------------------------------------------
function loadImageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

async function showLevel(lvl) {
  level = lvl;
  $("#level-name").textContent = lvl.name;

  const { width, height } = await loadImageSize(lvl.imagePath);
  imageHeight = height;
  // In CRS.Simple one map unit = one image pixel at zoom 0. Bounds are
  // [[south, west], [north, east]] = [[0, 0], [height, width]].
  bounds = L.latLngBounds([[0, 0], [height, width]]);

  if (map) map.remove();
  pins = new Map();
  history.clear();
  map = L.map("plan", {
    crs: L.CRS.Simple,
    minZoom: -3,                   // negative zoom = image smaller than 1:1
    maxZoom: 3,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    attributionControl: false,
    maxBounds: bounds.pad(0.5),    // don't let the plan be dragged completely off-screen
    maxBoundsViscosity: 0.6,
  });
  L.imageOverlay(lvl.imagePath, bounds).addTo(map);
  map.fitBounds(bounds);

  map.on("click", (e) => {
    if (placing) return createPinAt(e.latlng);
    const p = toPixel(e.latlng);
    setStatus(t("status.clicked", p));
  });

  const list = await invoke("list_pins", { levelId: lvl.id });
  list.forEach(addMarker);
  return list.length;
}

async function main() {
  const lang = detectLanguage();
  langSelect.value = lang;
  await setLanguage(lang);          // fills every data-i18n element and fires languagechange
  setPlacing(false);
  $("#btn-fit").addEventListener("click", () => map && map.fitBounds(bounds));

  const levels = await invoke("list_levels");
  if (!levels.length) throw new Error("no levels in database");
  const n = await showLevel(levels[0]);   // Phase F: a level switcher instead of "the first one"

  const path = await invoke("db_path");
  setStatus(t("status.loaded", { n, path }));
  console.log("database:", path);
}

// The webview's default right-click menu (back / forward / reload / inspect) is a
// browser artefact that makes no sense in a desktop app. Suppress it in release
// builds; keep it in development so "Inspect" stays available. A proper context
// menu ("add pin here", "fit view", …) is planned — see the MVP issues.
if (import.meta.env.PROD) document.addEventListener("contextmenu", (e) => e.preventDefault());

main().catch(showError);
