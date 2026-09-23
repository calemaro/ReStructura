// The plan editor: straight walls drawn onto a floor.
//
// Works on both kinds of floor:
//   * a DRAWN floor has no image, just a sheet where one pixel is one centimetre,
//     so it is to scale by construction;
//   * an IMPORTED floor keeps its image, shown faintly while editing so the walls
//     can be traced over it. Walls need a real scale, so the floor must be
//     calibrated first.
//
// Walls are stored as a centre line in plan pixels plus a thickness in real
// centimetres. Everything here works in plan pixels (origin top-left, y down),
// kept as floats: a wall typed as 3.50 m at 45° does not land on whole pixels.
//
// Gestures follow the rest of the app: click to place, click to pick up and click
// to drop (nothing is dragged, so a touchpad cannot move a wall by accident),
// every change is one undo step, Esc backs out one level at a time.

import * as api from "./api.js";
import * as history from "./history.js";
import * as settings from "./settings.js";
import { t } from "./i18n.js";
import { setStatus, showError, showContextMenu } from "./ui.js";
import { unitHint } from "./units.js";

const SNAP_PX = 10;              // screen pixels: how close counts as "on" a corner or wall
const HANDLE_PX = 9;             // screen pixels: how close counts as clicking a corner handle
const ANGLE_TOL = (7 * Math.PI) / 180;
const SAME_POINT = 0.5;          // plan pixels: corners closer than this are the same corner
const WALL_FILL = "#2e3230";     // fixed, not a theme token: walls sit on a white plan in both themes
const WALL_SELECTED = "#0b5fa5";
const PREVIEW = "#a85d0c";

let ctx = null;                  // hooks from main.js: formatCm, parseCm, inputCm, onEnter, onExit
let map = null, level = null, height = 0, overlay = null;
let wallLayer = null, drawLayer = null;
let walls = [];                  // this floor's walls, as stored
let active = false;
let tool = "wall";               // "wall" | "select"
let chain = null;                // wall tool: { start, first, ids } while drawing a run of walls
let cursor = null;               // last snapped cursor position
let lastDir = { x: 1, y: 0 };    // direction used when a length is typed before the mouse moves
let selected = new Set();
let moving = null;               // select tool: { point, affected: [{ before, end }] }
let busy = false;                // a database write is in flight; ignore clicks meanwhile

const $ = (sel) => document.querySelector(sel);
const bar = $("#editor-bar");
const palette = $("#editor-tools");
const toolBtns = [...palette.querySelectorAll("[data-tool]")];
const lengthInput = $("#ed-length");
const thickInput = $("#ed-thickness");
const imageWrap = $("#ed-image-wrap");
const imageRange = $("#ed-image");

// ---- geometry ------------------------------------------------------------------------
const r2 = (v) => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a, b) => dist(a, b) < SAME_POINT;
const end1 = (w) => ({ x: w.x1, y: w.y1 });
const end2 = (w) => ({ x: w.x2, y: w.y2 });
const cmPerPx = () => level?.cmPerPx ?? null;
const screenScale = () => map.getZoomScale(map.getZoom(), 0);   // screen px per plan px
const toLatLng = (p) => L.latLng(height - p.y, p.x);
const toPoint = (ll) => ({ x: ll.lng, y: height - ll.lat });
const wallCm = (w) => dist(end1(w), end2(w)) * (cmPerPx() ?? 1);

function closestOnSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return a;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { x: a.x + u * dx, y: a.y + u * dy };
}

/** Where the ray from `o` along `d` crosses segment ab, or null. */
function rayHitsSegment(o, d, a, b) {
  const ex = b.x - a.x, ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-9) return null;
  const ax = a.x - o.x, ay = a.y - o.y;
  const s = (ax * ey - ay * ex) / den;
  const u = (ax * d.y - ay * d.x) / den;
  return s > 0 && u >= 0 && u <= 1 ? { x: o.x + s * d.x, y: o.y + s * d.y } : null;
}

