// Application settings: preferences belonging to this person on this machine.
//
// They are kept in browser storage rather than in a project, because they are
// about how YOU like to work — a project exported to someone else should arrive
// with their language and their units, not yours. Settings that describe the
// project itself (its name, its colour scheme) live in project.json instead.

const KEY = "restructura.settings";

const DEFAULTS = {
  language: null,            // null = follow the system locale
  theme: "system",           // "system" | "light" | "dark"
  units: "cm",               // see units.js — display only; storage is always cm
  defaultColourScheme: "it", // applied to newly created projects
};

let current = { ...DEFAULTS };
const listeners = new Set();

export function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    current = { ...DEFAULTS, ...saved };
  } catch (_) {
    current = { ...DEFAULTS };
  }
  applyTheme();
  return current;
}

export const get = () => current;
export const value = (name) => current[name];

export function set(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (_) { /* private window */ }
  if ("theme" in patch) applyTheme();
  listeners.forEach((fn) => fn(current, patch));
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** The stylesheet already handles light and dark; this forces one or follows the system. */
function applyTheme() {
  const root = document.documentElement;
  if (current.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", current.theme);
}
