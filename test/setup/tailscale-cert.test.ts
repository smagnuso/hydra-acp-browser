import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { mergeConf } from "../../src/setup/conf-writer.js";
import {
  certChmodWarning,
  confWrittenNote,
  permissionAdvice,
} from "../../src/setup/platform-hints.js";
import { step2MintCert, type MintCertDeps } from "../../src/setup/tailscale-wizard.js";

interface Call {
  command: string;
  args: string[];
}

class Exit extends Error {}

async function run(platform: NodeJS.Platform, confirmAnswer = true) {
  const calls: Call[] = [];
  const spawn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "tailscale") {
      return { status: 1, stderr: "access denied: operator required" };
    }
    return { status: 0, stderr: "" };
  }) as unknown as MintCertDeps["spawn"];
  const asked: string[] = [];
  const confirm = async (q: string): Promise<boolean> => {
    asked.push(q);
    return confirmAnswer;
  };
  const stderr: string[] = [];
  const stdout: string[] = [];
  mock.method(process, "exit", () => {
    throw new Exit();
  });
  mock.method(process.stderr, "write", (s: string) => {
    stderr.push(s);
    return true;
  });
  mock.method(process.stdout, "write", (s: string) => {
    stdout.push(s);
    return true;
  });
  let exited = false;
  try {
    await step2MintCert("host.ts.net", platform, {
      spawn,
      confirm,
      tlsDir: mkdtempSync(join(tmpdir(), "hb-tls-")),
    });
  } catch (err) {
    exited = err instanceof Exit;
    if (!exited) {
      throw err;
    }
  } finally {
    mock.restoreAll();
  }
  return { calls, asked, stderr: stderr.join(""), stdout: stdout.join(""), exited };
}

test("cert flow on win32: permission failure never runs sudo or chown", async () => {
  const r = await run("win32");
  assert.ok(r.exited);
  assert.deepEqual(r.calls.map((c) => c.command), ["tailscale"]);
  assert.deepEqual(r.asked, []);
  assert.match(r.stderr, /Administrator/);
  assert.doesNotMatch(r.stdout + r.stderr, /sudo|whoami/);
});

test("cert flow on linux: permission failure offers sudo, then chown", async () => {
  const r = await run("linux");
  assert.deepEqual(r.calls.map((c) => c.command), ["tailscale", "sudo", "sudo"]);
  assert.equal(r.calls[2]!.args[0], "chown");
  assert.equal(r.asked.length, 1);
  assert.match(r.stdout, /sudo tailscale set --operator=\$\(whoami\)/);
});

test("cert flow on linux: declining sudo points at the operator fix", async () => {
  const r = await run("linux", false);
  assert.ok(r.exited);
  assert.deepEqual(r.calls.map((c) => c.command), ["tailscale"]);
  assert.match(r.stderr, /sudo tailscale set --operator=\$\(whoami\)/);
});

test("permissionAdvice: win32 has no sudo hint, posix does", () => {
  const win = permissionAdvice("win32");
  assert.equal(win.offerSudo, false);
  assert.equal(win.fixHint, null);
  assert.match(win.failMessage, /elevated \(Administrator\)/);
  const mac = permissionAdvice("darwin");
  assert.equal(mac.offerSudo, true);
  assert.match(mac.fixHint!, /^Fix this permanently: sudo tailscale set/);
});

test("confWrittenNote: chmod wording only off win32", () => {
  assert.equal(confWrittenNote("linux", "/p/x.conf"), "Wrote /p/x.conf (chmod 600)");
  assert.equal(confWrittenNote("darwin", "/p/x.conf"), "Wrote /p/x.conf (chmod 600)");
  const win = confWrittenNote("win32", "C:\\p\\x.conf");
  assert.match(win, /user profile/);
  assert.doesNotMatch(win, /chmod/);
});

test("certChmodWarning: omitted on win32, unchanged on posix", () => {
  assert.equal(certChmodWarning("win32", "boom"), null);
  assert.equal(
    certChmodWarning("linux", "boom"),
    "Couldn't chmod cert files (boom). Check ownership if HTTPS fails to start.",
  );
});

test("mergeConf header: chmod advice only off win32", () => {
  const posix = mergeConf("", { A: "1" }, "linux");
  assert.match(posix, /# Lock this file: chmod 600\./);
  const win = mergeConf("", { A: "1" }, "win32");
  assert.doesNotMatch(win, /chmod/);
  assert.match(win, /user profile/);
});