/** The outline of a wall: its centre line widened to the thickness, with square
 *  ends that reach half a thickness past each corner so two walls meeting at a
 *  right angle close the corner cleanly. */
function outline(a, b, thicknessCm) {
  const len = dist(a, b);
  if (!len) return null;
  const h = thicknessCm / (cmPerPx() ?? 1) / 2;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const nx = -uy * h, ny = ux * h;
  const s = { x: a.x - ux * h, y: a.y - uy * h };
  const e = { x: b.x + ux * h, y: b.y + uy * h };
  return [
    { x: s.x + nx, y: s.y + ny }, { x: e.x + nx, y: e.y + ny },
    { x: e.x - nx, y: e.y - ny }, { x: s.x - nx, y: s.y - ny },
  ].map(toLatLng);
}

/** Every distinct corner on this floor, optionally leaving out some walls. */
function corners(excludeIds) {
  const out = [];
  for (const w of walls) {
    if (excludeIds?.has(w.id)) continue;
    for (const p of [end1(w), end2(w)]) if (!out.some((q) => same(p, q))) out.push(p);
  }
  return out;
}

/**
 * Where a click really goes. In order of preference:
 *   1. an existing corner, so walls join exactly;
 *   2. from the previous corner, a direction within a few degrees of a multiple
 *      of 45° is straightened, and if that straight line crosses a wall near the
 *      cursor it stops exactly on it;
 *   3. otherwise a point on an existing wall's centre line (a T-junction).
 * Holding Ctrl turns all of it off.
 */
function snap(raw, { from = null, exclude = null, free = false } = {}) {
  if (free) return { ...raw, kind: null };
  const tol = SNAP_PX / screenScale();

  let best = null, bestD = tol;
  const pts = corners(exclude);
  if (chain) pts.push(chain.first);
  for (const p of pts) {
    if (from && same(p, from)) continue;
    const d = dist(p, raw);
    if (d < bestD) { best = p; bestD = d; }
  }
  if (best) return { x: best.x, y: best.y, kind: "corner" };

  let p = raw, kind = null, dir = null;
  if (from && dist(from, raw) > 0) {
    const ang = Math.atan2(raw.y - from.y, raw.x - from.x);
    const straight = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(ang - straight) < ANGLE_TOL) {
      dir = { x: Math.cos(straight), y: Math.sin(straight) };
      const len = dist(from, raw);
      p = { x: from.x + dir.x * len, y: from.y + dir.y * len };
      kind = "angle";
    }
  }
  let onWall = null, onD = tol;
  for (const w of walls) {
    if (exclude?.has(w.id)) continue;
    const q = dir ? rayHitsSegment(from, dir, end1(w), end2(w)) : closestOnSegment(raw, end1(w), end2(w));
    if (!q) continue;
    const d = dist(q, dir ? p : raw);
    if (d < onD) { onWall = q; onD = d; }
  }
  if (onWall) return { x: onWall.x, y: onWall.y, kind: "wall" };
  return { x: p.x, y: p.y, kind };
}

/** The wall under a click, if any: within its thickness or a few screen pixels. */
function wallAt(p) {
  let best = null, bestD = Infinity;
  for (const w of walls) {
    const d = dist(p, closestOnSegment(p, end1(w), end2(w)));
    const reach = Math.max(w.thicknessCm / (cmPerPx() ?? 1) / 2, SNAP_PX / screenScale());
    if (d <= reach && d < bestD) { best = w; bestD = d; }
  }
  return best;
}

// ---- drawing -------------------------------------------------------------------------
const fmt = (cm) => ctx.formatCm(cm);

