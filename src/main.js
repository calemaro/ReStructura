// PlanFloorViewer — the map screen.
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
// Data comes from the open project's SQLite database through the commands in
// api.js. Every change goes through history.run(command) so it can be undone.

import * as api from "./api.js";
import * as history from "./history.js";
import * as projects from "./projects.js";
import { t, setLanguage, detectLanguage, currentLanguage, SUPPORTED } from "./i18n.js";
import { setStatus, showError, askText } from "./ui.js";
import { CATEGORIES, SCHEMES, colourFor, pinIcon } from "./categories.js";
import { parseCm, formatCm, inputCm } from "./units.js";

// ---- helpers: image pixels <-> Leaflet coordinates ----------------------------------
let imageHeight = 0;
const toLatLng = (x, y) => L.latLng(imageHeight - y, x);
const toPixel = (latlng) => ({ x: Math.round(latlng.lng), y: Math.round(imageHeight - latlng.lat) });

// ---- state ---------------------------------------------------------------------------
let project = null;              // the open project (ProjectInfo)
let levels = [];                 // this project's levels
let level = null;                // the level currently shown
let map = null;
let bounds = null;
let pins = new Map();            // pin id -> { pin, marker }
let selectedId = null;           // pin open in the panel
let placing = false;             // "Add pin" mode: next click on the plan creates a pin
let scheme = "it";               // the project's colour scheme ("it" | "apwa")
const hiddenCats = new Set();    // categories switched off in the legend

// ---- DOM -----------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const panelEl = $("#panel");
const planEl = $("#plan");
const emptyEl = $("#plan-empty");
const addBtn = $("#btn-add");
const levelSelect = $("#level-select");

// ---- pin panel -----------------------------------------------------------------------
const labelInput = $("#pin-label");
const notesInput = $("#pin-notes");
const catSelect = $("#pin-category");
const swatchEl = $("#pin-swatch");
const saveStateEl = $("#pin-save-state");

function fillCategorySelect() {
  const v = catSelect.value;
  catSelect.innerHTML = "";
  for (const c of CATEGORIES) catSelect.add(new Option(t("cat." + c), c));
  if (v) catSelect.value = v;
}

function showPin(id, { focus = false } = {}) {
  const entry = pins.get(id);
  if (!entry) return;
  const { pin } = entry;
  selectedId = id;
  labelInput.value = pin.label;
  notesInput.value = pin.notes;
  catSelect.value = pin.category;
  swatchEl.style.background = colourFor(scheme, pin.category);
  for (const [pid, e] of pins) e.marker.setIcon(pinIcon(colourFor(scheme, e.pin.category), { selected: pid === id }));
  $("#pin-position").textContent = t("panel.positionValue", { x: Math.round(pin.x), y: Math.round(pin.y) });
  $("#pin-created").textContent = new Date(pin.createdAt).toLocaleString(currentLanguage());
  setSaveState("");
  panelEl.hidden = false;
  renderMeasurements([]);
  renderPhotos([]);
  api.listMeasurements(id).then((list) => { if (selectedId === id) renderMeasurements(list); }).catch(showError);
  api.listPhotos(id).then((list) => { if (selectedId === id) renderPhotos(list); }).catch(showError);
  if (focus) { labelInput.focus(); labelInput.select(); }
}
function hidePanel() {
  flushSave();
  flushMeasSave();
  if (!viewerEl.hidden) closeViewer();
  panelEl.hidden = true;
  if (selectedId != null) pins.get(selectedId)?.marker.setIcon(pinIcon(colourFor(scheme, pins.get(selectedId).pin.category)));
  selectedId = null;
}
$("#panel-close").addEventListener("click", hidePanel);

function setSaveState(kind, msg) {
  saveStateEl.textContent = msg ?? "";
  saveStateEl.className = "save-state" + (kind ? " " + kind : "");
}

