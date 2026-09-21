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

import { t, setLanguage, detectLanguage, currentLanguage, SUPPORTED } from "./i18n.js";

// ---- the level (plan image) to show ------------------------------------------------
// One hardcoded level for the skeleton. Phase F replaces this with the `levels`
// table. To try your own plan locally, drop it in src/assets/private/ (gitignored)
// and point `image` at it — that folder never reaches the repository.
const LEVEL = {
  nameKey: "level.demo",
  image: "assets/demo-plan.png",
};

// ---- one hardcoded pin ---------------------------------------------------------------
// Phase D loads pins from SQLite instead. Position is in image pixels (see above).
const DEMO_PIN = {
  id: 1,
  x: 1010,
  y: 300,
  labelKey: "demo.pin.label",
  notesKey: "demo.pin.notes",
  createdAt: "2026-09-21T09:30:00Z",
};

// ---- helpers: image pixels <-> Leaflet coordinates ----------------------------------
let imageHeight = 0;
const toLatLng = (x, y) => L.latLng(imageHeight - y, x);
const toPixel = (latlng) => ({ x: Math.round(latlng.lng), y: Math.round(imageHeight - latlng.lat) });

// ---- DOM -----------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");
const panelEl = $("#panel");
const setStatus = (msg) => { statusEl.textContent = msg; };

function showPin(pin) {
  $("#pin-label").textContent = t(pin.labelKey);
  $("#pin-notes").textContent = t(pin.notesKey);
  $("#pin-position").textContent = t("panel.positionValue", { x: pin.x, y: pin.y });
  $("#pin-created").textContent = new Date(pin.createdAt).toLocaleString(currentLanguage());
  panelEl.hidden = false;
}
$("#panel-close").addEventListener("click", () => { panelEl.hidden = true; });

// ---- language switcher --------------------------------------------------------------
const langSelect = $("#lang-select");
for (const [code, name] of Object.entries(SUPPORTED)) langSelect.add(new Option(name, code));
langSelect.addEventListener("change", () => setLanguage(langSelect.value));
document.addEventListener("languagechange", () => {
  // strings built in JS need refreshing by hand; data-i18n ones are done by i18n.js
  $("#level-name").textContent = t(LEVEL.nameKey);
  if (!panelEl.hidden) showPin(DEMO_PIN);
  setStatus(t("status.ready"));
});

// ---- map -----------------------------------------------------------------------------
async function loadImageSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

async function main() {
  const lang = detectLanguage();
  langSelect.value = lang;
  await setLanguage(lang);           // fills every data-i18n element and fires languagechange

  const { width, height } = await loadImageSize(LEVEL.image);
  imageHeight = height;

  // In CRS.Simple one map unit = one image pixel at zoom 0. Bounds are given as
  // [[south, west], [north, east]] = [[0, 0], [height, width]].
  const bounds = L.latLngBounds([[0, 0], [height, width]]);

  const map = L.map("plan", {
    crs: L.CRS.Simple,
    minZoom: -3,                     // negative zoom = image smaller than 1:1
    maxZoom: 3,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,
    attributionControl: false,
    maxBounds: bounds.pad(0.5),      // don't let the plan be dragged completely off-screen
    maxBoundsViscosity: 0.6,
  });

  L.imageOverlay(LEVEL.image, bounds).addTo(map);
  map.fitBounds(bounds);
  $("#btn-fit").addEventListener("click", () => map.fitBounds(bounds));

  // the one hardcoded marker
  L.marker(toLatLng(DEMO_PIN.x, DEMO_PIN.y), { title: t(DEMO_PIN.labelKey) })
    .addTo(map)
    .on("click", () => showPin(DEMO_PIN));

  // report where the user clicks, in image pixels — this is what a real pin will store
  map.on("click", (e) => {
    const p = toPixel(e.latlng);
    setStatus(t("status.clicked", p));
    console.log("plan click (image px):", p);
  });
}

main().catch((err) => {
  console.error(err);
  setStatus(String(err));
});
