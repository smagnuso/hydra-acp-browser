import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  quoteForCmd,
  resolveSpawnTarget,
  resolveWindowsCommand,
} from "../src/util/windows-command.js";
import { restartExtension } from "../src/setup/tailscale-wizard.js";

// Platform is injected; the fixture files are real, statSync does not care
// which OS named them. Paths compare case-insensitively because PATHEXT is
// uppercase while the files are lowercase.
const eqPath = (actual: string, expected: string): void => {
  assert.equal(actual.toLowerCase(), expected.toLowerCase());
};

const dir = mkdtempSync(join(tmpdir(), "hydra-wincmd-"));
const spacedDir = join(dir, "First Last");
mkdirSync(spacedDir, { recursive: true });
writeFileSync(join(dir, "npm.cmd"), "@echo off\n");
writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
writeFileSync(join(dir, "real-tool.exe"), "MZ");
writeFileSync(join(dir, "shimmed"), "#!/bin/sh\n");
writeFileSync(join(dir, "shimmed.cmd"), "@echo off\n");
writeFileSync(join(spacedDir, "npm.cmd"), "@echo off\n");
const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("resolveWindowsCommand is identity off Windows even with a .cmd sibling", () => {
  assert.equal(resolveWindowsCommand("npm", { env, platform: "linux" }), "npm");
});

test("resolveWindowsCommand finds a bare command on PATH via PATHEXT", () => {
  eqPath(resolveWindowsCommand("npm", { env, platform: "win32" }), join(dir, "npm.cmd"));
});

test("resolveWindowsCommand prefers the .cmd sibling over an extensionless sh shim", () => {
  const shim = join(dir, "shimmed");
  eqPath(resolveWindowsCommand(shim, { env, platform: "win32" }), `${shim}.cmd`);
});

test("resolveWindowsCommand leaves an extension-bearing or unresolvable command alone", () => {
  const exe = join(dir, "real-tool.exe");
  eqPath(resolveWindowsCommand(exe, { env, platform: "win32" }), exe);
  assert.equal(resolveWindowsCommand("nope", { env, platform: "win32" }), "nope");
});

test("resolveWindowsCommand searches every PATH entry", () => {
  const multi = { ...env, PATH: [join(dir, "nope"), dir].join(delimiter) };
  eqPath(resolveWindowsCommand("npm", { env: multi, platform: "win32" }), join(dir, "npm.cmd"));
});

test("quoteForCmd leaves ordinary tokens bare and quotes spaces and metacharacters", () => {
  assert.equal(quoteForCmd("install"), "install");
  assert.equal(quoteForCmd(String.raw`C:\Users\First Last\x`), String.raw`"C:\Users\First Last\x"`);
  assert.equal(quoteForCmd("a&b"), '"a&b"');
});

test("quoteForCmd refuses tokens it cannot quote unambiguously", () => {
  assert.throws(() => quoteForCmd('say "hi"'), /cannot pass/i);
  assert.throws(() => quoteForCmd("%PATH%"), /cannot pass/i);
  assert.throws(() => quoteForCmd("a\nb"), /cannot pass/i);
  assert.throws(() => quoteForCmd("a\rb"), /cannot pass/i);
});

test("resolveSpawnTarget asks for no shell off Windows", () => {
  assert.deepEqual(resolveSpawnTarget("npm", ["install"], { env, platform: "linux" }), {
    command: "npm",
    args: ["install"],
    shell: false,
  });
});

test("resolveSpawnTarget asks for a shell and pre-quotes when it resolves to a .cmd", () => {
  const t = resolveSpawnTarget("npm", ["install", "a b"], { env, platform: "win32" });
  assert.equal(t.shell, true);
  eqPath(t.command, join(dir, "npm.cmd"));
  assert.deepEqual(t.args, ["install", '"a b"']);
});

test("resolveSpawnTarget quotes an install path containing spaces", () => {
  const t = resolveSpawnTarget("npm", [], { env: { ...env, PATH: spacedDir }, platform: "win32" });
  assert.equal(t.shell, true);
  eqPath(t.command, `"${join(spacedDir, "npm.cmd")}"`);
});

test("resolveSpawnTarget needs no shell for a real executable or a missing command", () => {
  const exe = resolveSpawnTarget("real-tool", [], { env, platform: "win32" });
  assert.equal(exe.shell, false);
  eqPath(exe.command, join(dir, "real-tool.exe"));
  assert.deepEqual(resolveSpawnTarget("nope", ["-x"], { env, platform: "win32" }), {
    command: "nope",
    args: ["-x"],
    shell: false,
  });
});

type Call = { command: string; args: string[]; options: { stdio: string; shell: boolean } };

function recorder(): { calls: Call[]; spawn: Parameters<typeof restartExtension>[0] } {
  const calls: Call[] = [];
  const spawn: Parameters<typeof restartExtension>[0] = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<NonNullable<Parameters<typeof restartExtension>[0]>>;
  };
  return { calls, spawn };
}

test("restartExtension on win32 spawns the resolved .cmd shim through a shell", () => {
  const { calls, spawn } = recorder();
  restartExtension(spawn, { env, platform: "win32" });
  assert.equal(calls.length, 1);
  eqPath(calls[0]!.command, join(dir, "hydra-acp.cmd"));
  assert.deepEqual(calls[0]!.args, ["extensions", "restart", "hydra-acp-browser"]);
  assert.deepEqual(calls[0]!.options, { stdio: "inherit", shell: true });
});

test("restartExtension on linux spawns the bare command with no shell", () => {
  const { calls, spawn } = recorder();
  restartExtension(spawn, { env, platform: "linux" });
  assert.deepEqual(calls, [
    {
      command: "hydra-acp",
      args: ["extensions", "restart", "hydra-acp-browser"],
      options: { stdio: "inherit", shell: false },
    },
  ]);
});
