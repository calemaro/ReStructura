// The plan editor: walls, doors and windows drawn onto a floor.
//
// Works on both kinds of floor:
//   * a DRAWN floor has no image, just a sheet where one pixel is one centimetre,
//     so it is to scale by construction;
//   * an IMPORTED floor keeps its image, shown faintly while editing so the walls
//     can be traced over it. Walls need a real scale, so the floor must be
//     calibrated first.
//
// Walls are stored as a centre line in plan pixels plus a thickness in real
// centimetres. Doors and windows ("openings") belong to a wall and are stored as a
// position ALONG it, so they follow the wall when a corner moves. Everything here
// works in plan pixels (origin top-left, y down), kept as floats. How the plan is
// drawn (symbols included) lives in plan-shapes.js, shared with the printed report.
//
// Gestures follow the rest of the app: click to place, click to pick up and click
// to drop (nothing is dragged, so a touchpad cannot move a wall by accident),
// every change is one undo step, Esc backs out one level at a time.

import * as api from "./api.js";
import * as history from "./history.js";
import * as settings from "./settings.js";
import { t, currentLanguage } from "./i18n.js";
import { setStatus, showError, showContextMenu } from "./ui.js";
import { unitHint } from "./units.js";
import { planShapes, wallFrame, occupiedSpan, DOOR_KINDS, WINDOW_KINDS, isDoorKind, swings } from "./plan-shapes.js";

const SNAP_PX = 10;              // screen pixels: how close counts as "on" a corner or wall
const HANDLE_PX = 9;             // screen pixels: how close counts as clicking a corner handle
const ANGLE_TOL = (7 * Math.PI) / 180;
const SAME_POINT = 0.5;          // plan pixels: corners closer than this are the same corner
const MIN_OPENING_CM = 20;
const SHEET_STEP_CM = 500;       // a drawn floor's sheet grows in whole 5 m squares (the grid stays put)
const SHEET_MARGIN_CM = 500;     // and keeps at least 5 m of paper beyond the drawing
const INK = "#2e3230";           // fixed, not a theme token: the plan is white paper in both themes
const SELECTED = "#0b5fa5";
const PREVIEW = "#a85d0c";

let ctx = null;                  // hooks from main.js: formatCm, parseCm, inputCm, onEnter, onExit
let map = null, level = null, height = 0, overlay = null;
let wallLayer = null, drawLayer = null, sheetLayer = null;
let baseSheet = null;            // drawn floor: the sheet it was created with, { x0, y0, x1, y1 }
let sheetKey = "";               // the sheet currently drawn, to redraw only when it changes
let walls = [];                  // this floor's walls, as stored
let openings = [];               // this floor's doors and windows, as stored
let active = false;
let tool = "wall";               // "select" | "wall" | "door" | "window"
let chain = null;                // wall tool: { start, first, ids } while drawing a run of walls
let cursor = null;               // wall tool: last snapped cursor position
let cursorRaw = null, cursorFree = false;   // the mouse, unsnapped, and whether Ctrl was held
let lastDir = { x: 1, y: 0 };    // direction used when a length is typed before the mouse moves
let selected = new Set();        // selected wall ids
let selOps = new Set();          // selected opening ids
let moving = null;               // select tool: a corner picked up, { affected, anchor, ids }
let movingOp = null;             // select tool: an opening picked up, { before, grab }
let placing = null;              // door/window tool after the first click: { wall, t, side }
let busy = false;                // a database write is in flight; ignore clicks meanwhile

const $ = (sel) => document.querySelector(sel);
const bar = $("#editor-bar");
const palette = $("#editor-tools");
const toolBtns = [...palette.querySelectorAll("[data-tool]")];
const kindSelect = $("#ed-kind");
const lengthInput = $("#ed-length");
const widthInput = $("#ed-width");
const fromInput = $("#ed-from");
const thickInput = $("#ed-thickness");
const imageRange = $("#ed-image");

// ---- geometry ------------------------------------------------------------------------
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a, b) => dist(a, b) < SAME_POINT;
const end1 = (w) => ({ x: w.x1, y: w.y1 });
const end2 = (w) => ({ x: w.x2, y: w.y2 });
const cmPerPx = () => level?.cmPerPx ?? null;
const k = () => cmPerPx() ?? 1;
const screenScale = () => map.getZoomScale(map.getZoom(), 0);   // screen px per plan px
const toLatLng = (p) => L.latLng(height - p.y, p.x);
const toPoint = (ll) => ({ x: ll.lng, y: height - ll.lat });
const wallCm = (w) => dist(end1(w), end2(w)) * k();
const halfThick = (w) => w.thicknessCm / k() / 2;
const wallOf = (o) => walls.find((w) => w.id === o.wallId);
const isOpeningTool = () => tool === "door" || tool === "window";

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

/** The outline of a wall being drawn (preview): square ends, like the real thing. */
function outline(a, b, thicknessCm) {
  const len = dist(a, b);
  if (!len) return null;
  const h = thicknessCm / k() / 2;
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
 * Where a wall click really goes. In order of preference:
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
    const reach = Math.max(halfThick(w), SNAP_PX / screenScale());
    if (d <= reach && d < bestD) { best = w; bestD = d; }
  }
  return best;
}