// Autosave: a short pause after typing, or leaving the field, writes to SQLite
// through the history stack (so it can be undone). Consecutive edits of the
// same pin collapse into one history entry.
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
  const before = { label: entry.pin.label, notes: entry.pin.notes, category: entry.pin.category };
  const after = { label: labelInput.value.trim(), notes: notesInput.value, category: catSelect.value };
  if (before.label === after.label && before.notes === after.notes && before.category === after.category) { setSaveState(""); return; }

  lastCategory = after.category;
  const apply = async (values) => {
    const updated = await api.updatePin(id, values.label, values.notes, values.category);
    const e = pins.get(id);
    if (!e) return;
    e.pin = updated;
    e.marker.options.title = updated.label;
    e.marker.getElement()?.setAttribute("title", updated.label);
    e.marker.setIcon(pinIcon(colourFor(scheme, updated.category), { selected: selectedId === id }));
    applyFilter();
    if (selectedId === id) {
      labelInput.value = updated.label; notesInput.value = updated.notes; catSelect.value = updated.category;
      swatchEl.style.background = colourFor(scheme, updated.category);
    }
    renderLegend();
  };
  const cmd = {
    label: t("history.editPin"),
    pinId: id,
    before, after,
    do: () => apply(cmd.after),
    undo: () => apply(cmd.before),
    merge(next) { if (next.pinId !== id || !next.before || next.measBefore || next.capBefore != null) return false; cmd.after = next.after; return true; },
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
catSelect.addEventListener("change", () => { swatchEl.style.background = colourFor(scheme, catSelect.value); scheduleSave(); flushSave(); });
labelInput.addEventListener("blur", flushSave);
notesInput.addEventListener("blur", flushSave);
window.addEventListener("beforeunload", flushSave);

// ---- photos --------------------------------------------------------------------------
// Files are copied into the project (photos/<pinId>/) with a thumbnail. Attach and
// remove are undoable: a removed photo's files wait in the project's .trash.
const photoGrid = $("#photo-grid");
const photosNone = $("#photos-none");
const viewerEl = $("#viewer");
const viewerImg = $("#viewer-img");
const viewerCaption = $("#viewer-caption");
let photos = [];                 // the selected pin's photos, in order
let viewerIndex = -1;

function renderPhotos(list) {
  photos = list;
  photoGrid.innerHTML = "";
  photosNone.hidden = list.length > 0;
  list.forEach((ph, i) => {
    const b = document.createElement("button"); b.type = "button"; b.title = ph.caption;
    const img = document.createElement("img"); img.src = api.fileUrl(ph.thumb); img.alt = ph.caption; img.loading = "lazy";
    b.append(img);
    b.onclick = () => openViewer(i);
    photoGrid.append(b);
  });
  if (!viewerEl.hidden) {
    if (!list.length) closeViewer(); else showViewerIndex(Math.min(viewerIndex, list.length - 1));
  }
}

async function attachPhotosFlow() {
  if (selectedId == null) return;
  const id = selectedId;
  try {
    const paths = await api.pickImages(t("photos.pick"));
    if (!paths.length) return;
    let added = null;                                    // remembered so redo restores the same rows
    await history.run({
      label: t("history.addPhotos"),
      do: async () => {
        added = added ? await Promise.all(added.map((ph) => api.restorePhoto(ph))) : await api.addPhotos(id, paths);
        if (selectedId === id) renderPhotos(await api.listPhotos(id));
        setStatus(t("photos.added", { n: added.length }));
      },
      undo: async () => {
        for (const ph of added) await api.removePhoto(ph.id);
        if (selectedId === id) renderPhotos(await api.listPhotos(id));
      },
    });
  } catch (err) { showError(err); }
}
$("#btn-attach").addEventListener("click", attachPhotosFlow);

async function removePhotoFlow(index) {
  const ph = photos[index];
  if (!ph || !confirm(t("photos.removeConfirm"))) return;
  const id = ph.pinId;
  let snapshot = null;
  try {
    await history.run({
      label: t("history.removePhoto"),
      do: async () => {
        snapshot = await api.removePhoto(ph.id);
        if (selectedId === id) renderPhotos(await api.listPhotos(id));
        setStatus(t("photos.removed"));
      },
      undo: async () => {
        await api.restorePhoto(snapshot);
        if (selectedId === id) renderPhotos(await api.listPhotos(id));
      },
    });
  } catch (err) { showError(err); }
}

// ---- viewer
function openViewer(i) { viewerEl.hidden = false; showViewerIndex(i); }
function closeViewer() { flushCaption(); viewerEl.hidden = true; viewerIndex = -1; }
function showViewerIndex(i) {
  if (!photos.length) return closeViewer();
  flushCaption();
  viewerIndex = (i + photos.length) % photos.length;
  const ph = photos[viewerIndex];
  viewerImg.src = api.fileUrl(ph.file);
  viewerImg.alt = ph.caption;
  viewerCaption.value = ph.caption;
  $("#viewer-counter").textContent = t("photos.counter", { i: viewerIndex + 1, n: photos.length });
  $("#viewer-prev").disabled = $("#viewer-next").disabled = photos.length < 2;
}
$("#viewer-close").addEventListener("click", closeViewer);
$("#viewer-prev").addEventListener("click", () => showViewerIndex(viewerIndex - 1));
$("#viewer-next").addEventListener("click", () => showViewerIndex(viewerIndex + 1));
$("#viewer-remove").addEventListener("click", () => removePhotoFlow(viewerIndex));
viewerEl.addEventListener("click", (e) => { if (e.target === viewerEl || e.target.id === "viewer-stage") closeViewer(); });

// caption: autosave, one undo step per photo edit (consecutive edits of the same photo merge)
let captionTimer = null;
let captionDirty = null;         // photo id with unsaved caption text
function scheduleCaption() {
  if (viewerIndex < 0) return;
  captionDirty = photos[viewerIndex].id;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(flushCaption, 600);
}
async function flushCaption() {
  clearTimeout(captionTimer);
  if (captionDirty == null) return;
  const id = captionDirty; captionDirty = null;
  const ph = photos.find((p) => p.id === id);
  if (!ph) return;
  const before = ph.caption, after = viewerCaption.value.trim();
  if (before === after) return;
  const apply = async (text) => {
    const updated = await api.setPhotoCaption(id, text);
    const i = photos.findIndex((p) => p.id === id);
    if (i >= 0) { photos[i] = updated; photoGrid.children[i]?.setAttribute("title", updated.caption); }
    if (viewerIndex === i) viewerCaption.value = updated.caption;
  };
  const cmd = { label: t("history.caption"), photoId: id, capBefore: before, capAfter: after,
    do: () => apply(cmd.capAfter), undo: () => apply(cmd.capBefore),
    merge(next) { if (next.photoId !== id || next.capBefore == null) return false; cmd.capAfter = next.capAfter; return true; } };
  try { await history.run(cmd); } catch (err) { showError(err); }
}
viewerCaption.addEventListener("input", scheduleCaption);
viewerCaption.addEventListener("blur", flushCaption);

// ---- measurements --------------------------------------------------------------------
// The pin's measurements are edited as one list. Height and depth are fixed rows;
// distances are added rows. Each saved change (one field, one added or removed
// row) is its own undo step, so Ctrl+Z steps back one measurement at a time.
const measHeight = $("#meas-height");
const measDepth = $("#meas-depth");
const measDistances = $("#meas-distances");
const measError = $("#meas-error");
let measurements = [];           // the saved list for the selected pin
let measTimer = null;
let measDirtyId = null;

function distanceRow(m = { reference: "", valueCm: null }) {
  const row = document.createElement("div"); row.className = "dist-row";
  const ref = document.createElement("input"); ref.type = "text"; ref.className = "ref"; ref.autocomplete = "off";
  ref.placeholder = t("meas.refPlaceholder"); ref.value = m.reference ?? "";
  const val = document.createElement("input"); val.type = "text"; val.className = "val"; val.inputMode = "decimal"; val.autocomplete = "off";
  val.placeholder = t("meas.valuePlaceholder"); val.value = inputCm(m.valueCm);
  const x = document.createElement("button"); x.type = "button"; x.className = "icon-btn x"; x.textContent = "×"; x.title = t("meas.remove");
  const fmt = document.createElement("span"); fmt.className = "meas-fmt"; fmt.textContent = formatCm(m.valueCm, currentLanguage());
  x.onclick = () => { row.remove(); scheduleMeasSave(); flushMeasSave(); };
  for (const el of [ref, val]) { el.addEventListener("input", scheduleMeasSave); el.addEventListener("blur", flushMeasSave); }
  val.addEventListener("input", () => { const v = parseCm(val.value); fmt.textContent = Number.isNaN(v) ? "" : formatCm(v, currentLanguage()); });
  row.append(ref, val, x, fmt);
  return row;
}

function renderMeasurements(list) {
  measurements = list;
  const h = list.find((m) => m.kind === "height");
  const d = list.find((m) => m.kind === "depth");
  measHeight.value = inputCm(h?.valueCm ?? null);
  measDepth.value = inputCm(d?.valueCm ?? null);
  $("#meas-height-fmt").textContent = formatCm(h?.valueCm ?? null, currentLanguage());
  $("#meas-depth-fmt").textContent = formatCm(d?.valueCm ?? null, currentLanguage());
  measDistances.innerHTML = "";
  for (const m of list.filter((m) => m.kind === "distance")) measDistances.append(distanceRow(m));
  measError.hidden = true;
  for (const el of [measHeight, measDepth]) el.classList.remove("invalid");
}

/** Read the form back into a list. Returns null (and marks the field) if something is not a length. */
function readMeasurements() {
  const out = [];
  let bad = false;
  const take = (input, kind, reference = "") => {
    const v = parseCm(input.value);
    input.classList.toggle("invalid", Number.isNaN(v));
    if (Number.isNaN(v)) { bad = true; return; }
    if (v != null) out.push({ kind, reference, valueCm: v });
  };
  take(measHeight, "height");
  take(measDepth, "depth");
  for (const row of measDistances.querySelectorAll(".dist-row")) {
    take(row.querySelector(".val"), "distance", row.querySelector(".ref").value.trim());
  }
  measError.hidden = !bad;
  if (bad) measError.textContent = t("meas.invalid");
  return bad ? null : out;
}
const sameList = (a, b) => JSON.stringify(a.map(({ kind, reference, valueCm }) => [kind, reference, valueCm]))
                        === JSON.stringify(b.map(({ kind, reference, valueCm }) => [kind, reference, valueCm]));

function scheduleMeasSave() {
  if (selectedId == null) return;
  measDirtyId = selectedId;
  clearTimeout(measTimer);
  measTimer = setTimeout(flushMeasSave, 700);
}
async function flushMeasSave() {
  clearTimeout(measTimer);
  if (measDirtyId == null) return;
  const id = measDirtyId;
  const after = readMeasurements();
  if (after == null) return;                       // invalid input: keep dirty, wait for a fix
  measDirtyId = null;
  const before = measurements;
  if (sameList(before, after)) return;
  const apply = async (list) => {
    const saved = await api.setMeasurements(id, list);
    if (selectedId === id) renderMeasurements(saved);
  };
  const cmd = {
    label: t("history.editMeasurements"), pinId: id, measBefore: before, measAfter: after,
    do: () => apply(cmd.measAfter),
    undo: () => apply(cmd.measBefore),
    // deliberately no merge(): one undo step per saved change
  };
  try { await history.run(cmd); if (selectedId === id) setSaveState("ok", t("panel.saved")); }
  catch (err) { showError(err); }
}
for (const el of [measHeight, measDepth]) {
  el.addEventListener("input", () => {
    const v = parseCm(el.value);
    $(el === measHeight ? "#meas-height-fmt" : "#meas-depth-fmt").textContent = Number.isNaN(v) ? "" : formatCm(v, currentLanguage());
    scheduleMeasSave();
  });
  el.addEventListener("blur", flushMeasSave);
}
$("#meas-add").addEventListener("click", () => {
  const row = distanceRow();
  measDistances.append(row);
  row.querySelector(".ref").focus();
});

$("#pin-delete").addEventListener("click", async () => {
  if (selectedId == null || !confirm(t("panel.deleteConfirm"))) return;
  const id = selectedId;
  await flushSave();
  await flushMeasSave();
  const snapshot = { ...pins.get(id).pin };
  const measSnapshot = await api.listMeasurements(id);   // removed with the pin; undo puts them back
  const photoSnapshot = await api.listPhotos(id);        // rows go with the pin; the files stay, so rows are re-inserted on undo
  try {
    await history.run({
      label: t("history.deletePin"),
      do: async () => {
        await api.deletePin(id);
        removeMarker(id);
        if (selectedId === id) hidePanel();
        setStatus(t("status.deleted", { id }));
      },
      undo: async () => {
        const pin = await api.restorePin(snapshot);
        if (measSnapshot.length) await api.setMeasurements(pin.id, measSnapshot);
        for (const ph of photoSnapshot) await api.restorePhoto(ph);
        addMarker(pin);
        showPin(pin.id);
      },
    });
  } catch (err) { showError(err); }
});

// ---- markers -------------------------------------------------------------------------
function addMarker(pin) {
  const marker = L.marker(toLatLng(pin.x, pin.y), { title: pin.label, icon: pinIcon(colourFor(scheme, pin.category)) })
    .addTo(map)
    .on("click", () => { flushSave(); flushMeasSave(); showPin(pin.id); });
  pins.set(pin.id, { pin, marker });
  applyFilter(); renderLegend();
  return marker;
}
function removeMarker(id) {
  pins.get(id)?.marker.remove();
  pins.delete(id);
  renderLegend();
}

// ---- legend: colours for the current scheme; click a row to hide/show that category
const legendEl = $("#legend");
const legendList = $("#legend-list");
const schemeSelect = $("#scheme-select");

function applyFilter() {
  for (const { pin, marker } of pins.values()) {
    const off = hiddenCats.has(pin.category);
    marker.getElement()?.classList.toggle("dimmed", off);
    marker.setOpacity(off ? 0.15 : 1);
  }
}
function renderLegend() {
  legendList.innerHTML = "";
  const counts = {};
  for (const { pin } of pins.values()) counts[pin.category] = (counts[pin.category] ?? 0) + 1;
  for (const c of CATEGORIES) {
    const li = document.createElement("li");
    li.classList.toggle("off", hiddenCats.has(c));
    const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = colourFor(scheme, c);
    const name = document.createElement("span"); name.textContent = t("cat." + c);
    const n = document.createElement("span"); n.className = "count"; n.textContent = counts[c] ?? "";
    li.append(sw, name, n);
    li.onclick = () => { hiddenCats.has(c) ? hiddenCats.delete(c) : hiddenCats.add(c); li.classList.toggle("off"); applyFilter(); };
    legendList.append(li);
  }
  schemeSelect.innerHTML = "";
  for (const k of Object.keys(SCHEMES)) schemeSelect.add(new Option(t("scheme." + k), k));
  schemeSelect.value = scheme;
}
schemeSelect.addEventListener("change", async () => {
  try {
    project = await api.setColourScheme(schemeSelect.value);
    scheme = project.colourScheme;
    for (const [pid, e] of pins) e.marker.setIcon(pinIcon(colourFor(scheme, e.pin.category), { selected: pid === selectedId }));
    applyFilter();
    if (selectedId != null) swatchEl.style.background = colourFor(scheme, pins.get(selectedId).pin.category);
    renderLegend();
  } catch (err) { showError(err); }
});

// ---- "Add pin" mode ------------------------------------------------------------------
function setPlacing(on) {
  placing = on && !!level;
  addBtn.setAttribute("aria-pressed", String(placing));
  addBtn.textContent = t(placing ? "toolbar.cancel" : "toolbar.addPin");
  planEl.classList.toggle("placing", placing);
  setStatus(t(placing ? "toolbar.addPinActive" : "status.ready"));
}
addBtn.addEventListener("click", () => setPlacing(!placing));

let lastCategory = "other";      // a run of similar pins should not need re-picking the category
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
        created = created ? await api.restorePin(created) : await api.addPin(level.id, x, y, "", "", lastCategory);
        addMarker(created);
        setPlacing(false);
        showPin(created.id, { focus: true });
        setStatus(t("status.saved", { id: created.id, x, y }));
      },
      undo: async () => {
        created = { ...pins.get(created.id)?.pin ?? created };
        await api.deletePin(created.id);
        removeMarker(created.id);
        if (selectedId === created.id) hidePanel();
      },
    });
  } catch (err) { showError(err); }
}