function lengthLabel(a, b, text, cls = "") {
  return L.marker(toLatLng({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), {
    icon: L.divIcon({ className: "", html: `<span class="ruler-label wall-len ${cls}">${text}</span>`, iconSize: [0, 0] }),
    interactive: false, keyboard: false, pane: "plan-labels",
  });
}

function render() {
  if (!wallLayer) return;
  wallLayer.clearLayers();
  for (const id of selected) if (!walls.some((w) => w.id === id)) selected.delete(id);
  for (const w of walls) {
    const sel = active && selected.has(w.id);
    const shape = outline(end1(w), end2(w), w.thicknessCm);
    if (shape) {
      L.polygon(shape, {
        pane: "plan-walls", stroke: false, fillColor: sel ? WALL_SELECTED : WALL_FILL, fillOpacity: 1, interactive: false,
      }).addTo(wallLayer);
    }
    if (sel) {
      for (const p of [end1(w), end2(w)]) {
        L.circleMarker(toLatLng(p), {
          pane: "plan-labels", radius: 5, color: WALL_SELECTED, weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false,
        }).addTo(wallLayer);
      }
      lengthLabel(end1(w), end2(w), fmt(wallCm(w)), "selected").addTo(wallLayer);
    }
  }
  refreshBar();
}

function clearPreview() { drawLayer?.clearLayers(); }

/** The wall being drawn follows the cursor; a typed length overrides its reach. */
function renderPreview() {
  clearPreview();
  if (!active || !cursor) return;
  if (cursor.kind) {
    L.circleMarker(toLatLng(cursor), {
      pane: "plan-labels", radius: cursor.kind === "corner" ? 6 : 4, color: PREVIEW, weight: 2,
      fill: cursor.kind === "corner", fillColor: PREVIEW, fillOpacity: 0.25, interactive: false,
    }).addTo(drawLayer);
  }
  if (tool !== "wall" || !chain) return;
  const to = previewEnd();
  if (!to || same(to, chain.start)) return;
  const shape = outline(chain.start, to, thickness());
  if (shape) L.polygon(shape, { pane: "plan-walls", stroke: false, fillColor: PREVIEW, fillOpacity: 0.55, interactive: false }).addTo(drawLayer);
  lengthLabel(chain.start, to, fmt(dist(chain.start, to) * (cmPerPx() ?? 1)), "preview").addTo(drawLayer);
  lengthInput.placeholder = fmt(dist(chain.start, to) * (cmPerPx() ?? 1));
}

/** The next corner: the snapped cursor, or the typed length along the cursor's direction. */
function previewEnd() {
  if (!chain) return null;
  const typed = lengthInput.value.trim() ? ctx.parseCm(lengthInput.value) : null;
  if (typed == null || !(typed > 0)) return cursor;
  const d = cursor && dist(cursor, chain.start) > 0
    ? { x: (cursor.x - chain.start.x) / dist(cursor, chain.start), y: (cursor.y - chain.start.y) / dist(cursor, chain.start) }
    : lastDir;
  const px = typed / (cmPerPx() ?? 1);
  return { x: chain.start.x + d.x * px, y: chain.start.y + d.y * px };
}

// ---- toolbar -------------------------------------------------------------------------
const thickness = () => {
  const v = Number(settings.value("wallThicknessCm"));
  return v > 0 ? v : 10;
};

function refreshBar() {
  if (!active) return;
  for (const b of toolBtns) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
  $("#ed-tool-name").textContent = t(tool === "wall" ? "editor.wall" : "editor.select");
  // the unit a bare number is read in; any unit can still be typed explicitly
  const u = settings.value("units");
  for (const el of bar.querySelectorAll(".ed-unit")) el.textContent = u === "ftin" ? "ft in" : u === "in" ? "in" : unitHint(u);
  const one = selected.size === 1 ? walls.find((w) => w.id === [...selected][0]) : null;
  const lengthUsable = (tool === "wall" && !!chain) || (tool === "select" && !!one);
  lengthInput.disabled = !lengthUsable;
  if (document.activeElement !== lengthInput) {
    lengthInput.value = tool === "select" && one ? ctx.inputCm(wallCm(one)) : "";
    if (!lengthUsable) lengthInput.placeholder = "";
  }
  if (document.activeElement !== thickInput) {
    const sel = walls.filter((w) => selected.has(w.id));
    const allSame = sel.length && sel.every((w) => w.thicknessCm === sel[0].thicknessCm);
    thickInput.value = ctx.inputCm(tool === "select" && allSame ? sel[0].thicknessCm : thickness());
  }
}

function hint() {
  if (!active) return;
  const key = moving ? "editor.hintMove"
    : tool === "select" ? "editor.hintSelect"
    : chain ? "editor.hintChain" : "editor.hintWall";
  setStatus(t(key));
}

function setTool(next) {
  finishChain();
  cancelMove();
  tool = next;
  if (tool === "wall") selected.clear();
  render();
  renderPreview();
  hint();
}

// ---- commands (every change is one undo step) ----------------------------------------
function upsert(rows) {
  for (const row of rows) {
    const i = walls.findIndex((w) => w.id === row.id);
    if (i >= 0) walls[i] = row; else walls.push(row);
  }
  render();
}
function drop(ids) { walls = walls.filter((w) => !ids.includes(w.id)); render(); }

async function write(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (err) { showError(err); } finally { busy = false; }
}

async function addWall(a, b) {
  let row = null;
  await history.run({
    label: t("wall.add"),
    do: async () => {
      row = row ? (await api.putWalls([row]))[0]
        : await api.addWall({ levelId: level.id, x1: r2(a.x), y1: r2(a.y), x2: r2(b.x), y2: r2(b.y), thicknessCm: thickness() });
      upsert([row]);
    },
    undo: async () => { await api.deleteWalls([row.id]); drop([row.id]); },
  });
  return row;
}

async function replaceWalls(label, before, after) {
  await history.run({
    label,
    do: async () => upsert(await api.putWalls(after)),
    undo: async () => upsert(await api.putWalls(before)),
  });
}

async function deleteSelected() {
  const rows = walls.filter((w) => selected.has(w.id));
  if (!rows.length) return;
  await write(() => history.run({
    label: t("wall.delete"),
    do: async () => { await api.deleteWalls(rows.map((w) => w.id)); drop(rows.map((w) => w.id)); },
    undo: async () => upsert(await api.putWalls(rows)),
  }));
  setStatus(t("wall.deleted", { n: rows.length }));
}

/** Every wall end sitting on `p`, so moving a corner keeps the walls joined there. */
function endsAt(p) {
  const out = [];
  for (const w of walls) {
    if (same(end1(w), p)) out.push({ before: { ...w }, end: 1 });
    if (same(end2(w), p)) out.push({ before: { ...w }, end: 2 });
  }
  return out;
}
const moved = (affected, p) => affected.map(({ before, end }) =>
  end === 1 ? { ...before, x1: r2(p.x), y1: r2(p.y) } : { ...before, x2: r2(p.x), y2: r2(p.y) });

async function moveCorner(label, affected, p) {
  const after = moved(affected, p);
  if (after.some((w) => dist(end1(w), end2(w)) < 1)) { setStatus(t("editor.tooShort")); return false; }
  await replaceWalls(label, affected.map((a) => a.before), after);
  return true;
}

// ---- wall tool -----------------------------------------------------------------------
async function wallClick(p) {
  if (!chain) {
    chain = { start: p, first: p, ids: [] };
    renderPreview(); refreshBar(); hint();
    return;
  }
  // a second click on the same spot (or a double-click) ends the run
  if (dist(p, chain.start) * screenScale() < 4) { finishChain(); return; }
  await write(async () => {
    const row = await addWall(chain.start, p);
    if (!row) return;
    lastDir = { x: (p.x - chain.start.x) / dist(p, chain.start), y: (p.y - chain.start.y) / dist(p, chain.start) };
    chain.ids.push(row.id);
    const closed = chain.ids.length > 1 && same(p, chain.first);
    chain.start = p;
    lengthInput.value = "";
    if (closed) finishChain(); else { renderPreview(); hint(); }
  });
}

function finishChain() {
  if (!chain) return;
  chain = null;
  lengthInput.value = "";
  lengthInput.blur();
  renderPreview(); refreshBar(); hint();
}

/** Backspace (or Ctrl+Z) while drawing: take back the last wall and continue from its start. */
async function stepBack() {
  if (!chain || busy) return;
  if (!chain.ids.length) { finishChain(); return; }
  const id = chain.ids.pop();
  const w = walls.find((x) => x.id === id);
  await write(() => history.undo());
  if (w) chain.start = end1(w);
  if (!chain.ids.length) chain.first = chain.start;
  renderPreview(); hint();
}

async function typedLength() {
  if (tool === "wall") {
    if (!chain) return;
    const cm = ctx.parseCm(lengthInput.value);
    if (!(cm > 0)) { lengthInput.classList.add("invalid"); return; }
    lengthInput.classList.remove("invalid");
    const to = previewEnd();
    lengthInput.blur();
    if (to) await wallClick({ ...to, kind: null });
    return;
  }
  const one = selected.size === 1 ? walls.find((w) => w.id === [...selected][0]) : null;
  const cm = ctx.parseCm(lengthInput.value);
  if (!one || !(cm > 0)) { lengthInput.classList.toggle("invalid", !!one); return; }
  lengthInput.classList.remove("invalid");
  if (Math.abs(cm - wallCm(one)) < 0.05) { lengthInput.blur(); return; }   // Enter, then the blur's change event
  // keep the first corner, move the second along the wall; walls joined there follow
  const a = end1(one), b = end2(one);
  const k = cm / (cmPerPx() ?? 1) / dist(a, b);
  const to = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  await write(() => moveCorner(t("wall.length"), endsAt(b), to));
  lengthInput.blur();
}

async function applyThickness() {
  const cm = ctx.parseCm(thickInput.value);
  if (!(cm > 0) || cm > 200) { thickInput.classList.add("invalid"); return; }
  thickInput.classList.remove("invalid");
  settings.set({ wallThicknessCm: cm });
  const rows = tool === "select" ? walls.filter((w) => selected.has(w.id) && w.thicknessCm !== cm) : [];
  if (rows.length) await write(() => replaceWalls(t("wall.thickness"), rows, rows.map((w) => ({ ...w, thicknessCm: cm }))));
  refreshBar(); renderPreview();
}

// ---- select tool ---------------------------------------------------------------------
function cancelMove() {
  if (!moving) return;
  upsert(moving.affected.map((a) => a.before));   // put the preview back where it was
  moving = null;
  hint();
}

async function selectClick(raw, e) {
  if (moving) {
    const p = snap(raw, { from: moving.anchor, exclude: moving.ids, free: e.ctrlKey || e.metaKey });
    const m = moving;
    moving = null;
    upsert(m.affected.map((a) => a.before));
    await write(() => moveCorner(t("wall.move"), m.affected, p));
    hint();
    return;
  }
  const tol = HANDLE_PX / screenScale();
  for (const w of walls.filter((x) => selected.has(x.id))) {
    for (const [p, other] of [[end1(w), end2(w)], [end2(w), end1(w)]]) {
      if (dist(p, raw) < tol) {
        const affected = endsAt(p);
        moving = { affected, anchor: other, ids: new Set(affected.map((a) => a.before.id)) };
        hint();
        return;
      }
    }
  }
  const hit = wallAt(raw);
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (!hit) { if (!additive) selected.clear(); }
  else if (additive) { selected.has(hit.id) ? selected.delete(hit.id) : selected.add(hit.id); }
  else selected = new Set([hit.id]);
  render();
  if (hit && selected.size === 1) setStatus(t("wall.info", { len: fmt(wallCm(hit)), th: fmt(hit.thicknessCm) }));
  else hint();
}

// ---- entering and leaving ------------------------------------------------------------
export function init(hooks) {
  ctx = hooks;
  for (const b of toolBtns) b.addEventListener("click", () => setTool(b.dataset.tool));
  lengthInput.addEventListener("input", () => { lengthInput.classList.remove("invalid"); if (tool === "wall") renderPreview(); });
  lengthInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); typedLength(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); lengthInput.value = ""; lengthInput.blur(); refreshBar(); renderPreview(); }
  });
  lengthInput.addEventListener("change", () => { if (tool === "select") typedLength(); });
  thickInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); thickInput.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); thickInput.blur(); refreshBar(); }
  });
  thickInput.addEventListener("change", applyThickness);
  imageRange.addEventListener("input", () => overlay?.setOpacity(imageRange.value / 100));
}

