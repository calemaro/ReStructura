// Copies the third-party frontend files the app needs from node_modules into
// src/vendor/. The frontend is served as plain files (no bundler), and the app
// must work fully offline, so nothing may be loaded from a CDN.
// Runs automatically after `npm install`; run by hand with `npm run vendor`.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "src", "public", "vendor", "leaflet");
const src = join(root, "node_modules", "leaflet", "dist");

if (!existsSync(src)) {
  console.error("leaflet is not installed — run `npm install` first");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
for (const f of ["leaflet.js", "leaflet.js.map", "leaflet.css"]) cpSync(join(src, f), join(out, f));
cpSync(join(src, "images"), join(out, "images"), { recursive: true });
console.log("vendored leaflet ->", out.replace(root + "/", ""));