// ---- undo / redo: toolbar buttons and keyboard --------------------------------------
const undoBtn = $("#btn-undo");
const redoBtn = $("#btn-redo");
let historyState = { canUndo: false, canRedo: false };
history.onChange((st) => { historyState = st; undoBtn.disabled = !st.canUndo; redoBtn.disabled = !st.canRedo; });
async function doUndo() {
  if (!historyState.canUndo) return;
  const what = historyState.undoLabel;
  await flushSave();
  await flushMeasSave();
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
  if (!viewerEl.hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeViewer(); return; }
    if (document.activeElement !== viewerCaption) {
      if (e.key === "ArrowLeft") { e.preventDefault(); showViewerIndex(viewerIndex - 1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); showViewerIndex(viewerIndex + 1); return; }
    }
  }
  if (e.key === "Escape") { if (placing) setPlacing(false); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (history.focusIsInTextField()) {
    // While there is unsaved typing, Ctrl+Z is the text field's own undo.
    // Once saved (or nothing typed) it means the app's undo.
    if (dirtyId != null || measDirtyId != null || captionDirty != null || !["z", "y"].includes(k)) return;
    document.activeElement.blur();
  }
  if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); doRedo(); }
});

// ---- language switcher (one select in each header, kept in sync) -------------------
const langSelects = [...document.querySelectorAll(".lang-select")];
for (const sel of langSelects) {
  for (const [code, name] of Object.entries(SUPPORTED)) sel.add(new Option(name, code));
  sel.addEventListener("change", () => setLanguage(sel.value));
}
document.addEventListener("languagechange", (e) => {
  for (const sel of langSelects) sel.value = e.detail.lang;
  fillCategorySelect();
  if (level) renderLegend();
  if (selectedId != null && measDirtyId == null) renderMeasurements(measurements);
  if (selectedId != null && dirtyId == null) showPin(selectedId);
  setPlacing(placing);
});