/** The door or window under a click: on its stretch of wall, or inside its swing. */
function openingAt(p) {
  const tol = SNAP_PX / screenScale();
  for (const o of openings) {
    const w = wallOf(o);
    if (!w) continue;
    const { t: along, s } = wallFrame(w).local(p);
    if (along < o.offsetPx - tol / 2 || along > o.offsetPx + o.widthPx + tol / 2) continue;
    const h = halfThick(w);
    if (Math.abs(s) <= Math.max(h, tol)) return o;
    if (swings(o.kind) && s * o.side > 0 && Math.abs(s) <= h + o.widthPx) return o;
  }
  return null;
}

/** A position along a wall, pulled onto the wall's ends and the edges of the
 *  other openings in it when close (unless Ctrl is held). */
function snapAlong(w, along, free, excludeId = null) {
  const len = wallFrame(w).len;
  along = clamp(along, 0, len);
  if (free) return along;
  const tol = SNAP_PX / screenScale();
  const marks = [0, len];
  for (const o of openings) {
    if (o.wallId !== w.id || o.id === excludeId) continue;
    const occ = occupiedSpan(o, len);
    if (occ) marks.push(...occ);
  }
  let best = along, bestD = tol;
  for (const m of marks) if (Math.abs(m - along) < bestD) { best = m; bestD = Math.abs(m - along); }
  return best;
}

function overlaps(o) {
  const w = wallOf(o);
  if (!w) return false;
  const len = wallFrame(w).len;
  const mine = occupiedSpan(o, len);
  if (!mine) return false;
  return openings.some((x) => {
    if (x.id === o.id || x.wallId !== o.wallId) return false;
    const other = occupiedSpan(x, len);
    return other && mine[0] < other[1] - 0.5 && other[0] < mine[1] - 0.5;
  });
}

/** Distance from the nearer corner of its wall, and which end that is. */
function fromCorner(o) {
  const len = wallFrame(wallOf(o)).len;
  const a = o.offsetPx, b = len - o.offsetPx - o.widthPx;
  return a <= b ? { end: "start", px: a } : { end: "end", px: b };
}

// ---- drawing -------------------------------------------------------------------------
const fmt = (cm) => ctx.formatCm(cm);

function labelAt(p, text, cls = "") {
  return L.marker(toLatLng(p), {
    icon: L.divIcon({ className: "", html: `<span class="ruler-label wall-len ${cls}">${text}</span>`, iconSize: [0, 0] }),
    interactive: false, keyboard: false, pane: "plan-labels",
  });
}
const lengthLabel = (a, b, text, cls) => labelAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, text, cls);

function addShape(sh, colour, layer) {
  const lls = sh.pts.map(toLatLng);
  const dashArray = sh.dash ? "4 3" : null;
  if (sh.type === "fill") {
    L.polygon(lls, { pane: "plan-walls", stroke: false, fillColor: colour, fillOpacity: 1, interactive: false }).addTo(layer);
  } else if (sh.type === "outline") {
    L.polygon(lls, {
      pane: "plan-walls", color: colour, weight: sh.weight ?? 1, dashArray,
      fill: !!sh.paper, fillColor: "#ffffff", fillOpacity: 1, interactive: false,
    }).addTo(layer);
  } else {
    L.polyline(lls, { pane: "plan-walls", color: colour, weight: sh.weight ?? 1, dashArray, interactive: false }).addTo(layer);
  }
}

/** Width of an opening, and how far it is from each corner of its wall, written on
 *  the side of the wall away from the swing. */
function openingLabels(o, cls, layer) {
  const w = wallOf(o);
  if (!w) return;
  const f = wallFrame(w);
  const off = -(o.side >= 0 ? 1 : -1) * (halfThick(w) + 16 / screenScale());
  const a = o.offsetPx, b = o.offsetPx + o.widthPx;
  labelAt(f.at((a + b) / 2, off), fmt(o.widthPx * k()), cls).addTo(layer);
  if (a > 1) labelAt(f.at(a / 2, off), fmt(a * k()), "dim").addTo(layer);
  if (f.len - b > 1) labelAt(f.at((b + f.len) / 2, off), fmt((f.len - b) * k()), "dim").addTo(layer);
}

function render() {
  if (!wallLayer) return;
  wallLayer.clearLayers();
  for (const id of selected) if (!walls.some((w) => w.id === id)) selected.delete(id);
  for (const id of selOps) if (!openings.some((o) => o.id === id)) selOps.delete(id);
  for (const sh of planShapes(walls, openings, k())) {
    const sel = active && (sh.openingId != null ? selOps.has(sh.openingId) : selected.has(sh.wallId));
    addShape(sh, sel ? SELECTED : INK, wallLayer);
  }
  drawSheet();
  if (active) {
    for (const w of walls.filter((x) => selected.has(x.id))) {
      for (const p of [end1(w), end2(w)]) {
        L.circleMarker(toLatLng(p), {
          pane: "plan-labels", radius: 5, color: SELECTED, weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false,
        }).addTo(wallLayer);
      }
      lengthLabel(end1(w), end2(w), fmt(wallCm(w)), "selected").addTo(wallLayer);
    }
    const one = oneOpening();
    if (one) openingLabels(one, movingOp ? "preview" : "selected", wallLayer);
  }
  refreshBar();
}

