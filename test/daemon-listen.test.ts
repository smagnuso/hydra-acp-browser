import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_BROWSER_PORT, type Config } from "../src/config.js";
import {
  applyCertNames,
  applyDaemonListen,
  certExpiryNotice,
  fetchDaemonListen,
  ownCertNotice,
  type DaemonListen,
} from "../src/daemon-listen.js";

function fixtureConfig(overrides: Partial<Config> = {}): Config {
  return {
    browserHost: "127.0.0.1",
    browserHostExplicit: false,
    browserPort: DEFAULT_BROWSER_PORT,
    tls: undefined,
    linkFile: "/tmp/link",
    preferredHost: undefined,
    allowedHosts: [],
    hydraDaemonUrl: "http://127.0.0.1:55514",
    hydraWsUrl: "ws://127.0.0.1:55514/acp",
    hydraToken: "test-token",
    permissionDisplayDelayMs: 500,
    permissionNotifyDelayMs: 15_000,
    debug: false,
    ...overrides,
  };
}

const DAEMON_TLS = { cert: "/h/.hydra-acp/tls/cert.pem", key: "/h/.hydra-acp/tls/key.pem" };
const TAILNET: DaemonListen = {
  host: "100.64.1.5",
  port: 55514,
  publicHost: "box.tail1.ts.net",
  tls: DAEMON_TLS,
};

test("applyDaemonListen: inherits cert, bind host and public host when browser.conf sets none", () => {
  const out = applyDaemonListen(fixtureConfig(), TAILNET);
  assert.deepEqual(out.tls, DAEMON_TLS);
  assert.equal(out.browserHost, "100.64.1.5");
  assert.equal(out.preferredHost, "box.tail1.ts.net");
});

test("applyDaemonListen: an explicit browser cert wins outright", () => {
  const own = { cert: "/proxy/cert.pem", key: "/proxy/key.pem" };
  const config = fixtureConfig({ tls: own });
  assert.equal(applyDaemonListen(config, TAILNET), config);
});

test("applyDaemonListen: an explicit BROWSER_HOST and preferred host are kept", () => {
  const out = applyDaemonListen(
    fixtureConfig({ browserHost: "127.0.0.1", browserHostExplicit: true, preferredHost: "mine.example" }),
    TAILNET,
  );
  assert.deepEqual(out.tls, DAEMON_TLS);
  assert.equal(out.browserHost, "127.0.0.1");
  assert.equal(out.preferredHost, "mine.example");
});

test("applyDaemonListen: a loopback daemon or no answer changes nothing", () => {
  const config = fixtureConfig();
  assert.equal(applyDaemonListen(config, { host: "127.0.0.1", port: 55514 }), config);
  assert.equal(applyDaemonListen(config, undefined), config);
});

test("ownCertNotice: names both certs only when the wizard's cert is in use and the daemon has one", () => {
  const legacyDir = "/h/.hydra-acp/browser/tls";
  const legacy = fixtureConfig({ tls: { cert: `${legacyDir}/cert.pem`, key: `${legacyDir}/key.pem` } });
  assert.match(ownCertNotice(legacy, TAILNET, legacyDir) ?? "", /Remove BROWSER_TLS_CERT/);
  assert.equal(ownCertNotice(legacy, { host: "127.0.0.1", port: 55514 }, legacyDir), undefined);
  const proxy = fixtureConfig({ tls: { cert: "/proxy/cert.pem", key: "/proxy/key.pem" } });
  assert.equal(ownCertNotice(proxy, TAILNET, legacyDir), undefined);
  const lookalike = fixtureConfig({ tls: { cert: `${legacyDir}-old/cert.pem`, key: "/k" } });
  assert.equal(ownCertNotice(lookalike, TAILNET, legacyDir), undefined);
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("certExpiryNotice: warns inside 14 days, silent otherwise", { skip: !hasOpenssl }, () => {
  const dir = mkdtempSync(join(tmpdir(), "listen-test-"));
  try {
    const cert = join(dir, "cert.pem");
    const r = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "5",
      "-keyout", join(dir, "key.pem"), "-out", cert, "-subj", "/CN=t",
    ]);
    assert.equal(r.status, 0);
    assert.match(certExpiryNotice(cert) ?? "", /expires in [45] day/);
    const later = new Date(Date.now() - 30 * 86_400_000);
    assert.equal(certExpiryNotice(cert, later), undefined);
    assert.equal(certExpiryNotice(join(dir, "missing.pem")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("fetchDaemonListen: reads listen with the bearer token, undefined when absent", async () => {
  let seenAuth: string | undefined;
  let body: unknown = { defaultAgent: "x", listen: TAILNET };
  const server = createServer((req, res) => {
    seenAuth = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await fetchDaemonListen(url, "tok"), TAILNET);
    assert.equal(seenAuth, "Bearer tok");
    body = { defaultAgent: "x" };
    assert.equal(await fetchDaemonListen(url, "tok"), undefined);
  } finally {
    server.close();
  }
  assert.equal(await fetchDaemonListen("http://127.0.0.1:1", "tok", 500), undefined);
});

test("applyCertNames: shows and allows the cert's names on a non-loopback bind only", { skip: !hasOpenssl }, () => {
  const dir = mkdtempSync(join(tmpdir(), "listen-test-"));
  try {
    const cert = join(dir, "cert.pem");
    const r = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30",
      "-keyout", join(dir, "key.pem"), "-out", cert, "-subj", "/CN=t",
      "-addext", "subjectAltName=DNS:other.example,DNS:box.tail1.ts.net,IP:10.0.0.5",
    ]);
    assert.equal(r.status, 0);
    const tls = { cert, key: join(dir, "key.pem") };

    const open = applyCertNames(fixtureConfig({ browserHost: "0.0.0.0", tls }), "box");
    assert.equal(open.preferredHost, "box.tail1.ts.net");
    assert.deepEqual(open.allowedHosts, ["other.example", "box.tail1.ts.net", "10.0.0.5"]);

    const explicit = applyCertNames(fixtureConfig({ browserHost: "0.0.0.0", tls, preferredHost: "me.lan" }), "box");
    assert.equal(explicit.preferredHost, "me.lan");

    const loop = fixtureConfig({ tls });
    assert.equal(applyCertNames(loop, "box"), loop);
    const plain = fixtureConfig({ browserHost: "0.0.0.0" });
    assert.equal(applyCertNames(plain, "box"), plain);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
