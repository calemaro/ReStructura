// Pin categories and the colour schemes that display them.
//
// A pin stores a CATEGORY id (what the thing is). The project's colour SCHEME
// decides what colour that category is drawn in. The two conventions disagree
// — green is data/TV on an Italian site and sewer under the US APWA code —
// which is exactly why the colour is never stored on the pin.
//
// European scheme = Italian residential site practice. Checked against the sources
// (2026-09-22): CEI 64-100/2 table 4 recommends black = power, green = data/TV/phone,
// light blue = intercom/audio-video, brown = alarms (violet for multimedia is site
// custom, not in the guide). UNI 5634 says gas = yellow but ALL water = green and
// drains = black; the cold-blue / hot-red split is insulation-sheath custom.
// Decided with the user (2026-09-23): water follows sheath practice, cold = blue and
// hot/heating = red; drains = green; power stays black. Because drains took green,
// data/phone/TV uses white, the alternative CEI 64-100/2 itself allows for it.
// Light colours get a dark outline and dark text (see isLight) so they stay visible
// on a white plan. APWA: the US utility-locating code.

export const CATEGORIES = [
  "gas", "electric", "data", "alarm", "intercom", "multimedia",
  "cold_water", "hot_water", "drain", "other",
];

export const SCHEMES = {
  it: {
    gas: "#F2C300", electric: "#2B2B2B", data: "#FFFFFF", alarm: "#7A4B2A",
    intercom: "#6EC1E4", multimedia: "#7B3FA0", cold_water: "#1B62B5",
    hot_water: "#D42B1E", drain: "#2E9B4F", other: "#8A8F8A",
  },
  apwa: {
    gas: "#F2C300", electric: "#D42B1E", data: "#F07A13", alarm: "#F07A13",
    intercom: "#F07A13", multimedia: "#F07A13", cold_water: "#1B62B5",
    hot_water: "#1B62B5", drain: "#2E9B4F", other: "#8A8F8A",
  },
};

export const colourFor = (scheme, category) =>
  (SCHEMES[scheme] ?? SCHEMES.it)[category] ?? SCHEMES.it.other;

/** True for colours too pale for white text or a white outline (white, yellow…). */
export function isLight(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.72;
}
/** Text colour that reads on a given background colour. */
export const inkOn = (hex) => (isLight(hex) ? "#1c211f" : "#ffffff");

/** Leaflet icon: a map-pin silhouette filled with the category colour. */
export function pinIcon(colour, { selected = false } = {}) {
  const light = isLight(colour);
  const stroke = selected ? (light ? "#0b5fa5" : "#ffffff") : light ? "#4a4f4c" : "rgba(0,0,0,0.35)";
  const w = selected ? 2.5 : light ? 1.6 : 1.25;
  const dot = light ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.85)";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36">
    <path d="M13 1C6.4 1 1 6.3 1 12.8c0 8.6 10.3 20.6 11.2 21.6a1 1 0 0 0 1.6 0C14.7 33.4 25 21.4 25 12.8 25 6.3 19.6 1 13 1z"
          fill="${colour}" stroke="${stroke}" stroke-width="${w}"/>
    <circle cx="13" cy="12.8" r="4.2" fill="${dot}"/>
  </svg>`;
  return L.divIcon({ className: "pin-icon" + (selected ? " selected" : ""), html: svg,
    iconSize: [26, 36], iconAnchor: [13, 35], popupAnchor: [0, -30] });
}
