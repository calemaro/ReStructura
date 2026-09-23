// Help: a full screen, like Settings, explaining every feature and listing every
// keyboard shortcut, with a search box that filters as you type.
//
// The content lives in public/help/<language>.json and ships inside the app: nothing
// is fetched from the internet. A language without its own file falls back to
// English. Adding a language = adding one file, like the interface strings.
//
// Content format: { sections: [{ id, title, note?, keys?, items: [{ title, text?, keys? }] }],
//                   tour: { "<step id>": { title, text } } }
// In `text`, **word** is shown bold (used for the names of buttons and fields).

import { t, currentLanguage, keyNames } from "./i18n.js";

const $ = (sel) => document.querySelector(sel);
const screen = $("#help");
const searchInput = $("#help-search");
const tocEl = $("#help-toc");
const bodyEl = $("#help-body");
const cache = new Map();
let content = null;

async function load(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let data = null;
  try {
    const res = await fetch(`help/${lang}.json`);
    if (res.ok) data = await res.json();
  } catch (_) { /* no file for this language */ }
  if (!data) data = lang === "en" ? { sections: [], tour: {} } : await load("en");
  // on a Mac every shortcut and every mention of Ctrl reads ⌘
  data = JSON.parse(keyNames(JSON.stringify(data)));
  cache.set(lang, data);
  return data;
}

/** Title and text of one tour step, in the current language. */
export async function tourText(id) {
  const own = await load(currentLanguage());
  return own.tour?.[id] ?? (await load("en")).tour?.[id] ?? { title: id, text: "" };
}

// ---- search --------------------------------------------------------------------------
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Lower case without accents, one character for one character, so "perche" finds
 *  "perché" and match positions still line up with the original text. */
const fold = (s) => [...String(s ?? "")].map((c) => c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()[0] ?? c).join("");
const rich = (text) => esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
const keysHtml = (keys) => keys
  .map((combo) => combo.split("+").map((k) => `<kbd>${esc(k.trim())}</kbd>`).join("<span class=\"plus\">+</span>"))
  .join(`<span class="or"> / </span>`);

function render() {
  const words = fold(searchInput.value).split(/\s+/).filter(Boolean);
  const hits = (sec, item) => {
    if (!words.length) return true;
    const hay = fold([sec.title, item.title, item.text, ...(item.keys ?? [])].join(" "));
    return words.every((w) => hay.includes(w));
  };
  const shown = (content?.sections ?? [])
    .map((sec) => ({ sec, items: sec.items.filter((it) => hits(sec, it)) }))
    .filter((s) => s.items.length);

  tocEl.innerHTML = shown.map(({ sec, items }) =>
    `<a href="#help-${esc(sec.id)}" data-sec="${esc(sec.id)}"><span>${esc(sec.title)}</span>${words.length ? `<span class="n">${items.length}</span>` : ""}</a>`).join("");

  if (!shown.length) {
    bodyEl.innerHTML = `<p class="help-empty">${esc(t("help.noResults", { q: searchInput.value.trim() }))}</p>`;
    return;
  }
  bodyEl.innerHTML = shown.map(({ sec, items }) => {
    const note = sec.note ? `<p class="help-note">${rich(sec.note)}</p>` : "";
    const inner = sec.keys
      ? `<table class="help-keys">${items.map((it) => `<tr><td>${rich(it.title)}</td><td>${keysHtml(it.keys ?? [])}</td></tr>`).join("")}</table>`
      : items.map((it) => `<article class="help-item"><h3>${rich(it.title)}</h3><p>${rich(it.text)}</p></article>`).join("");
    return `<section id="help-${esc(sec.id)}"><h2>${esc(sec.title)}</h2>${note}${inner}</section>`;
  }).join("");
  highlight(bodyEl, words);
}

/** Wrap every occurrence of the search words in <mark>, without touching the markup. */
function highlight(root, words) {
  if (!words.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const folded = fold(text);
    if (folded.length !== text.length) continue;
    const ranges = [];
    for (const w of words) {
      for (let i = folded.indexOf(w); i !== -1; i = folded.indexOf(w, i + w.length)) ranges.push([i, i + w.length]);
    }
    if (!ranges.length) continue;
    ranges.sort((a, b) => a[0] - b[0]);
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [a, b] of ranges) {
      if (b <= at) continue;
      const from = Math.max(a, at);
      if (from > at) frag.append(text.slice(at, from));
      const m = document.createElement("mark");
      m.textContent = text.slice(from, b);
      frag.append(m);
      at = b;
    }
    if (at < text.length) frag.append(text.slice(at));
    node.replaceWith(frag);
  }
}

// ---- open and close ------------------------------------------------------------------
export const isOpen = () => !screen.hidden;

export async function open() {
  content = await load(currentLanguage());
  searchInput.value = "";
  render();
  screen.hidden = false;
  screen.scrollTop = 0;
  searchInput.focus();
}

export function close() { screen.hidden = true; }

export function init({ onReplayTour }) {
  searchInput.addEventListener("input", () => { render(); screen.scrollTop = 0; });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) { e.preventDefault(); e.stopPropagation(); searchInput.value = ""; render(); }
  });
  tocEl.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-sec]");
    if (!a) return;
    e.preventDefault();
    $(`#help-${CSS.escape(a.dataset.sec)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#help-close").addEventListener("click", close);
  $("#help-tour").addEventListener("click", () => { close(); onReplayTour(); });
  document.addEventListener("languagechange", async () => {
    if (!isOpen()) return;
    content = await load(currentLanguage());
    render();
  });
}