function clearPreview() { drawLayer?.clearLayers(); }

/** What follows the mouse: the wall being drawn, or the door/window being placed. */
function renderPreview() {
  clearPreview();
  if (!active) return;
  if (tool === "wall") renderWallPreview();
  else if (isOpeningTool()) renderOpeningPreview();
}

function renderWallPreview() {
  if (!cursor) return;
  if (cursor.kind) {
    L.circleMarker(toLatLng(cursor), {
      pane: "plan-labels", radius: cursor.kind === "corner" ? 6 : 4, color: PREVIEW, weight: 2,
      fill: cursor.kind === "corner", fillColor: PREVIEW, fillOpacity: 0.25, interactive: false,
    }).addTo(drawLayer);
  }
  if (!chain) return;
  const to = previewEnd();
  drawSheet(to);                                  // the paper follows a wall drawn past its edge
  if (!to || same(to, chain.start)) return;
  const shape = outline(chain.start, to, thickness());
  if (shape) L.polygon(shape, { pane: "plan-walls", stroke: false, fillColor: PREVIEW, fillOpacity: 0.55, interactive: false }).addTo(drawLayer);
  const len = fmt(dist(chain.start, to) * k());
  lengthLabel(chain.start, to, len, "preview").addTo(drawLayer);
  lengthInput.placeholder = len;
}

function renderOpeningPreview() {
  if (!cursorRaw) return;
  if (!placing) {
    // before the first click: show where on the wall the opening would start
    const w = wallAt(cursorRaw);
    if (!w) return;
    const f = wallFrame(w);
    const p = f.at(snapAlong(w, f.local(cursorRaw).t, cursorFree));
    L.circleMarker(toLatLng(p), { pane: "plan-labels", radius: 5, color: PREVIEW, weight: 2, fillColor: PREVIEW, fillOpacity: 0.25, interactive: false }).addTo(drawLayer);
    return;
  }
  const o = placementOpening();
  if (!o || o.widthPx < 0.5) return;
  const w = placing.wall, f = wallFrame(w), h = halfThick(w);
  const a = o.offsetPx, b = a + o.widthPx;
  L.polygon([f.at(a, h), f.at(b, h), f.at(b, -h), f.at(a, -h)].map(toLatLng), {
    pane: "plan-walls", color: PREVIEW, weight: 1, fillColor: "#ffffff", fillOpacity: 1, interactive: false,
  }).addTo(drawLayer);
  for (const sh of planShapes([w], [o], k())) if (sh.openingId === o.id) addShape(sh, PREVIEW, drawLayer);
  openingLabels(o, "preview", drawLayer);
  widthInput.placeholder = fmt(o.widthPx * k());
}

/** The next wall corner: the snapped cursor, or the typed length along the cursor's direction. */
function previewEnd() {
  if (!chain) return null;
  const typed = lengthInput.value.trim() ? ctx.parseCm(lengthInput.value) : null;
  if (typed == null || !(typed > 0)) return cursor;
  const d = cursor && dist(cursor, chain.start) > 0
    ? { x: (cursor.x - chain.start.x) / dist(cursor, chain.start), y: (cursor.y - chain.start.y) / dist(cursor, chain.start) }
    : lastDir;
  const px = typed / k();
  return { x: chain.start.x + d.x * px, y: chain.start.y + d.y * px };
}

/** The door or window being placed: from the first click to the mouse (or to the typed
 *  width in the mouse's direction). The side of the wall the mouse is on is the side it
 *  opens to; the hinge is at the first click. */
function placementOpening() {
  if (!placing || !cursorRaw) return null;
  const w = placing.wall, f = wallFrame(w);
  const { t: along, s } = f.local(cursorRaw);
  const typed = widthInput.value.trim() ? ctx.parseCm(widthInput.value) : null;
  let t2 = typed > 0
    ? placing.t + (along >= placing.t ? 1 : -1) * (typed / k())
    : snapAlong(w, along, cursorFree);
  t2 = clamp(t2, 0, f.len);
  if (Math.abs(s) > halfThick(w) * 0.2) placing.side = s > 0 ? 1 : -1;
  return {
    id: -1, levelId: level.id, wallId: w.id, kind: currentKind(tool),
    offsetPx: r2(Math.min(placing.t, t2)), widthPx: r2(Math.abs(t2 - placing.t)),
    hinge: t2 >= placing.t ? 0 : 1, side: placing.side,
  };
}

