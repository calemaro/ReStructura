// Minimal internationalisation.
//
// Every user-visible string lives in src/locales/<lang>.json as a flat
// key -> string map. Nothing visible is written directly in HTML or JS.
//
//   - Static HTML:  <span data-i18n="panel.label"></span>   filled by applyTranslations()
//   - Dynamic JS:   t("status.clicked", { x: 120, y: 340 })  -> placeholders in {braces}
//
// Lookup order: active language -> English -> the key itself. A missing
// translation therefore shows up as a visible key, never as a crash.
// Adding a language = adding one JSON file and one entry in SUPPORTED.

export const SUPPORTED = { en: "English", it: "Italiano" };
const FALLBACK = "en";
const STORAGE_KEY = "planfloorviewer.lang";   // moves to the SQLite settings table in Phase F

const cache = {};                              // lang -> dictionary
let active = FALLBACK;
let dict = {};
let fallbackDict = {};

async function load(lang) {
  if (cache[lang]) return cache[lang];
  const res = await fetch(`locales/${lang}.json`);
  if (!res.ok) throw new Error(`locale ${lang}: HTTP ${res.status}`);
  cache[lang] = await res.json();
  return cache[lang];
}

/** Pick the initial language: remembered choice, else the system locale if we have it, else English. */
export function detectLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED[saved]) return saved;
  } catch (_) { /* storage unavailable: fall through */ }
  const sys = (navigator.language || FALLBACK).slice(0, 2).toLowerCase();
  return SUPPORTED[sys] ? sys : FALLBACK;
}

export async function setLanguage(lang) {
  if (!SUPPORTED[lang]) lang = FALLBACK;
  fallbackDict = await load(FALLBACK);
  dict = lang === FALLBACK ? fallbackDict : await load(lang);
  active = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) { /* ignore */ }
  document.documentElement.lang = lang;
  applyTranslations();
  document.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } }));
}

export function currentLanguage() { return active; }

export function t(key, vars) {
  let s = dict[key] ?? fallbackDict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Fill every element carrying data-i18n (text) or data-i18n-attr="title:key,placeholder:key" (attributes). */
export function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(",")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}
