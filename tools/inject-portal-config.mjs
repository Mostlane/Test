#!/usr/bin/env node
// Adds <script src="/portal-config.js"></script> as the FIRST thing inside
// <head> on every root-level *.html page, so the API bridge is installed before
// auth.js or any fetch() runs. Idempotent: skips pages that already have it.
//
//   node tools/inject-portal-config.mjs
//
// Safe to commit immediately — portal-config.js is a no-op until MOSTLANE_API
// is set, so nothing changes behaviour until you flip that one line.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = `<script src="/portal-config.js"></script>`;

const files = readdirSync(ROOT).filter(f => f.toLowerCase().endsWith(".html"));
let injected = 0, skipped = 0, noHead = 0;

for (const f of files) {
  const path = join(ROOT, f);
  let html = readFileSync(path, "utf8");

  if (html.includes("portal-config.js")) { skipped++; continue; }

  // Insert right after the opening <head ...> tag.
  const m = html.match(/<head[^>]*>/i);
  if (!m) { noHead++; console.warn("no <head>:", f); continue; }

  const idx = m.index + m[0].length;
  html = html.slice(0, idx) + `\n  ${TAG}` + html.slice(idx);
  writeFileSync(path, html);
  injected++;
}

console.log(`Injected: ${injected}, already had it: ${skipped}, no <head>: ${noHead}, total html: ${files.length}`);