// ---- options bar ---------------------------------------------------------------------
const thickness = () => {
  const v = Number(settings.value("wallThicknessCm"));
  return v > 0 ? v : 10;
};
const family = (kind) => (isDoorKind(kind) ? "door" : "window");
function currentKind(forTool) {
  const list = forTool === "door" ? DOOR_KINDS : WINDOW_KINDS;
  const saved = settings.value(forTool === "door" ? "doorKind" : "windowKind");
  return list.includes(saved) ? saved : list[0];
}
const selectedWalls = () => walls.filter((w) => selected.has(w.id));
const selectedOpenings = () => openings.filter((o) => selOps.has(o.id));
function oneOpening() {
  const ops = selectedOpenings();
  return tool === "select" && ops.length === 1 && !selected.size ? ops[0] : null;
}

/** Which fields the options bar shows: the ones that mean something right now. */
function fields() {
  const show = new Set(overlay ? ["image"] : []);
  if (tool === "wall") ["length", "thickness"].forEach((f) => show.add(f));
  else if (isOpeningTool()) ["kind", "width"].forEach((f) => show.add(f));
  else if (oneOpening()) ["kind", "width", "from", "flip"].forEach((f) => show.add(f));
  else if (selected.size && !selOps.size) ["length", "thickness"].forEach((f) => show.add(f));
  return show;
}

function fillKinds(fam) {
  const sig = `${fam}:${currentLanguage()}`;
  if (kindSelect.dataset.sig === sig) return;
  kindSelect.dataset.sig = sig;
  kindSelect.innerHTML = "";
  for (const kd of fam === "door" ? DOOR_KINDS : WINDOW_KINDS) kindSelect.add(new Option(t("kind." + kd), kd));
}

function refreshBar() {
  if (!active) return;
  for (const b of toolBtns) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
  $("#ed-tool-name").textContent = t("editor." + tool);
  // the unit a bare number is read in; any unit can still be typed explicitly
  const u = settings.value("units");
  for (const el of bar.querySelectorAll(".ed-unit")) el.textContent = u === "ftin" ? "ft in" : u === "in" ? "in" : unitHint(u);
  const show = fields();
  for (const el of bar.querySelectorAll("[data-field]")) el.hidden = !show.has(el.dataset.field);

  const oneWall = tool === "select" && selected.size === 1 && !selOps.size ? walls.find((w) => selected.has(w.id)) : null;
  const op = oneOpening();
  const idle = (el) => document.activeElement !== el;

  lengthInput.disabled = !((tool === "wall" && chain) || oneWall);
  if (idle(lengthInput)) {
    lengthInput.value = oneWall ? ctx.inputCm(wallCm(oneWall)) : "";
    if (lengthInput.disabled) lengthInput.placeholder = "";
  }
  widthInput.disabled = !((isOpeningTool() && placing) || op);
  if (idle(widthInput)) {
    widthInput.value = op ? ctx.inputCm(op.widthPx * k()) : "";
    if (widthInput.disabled) widthInput.placeholder = "";
  }
  if (op && idle(fromInput)) fromInput.value = ctx.inputCm(fromCorner(op).px * k());
  if (idle(thickInput)) {
    const sel = selectedWalls();
    const allSame = sel.length && sel.every((w) => w.thicknessCm === sel[0].thicknessCm);
    thickInput.value = ctx.inputCm(tool === "select" && allSame ? sel[0].thicknessCm : thickness());
  }
  if (show.has("kind")) {
    fillKinds(op ? family(op.kind) : tool);
    kindSelect.value = op ? op.kind : currentKind(tool);
  }
}

function hint() {
  if (!active) return;
  const key = moving ? "editor.hintMove"
    : movingOp ? "editor.hintMoveOpening"
    : tool === "select" ? "editor.hintSelect"
    : tool === "wall" ? (chain ? "editor.hintChain" : "editor.hintWall")
    : placing ? "editor.hintPlace2"
    : tool === "door" ? "editor.hintDoor" : "editor.hintWindow";
  setStatus(t(key));
}

function setTool(next) {
  settle();
  tool = next;
  if (tool !== "select") { selected.clear(); selOps.clear(); }
  render();
  renderPreview();
  hint();
}

// ---- commands (every change is one undo step) ----------------------------------------
function upsertIn(list, rows) {
  for (const row of rows) {
    const i = list.findIndex((x) => x.id === row.id);
    if (i >= 0) list[i] = row; else list.push(row);
  }
}
function upsert(rows) { upsertIn(walls, rows); render(); }
function upsertOps(rows) { upsertIn(openings, rows); render(); }

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
    undo: async () => {
      await api.deleteWalls([row.id]);
      walls = walls.filter((w) => w.id !== row.id);
      openings = openings.filter((o) => o.wallId !== row.id);   // the database cascades too
      render();
    },
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

async function addOpening(o) {
  const { id: _, ...fresh } = o;
  let row = null;
  await history.run({
    label: t(isDoorKind(o.kind) ? "opening.addDoor" : "opening.addWindow"),
    do: async () => {
      row = row ? (await api.putOpenings([row]))[0] : await api.addOpening(fresh);
      upsertOps([row]);
    },
    undo: async () => {
      await api.deleteOpenings([row.id]);
      openings = openings.filter((x) => x.id !== row.id);
      render();
    },
  });
  return row;
}

async function replaceOps(label, before, after) {
  await history.run({
    label,
    do: async () => upsertOps(await api.putOpenings(after)),
    undo: async () => upsertOps(await api.putOpenings(before)),
  });
}

