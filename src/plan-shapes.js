// The drawn plan as simple shapes: walls with their doors and windows, in plan
// pixels. The editor draws these with Leaflet and the printed report with SVG, so
// the plan looks the same on screen and on paper. No DOM, no Leaflet here.
//
// Symbols follow standard architectural plan conventions, readable by a builder
// and by anyone else:
//   door ............ wall cut, leaf drawn open at 90° from the hinge, quarter-circle swing
//   double door ..... two leaves from the two jambs, each half the width
//   pocket door ..... wall beside the opening drawn hollow (the pocket), leaf in it,
//                     dashed where it is hidden inside the wall
//   opening ......... wall cut only; dashed lines along both faces = lintel overhead
//   window .......... wall cut, sill lines on both faces, frame lines at the jambs,
//                     double line in the middle for the glazing
//   fixed window .... the same with a single glazing line (nothing opens)
//   French window ... glazing line with the leaf swing(s) drawn like a door
//
// Shapes: { type: "fill" | "outline" | "line", pts: [{x, y}], weight?, dash?, paper?,
//           wallId, openingId? }
//   fill .... solid wall            outline .. closed thin outline (paper = white inside)
//   line .... open polyline

export const DOOR_KINDS = ["door", "double_door", "pocket_door", "opening"];
export const WINDOW_KINDS = ["window", "french_window", "french_window_2", "fixed_window"];
export const isDoorKind = (k) => DOOR_KINDS.includes(k);
/** Kinds drawn with a swing arc: clicking inside the arc selects them too. */
export const swings = (k) => ["door", "double_door", "french_window", "french_window_2"].includes(k);

const LEAF = 1.6;                // line weights, in screen pixels
const THIN = 1;

/** A wall's own coordinates: `at(t, s)` is the point t along it from its first end
 *  and s across it (positive s = side +1 of an opening). */
export function wallFrame(w) {
  const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
  const ux = len ? (w.x2 - w.x1) / len : 1, uy = len ? (w.y2 - w.y1) / len : 0;
  const nx = -uy, ny = ux;
  return {
    len, ux, uy, nx, ny,
    at: (t, s = 0) => ({ x: w.x1 + ux * t + nx * s, y: w.y1 + uy * t + ny * s }),
    /** A point in wall coordinates: t along, s across. */
    local: (p) => ({ t: (p.x - w.x1) * ux + (p.y - w.y1) * uy, s: (p.x - w.x1) * nx + (p.y - w.y1) * ny }),
  };
}

/** The part of the wall an opening cuts, clamped to the wall, or null if it no
 *  longer fits (a corner was moved and the wall got shorter). */
export function openingSpan(o, len) {
  const t0 = Math.max(0, o.offsetPx), t1 = Math.min(len, o.offsetPx + o.widthPx);
  return t1 - t0 > 0.5 ? [t0, t1] : null;
}

/** Where a pocket door's leaf goes: the stretch of wall beside the opening, on the hinge side. */
export function pocketSpan(o, len) {
  const s = openingSpan(o, len);
  if (!s) return null;
  const w = s[1] - s[0];
  return o.hinge ? [s[1], Math.min(len, s[1] + w)] : [Math.max(0, s[0] - w), s[0]];
}

/** Everything an opening takes up along its wall, pocket included: two openings may not share any of it. */
export function occupiedSpan(o, len) {
  const s = openingSpan(o, len);
  if (!s || o.kind !== "pocket_door") return s;
  const p = pocketSpan(o, len);
  return [Math.min(s[0], p[0]), Math.max(s[1], p[1])];
}

