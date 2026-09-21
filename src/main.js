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
//   invoke("delete_pin", { id })                -> true if a row was removed

import { t, setLanguage, detectLanguage, currentLanguage, SUPPORTED } from "./i18n.js";

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
  const label = labelInput.value.trim();
  const notes = notesInput.value;
  try {
    const updated = await invoke("update_pin", { id, label, notes });
    entry.pin = updated;
    entry.marker.options.title = updated.label;
    entry.marker.getElement()?.setAttribute("title", updated.label);
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
  try {
    await invoke("delete_pin", { id });
    pins.get(id)?.marker.remove();
    pins.delete(id);
    hidePanel();
    setStatus(t("status.deleted", { id }));
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

// ---- "Add pin" mode ------------------------------------------------------------------
function setPlacing(on) {
  placing = on;
  addBtn.setAttribute("aria-pressed", String(on));
  addBtn.textContent = t(on ? "toolbar.cancel" : "toolbar.addPin");
  planEl.classList.toggle("placing", on);
  setStatus(t(on ? "toolbar.addPinActive" : "status.ready"));
}
addBtn.addEventListener("click", () => setPlacing(!placing));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && placing) setPlacing(false); });

async function createPinAt(latlng) {
  const { x, y } = toPixel(latlng);
  try {
    // This is the round-trip: JS -> Rust -> SQLite -> Rust -> JS.
    const pin = await invoke("add_pin", { levelId: level.id, x, y, label: "", notes: "" });
    addMarker(pin);
    setPlacing(false);
    showPin(pin.id, { focus: true });
    setStatus(t("status.saved", { id: pin.id, x, y }));
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