/** A floor was shown: create the panes and draw its sheet and walls. */
export async function attach(m, lvl, { height: h, overlay: ov, bounds }) {
  map = m; level = lvl; height = h; overlay = ov;
  walls = []; selected = new Set(); chain = null; moving = null; cursor = null; active = false;
  // Panes stack the plan: image or sheet < walls < rulers and pins (Leaflet's own panes).
  map.createPane("plan-base").style.zIndex = 250;
  map.createPane("plan-walls").style.zIndex = 350;
  map.createPane("plan-labels").style.zIndex = 450;
  if (!ov) drawSheet(bounds);
  wallLayer = L.layerGroup().addTo(map);
  drawLayer = L.layerGroup().addTo(map);
  walls = await api.listWalls(lvl.id);
  render();
}

export function detach() {
  if (active) exit();
  map = null; level = null; wallLayer = null; drawLayer = null; walls = [];
}

/** A drawn floor is white paper with a 1 m grid, heavier every 5 m. The colours are
 *  fixed: the sheet stays paper-white in dark mode, like any imported plan. */
function drawSheet(bounds) {
  L.rectangle(bounds, { pane: "plan-base", color: "#c9d0cc", weight: 1, fillColor: "#ffffff", fillOpacity: 1, interactive: false }).addTo(map);
  const w = bounds.getEast(), hgt = bounds.getNorth();
  const minor = [], major = [];
  for (let x = 100; x < w; x += 100) (x % 500 ? minor : major).push([toLatLng({ x, y: 0 }), toLatLng({ x, y: hgt })]);
  for (let y = 100; y < hgt; y += 100) (y % 500 ? minor : major).push([toLatLng({ x: 0, y }), toLatLng({ x: w, y })]);
  L.polyline(minor, { pane: "plan-base", color: "#e6ebe8", weight: 1, interactive: false }).addTo(map);
  L.polyline(major, { pane: "plan-base", color: "#cfd7d3", weight: 1, interactive: false }).addTo(map);
}