function arcPts(c, r, a0, a1, n = 20) {
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (d * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

export function planShapes(walls, openings, cmPerPx) {
  const k = cmPerPx || 1;
  const byWall = new Map();
  for (const o of openings) {
    if (!byWall.has(o.wallId)) byWall.set(o.wallId, []);
    byWall.get(o.wallId).push(o);
  }
  const out = [];
  for (const w of walls) {
    const f = wallFrame(w);
    if (!f.len) continue;
    const h = w.thicknessCm / k / 2;
    const rect = (a, b, s = h) => [f.at(a, s), f.at(b, s), f.at(b, -s), f.at(a, -s)];

    const ops = (byWall.get(w.id) ?? []).filter((o) => openingSpan(o, f.len));
    // what is cut out of the solid wall: the openings, and the pockets (hollow wall)
    const cuts = [];
    for (const o of ops) {
      cuts.push(openingSpan(o, f.len));
      if (o.kind === "pocket_door") cuts.push(pocketSpan(o, f.len));
    }
    cuts.sort((a, b) => a[0] - b[0]);
    let from = 0;
    const solid = [];
    for (const [a, b] of cuts) {
      if (a > from) solid.push([from, a]);
      from = Math.max(from, b);
    }
    if (from < f.len) solid.push([from, f.len]);
    // square ends only at the wall's real ends (so corners close); flat at the jambs
    for (const [a, b] of solid) {
      const ca = a <= 1e-6 ? h : 0, cb = b >= f.len - 1e-6 ? h : 0;
      out.push({ type: "fill", wallId: w.id, pts: rect(a - ca, b + cb) });
    }
    for (const o of ops) out.push(...symbol(o, f, h, k, rect));
  }
  return out;
}

function symbol(o, f, h, k, rect) {
  const [t0, t1] = openingSpan(o, f.len);
  const W = t1 - t0;
  const side = o.side >= 0 ? 1 : -1;
  const tag = { wallId: o.wallId, openingId: o.id };
  const line = (pts, extra = {}) => ({ type: "line", pts, weight: THIN, ...tag, ...extra });
  /** A leaf hinged at tHinge on the face it opens to, drawn open at 90°, with its swing to tFree. */
  const leaf = (tHinge, tFree, r) => {
    const hinge = f.at(tHinge, side * h);
    const tip = f.at(tHinge, side * (h + r));
    const shut = f.at(tFree, side * h);
    const a0 = Math.atan2(tip.y - hinge.y, tip.x - hinge.x);
    const a1 = Math.atan2(shut.y - hinge.y, shut.x - hinge.x);
    return [line([hinge, tip], { weight: LEAF }), line(arcPts(hinge, r, a0, a1))];
  };
  const jambs = () => [line([f.at(t0, -h), f.at(t0, h)]), line([f.at(t1, -h), f.at(t1, h)])];
  const glass = (double) => {
    const g = Math.min(h * 0.3, 1.5 / k);
    return double
      ? [line([f.at(t0, g), f.at(t1, g)]), line([f.at(t0, -g), f.at(t1, -g)])]
      : [line([f.at(t0, 0), f.at(t1, 0)])];
  };
  const sills = () => [line([f.at(t0, h), f.at(t1, h)]), line([f.at(t0, -h), f.at(t1, -h)])];

  switch (o.kind) {
    case "door": {
      const [th, tf] = o.hinge ? [t1, t0] : [t0, t1];
      return leaf(th, tf, W);
    }
    case "double_door":
      return [...leaf(t0, t0 + W / 2, W / 2), ...leaf(t1, t1 - W / 2, W / 2)];
    case "pocket_door": {
      const [p0, p1] = pocketSpan(o, f.len);
      const lt = Math.min(2 / k, h * 0.5);                 // leaf about 4 cm thick
      const edge = o.hinge ? t1 : t0;                      // where the leaf leaves the pocket
      const into = o.hinge ? -1 : 1;                       // direction into the opening
      return [
        { type: "outline", pts: rect(p0, p1), weight: THIN, paper: true, ...tag },   // hollow wall
        { type: "outline", pts: rect(edge, edge + into * W * 0.3, lt), weight: LEAF, ...tag },
        { type: "outline", pts: rect(edge, edge - into * W * 0.7, lt), weight: THIN, dash: true, ...tag },
      ];
    }
    case "opening":
      return sills().map((s) => ({ ...s, dash: true }));
    case "window":
      return [...sills(), ...jambs(), ...glass(true)];
    case "fixed_window":
      return [...sills(), ...jambs(), ...glass(false)];
    case "french_window": {
      const [th, tf] = o.hinge ? [t1, t0] : [t0, t1];
      return [...jambs(), ...glass(true), ...leaf(th, tf, W)];
    }
    case "french_window_2":
      return [...jambs(), ...glass(true), ...leaf(t0, t0 + W / 2, W / 2), ...leaf(t1, t1 - W / 2, W / 2)];
    default:
      return [];
  }
}