/** Change the one selected opening; refused (with a message) if it would not fit. */
async function changeOpening(label, patch) {
  const op = oneOpening();
  if (!op) return;
  const next = { ...op, ...patch };
  const len = wallFrame(wallOf(op)).len;
  next.offsetPx = r2(clamp(next.offsetPx, 0, len - Math.min(next.widthPx, len)));
  next.widthPx = r2(Math.min(next.widthPx, len - next.offsetPx));
  if (next.widthPx * k() < MIN_OPENING_CM) { setStatus(t("editor.tooNarrow")); return; }
  if (overlaps(next)) { setStatus(t("editor.overlap")); render(); return; }
  await write(() => replaceOps(label, [op], [next]));
}

/** Delete the selected walls and openings as one step. A wall's own doors and
 *  windows go with it, and come back with it on undo. */
async function deleteSelected() {
  const ws = selectedWalls();
  const wallIds = ws.map((w) => w.id);
  const ops = openings.filter((o) => selOps.has(o.id) || wallIds.includes(o.wallId));
  const loose = ops.filter((o) => !wallIds.includes(o.wallId)).map((o) => o.id);
  if (!ws.length && !ops.length) return;
  await write(() => history.run({
    label: t("editor.deleteLabel"),
    do: async () => {
      if (loose.length) await api.deleteOpenings(loose);
      if (wallIds.length) await api.deleteWalls(wallIds);
      const gone = new Set(ops.map((o) => o.id));
      openings = openings.filter((o) => !gone.has(o.id));
      walls = walls.filter((w) => !wallIds.includes(w.id));
      render();
    },
    undo: async () => {
      if (ws.length) upsertIn(walls, await api.putWalls(ws));
      if (ops.length) upsertIn(openings, await api.putOpenings(ops));
      render();
    },
  }));
  setStatus(t("editor.deleted", { n: ws.length + ops.length }));
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
  const one = selected.size === 1 ? walls.find((w) => selected.has(w.id)) : null;
  const cm = ctx.parseCm(lengthInput.value);
  if (!one || !(cm > 0)) { lengthInput.classList.toggle("invalid", !!one); return; }
  lengthInput.classList.remove("invalid");
  if (Math.abs(cm - wallCm(one)) < 0.05) { lengthInput.blur(); return; }   // Enter, then the blur's change event
  // keep the first corner, move the second along the wall; walls joined there follow
  const a = end1(one), b = end2(one);
  const f = cm / k() / dist(a, b);
  const to = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  await write(() => moveCorner(t("wall.length"), endsAt(b), to));
  lengthInput.blur();
}

async function applyThickness() {
  const cm = ctx.parseCm(thickInput.value);
  if (!(cm > 0) || cm > 200) { thickInput.classList.add("invalid"); return; }
  thickInput.classList.remove("invalid");
  settings.set({ wallThicknessCm: cm });
  const rows = tool === "select" ? selectedWalls().filter((w) => w.thicknessCm !== cm) : [];
  if (rows.length) await write(() => replaceWalls(t("wall.thickness"), rows, rows.map((w) => ({ ...w, thicknessCm: cm }))));
  refreshBar(); renderPreview();
}

// ---- door and window tools -----------------------------------------------------------
function cancelPlacing() {
  if (!placing) return;
  placing = null;
  widthInput.value = "";
  widthInput.blur();
  renderPreview(); refreshBar(); hint();
}

async function openingClick(raw) {
  if (!placing) {
    const w = wallAt(raw);
    if (!w) { setStatus(t("editor.notOnWall")); return; }
    const { t: along, s } = wallFrame(w).local(raw);
    placing = { wall: w, t: snapAlong(w, along, cursorFree), side: s < 0 ? -1 : 1 };
    renderPreview(); refreshBar(); hint();
    return;
  }
  const o = placementOpening();
  if (!o) return;
  if (o.widthPx * k() < MIN_OPENING_CM) { setStatus(t("editor.tooNarrow")); return; }
  if (overlaps(o)) { setStatus(t("editor.overlap")); return; }
  placing = null;
  widthInput.value = "";
  widthInput.blur();
  await write(() => addOpening(o));
  renderPreview(); refreshBar();
  setStatus(t("opening.placed", { kind: t("kind." + o.kind), w: fmt(o.widthPx * k()) }));
}

async function typedWidth() {
  const cm = ctx.parseCm(widthInput.value);
  if (!(cm > 0)) { widthInput.classList.add("invalid"); return; }
  widthInput.classList.remove("invalid");
  if (placing) { widthInput.blur(); await openingClick(cursorRaw); return; }
  const op = oneOpening();
  if (!op || Math.abs(cm - op.widthPx * k()) < 0.05) { widthInput.blur(); return; }
  // the hinge side stays put; the opening grows or shrinks at the other side
  const w = cm / k();
  const offsetPx = op.hinge ? op.offsetPx + op.widthPx - w : op.offsetPx;
  await changeOpening(t("opening.change"), { offsetPx, widthPx: w });
  widthInput.blur();
}

