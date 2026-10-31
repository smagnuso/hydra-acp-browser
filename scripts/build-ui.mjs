#!/usr/bin/env node
import * as esbuild from "esbuild";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Usage: build-ui.mjs [ui-name ...] [--out <dir>]
// Each ui-name is a directory src/ui-<name> (or the full dir name) holding
// index.html, main.ts and optionally sw.js, built to dist/ui/<name>/. With
// no names, every src/ui-* directory is built. --out redirects a single
// build (e.g. for BROWSER_UI_DIR).
const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--out");
const outOverride = outFlag >= 0 ? resolve(argv[outFlag + 1] ?? "") : undefined;
const requested = argv.filter((a, i) => !a.startsWith("--") && i !== outFlag + 1);
const dirNames = requested.length
  ? requested.map((n) => (n.startsWith("ui-") ? n : `ui-${n}`))
  : readdirSync(join(root, "src")).filter((d) => d.startsWith("ui-"));
if (outOverride && dirNames.length !== 1) {
  throw new Error("--out needs exactly one ui name");
}
// A full build starts from an empty dist/ui so a UI that was removed or
// renamed (or a file moved between UIs) cannot linger in the build, be
// served by the server, or be published in the package.
if (requested.length === 0 && !outOverride) {
  rmSync(join(root, "dist", "ui"), { recursive: true, force: true });
}
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// Stamped into the bundle so a running client can report which build it
// is actually on. Without it there's no way to tell a stale cached PWA
// from a genuine bug — the same symptom either way, and mobile has no
// convenient inspector to check.
const buildId = new Date().toISOString().replace("T", " ").slice(0, 16) + "Z";

async function buildOne(dirName) {
  const name = dirName.slice(3);
  const uiDir = join(root, "src", dirName);
  const outDir = outOverride ?? join(root, "dist", "ui", name);
  const htmlIn = join(uiDir, "index.html");
  const htmlOut = join(outDir, "index.html");
  const entry = join(uiDir, "main.ts");
  // Deliberately NOT bundled with main.ts: a service worker must be servable
  // at its own URL, so it is copied through rather than inlined.
  const swIn = join(uiDir, "sw.js");
  const swOut = join(outDir, "sw.js");
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

}

for (const d of dirNames) {
  await buildOne(d);
}

// One service worker for every UI (push display only). A UI may still ship
// its own sw.js in its directory, which takes precedence on the server.
const sharedSw = join(root, "src", "shared", "sw.js");
if (!outOverride && existsSync(sharedSw)) {
  mkdirSync(join(root, "dist", "ui"), { recursive: true });
  copyFileSync(sharedSw, join(root, "dist", "ui", "sw.js"));
  console.log(`wrote ${join(root, "dist", "ui", "sw.js")}`);
}
