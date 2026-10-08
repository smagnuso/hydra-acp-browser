// Serve with the daemon's cert (from `hydra-acp daemon listen`) unless
// browser.conf sets its own. Read once at startup: the daemon's listen
// settings only change on a daemon restart, which restarts this extension.

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve, sep } from "node:path";
import type { Config } from "./config.js";

export interface DaemonListen {
  host: string;
  port: number;
  publicHost?: string;
  tls?: { cert: string; key: string };
}

const EXPIRY_WARN_DAYS = 14;

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

// Undefined on any failure, including a daemon that predates the field:
// the caller then runs exactly as it did before this existed.
export async function fetchDaemonListen(
  daemonUrl: string,
  token: string,
  timeoutMs = 3_000,
): Promise<DaemonListen | undefined> {
  try {
    const res = await fetch(`${daemonUrl.replace(/\/$/, "")}/v1/config`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return undefined;
    }
    const body = (await res.json()) as { listen?: DaemonListen };
    if (!body.listen || typeof body.listen.host !== "string") {
      return undefined;
    }
    return body.listen;
  } catch {
    return undefined;
  }
}

export function applyDaemonListen(
  config: Config,
  listen: DaemonListen | undefined,
): Config {
  if (!listen?.tls || config.tls) {
    return config;
  }
  const next: Config = { ...config, tls: { ...listen.tls } };
  if (!config.browserHostExplicit && !isLoopbackHost(listen.host)) {
    next.browserHost = listen.host;
  }
  if (!config.preferredHost && listen.publicHost) {
    next.preferredHost = listen.publicHost;
  }
  return next;
}

// `tailscale setup` writes a browser-only cert here. Explicit keys win, so
// when the daemon also has one, say which is in use and how to switch.
export function ownCertNotice(
  config: Config,
  listen: DaemonListen | undefined,
  wizardTlsDir: string,
): string | undefined {
  if (!config.tls || !listen?.tls) {
    return undefined;
  }
  if (!resolve(config.tls.cert).startsWith(resolve(wizardTlsDir) + sep)) {
    return undefined;
  }
  return (
    `serving with browser.conf's cert from \`tailscale setup\` (${config.tls.cert}); ` +
    `the daemon has its own (${listen.tls.cert}). Remove BROWSER_TLS_CERT/BROWSER_TLS_KEY to use the daemon's.`
  );
}

export function certExpiryNotice(certPath: string, now: Date = new Date()): string | undefined {
  let validTo: Date;
  try {
    validTo = new Date(new X509Certificate(readFileSync(certPath)).validTo);
  } catch {
    return undefined;
  }
  const days = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
  if (days >= EXPIRY_WARN_DAYS) {
    return undefined;
  }
  return days < 0
    ? `TLS cert ${certPath} expired ${-days} day(s) ago.`
    : `TLS cert ${certPath} expires in ${days} day(s).`;
}

// The names a TLS client can validate: the cert's DNS and IP subject alternative names.
export function certNames(certPath: string): { dns: string[]; ips: string[] } {
  const dns: string[] = [];
  const ips: string[] = [];
  try {
    const alt = new X509Certificate(readFileSync(certPath)).subjectAltName ?? "";
    for (const entry of alt.split(",").map((part) => part.trim())) {
      if (entry.startsWith("DNS:")) {
        dns.push(entry.slice(4).toLowerCase());
      } else if (entry.startsWith("IP Address:")) {
        ips.push(entry.slice(11).toLowerCase());
      }
    }
  } catch {
    // an unreadable cert fails at listen time with a clearer error
  }
  return { dns, ips };
}

export function pickDisplayName(dns: readonly string[], machine: string): string | undefined {
  const concrete = dns.filter((name) => !name.startsWith("*"));
  const own = machine.toLowerCase();
  return concrete.find((name) => name === own || name.startsWith(`${own}.`)) ?? concrete[0];
}

// On a non-loopback bind the cert's own names are the ones a client can use: show one, and accept them all in the Host check.
export function applyCertNames(config: Config, machine: string = hostname()): Config {
  if (!config.tls || isLoopbackHost(config.browserHost)) {
    return config;
  }
  const names = certNames(config.tls.cert);
  const preferredHost = config.preferredHost ?? pickDisplayName(names.dns, machine);
  return {
    ...config,
    ...(preferredHost ? { preferredHost } : {}),
    allowedHosts: [...config.allowedHosts, ...names.dns, ...names.ips],
  };
}
