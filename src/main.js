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
import { setStatus, showError, askText, showContextMenu } from "./ui.js";
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
let selectedId = null;           // pin open in the panel (always part of the selection)
const selection = new Set();     // selected pin ids — the target of Ctrl+C/X, Delete, edit mode
let editingId = null;            // the one pin currently unlocked for dragging (#8)
let clipboard = [];              // copied pins: { pin, measurements }
let cursorLatLng = null;         // where the mouse is over the plan (for paste), or null
let placing = false;             // "Add pin" mode: next click on the plan creates a pin
let scheme = "it";               // the project's colour scheme ("it" | "apwa")
let rooms = [];                  // this level's rooms: { room, poly, layer, label }
let selectedRoomId = null;       // room open in the room panel
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

function refreshIcons() {
  for (const [pid, e] of pins) {
    e.marker.setIcon(pinIcon(colourFor(scheme, e.pin.category), { selected: selection.has(pid) }));
    if (pid === editingId) e.marker.getElement()?.classList.add("editing");
  }
  applyFilter();
}
function setSelection(ids) {
  selection.clear();
  for (const id of ids) if (pins.has(id)) selection.add(id);
  if (selectedId != null && !selection.has(selectedId)) selectedId = null, panelEl.hidden = true;
  refreshIcons();
  if (selection.size > 1) setStatus(t("status.selected", { n: selection.size }));
}