// ---- screens: the main menu and the plan --------------------------------------------
function showScreen(which) {
  const plan = which === "plan";
  $("#menu-bar").hidden = plan;
  $("#plan-bar").hidden = !plan;
  $("#status").hidden = !plan;
  planEl.hidden = !plan;
  if (!plan) { panelEl.hidden = true; emptyEl.hidden = true; legendEl.hidden = true; }
}

// ---- levels --------------------------------------------------------------------------
function loadImageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

function renderLevelSelect() {
  levelSelect.innerHTML = "";
  for (const l of levels) levelSelect.add(new Option(l.name, String(l.id)));
  levelSelect.parentElement.hidden = levels.length < 2;
  if (level) levelSelect.value = String(level.id);
}
levelSelect.addEventListener("change", () => {
  const next = levels.find((l) => String(l.id) === levelSelect.value);
  if (next) showLevel(next).catch(showError);
});

async function showLevel(lvl) {
  await flushSave();
  await flushMeasSave();
  hidePanel();
  history.clear();
  if (map) { map.remove(); map = null; }
  pins = new Map();
  level = lvl;
  renderLevelSelect();
  emptyEl.hidden = !!lvl;
  legendEl.hidden = !lvl;
  addBtn.disabled = !lvl;
  if (!lvl) { setStatus(t("start.title")); return 0; }

  const url = api.fileUrl(lvl.imageFile);
  const { width, height } = await loadImageSize(url);
  imageHeight = height;
  // In CRS.Simple one map unit = one image pixel at zoom 0. Bounds are
  // [[south, west], [north, east]] = [[0, 0], [height, width]].
  bounds = L.latLngBounds([[0, 0], [height, width]]);
  map = L.map("plan", {
    crs: L.CRS.Simple,
    minZoom: -3, maxZoom: 3, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
    attributionControl: false,
    maxBounds: bounds.pad(0.5), maxBoundsViscosity: 0.6,
  });
  L.imageOverlay(url, bounds).addTo(map);
  map.fitBounds(bounds);
  map.on("click", (e) => {
    if (placing) return createPinAt(e.latlng);
    setStatus(t("status.clicked", toPixel(e.latlng)));
  });

  const list = await api.listPins(lvl.id);
  list.forEach(addMarker);
  setStatus(t("status.ready"));
  return list.length;
}