async function typedFrom() {
  const op = oneOpening();
  const cm = ctx.parseCm(fromInput.value);
  if (!op || cm == null || Number.isNaN(cm) || cm < 0) { fromInput.classList.toggle("invalid", !!op); return; }
  fromInput.classList.remove("invalid");
  const ref = fromCorner(op);
  if (Math.abs(cm - ref.px * k()) < 0.05) { fromInput.blur(); return; }
  const len = wallFrame(wallOf(op)).len;
  const offsetPx = ref.end === "start" ? cm / k() : len - op.widthPx - cm / k();
  await changeOpening(t("opening.move"), { offsetPx });
  fromInput.blur();
}

const flipSide = () => { const op = oneOpening(); if (op) changeOpening(t("opening.change"), { side: -op.side }); };
const flipHinge = () => { const op = oneOpening(); if (op) changeOpening(t("opening.change"), { hinge: op.hinge ? 0 : 1 }); };

// ---- select tool ---------------------------------------------------------------------
function cancelMove() {
  if (!moving) return;
  upsert(moving.affected.map((a) => a.before));   // put the preview back where it was
  moving = null;
  hint();
}
function cancelMoveOp() {
  if (!movingOp) return;
  const before = movingOp.before;
  movingOp = null;
  upsertOps([before]);
  hint();
}

/** While an opening is picked up it slides along its own wall with the mouse. */
function slideOpening(raw) {
  const o = openings.find((x) => x.id === movingOp.before.id);
  const w = wallOf(o);
  if (!w) return;
  const len = wallFrame(w).len;
  let start = clamp(wallFrame(w).local(raw).t - movingOp.grab, 0, len - o.widthPx);
  if (!cursorFree) {
    // whichever edge is nearer to something to snap to wins
    const s1 = snapAlong(w, start, false, o.id);
    const s2 = snapAlong(w, start + o.widthPx, false, o.id) - o.widthPx;
    start = Math.abs(s1 - start) <= Math.abs(s2 - start) ? s1 : s2;
  }
  upsertOps([{ ...o, offsetPx: r2(clamp(start, 0, len - o.widthPx)) }]);   // preview only
}

async function selectClick(raw, e) {
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  if (moving) {
    const p = snap(raw, { from: moving.anchor, exclude: moving.ids, free: e.ctrlKey || e.metaKey });
    const m = moving;
    moving = null;
    upsert(m.affected.map((a) => a.before));
    await write(() => moveCorner(t("wall.move"), m.affected, p));
    hint();
    return;
  }
  if (movingOp) {
    const before = movingOp.before;
    const now = openings.find((x) => x.id === before.id);
    movingOp = null;
    upsertOps([before]);
    if (now && overlaps(now)) { setStatus(t("editor.overlap")); hint(); return; }
    if (now && now.offsetPx !== before.offsetPx) await write(() => replaceOps(t("opening.move"), [before], [now]));
    hint();
    return;
  }
  const tol = HANDLE_PX / screenScale();
  for (const w of selectedWalls()) {
    for (const [p, other] of [[end1(w), end2(w)], [end2(w), end1(w)]]) {
      if (dist(p, raw) < tol) {
        const affected = endsAt(p);
        moving = { affected, anchor: other, ids: new Set(affected.map((a) => a.before.id)) };
        hint();
        return;
      }
    }
  }
  const op = openingAt(raw);
  if (op) {
    // clicking the already selected door or window picks it up to slide it
    if (!additive && selOps.size === 1 && selOps.has(op.id) && !selected.size) {
      movingOp = { before: { ...op }, grab: wallFrame(wallOf(op)).local(raw).t - op.offsetPx };
      render(); hint();
      return;
    }
    if (additive) selOps.has(op.id) ? selOps.delete(op.id) : selOps.add(op.id);
    else { selected.clear(); selOps = new Set([op.id]); }
    render();
    const one = oneOpening();
    if (one) setStatus(t("opening.info", { kind: t("kind." + one.kind), w: fmt(one.widthPx * k()), d: fmt(fromCorner(one).px * k()) }));
    else hint();
    return;
  }
  const hit = wallAt(raw);
  if (!hit) { if (!additive) { selected.clear(); selOps.clear(); } }
  else if (additive) { selected.has(hit.id) ? selected.delete(hit.id) : selected.add(hit.id); }
  else { selected = new Set([hit.id]); selOps.clear(); }
  render();
  if (hit && selected.size === 1 && !selOps.size) setStatus(t("wall.info", { len: fmt(wallCm(hit)), th: fmt(hit.thicknessCm) }));
  else hint();
}

// ---- entering and leaving ------------------------------------------------------------
/** A text box in the options bar: Enter applies, Esc restores, leaving it applies. */
function wireField(input, apply, { liveWhile } = {}) {
  input.addEventListener("input", () => { input.classList.remove("invalid"); if (liveWhile?.()) renderPreview(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); input.value = ""; input.blur(); refreshBar(); renderPreview(); }
  });
  input.addEventListener("change", () => { if (tool === "select") apply(); });
}

