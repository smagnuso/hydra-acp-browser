#!/usr/bin/env node
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Usage: build-ui.mjs [ui-name] [--out <dir>]. ui-name is a directory
// under src/ (default ui-classic) holding index.html, main.ts and
// optionally sw.js; output defaults to dist/ui, which the server serves
// unless BROWSER_UI_DIR points elsewhere.
const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--out");
const outDir = outFlag >= 0 ? resolve(argv[outFlag + 1] ?? "") : join(root, "dist", "ui");
const uiName = argv.find((a, i) => !a.startsWith("--") && i !== outFlag + 1) ?? "ui-classic";
const uiDir = join(root, "src", uiName);
const htmlIn = join(uiDir, "index.html");
const htmlOut = join(outDir, "index.html");
const entry = join(uiDir, "main.ts");
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// Deliberately NOT bundled with main.ts — a service worker must be
// servable at its own URL to register, so it's copied through as-is
// rather than inlined into index.html like the rest of the app.
const swIn = join(uiDir, "sw.js");
const swOut = join(outDir, "sw.js");

// Stamped into the bundle so a running client can report which build it
// is actually on. Without it there's no way to tell a stale cached PWA
// from a genuine bug — the same symptom either way, and mobile has no
// convenient inspector to check.
const buildId = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";

const result = await esbuild.build({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  write: false,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

if (result.outputFiles.length !== 1) {
  throw new Error(`expected 1 esbuild output, got ${result.outputFiles.length}`);
}
const bundle = result.outputFiles[0].text;

const template = readFileSync(htmlIn, "utf8");
const placeholder = "/*BUNDLE*/";
if (!template.includes(placeholder)) {
  throw new Error(`HTML template at ${htmlIn} is missing the ${placeholder} placeholder`);
}
const html = template.replace(placeholder, () => bundle);

mkdirSync(dirname(htmlOut), { recursive: true });
writeFileSync(htmlOut, html, "utf8");
const hasSw = existsSync(swIn);
if (hasSw) {
  copyFileSync(swIn, swOut);
}

const sizeKb = (Buffer.byteLength(bundle, "utf8") / 1024).toFixed(1);
console.log(`wrote ${htmlOut} (bundle ${sizeKb} KB, build ${buildId})`);
if (hasSw) {
  console.log(`wrote ${swOut}`);
}
