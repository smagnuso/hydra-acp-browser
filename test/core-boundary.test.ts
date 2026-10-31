import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CORE = "src/core";
const DOM_GLOBAL = /(?<![\w.$])(document|window)\./;
// platform.ts is the one sanctioned place core touches page globals.
const ALLOWED = new Set(["platform.ts"]);

function coreFiles(): string[] {
  return readdirSync(CORE).filter((f) => f.endsWith(".ts"));
}

function codeLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

test("core never imports from ui-classic", () => {
  for (const f of coreFiles()) {
    const text = readFileSync(join(CORE, f), "utf8");
    assert.doesNotMatch(text, /from\s+["'][^"']*ui-classic/, f);
  }
});

test("core touches document/window only through platform.ts", () => {
  for (const f of coreFiles()) {
    if (ALLOWED.has(f)) {
      continue;
    }
    const hits = codeLines(readFileSync(join(CORE, f), "utf8")).filter((l) =>
      DOM_GLOBAL.test(l),
    );
    assert.deepEqual(hits, [], f);
  }
});
