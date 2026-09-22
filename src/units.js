// Lengths are ALWAYS stored in centimetres. This module is the only place that
// knows about display units, so switching between metric and imperial changes
// what is shown and what can be typed, never what is stored — a project made in
// one system opens correctly in the other.

export const UNIT_SYSTEMS = {
  cm: "unit.cm",     // centimetres, with metres alongside from 1 m up
  m: "unit.m",       // metres
  ftin: "unit.ftin", // feet and inches, e.g. 4' 7"
  in: "unit.in",     // inches
};
export const DEFAULT_UNIT = "cm";

const CM_PER_INCH = 2.54;
const CM_PER_FOOT = 30.48;

// ---- parsing -------------------------------------------------------------------------
// Whatever the display unit, all of these are understood, so a number copied from
// anywhere still works:
//   112      112 cm     1.12 m     1,12m      1120 mm
//   44 in    44"        3 ft       3'         3' 8"    3 ft 8 in    3-8"
// A bare number is read in the ACTIVE unit: "112" is 112 cm under cm, 112 inches
// under in, and 112 feet would be absurd — so under ft-in a bare number is inches.

/** Parse a typed length into centimetres. null = empty, NaN = not a length. */
export function parseCm(text, unit = DEFAULT_UNIT) {
  const s = String(text ?? "").trim().toLowerCase().replace(/,/g, ".").replace(/\s+/g, " ");
  if (!s) return null;

  // feet and inches together: 3' 8", 3ft 8in, 3-8", 3' 8
  const ftin = s.match(/^(\d*\.?\d+)\s*(?:(?:'|ft|feet|foot)\s*[- ]?\s*|-)\s*(\d*\.?\d+)?\s*(?:"|in|inch|inches)?$/);
  if (ftin) {
    const ft = parseFloat(ftin[1]);
    const inch = ftin[2] ? parseFloat(ftin[2]) : 0;
    return ft * CM_PER_FOOT + inch * CM_PER_INCH;
  }
  // a single value with an explicit unit
  const one = s.match(/^(\d*\.?\d+)\s*(mm|cm|m|"|in|inch|inches|'|ft|feet|foot)?$/);
  if (!one) return NaN;
  const n = parseFloat(one[1]);
  switch (one[2]) {
    case "mm": return n / 10;
    case "cm": return n;
    case "m": return n * 100;
    case '"': case "in": case "inch": case "inches": return n * CM_PER_INCH;
    case "'": case "ft": case "feet": case "foot": return n * CM_PER_FOOT;
    default:
      // no unit given: read it in the unit currently on screen
      if (unit === "m") return n * 100;
      if (unit === "in" || unit === "ftin") return n * CM_PER_INCH;
      return n;
  }
}

// ---- formatting ----------------------------------------------------------------------

const nf = (lang, max = 1) => new Intl.NumberFormat(lang, { maximumFractionDigits: max });

/** A length for display, in the chosen unit. */
export function formatCm(cm, lang, unit = DEFAULT_UNIT) {
  if (cm == null || !isFinite(cm)) return "";
  switch (unit) {
    case "m":
      return `${nf(lang, 2).format(cm / 100)} m`;
    case "in":
      return `${nf(lang, 1).format(cm / CM_PER_INCH)}″`;
    case "ftin": {
      const totalIn = cm / CM_PER_INCH;
      const feet = Math.floor(totalIn / 12);
      const inches = totalIn - feet * 12;
      // round to a quarter inch: finer than anyone measures a wall with a tape
      const q = Math.round(inches * 4) / 4;
      const [f, i] = q >= 12 ? [feet + 1, 0] : [feet, q];
      const inchText = `${nf(lang, 2).format(i)}″`;
      return f ? `${f}′ ${inchText}` : inchText;
    }
    default: {
      const base = `${nf(lang, 1).format(cm)} cm`;
      return cm >= 100 ? `${base} · ${nf(lang, 2).format(cm / 100)} m` : base;
    }
  }
}

/** What goes inside an input box: a bare number in the active unit, no suffix. */
export function inputCm(cm, unit = DEFAULT_UNIT) {
  if (cm == null || !isFinite(cm)) return "";
  const round = (n, d) => String(Math.round(n * 10 ** d) / 10 ** d);
  switch (unit) {
    case "m": return round(cm / 100, 3);
    case "in": return round(cm / CM_PER_INCH, 2);
    case "ftin": {
      const totalIn = cm / CM_PER_INCH;
      const feet = Math.floor(totalIn / 12);
      const inches = Math.round((totalIn - feet * 12) * 4) / 4;
      return feet ? `${feet}' ${inches}"` : `${inches}"`;
    }
    default: return round(cm, 1);
  }
}

/** Placeholder/suffix hint for an input, e.g. "cm" or "ft in". */
export const unitHint = (unit = DEFAULT_UNIT) =>
  ({ cm: "cm", m: "m", in: '"', ftin: `' "` }[unit] ?? "cm");

/** Round values a scale bar should offer, in centimetres, for this unit system. */
export function scaleSteps(unit = DEFAULT_UNIT) {
  if (unit === "in" || unit === "ftin") {
    // 1″, 3″, 6″, 1′, 3′, 5′, 10′, 25′, 50′, 100′, 250′
    return [1, 3, 6, 12, 36, 60, 120, 300, 600, 1200, 3000].map((i) => i * CM_PER_INCH);
  }
  const out = [];
  for (let pow = 0; pow <= 4; pow++) for (const m of [1, 2, 5]) out.push(m * 10 ** pow);
  return out;
}

/** Label for a scale-bar value given in centimetres. */
export function scaleLabel(cm, unit = DEFAULT_UNIT) {
  if (unit === "in" || unit === "ftin") {
    const inches = Math.round(cm / CM_PER_INCH);
    return inches >= 12 ? { value: String(inches / 12), unit: "ft" } : { value: String(inches), unit: "in" };
  }
  return cm >= 100 ? { value: String(cm / 100), unit: "m" } : { value: String(cm), unit: "cm" };
}
