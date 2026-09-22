// Lengths are stored in centimetres. People type them however they like.
//
//   parseCm("112")     -> 112       parseCm("1.12 m") -> 112
//   parseCm("112 cm")  -> 112       parseCm("1,12m")  -> 112   (comma decimal, Italian keyboards)
//   parseCm("1120 mm") -> 112       parseCm("")       -> null  (no value)
//   parseCm("abc")     -> NaN       (invalid — caller shows an error)

export function parseCm(text) {
  const s = String(text ?? "").trim().toLowerCase().replace(",", ".");
  if (!s) return null;
  const m = s.match(/^([0-9]*\.?[0-9]+)\s*(mm|cm|m)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? "cm";
  return unit === "m" ? n * 100 : unit === "mm" ? n / 10 : n;
}

/** "112 cm" and, from one metre up, "112 cm · 1.12 m" (locale-aware decimal). */
export function formatCm(cm, lang) {
  if (cm == null || !isFinite(cm)) return "";
  const nf = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  const base = `${nf.format(cm)} cm`;
  return cm >= 100 ? `${base} · ${new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(cm / 100)} m` : base;
}

/** What to show inside an input box: plain number in cm, no unit. */
export const inputCm = (cm) => (cm == null ? "" : String(Math.round(cm * 10) / 10));
