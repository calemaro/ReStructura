// The printed report: a self-contained document opened in a window and sent to
// the system print dialog, where "Save as PDF" produces the file.
//
// Everything is embedded as data URIs, so the document does not depend on the
// app or on any file staying where it is — it prints identically anywhere and
// can be saved and reopened on its own.

import { t, currentLanguage } from "./i18n.js";
import { colourFor, CATEGORIES } from "./categories.js";
import { formatCm } from "./units.js";

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nl2br = (v) => esc(v).replace(/\n/g, "<br>");

/** Pin markers drawn over the plan as an SVG overlay, numbered to match the list. */
function planSvg(level, pins, rooms, scheme, width, height) {
  const marks = pins.map((p, i) => {
    const colour = colourFor(scheme, p.category);
    const r = Math.max(9, Math.round(width / 85));
    return `
      <g>
        <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${colour}" stroke="#fff" stroke-width="${r * 0.22}"/>
        <text x="${p.x}" y="${p.y + r * 0.36}" font-size="${r * 1.05}" font-family="sans-serif"
              font-weight="700" fill="#fff" text-anchor="middle">${i + 1}</text>
      </g>`;
  }).join("");
  const labels = rooms.map((room) => {
    const size = Math.max(11, Math.round(width / 70));
    const h = room.ceilingCm ? `<tspan x="${room.x}" dy="${size * 1.15}" font-size="${size * 0.8}" font-weight="400">H ${(room.ceilingCm / 100).toFixed(2)} m</tspan>` : "";
    return `<text x="${room.x}" y="${room.y}" font-size="${size}" font-family="sans-serif" font-weight="600"
            fill="#333" text-anchor="middle" paint-order="stroke" stroke="#fff" stroke-width="${size * 0.35}"
            stroke-linejoin="round">${esc(room.name)}${h}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="plan-overlay">${labels}${marks}</svg>`;
}

/** A scale bar in the report, drawn to the floor's calibration. */
function scaleBlock(level, lang, unit) {
  if (!level.cmPerPx) return `<p class="note">${esc(t("report.uncalibrated"))}</p>`;
  const target = 160;                                   // report pixels
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  let best = steps[0], err = Infinity;
  for (const cm of steps) {
    const e = Math.abs(cm / level.cmPerPx - target);
    if (e < err) { best = cm; err = e; }
  }
  const px = Math.round(best / level.cmPerPx);
  const label = formatCm(best, lang, unit);
  return `
    <div class="scale">
      <span class="scale-label">${esc(t("report.scale"))}</span>
      <span class="scale-draw" style="width:${px}px"><i></i><i class="alt"></i></span>
      <span class="scale-label">${esc(label)}</span>
    </div>`;
}

function measurementRows(list, lang, unit) {
  if (!list.length) return "";
  const name = (m) => m.kind === "height" ? t("meas.height") : m.kind === "depth" ? t("meas.depth") : (m.reference || t("meas.distances"));
  return `<table class="meas">${list.map((m) =>
    `<tr><th>${esc(name(m))}</th><td>${esc(formatCm(m.valueCm, lang, unit))}</td></tr>`).join("")}</table>`;
}

/** Build the whole document. `floors` is [{ level, planUri, pins, rooms }] where each
 *  pin already carries its measurements, room name and photo data URIs. */
export function buildHtml({ project, floors, scheme, unit, withPhotos }) {
  const lang = currentLanguage();
  const date = new Date().toLocaleDateString(lang, { dateStyle: "long" });
  const usedCategories = new Set(floors.flatMap((f) => f.pins.map((p) => p.category)));

  const cover = `
    <section class="page cover">
      <p class="eyebrow">${esc(t("report.cover"))}</p>
      <h1>${esc(project.name)}</h1>
      <p class="sub">${esc(t("report.generated", { date }))}</p>
      <h2>${esc(t("report.contents"))}</h2>
      <ol class="toc">
        ${floors.map((f) => `<li><span>${esc(f.level.name)}</span><span class="dots"></span><span>${esc(t("report.floorPins", { n: f.pins.length }))}</span></li>`).join("")}
      </ol>
      <div class="legend">
        <h3>${esc(t("legend.title"))}</h3>
        <ul>${CATEGORIES.filter((c) => usedCategories.has(c)).map((c) =>
          `<li><span class="sw" style="background:${colourFor(scheme, c)}"></span>${esc(t("cat." + c))}</li>`).join("")}</ul>
      </div>
      <p class="note">${esc(t("report.approx"))}</p>
    </section>`;

  const floorPages = floors.map((f) => {
    const planPage = `
      <section class="page">
        <h2 class="floor-title">${esc(f.level.name)}</h2>
        <div class="plan-wrap">
          <img src="${f.planUri}" alt="">
          ${planSvg(f.level, f.pins, f.rooms, scheme, f.width, f.height)}
        </div>
        ${scaleBlock(f.level, lang, unit)}
      </section>`;

    if (!f.pins.length) {
      return planPage + `<section class="page"><p class="note">${esc(t("report.noPins"))}</p></section>`;
    }

    const pinBlocks = f.pins.map((p, i) => `
      <article class="pin">
        <header>
          <span class="num" style="background:${colourFor(scheme, p.category)}">${i + 1}</span>
          <h3>${esc(p.label || t("search.noLabel"))}</h3>
        </header>
        <dl class="facts">
          <dt>${esc(t("report.category"))}</dt><dd>${esc(t("cat." + p.category))}</dd>
          ${p.roomName ? `<dt>${esc(t("report.room"))}</dt><dd>${esc(p.roomName)}</dd>` : ""}
          <dt>${esc(t("report.recorded"))}</dt><dd>${esc(new Date(p.createdAt).toLocaleDateString(lang, { dateStyle: "medium" }))}</dd>
        </dl>
        ${p.measurements.length ? `<h4>${esc(t("report.measurements"))}</h4>${measurementRows(p.measurements, lang, unit)}` : ""}
        ${p.notes ? `<h4>${esc(t("report.notes"))}</h4><p class="notes">${nl2br(p.notes)}</p>` : ""}
        ${withPhotos && p.photos.length ? `<h4>${esc(t("report.photos"))}</h4>
          <div class="photos">${p.photos.map((ph) =>
            `<figure><img src="${ph.uri}" alt="">${ph.caption ? `<figcaption>${esc(ph.caption)}</figcaption>` : ""}</figure>`).join("")}</div>` : ""}
      </article>`).join("");

    return planPage + `<section class="page"><h2 class="floor-title">${esc(f.level.name)}</h2>${pinBlocks}</section>`;
  }).join("");

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(project.name)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c211f; }
  h1 { font-size: 26pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
  h2 { font-size: 14pt; margin: 0 0 8pt; }
  h3 { font-size: 12pt; margin: 0; }
  h4 { font-size: 9pt; letter-spacing: 0.07em; text-transform: uppercase; color: #5a615d; margin: 12pt 0 4pt; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .eyebrow { font-size: 9pt; letter-spacing: 0.16em; text-transform: uppercase; color: #5a615d; margin: 0 0 6pt; }
  .cover .sub { color: #5a615d; margin: 0 0 28pt; }
  .toc { list-style: none; padding: 0; margin: 0 0 24pt; }
  .toc li { display: flex; align-items: baseline; gap: 6pt; padding: 3pt 0; border-bottom: 1px solid #e4e7e0; }
  .toc .dots { flex: 1 1 auto; border-bottom: 1px dotted #c6cbc0; transform: translateY(-2pt); }
  .legend h3 { font-size: 9pt; letter-spacing: 0.07em; text-transform: uppercase; color: #5a615d; margin: 0 0 6pt; }
  .legend ul { list-style: none; padding: 0; margin: 0 0 20pt; display: grid; grid-template-columns: repeat(2, 1fr); gap: 4pt 16pt; font-size: 10pt; }
  .legend li { display: flex; align-items: center; gap: 7pt; }
  .sw { width: 11pt; height: 11pt; border-radius: 2pt; border: 0.5pt solid rgba(0,0,0,0.35); }
  .note { font-size: 9pt; color: #5a615d; border-left: 2pt solid #c6cbc0; padding-left: 8pt; margin: 10pt 0 0; }
  .floor-title { border-bottom: 1.5pt solid #1c211f; padding-bottom: 5pt; margin-bottom: 12pt; }
  .plan-wrap { position: relative; line-height: 0; }
  .plan-wrap img { width: 100%; height: auto; }
  .plan-overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
  .scale { display: flex; align-items: center; gap: 8pt; margin-top: 10pt; font-size: 9pt; color: #5a615d; }
  .scale-draw { display: flex; height: 7pt; border: 0.7pt solid #1c211f; }
  .scale-draw i { flex: 1 1 0; }
  .scale-draw i:first-child { background: #1c211f; }
  .pin { break-inside: avoid; page-break-inside: avoid; border-top: 1px solid #e4e7e0; padding: 12pt 0; }
  .pin:first-of-type { border-top: 0; padding-top: 0; }
  .pin header { display: flex; align-items: center; gap: 8pt; margin-bottom: 6pt; }
  .num { display: grid; place-items: center; width: 18pt; height: 18pt; border-radius: 50%; color: #fff; font-size: 10pt; font-weight: 700; flex: 0 0 auto; }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 2pt 10pt; margin: 0; font-size: 10pt; }
  .facts dt { color: #5a615d; }
  .facts dd { margin: 0; }
  .meas { border-collapse: collapse; font-size: 10pt; }
  .meas th { text-align: left; font-weight: 400; color: #5a615d; padding: 1pt 14pt 1pt 0; }
  .meas td { font-variant-numeric: tabular-nums; }
  .notes { margin: 0; white-space: pre-wrap; }
  .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 8pt; margin-top: 4pt; }
  .photos figure { margin: 0; break-inside: avoid; }
  .photos img { width: 100%; height: auto; border: 0.5pt solid #d5d9d1; }
  .photos figcaption { font-size: 8.5pt; color: #5a615d; margin-top: 2pt; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>${cover}${floorPages}</body>
</html>`;
}