export function init(hooks) {
  ctx = hooks;
  for (const b of toolBtns) b.addEventListener("click", () => setTool(b.dataset.tool));
  wireField(lengthInput, typedLength, { liveWhile: () => tool === "wall" });
  wireField(widthInput, typedWidth, { liveWhile: () => !!placing });
  wireField(fromInput, typedFrom);
  thickInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); thickInput.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); thickInput.blur(); refreshBar(); }
  });
  thickInput.addEventListener("change", applyThickness);
  kindSelect.addEventListener("change", () => {
    const op = oneOpening();
    if (op) { changeOpening(t("opening.change"), { kind: kindSelect.value }); return; }
    settings.set({ [tool === "door" ? "doorKind" : "windowKind"]: kindSelect.value });
    renderPreview();
  });
  $("#ed-flip-side").addEventListener("click", flipSide);
  $("#ed-flip-hinge").addEventListener("click", flipHinge);
  imageRange.addEventListener("input", () => overlay?.setOpacity(imageRange.value / 100));
}

/** A floor was shown: create the panes and draw its sheet, walls, doors and windows. */
export async function attach(m, lvl, { height: h, overlay: ov }) {
  map = m; level = lvl; height = h; overlay = ov;
  baseSheet = ov ? null : { x0: 0, y0: 0, x1: lvl.widthPx, y1: lvl.heightPx };
  sheetKey = "";
  walls = []; openings = []; selected = new Set(); selOps = new Set();
  chain = null; moving = null; movingOp = null; placing = null; cursor = null; cursorRaw = null; active = false;
  // Panes stack the plan: image or sheet < walls < rulers and pins (Leaflet's own panes).
  map.createPane("plan-base").style.zIndex = 250;
  map.createPane("plan-walls").style.zIndex = 350;
  map.createPane("plan-labels").style.zIndex = 450;
  sheetLayer = L.layerGroup().addTo(map);
  wallLayer = L.layerGroup().addTo(map);
  drawLayer = L.layerGroup().addTo(map);
  [walls, openings] = await Promise.all([api.listWalls(lvl.id), api.listOpenings(lvl.id)]);
  render();
}

export function detach() {
  if (active) exit();
  map = null; level = null; wallLayer = null; drawLayer = null; sheetLayer = null; walls = []; openings = [];
}

/** The paper of a drawn floor: the sheet it was created with, grown to keep a margin
 *  around every wall (and around `extra`, the wall being drawn). Worked out each time
 *  rather than stored, so it also shrinks back when walls are undone or deleted. */
function sheetRect(extra) {
  const step = SHEET_STEP_CM / k(), margin = SHEET_MARGIN_CM / k();
  const r = { ...baseSheet };
  const pts = walls.flatMap((w) => [end1(w), end2(w)]);
  if (extra) pts.push(extra);
  for (const p of pts) {
    r.x0 = Math.min(r.x0, Math.floor((p.x - margin) / step) * step);
    r.y0 = Math.min(r.y0, Math.floor((p.y - margin) / step) * step);
    r.x1 = Math.max(r.x1, Math.ceil((p.x + margin) / step) * step);
    r.y1 = Math.max(r.y1, Math.ceil((p.y + margin) / step) * step);
  }
  return r;
}

/** A drawn floor is white paper with a 1 m grid, heavier every 5 m. The grid is laid on
 *  whole metres of the plan, so it does not move when the sheet grows. The colours are
 *  fixed: the sheet stays paper-white in dark mode, like any imported plan. */
function drawSheet(extra) {
  if (!baseSheet || !sheetLayer) return;
  const r = sheetRect(extra);
  const key = `${r.x0},${r.y0},${r.x1},${r.y1}`;
  if (key === sheetKey) return;
  sheetKey = key;
  sheetLayer.clearLayers();
  const b = L.latLngBounds(toLatLng({ x: r.x0, y: r.y1 }), toLatLng({ x: r.x1, y: r.y0 }));
  L.rectangle(b, { pane: "plan-base", color: "#c9d0cc", weight: 1, fillColor: "#ffffff", fillOpacity: 1, interactive: false }).addTo(sheetLayer);
  const m = 100 / k(), major = (v) => Math.abs(Math.round(v / m)) % 5 === 0;
  const minorLines = [], majorLines = [];
  for (let x = Math.ceil(r.x0 / m + 1e-9) * m; x < r.x1 - 1e-6; x += m) {
    (major(x) ? majorLines : minorLines).push([toLatLng({ x, y: r.y0 }), toLatLng({ x, y: r.y1 })]);
  }
  for (let y = Math.ceil(r.y0 / m + 1e-9) * m; y < r.y1 - 1e-6; y += m) {
    (major(y) ? majorLines : minorLines).push([toLatLng({ x: r.x0, y }), toLatLng({ x: r.x1, y })]);
  }
  L.polyline(minorLines, { pane: "plan-base", color: "#e6ebe8", weight: 1, interactive: false }).addTo(sheetLayer);
  L.polyline(majorLines, { pane: "plan-base", color: "#cfd7d3", weight: 1, interactive: false }).addTo(sheetLayer);
  ctx.onSheet?.(b);
}