/** The floor's record changed (calibrated, renamed): wall thickness depends on the scale. */
export function updateLevel(lvl) {
  if (!level || lvl.id !== level.id) return;
  level = lvl;
  render();
}

export const isActive = () => active;
export const wallsOf = () => walls;

/** The drawn part of the floor in plan pixels, for "fit view" on a drawn floor. */
export function contentBox() {
  if (!walls.length) return null;
  const xs = walls.flatMap((w) => [w.x1, w.x2]), ys = walls.flatMap((w) => [w.y1, w.y2]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Open the editor. Without a tool: Select when there are walls to work on, else Wall. */
export function enter(startTool) {
  if (!map || !level) return false;
  if (!cmPerPx()) { setStatus(t("editor.needScale")); return false; }
  startTool ??= walls.length ? "select" : "wall";
  if (active) { setTool(startTool); return true; }
  active = true;
  ctx.onEnter?.();
  tool = startTool;
  bar.hidden = false;
  palette.hidden = false;
  imageWrap.hidden = !overlay;
  if (overlay) { imageRange.value = 35; overlay.setOpacity(0.35); }
  map.getContainer().classList.add("editing-walls");
  map.doubleClickZoom.disable();
  render(); renderPreview(); hint();
  return true;
}

export function exit() {
  if (!active) return;
  finishChain();
  cancelMove();
  active = false;
  selected.clear();
  bar.hidden = true;
  palette.hidden = true;
  overlay?.setOpacity(1);
  map?.getContainer().classList.remove("editing-walls");
  map?.doubleClickZoom.enable();
  clearPreview();
  render();
  ctx.onExit?.();
}

// ---- events routed from main.js ------------------------------------------------------
export function click(latlng, e) {
  if (!active || busy) return;
  const raw = toPoint(latlng);
  const free = e.ctrlKey || e.metaKey;
  if (tool !== "wall") { selectClick(raw, e); return; }
  // a length typed and then a click: the wall gets the typed length, in the clicked direction
  if (chain && lengthInput.value.trim() && ctx.parseCm(lengthInput.value) > 0) {
    cursor = snap(raw, { from: chain.start, free });
    wallClick({ ...previewEnd(), kind: null });
    return;
  }
  wallClick(snap(raw, { from: chain?.start, free }));
}

export function move(latlng, e) {
  if (!active) return;
  const raw = toPoint(latlng);
  const free = e?.ctrlKey || e?.metaKey;
  if (tool === "wall") {
    cursor = snap(raw, { from: chain?.start, free });
  } else if (moving) {
    cursor = snap(raw, { from: moving.anchor, exclude: moving.ids, free });
    upsert(moved(moving.affected, cursor));      // preview only: nothing is saved until the click
  } else {
    cursor = null;
  }
  renderPreview();
}

export function contextMenu(latlng, at) {
  if (!active) return;
  const hit = wallAt(toPoint(latlng));
  const items = [];
  if (hit) {
    items.push({ text: t("menu.deleteWall"), action: () => { selected = new Set([hit.id]); deleteSelected(); } });
    items.push({ separator: true });
  }
  items.push(
    { text: t("editor.select"), action: () => setTool("select") },
    { text: t("editor.wall"), action: () => setTool("wall") },
  );
  showContextMenu(items, at);
}

/** Keys while editing. Returns true when the key was used here. */
export function onKey(e) {
  if (!active) return false;
  if (history.focusIsInTextField()) return false;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") {
    e.preventDefault();
    if (moving) cancelMove();
    else if (chain) finishChain();
    else if (tool === "wall") setTool("select");
    else if (selected.size) { selected.clear(); render(); hint(); }
    return true;
  }
  if (e.key === "Enter" && chain) { e.preventDefault(); finishChain(); return true; }
  if (e.key === "Backspace" && chain) { e.preventDefault(); stepBack(); return true; }
  if (mod && k === "z" && !e.shiftKey && chain) { e.preventDefault(); stepBack(); return true; }
  if (mod && (k === "z" || k === "y")) { settle(); return false; }   // the app's undo/redo takes it from here
  if ((e.key === "Delete" || e.key === "Backspace") && selected.size) { e.preventDefault(); deleteSelected(); return true; }
  if (mod && k === "a") { e.preventDefault(); tool = "select"; selected = new Set(walls.map((w) => w.id)); render(); hint(); return true; }
  if (mod && ["c", "x", "v"].includes(k)) { e.preventDefault(); return true; }   // pins are out of reach while editing
  if (mod || e.altKey) return false;
  if (k === "w") { setTool("wall"); return true; }
  if (k === "s" || k === "v") { setTool("select"); return true; }
  // typing a number while drawing starts the length box with that character
  if (tool === "wall" && chain && /^[0-9.,]$/.test(e.key)) {
    e.preventDefault();
    lengthInput.value = e.key;
    lengthInput.focus();
    renderPreview();
    return true;
  }
  return false;
}

/** The unit preference changed: lengths on screen and the unit hints follow. */
export function refreshUnits() { render(); renderPreview(); hint(); }

/** End any half-finished gesture, before undo/redo changes the walls underneath it. */
export function settle() { finishChain(); cancelMove(); }