$("#btn-fit").addEventListener("click", () => map && map.fitBounds(bounds));

async function importPlanFlow() {
  try {
    const src = await api.pickImage(t("toolbar.importPlan"));
    if (!src) return;
    const suggested = src.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
    const name = await askText(t("plan.namePrompt"), { placeholder: t("plan.namePlaceholder"), value: suggested });
    if (!name) return;
    const lvl = await api.importPlan(src, name);
    levels.push(lvl);
    await showLevel(lvl);
    setStatus(t("plan.imported", { name: lvl.name }));
  } catch (err) { showError(err); }
}
$("#btn-import-plan").addEventListener("click", importPlanFlow);
$("#start-import").addEventListener("click", importPlanFlow);

// ---- projects ------------------------------------------------------------------------
async function onProjectOpened(p) {
  project = p;
  scheme = p.colourScheme || "it";
  hiddenCats.clear();
  $("#project-name").textContent = p.name;
  showScreen("plan");
  levels = await api.listLevels();
  await showLevel(levels[0] ?? null);
  if (map) map.invalidateSize();       // the plan area was hidden while the menu was up
}
$("#btn-projects").addEventListener("click", async () => { await flushSave(); projects.show(); });

// ---- boot ----------------------------------------------------------------------------
async function main() {
  const lang = detectLanguage();
  await setLanguage(lang);           // fills every data-i18n element and fires languagechange
  setPlacing(false);
  fillCategorySelect();
  addBtn.disabled = true;
  showScreen("menu");
  projects.init(onProjectOpened, () => showScreen("menu"));
  await projects.start();            // reopens the last project or shows the chooser
}

// The webview's default right-click menu (back / forward / reload / inspect) is a
// browser artefact. Suppress it in release builds; keep it in development for Inspect.
if (import.meta.env.PROD) document.addEventListener("contextmenu", (e) => e.preventDefault());

main().catch(showError);
