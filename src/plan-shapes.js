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
//   stairs .......... outline and tread lines; a walking line from a dot at the first
//                     step to an arrow at the last, marked UP (or DOWN) at the start;
//                     going up, a zigzag break line where the plan cuts the stair,
//                     with the treads above the cut dashed. Spiral: the same around a
//                     central post.
//
// Shapes: { type: "fill" | "outline" | "line" | "text", pts: [{x, y}], weight?, dash?,
//           paper?, wallId?, openingId?, stairId?, text?, size? }
//   fill .... solid wall            outline .. closed thin outline (paper = white inside)
//   line .... open polyline         text ..... a word at pts[0], size in plan pixels

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

export function planShapes(walls, openings, cmPerPx, stairs = [], words = { up: "UP", down: "DOWN" }) {
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
  for (const s of stairs) out.push(...stairShapes(s, k, words));
  return out;
}

// ---- stairs ----------------------------------------------------------------------------
const DIRS = { e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1] };
const CUT = 0.6;                 // where the plan's cutting plane crosses a stair going up

function arrowHead(tip, d, a) {
  const nx = -d.y, ny = d.x;
  return [
    { x: tip.x - d.x * a + nx * a * 0.55, y: tip.y - d.y * a + ny * a * 0.55 },
    tip,
    { x: tip.x - d.x * a - nx * a * 0.55, y: tip.y - d.y * a - ny * a * 0.55 },
  ];
}
const circlePts = (c, r, n = 32) =>
  Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

export function stairShapes(s, k, words) {
  const tag = { stairId: s.id };
  const line = (pts, extra = {}) => ({ type: "line", pts, weight: THIN, ...tag, ...extra });
  const steps = Math.max(1, s.steps);
  const label = s.up ? words.up : words.down;
  return s.kind === "spiral" ? spiral(s, k, steps, label, line, tag) : straight(s, k, steps, label, line, tag);
}

function straight(s, k, steps, label, line, tag) {
  const [ux, uy] = DIRS[s.dir] ?? DIRS.n;
  const along = ux !== 0;                                   // travel along x
  const L = along ? s.w : s.h, W = along ? s.h : s.w;
  // the middle of the edge where the stair starts
  const start = {
    x: ux > 0 ? s.x : ux < 0 ? s.x + s.w : s.x + s.w / 2,
    y: uy > 0 ? s.y : uy < 0 ? s.y + s.h : s.y + s.h / 2,
  };
  const P = (t, c) => ({ x: start.x + ux * t - uy * c, y: start.y + uy * t + ux * c });
  const out = [{ type: "outline", pts: [P(0, -W / 2), P(L, -W / 2), P(L, W / 2), P(0, W / 2)], weight: LEAF, ...tag }];
  const cut = L * CUT;
  for (let i = 1; i < steps; i++) {
    const t = (L * i) / steps;
    out.push(line([P(t, -W / 2), P(t, W / 2)], { dash: s.up && t > cut }));
  }
  if (s.up) {
    // a Z-shaped break line across the stair (two parallel diagonals joined by a jog)
    const g = W * 0.07;
    out.push(line([P(cut - W * 0.2, -W / 2), P(cut - W * 0.02, -W * 0.05), P(cut + g + W * 0.02, W * 0.05), P(cut + g + W * 0.2, W / 2)], { weight: LEAF }));
  }
  const tread = L / steps, a = Math.min(W * 0.22, 25 / k);
  const from = P(tread * 0.5, 0), to = P(L - tread * 0.3, 0);
  out.push(line([from, to]));
  out.push(line(arrowHead(to, { x: ux, y: uy }, a)));
  out.push({ type: "fill", pts: circlePts(from, a * 0.22, 12), ...tag });
  out.push({ type: "text", pts: [P(tread * 0.5, W * 0.28)], text: label, size: Math.min(W * 0.16, 14 / k), ...tag });
  return out;
}

function spiral(s, k, steps, label, line, tag) {
  const c = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  const R = Math.min(s.w, s.h) / 2, r0 = Math.max(R * 0.12, 5 / k);
  const [dx, dy] = DIRS[s.dir] ?? DIRS.s;
  const a0 = Math.atan2(dy, dx);                            // where the first step is
  const sign = s.clockwise ? 1 : -1;                        // screen y points down: + is clockwise
  const sweep = (Math.PI * 5) / 3;                          // treads over 300°, a gap for the entry
  const at = (ang, r) => ({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) });
  const ang = (f) => a0 + sign * sweep * f;
  const out = [
    { type: "outline", pts: circlePts(c, R, 48), weight: LEAF, ...tag },
    { type: "outline", pts: circlePts(c, r0, 16), weight: THIN, ...tag },
  ];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    out.push(line([at(ang(f), r0), at(ang(f), R)], { dash: s.up && f > CUT }));
  }
  if (s.up) {
    const b = ang(CUT) + sign * 0.06;
    out.push(line([at(b - sign * 0.06, r0), at(b - sign * 0.06, R * 0.5), at(b + sign * 0.02, R * 0.58), at(b + sign * 0.02, R)], { weight: LEAF }));
  }
  const rw = R * 0.62, a = Math.min(R * 0.2, 25 / k);
  const walk = Array.from({ length: 41 }, (_, i) => at(ang(0.5 / steps + ((1 - 0.8 / steps) * i) / 40), rw));
  out.push(line(walk));
  const end = walk.at(-1), prev = walk.at(-2);
  const len = Math.hypot(end.x - prev.x, end.y - prev.y) || 1;
  out.push(line(arrowHead(end, { x: (end.x - prev.x) / len, y: (end.y - prev.y) / len }, a)));
  out.push({ type: "fill", pts: circlePts(walk[0], a * 0.22, 12), ...tag });
  // the word sits in the gap between the last step and the first
  out.push({ type: "text", pts: [at(a0 - sign * (2 * Math.PI - sweep) / 2, R * 0.6)], text: label, size: Math.min(R * 0.18, 14 / k), ...tag });
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