function showPin(id, { focus = false, keepSelection = false } = {}) {
  const entry = pins.get(id);
  if (!entry) return;
  const { pin } = entry;
  if (editingId != null && editingId !== id) setEditing(null);
  if (!roomPanelEl.hidden) hideRoomPanel();
  selectedId = id;
  if (!keepSelection) { selection.clear(); }
  selection.add(id);
  labelInput.value = pin.label;
  notesInput.value = pin.notes;
  catSelect.value = pin.category;
  swatchEl.style.background = colourFor(scheme, pin.category);
  refreshIcons();
  $("#pin-edit-pos").setAttribute("aria-pressed", String(editingId === id));
  $("#pin-edit-pos").textContent = t(editingId === id ? "panel.donePosition" : "panel.editPosition");
  $("#pin-position").textContent = t("panel.positionValue", { x: Math.round(pin.x), y: Math.round(pin.y) });
  $("#pin-created").textContent = new Date(pin.createdAt).toLocaleString(currentLanguage());
  setSaveState("");
  panelEl.hidden = false;
  renderMeasurements([]);
  renderPhotos([]);
  refreshPinRoom();
  api.listMeasurements(id).then((list) => { if (selectedId === id) renderMeasurements(list); }).catch(showError);
  api.listPhotos(id).then((list) => { if (selectedId === id) renderPhotos(list); }).catch(showError);
  if (focus) { labelInput.focus(); labelInput.select(); }
}
function hidePanel() {
  flushSave();
  flushMeasSave();
  if (!viewerEl.hidden) closeViewer();
  if (editingId != null) setEditing(null);
  panelEl.hidden = true;
  selectedId = null;
  selection.clear();
  refreshIcons();
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
  const before = { label: entry.pin.label, notes: entry.pin.notes, category: entry.pin.category, roomId: entry.pin.roomId ?? null };
  const after = { label: labelInput.value.trim(), notes: notesInput.value, category: catSelect.value,
                  roomId: pinRoomSelect.value ? Number(pinRoomSelect.value) : null };
  if (before.label === after.label && before.notes === after.notes && before.category === after.category && before.roomId === after.roomId) { setSaveState(""); return; }

  lastCategory = after.category;
  const apply = async (values) => {
    const updated = await api.updatePin(id, values.label, values.notes, values.category, values.roomId);
    const e = pins.get(id);
    if (!e) return;
    e.pin = updated;
    e.marker.options.title = updated.label;
    e.marker.getElement()?.setAttribute("title", updated.label);
    refreshIcons();
    if (selectedId === id) {
      labelInput.value = updated.label; notesInput.value = updated.notes; catSelect.value = updated.category;
      pinRoomSelect.value = updated.roomId != null ? String(updated.roomId) : "";
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

$("#pin-delete").addEventListener("click", () => { if (selectedId != null) { setSelection([selectedId]); deleteSelection(); } });

// ---- markers -------------------------------------------------------------------------
function addMarker(pin) {
  const marker = L.marker(toLatLng(pin.x, pin.y), { title: pin.label, icon: pinIcon(colourFor(scheme, pin.category)) })
    .addTo(map)
    .on("click", (e) => {
      flushSave(); flushMeasSave();
      const oe = e.originalEvent;
      if (oe && (oe.ctrlKey || oe.metaKey || oe.shiftKey)) {          // toggle membership, keep the panel as it is
        selection.has(pin.id) ? selection.delete(pin.id) : selection.add(pin.id);
        if (selectedId === pin.id && !selection.has(pin.id)) { panelEl.hidden = true; selectedId = null; }
        refreshIcons();
        setStatus(t("status.selected", { n: selection.size }));
        return;
      }
      showPin(pin.id);
    })
  marker.on("contextmenu", (e) => { L.DomEvent.stop(e); pinMenu(pin.id, { x: e.originalEvent.clientX, y: e.originalEvent.clientY }); });
  pins.set(pin.id, { pin, marker });
  applyFilter(); renderLegend();
  return marker;
}
function removeMarker(id) {
  pins.get(id)?.marker.remove();
  pins.delete(id);
  selection.delete(id);
  if (editingId === id) editingId = null;
  renderLegend();
}

// ---- edit mode (#8): the selected pin is unlocked; clicking the plan moves it there ----
function setEditing(id) {
  if (editingId != null) pins.get(editingId)?.marker.getElement()?.classList.remove("editing");
  editingId = id;
  planEl.classList.toggle("moving", id != null);
  if (id != null) {
    pins.get(id)?.marker.getElement()?.classList.add("editing");
    setStatus(t("status.editPosition"));
  } else {
    setStatus(t("status.ready"));
  }
  if (selectedId != null) {
    $("#pin-edit-pos").setAttribute("aria-pressed", String(editingId === selectedId));
    $("#pin-edit-pos").textContent = t(editingId === selectedId ? "panel.donePosition" : "panel.editPosition");
  }
}
$("#pin-edit-pos").addEventListener("click", () => { if (selectedId != null) setEditing(editingId === selectedId ? null : selectedId); });

/** Move the pin in edit mode to a clicked point. Each click is one undo step. */
async function movePinTo(id, latlng) {
  const e = pins.get(id);
  if (!e) return;
  const before = { x: e.pin.x, y: e.pin.y };
  const after = toPixel(latlng);
  if (before.x === after.x && before.y === after.y) return;
  const apply = async (pos) => {
    const updated = await api.movePin(id, pos.x, pos.y);
    const en = pins.get(id);
    if (!en) return;
    en.pin = updated;
    en.marker.setLatLng(toLatLng(updated.x, updated.y));
    if (editingId === id) en.marker.getElement()?.classList.add("editing");
    if (selectedId === id) $("#pin-position").textContent = t("panel.positionValue", { x: Math.round(updated.x), y: Math.round(updated.y) });
  };
  try { await history.run({ label: t("history.movePin"), do: () => apply(after), undo: () => apply(before) }); }
  catch (err) { showError(err); }
}

// ---- room labels ---------------------------------------------------------------------
// A room is a NAME placed on the plan, not a traced outline: the drawing already shows
// where the rooms are, so tracing them is work for no gain. Which room a pin belongs to
// is recorded on the pin itself (its Room field), chosen by the user.
const roomPanelEl = $("#room-panel");
const roomNameInput = $("#room-name");
const roomCeilingInput = $("#room-ceiling");
const roomBtn = $("#btn-room");
const pinRoomSelect = $("#pin-room");

let roomLayer = null;            // Leaflet layer group holding the labels
let placingRoom = false;         // next plan click drops a new label
let movingRoomId = null;         // label being repositioned (click-to-move, like pins)

function roomLabelHtml(room, selected) {
  const h = room.ceilingCm ? `<span class="h">H ${(room.ceilingCm / 100).toFixed(2)} m</span>` : "";
  return `<div class="room-label${selected ? " selected" : ""}${movingRoomId === room.id ? " moving" : ""}">${escapeHtml(room.name)}${h}</div>`;
}
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function renderRooms() {
  roomLayer?.clearLayers();
  for (const r of rooms) {
    const marker = L.marker(toLatLng(r.x, r.y), {
      icon: L.divIcon({ className: "", html: roomLabelHtml(r, selectedRoomId === r.id), iconSize: [0, 0] }),
    }).addTo(roomLayer);
    marker.on("click", (e) => { L.DomEvent.stop(e); if (!placing && !placingRoom && editingId == null) showRoom(r.id); });
    marker.on("contextmenu", (e) => { L.DomEvent.stop(e); roomMenu(r.id, { x: e.originalEvent.clientX, y: e.originalEvent.clientY }); });
  }
  fillPinRoomSelect();
}

async function reloadRooms() {
  rooms = level ? await api.listRooms(level.id) : [];
  renderRooms();
}

// ---- placing a new label
function setPlacingRoom(on) {
  placingRoom = on && !!level;
  planEl.classList.toggle("drawing", placingRoom);
  roomBtn.setAttribute("aria-pressed", String(placingRoom));
  roomBtn.textContent = t(placingRoom ? "toolbar.cancel" : "room.add");
  setStatus(t(placingRoom ? "room.placing" : "status.ready"));
}
roomBtn.addEventListener("click", () => setPlacingRoom(!placingRoom));

async function createRoomAt(latlng) {
  const { x, y } = toPixel(latlng);
  setPlacingRoom(false);
  const name = await askText(t("room.namePrompt"), { placeholder: t("room.namePlaceholder") });
  if (!name) return;
  let created = null;
  try {
    await history.run({
      label: t("history.addRoom"),
      do: async () => {
        created = created ? await api.restoreRoom(created) : await api.addRoom(level.id, name, null, x, y);
        await reloadRooms();
        showRoom(created.id);
        setStatus(t("room.added", { name: created.name }));
      },
      undo: async () => { await api.deleteRoom(created.id); hideRoomPanel(); await reloadRooms(); },
    });
  } catch (err) { showError(err); }
}

// ---- room panel
function showRoom(id) {
  const room = rooms.find((r) => r.id === id);
  if (!room) return;
  hidePanel();
  selectedRoomId = id;
  roomNameInput.value = room.name;
  roomCeilingInput.value = inputCm(room.ceilingCm ?? null);
  $("#room-ceiling-fmt").textContent = formatCm(room.ceilingCm ?? null, currentLanguage());
  $("#room-save-state").textContent = "";
  $("#room-move").setAttribute("aria-pressed", String(movingRoomId === id));
  $("#room-move").textContent = t(movingRoomId === id ? "room.moveDone" : "room.move");
  roomPanelEl.hidden = false;
  renderRooms();
}
function hideRoomPanel() {
  flushRoomSave();
  if (movingRoomId != null) setMovingRoom(null);
  roomPanelEl.hidden = true;
  selectedRoomId = null;
  renderRooms();
}
$("#room-close").addEventListener("click", hideRoomPanel);

let roomTimer = null, roomDirty = null;
function scheduleRoomSave() {
  if (selectedRoomId == null) return;
  roomDirty = selectedRoomId;
  $("#room-save-state").textContent = t("panel.saving");
  clearTimeout(roomTimer);
  roomTimer = setTimeout(flushRoomSave, 600);
}
async function flushRoomSave() {
  clearTimeout(roomTimer);
  if (roomDirty == null) return;
  const id = roomDirty; roomDirty = null;
  const room = rooms.find((r) => r.id === id);
  if (!room) return;
  const ceiling = parseCm(roomCeilingInput.value);
  if (Number.isNaN(ceiling)) { $("#room-save-state").textContent = t("meas.invalid"); return; }
  const before = { name: room.name, ceilingCm: room.ceilingCm ?? null };
  const after = { name: roomNameInput.value.trim(), ceilingCm: ceiling };
  if (before.name === after.name && before.ceilingCm === after.ceilingCm) { $("#room-save-state").textContent = ""; return; }
  const apply = async (v) => {
    const updated = await api.updateRoom(id, v.name, v.ceilingCm, room.x, room.y);
    const i = rooms.findIndex((r) => r.id === id);
    if (i >= 0) rooms[i] = updated;
    renderRooms();
    if (selectedId != null) refreshPinRoom();
    if (selectedRoomId === id) {
      roomNameInput.value = updated.name;
      roomCeilingInput.value = inputCm(updated.ceilingCm ?? null);
      $("#room-ceiling-fmt").textContent = formatCm(updated.ceilingCm ?? null, currentLanguage());
    }
  };
  const cmd = { label: t("history.editRoom"), roomId: id, roomBefore: before, roomAfter: after,
    do: () => apply(cmd.roomAfter), undo: () => apply(cmd.roomBefore),
    merge(next) { if (next.roomId !== id || !next.roomBefore) return false; cmd.roomAfter = next.roomAfter; return true; } };
  try { await history.run(cmd); if (selectedRoomId === id) $("#room-save-state").textContent = t("panel.saved"); }
  catch (err) { showError(err); }
}
roomNameInput.addEventListener("input", scheduleRoomSave);
roomCeilingInput.addEventListener("input", () => {
  const v = parseCm(roomCeilingInput.value);
  $("#room-ceiling-fmt").textContent = Number.isNaN(v) ? "" : formatCm(v, currentLanguage());
  scheduleRoomSave();
});
for (const el of [roomNameInput, roomCeilingInput]) el.addEventListener("blur", flushRoomSave);

// ---- moving a label: click-to-move, the same gesture as a pin's Edit position
function setMovingRoom(id) {
  movingRoomId = id;
  planEl.classList.toggle("moving", id != null);
  setStatus(t(id != null ? "room.moving" : "status.ready"));
  if (selectedRoomId != null) {
    $("#room-move").setAttribute("aria-pressed", String(movingRoomId === selectedRoomId));
    $("#room-move").textContent = t(movingRoomId === selectedRoomId ? "room.moveDone" : "room.move");
  }
  renderRooms();
}
$("#room-move").addEventListener("click", () => { if (selectedRoomId != null) setMovingRoom(movingRoomId === selectedRoomId ? null : selectedRoomId); });

async function moveRoomTo(id, latlng) {
  const room = rooms.find((r) => r.id === id);
  if (!room) return;
  const before = { x: room.x, y: room.y };
  const after = toPixel(latlng);
  if (before.x === after.x && before.y === after.y) return;
  const apply = async (pos) => {
    const updated = await api.updateRoom(id, room.name, room.ceilingCm ?? null, pos.x, pos.y);
    const i = rooms.findIndex((r) => r.id === id);
    if (i >= 0) rooms[i] = updated;
    renderRooms();
  };
  try { await history.run({ label: t("history.moveRoom"), do: () => apply(after), undo: () => apply(before) }); }
  catch (err) { showError(err); }
}

async function deleteRoomFlow(id) {
  const room = rooms.find((r) => r.id === id);
  if (!room || !confirm(t("room.deleteConfirm", { name: room.name }))) return;
  const snapshot = { ...room };
  try {
    await history.run({
      label: t("history.deleteRoom"),
      do: async () => {
        await api.deleteRoom(id);
        if (selectedRoomId === id) hideRoomPanel();
        await reloadRooms();
        await reloadPinsRoomTags();
        setStatus(t("room.deleted", { name: snapshot.name }));
      },
      undo: async () => { await api.restoreRoom(snapshot); await reloadRooms(); showRoom(snapshot.id); },
    });
  } catch (err) { showError(err); }
}
$("#room-delete").addEventListener("click", () => selectedRoomId != null && deleteRoomFlow(selectedRoomId));

function roomMenu(id, at) {
  showContextMenu([
    { text: t("menu.open"), action: () => showRoom(id) },
    { text: t("room.move"), action: () => { showRoom(id); setMovingRoom(id); } },
    { separator: true },
    { text: t("room.delete"), action: () => deleteRoomFlow(id) },
  ], at);
}

// ---- the pin's own Room field
function fillPinRoomSelect() {
  const current = pinRoomSelect.value;
  pinRoomSelect.innerHTML = "";
  pinRoomSelect.add(new Option(t("panel.roomNone"), ""));
  for (const r of rooms) pinRoomSelect.add(new Option(r.name, String(r.id)));
  if (current) pinRoomSelect.value = current;
}
function refreshPinRoom() {
  const pin = selectedId != null ? pins.get(selectedId)?.pin : null;
  fillPinRoomSelect();
  pinRoomSelect.value = pin?.roomId != null ? String(pin.roomId) : "";
}
/** After a label is deleted the database clears the tag; refresh what is on screen. */
async function reloadPinsRoomTags() {
  if (!level) return;
  const list = await api.listPins(level.id);
  for (const p of list) { const e = pins.get(p.id); if (e) e.pin = p; }
  if (selectedId != null) refreshPinRoom();
}
pinRoomSelect.addEventListener("change", () => { scheduleSave(); flushSave(); });

// ---- right-click menus (#11): drawn by the app, same actions as buttons and keys ------
// (A native GTK popup opened from JavaScript is dismissed instantly on Wayland — it
// needs the originating input event, which is gone by the time the call reaches Rust.
// The in-app menu behaves identically on Linux, macOS and Windows.)
function planMenu(latlng, at) {
  const items = [
    { text: t("menu.addPinHere"), action: () => createPinAt(latlng) },
    { text: t("menu.addRoomHere"), action: () => createRoomAt(latlng) },
    { text: t("menu.pasteHere"), enabled: clipboard.length > 0, action: () => { cursorLatLng = latlng; pasteClipboard(); } },
    { separator: true },
    { text: t("menu.fitView"), action: () => map && map.fitBounds(bounds) },
  ];
  showContextMenu(items, at);
}
function pinMenu(id, at) {
  // Right-clicking a pin outside the current selection selects just that pin.
  if (!selection.has(id)) { selection.clear(); selection.add(id); refreshIcons(); }
  const n = selection.size;
  const items = [
    { text: t("menu.open"), action: () => showPin(id) },
    { text: t("menu.showPhotos"), action: async () => {
        showPin(id);
        try { const list = await api.listPhotos(id); if (selectedId === id) { renderPhotos(list); if (list.length) openViewer(0); else setStatus(t("photos.none")); } }
        catch (err) { showError(err); }
      } },
    { text: t("menu.editPosition"), action: () => { showPin(id); setEditing(id); } },
    { separator: true },
    { text: n > 1 ? t("menu.copyMany", { n }) : t("menu.copy"), action: () => copySelection().catch(showError) },
    { text: n > 1 ? t("menu.deleteMany", { n }) : t("menu.delete"), action: () => deleteSelection() },
  ];
  showContextMenu(items, at);
}

// ---- clipboard and multi-pin operations (#13) ---------------------------------------
function selectedEntries() { return [...selection].map((id) => pins.get(id)).filter(Boolean); }

/** Snapshot the selected pins with their measurements (photos are not copied). */
async function copySelection() {
  const entries = selectedEntries();
  if (!entries.length) return false;
  clipboard = await Promise.all(entries.map(async ({ pin }) => ({ pin: { ...pin }, measurements: await api.listMeasurements(pin.id) })));
  setStatus(t("status.copied", { n: clipboard.length }));
  return true;
}

/** Paste at the cursor if it is over the plan, else slightly offset from the originals. */
async function pasteClipboard() {
  if (!clipboard.length || !level) { setStatus(t("status.nothingToPaste")); return; }
  const anchor = clipboard[0].pin;
  const target = cursorLatLng ? toPixel(cursorLatLng) : { x: anchor.x + 30, y: anchor.y + 30 };
  const dx = target.x - anchor.x, dy = target.y - anchor.y;
  let created = null;                                       // remembered so redo restores the same ids
  try {
    await history.run({
      label: t("history.pastePins"),
      do: async () => {
        if (created) {
          for (const c of created) { const pin = await api.restorePin(c.pin); if (c.measurements.length) await api.setMeasurements(pin.id, c.measurements); addMarker(pin); }
        } else {
          created = [];
          for (const c of clipboard) {
            const pin = await api.addPin(level.id, c.pin.x + dx, c.pin.y + dy, c.pin.label, c.pin.notes, c.pin.category);
            if (c.measurements.length) await api.setMeasurements(pin.id, c.measurements);
            created.push({ pin, measurements: c.measurements });
            addMarker(pin);
          }
        }
        setSelection(created.map((c) => c.pin.id));
        setStatus(t("status.pasted", { n: created.length }));
      },
      undo: async () => {
        for (const c of created) { await api.deletePin(c.pin.id); removeMarker(c.pin.id); }
        if (created.some((c) => c.pin.id === selectedId)) { panelEl.hidden = true; selectedId = null; }
        refreshIcons();
      },
    });
  } catch (err) { showError(err); }
}

/** Delete every selected pin as one undo step, restoring measurements and photos on undo. */
async function deleteSelection({ confirmFirst = true } = {}) {
  const entries = selectedEntries();
  if (!entries.length) return;
  if (confirmFirst && !confirm(entries.length === 1 ? t("panel.deleteConfirm") : t("panel.deleteManyConfirm", { n: entries.length }))) return;
  await flushSave(); await flushMeasSave();
  const snaps = await Promise.all(entries.map(async ({ pin }) => ({
    pin: { ...pin }, measurements: await api.listMeasurements(pin.id), photos: await api.listPhotos(pin.id),
  })));
  try {
    await history.run({
      label: entries.length === 1 ? t("history.deletePin") : t("history.deletePins"),
      do: async () => {
        for (const sn of snaps) { await api.deletePin(sn.pin.id); removeMarker(sn.pin.id); }
        if (snaps.some((sn) => sn.pin.id === selectedId)) { panelEl.hidden = true; selectedId = null; }
        refreshIcons();
        setStatus(snaps.length === 1 ? t("status.deleted", { id: snaps[0].pin.id }) : t("status.deletedMany", { n: snaps.length }));
      },
      undo: async () => {
        for (const sn of snaps) {
          const pin = await api.restorePin(sn.pin);
          if (sn.measurements.length) await api.setMeasurements(pin.id, sn.measurements);
          for (const ph of sn.photos) await api.restorePhoto(ph);
          addMarker(pin);
        }
        setSelection(snaps.map((sn) => sn.pin.id));
        if (snaps.length === 1) showPin(snaps[0].pin.id);
      },
    });
  } catch (err) { showError(err); }
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
    refreshIcons();
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
  if (e.key === "Escape") {
    if (placingRoom) { setPlacingRoom(false); return; }
    if (movingRoomId != null) { setMovingRoom(null); return; }
    if (placing) setPlacing(false);
    else if (editingId != null) setEditing(null);
    else if (selection.size) { setSelection([]); panelEl.hidden = true; selectedId = null; }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (!history.focusIsInTextField() && level) {
    if ((e.key === "Delete" || e.key === "Backspace") && selection.size) { e.preventDefault(); deleteSelection(); return; }
    if (mod && k === "a") { e.preventDefault(); setSelection([...pins.keys()].filter((id) => !hiddenCats.has(pins.get(id).pin.category))); return; }
    if (mod && k === "c") { e.preventDefault(); copySelection().catch(showError); return; }
    if (mod && k === "x") { e.preventDefault(); copySelection().then((ok) => ok && deleteSelection({ confirmFirst: false })).catch(showError); return; }
    if (mod && k === "v") { e.preventDefault(); pasteClipboard(); return; }
  }
  if (!mod) return;
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
  if (selectedRoomId != null && roomDirty == null) showRoom(selectedRoomId);
  fillPinRoomSelect();
  setPlacing(placing);
});

// ---- screens: the main menu and the plan --------------------------------------------
function showScreen(which) {
  const plan = which === "plan";
  $("#menu-bar").hidden = plan;
  $("#plan-bar").hidden = !plan;
  $("#status").hidden = !plan;
  planEl.hidden = !plan;
  if (!plan) { panelEl.hidden = true; roomPanelEl.hidden = true; emptyEl.hidden = true; legendEl.hidden = true; }
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
  selection.clear(); editingId = null; cursorLatLng = null;
  setPlacingRoom(false); movingRoomId = null; rooms = []; selectedRoomId = null; roomPanelEl.hidden = true;
  level = lvl;
  renderLevelSelect();
  emptyEl.hidden = !!lvl;
  legendEl.hidden = !lvl;
  addBtn.disabled = !lvl;
  roomBtn.disabled = !lvl;
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
  roomLayer = L.layerGroup().addTo(map);
  map.fitBounds(bounds);
  map.on("click", (e) => {
    if (placingRoom) return createRoomAt(e.latlng);
    if (movingRoomId != null) return moveRoomTo(movingRoomId, e.latlng);
    if (placing) return createPinAt(e.latlng);
    if (editingId != null) return movePinTo(editingId, e.latlng);   // edit mode: click = new position
    if (selection.size) { hidePanel(); }
    setStatus(t("status.clicked", toPixel(e.latlng)));
  });
  map.on("contextmenu", (e) => { if (!placing && !placingRoom && editingId == null) planMenu(e.latlng, { x: e.originalEvent.clientX, y: e.originalEvent.clientY }); });
  map.on("mousemove", (e) => { cursorLatLng = e.latlng; });
  map.on("mouseout", () => { cursorLatLng = null; });

  await reloadRooms();
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
// browser artefact. The plan has its own native menu, so it is suppressed there in
// every build; elsewhere it is suppressed in release builds only, keeping Inspect
// reachable from the panel or toolbar during development.
document.addEventListener("contextmenu", (e) => {
  if (import.meta.env.PROD || planEl.contains(e.target)) e.preventDefault();
});

main().catch(showError);