/** The floor's record changed (calibrated, renamed): wall thickness depends on the scale. */
export function updateLevel(lvl) {
  if (!level || lvl.id !== level.id) return;
  level = lvl;
  render();
}

export const isActive = () => active;

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
  if (overlay) { imageRange.value = 35; overlay.setOpacity(0.35); }
  map.getContainer().classList.add("editing-walls");
  map.doubleClickZoom.disable();
  render(); renderPreview(); hint();
  return true;
}

export function exit() {
  if (!active) return;
  settle();
  active = false;
  selected.clear();
  selOps.clear();
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
  cursorRaw = raw;
  cursorFree = e.ctrlKey || e.metaKey;
  if (tool === "select") { selectClick(raw, e); return; }
  if (isOpeningTool()) { openingClick(raw); return; }
  // a length typed and then a click: the wall gets the typed length, in the clicked direction
  if (chain && lengthInput.value.trim() && ctx.parseCm(lengthInput.value) > 0) {
    cursor = snap(raw, { from: chain.start, free: cursorFree });
    wallClick({ ...previewEnd(), kind: null });
    return;
  }
  wallClick(snap(raw, { from: chain?.start, free: cursorFree }));
}

export function move(latlng, e) {
  if (!active) return;
  const raw = toPoint(latlng);
  cursorRaw = raw;
  cursorFree = !!(e?.ctrlKey || e?.metaKey);
  if (tool === "wall") {
    cursor = snap(raw, { from: chain?.start, free: cursorFree });
  } else if (moving) {
    cursor = snap(raw, { from: moving.anchor, exclude: moving.ids, free: cursorFree });
    upsert(moved(moving.affected, cursor));      // preview only: nothing is saved until the click
  } else if (movingOp) {
    slideOpening(raw);
  } else {
    cursor = null;
  }
  renderPreview();
}

export function contextMenu(latlng, at) {
  if (!active) return;
  const p = toPoint(latlng);
  const op = openingAt(p);
  const hit = op ? null : wallAt(p);
  const items = [];
  if (op) {
    setTool("select");
    selected.clear(); selOps = new Set([op.id]); render();
    items.push(
      { text: t("editor.flipSideTip"), action: flipSide },
      { text: t("editor.flipHingeTip"), action: flipHinge },
      { text: t("menu.delete"), action: deleteSelected },
      { separator: true },
    );
  } else if (hit) {
    items.push({ text: t("menu.deleteWall"), action: () => { selected = new Set([hit.id]); selOps.clear(); deleteSelected(); } });
    items.push({ separator: true });
  }
  for (const b of toolBtns) items.push({ text: t("editor." + b.dataset.tool), action: () => setTool(b.dataset.tool) });
  showContextMenu(items, at);
}

/** Keys while editing. Returns true when the key was used here. */
export function onKey(e) {
  if (!active) return false;
  if (history.focusIsInTextField()) return false;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (e.key === "Escape") {
    e.preventDefault();
    if (moving) cancelMove();
    else if (movingOp) cancelMoveOp();
    else if (placing) cancelPlacing();
    else if (chain) finishChain();
    else if (tool !== "select") setTool("select");
    else if (selected.size || selOps.size) { selected.clear(); selOps.clear(); render(); hint(); }
    return true;
  }
  if (e.key === "Enter" && chain) { e.preventDefault(); finishChain(); return true; }
  if (e.key === "Backspace" && chain) { e.preventDefault(); stepBack(); return true; }
  if (mod && key === "z" && !e.shiftKey && chain) { e.preventDefault(); stepBack(); return true; }
  if (mod && (key === "z" || key === "y")) { settle(); return false; }   // the app's undo/redo takes it from here
  if ((e.key === "Delete" || e.key === "Backspace") && (selected.size || selOps.size)) { e.preventDefault(); deleteSelected(); return true; }
  if (mod && key === "a") {
    e.preventDefault();
    setTool("select");
    selected = new Set(walls.map((w) => w.id));
    selOps = new Set(openings.map((o) => o.id));
    render(); hint();
    return true;
  }
  if (mod && ["c", "x", "v"].includes(key)) { e.preventDefault(); return true; }   // pins are out of reach while editing
  if (mod || e.altKey) return false;
  if (oneOpening() && key === "f") { flipSide(); return true; }
  if (oneOpening() && key === "h") { flipHinge(); return true; }
  const toolKey = { v: "select", s: "select", w: "wall", d: "door", n: "window" }[key];
  if (toolKey) { setTool(toolKey); return true; }
  // typing a number while drawing starts the length (or width) box with that character
  if (/^[0-9.,]$/.test(e.key) && ((tool === "wall" && chain) || placing)) {
    e.preventDefault();
    const input = chain ? lengthInput : widthInput;
    input.value = e.key;
    input.focus();
    renderPreview();
    return true;
  }
  return false;
}

/** The unit preference or the language changed: lengths, names and hints follow. */
export function refreshUnits() { render(); renderPreview(); hint(); }

/** End any half-finished gesture, before undo/redo changes things underneath it. */
export function settle() { finishChain(); cancelMove(); cancelMoveOp(); cancelPlacing(); }
