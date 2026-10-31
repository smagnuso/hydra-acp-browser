import { promises as fsp } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  buildClearCookie,
  buildSetCookie,
  COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  parseCookies,
} from "./auth.js";
import type { ServerContext } from "./http.js";
import { logger } from "../util/log.js";

const log = logger("routes-root");

const here = dirname(fileURLToPath(import.meta.url));

// In dist layout: dist/server/routes-root.js → ../ui/<name>/index.html
const UI_ROOT = resolve(here, "..", "ui");
const UI_COOKIE = "hb_ui";
const UI_NAME_RE = /^[a-z0-9-]{1,32}$/;
const CUSTOM_UI = "custom";

const MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

// Bundled UIs are cached; the custom dir is re-read on every request so a
// rebuild shows up on reload without restarting the server.
function makeUiRegistry(config: ServerContext["config"], uiRoot: string) {
  const cache = new Map<string, string>();
  let bundledNames: string[] | undefined;

  async function names(): Promise<string[]> {
    if (bundledNames === undefined) {
      bundledNames = [];
      try {
        for (const e of await fsp.readdir(uiRoot, { withFileTypes: true })) {
          if (e.isDirectory() && UI_NAME_RE.test(e.name)) {
            const html = resolve(uiRoot, e.name, "index.html");
            if (await fsp.stat(html).then(() => true, () => false)) {
              bundledNames.push(e.name);
            }
          }
        }
      } catch {
        void 0;
      }
      bundledNames.sort();
    }
    return config.uiDir ? [...bundledNames, CUSTOM_UI] : bundledNames;
  }

  function dirOf(name: string): string {
    return name === CUSTOM_UI && config.uiDir
      ? resolve(config.uiDir)
      : resolve(uiRoot, name);
  }

  return {
    names,
    dirOf,
    async select(request: FastifyRequest): Promise<string> {
      const available = await names();
      const picked = parseCookies(request.headers.cookie).get(UI_COOKIE);
      if (picked && available.includes(picked)) {
        return picked;
      }
      if (config.uiDir) {
        return CUSTOM_UI;
      }
      return available.includes(config.defaultUi)
        ? config.defaultUi
        : (available[0] ?? config.defaultUi);
    },
    async text(name: string, file: string): Promise<string> {
      const key = `${name}/${file}`;
      const hit = name === CUSTOM_UI ? undefined : cache.get(key);
      if (hit !== undefined) {
        return hit;
      }
      const body = await fsp.readFile(resolve(dirOf(name), file), "utf8");
      cache.set(key, body);
      return body;
    },
  };
}

export function registerRootRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  uiRoot: string = UI_ROOT,
): void {
  const ui = makeUiRegistry(ctx.config, uiRoot);

  app.get(
    "/",
    {
      config: { skipAuth: true, skipCsrf: true },
    },
    async (request, reply) => {
      const wanted = (request.query as { ui?: string } | undefined)?.ui;
      if (wanted !== undefined) {
        if ((await ui.names()).includes(wanted)) {
          reply.header(
            "Set-Cookie",
            `${UI_COOKIE}=${wanted}; Path=/; Max-Age=31536000; SameSite=Lax${ctx.scheme === "https" ? "; Secure" : ""}`,
          );
        }
        const rest = new URLSearchParams(new URL(request.url, "http://internal").search);
        rest.delete("ui");
        const qs = rest.toString();
        reply.code(303).header("Location", qs ? `/?${qs}` : "/").send();
        return;
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      if (request.sessionToken) {
        const html = await ui.text(await ui.select(request), "index.html");
        reply.send(injectNonce(html, request.cspNonce ?? ""));
        return;
      }
      // Preserve a deep link (e.g. ?protocol_launch=... from a web+hydra://
      // handoff) through the login round trip so it isn't lost when an
      // unauthenticated visit gets bounced to the login page.
      const next = new URL(request.url, "http://internal").search;
      reply.code(200).send(loginPage(request.cspNonce ?? "", undefined, next));
    },
  );

  app.post(
    "/login",
    {
      config: { skipAuth: true, skipCsrf: true },
    },
    async (request, reply) => {
      await handleLogin(request, reply, ctx);
    },
  );

  app.post(
    "/logout",
    {
      // skipAuth so a stale cookie can still hit logout without being
      // bounced to 401. We still want CSRF protection on the POST.
      config: { skipAuth: true },
    },
    async (request, reply) => {
      await handleLogout(request, reply, ctx);
    },
  );

  app.get(
    "/favicon.ico",
    { config: { skipAuth: true, skipCsrf: true } },
    async (_request, reply) => {
      reply.code(204).send();
    },
  );

  // Registration-only service worker (see src/ui-classic/sw.js) — exists so
  // Notification permission grants a working notifications.showNotification()
  // path even on Safari, which requires that instead of a bare `new
  // Notification()`. Same auth/CSRF posture as any other authenticated
  // GET; a same-origin navigator.serviceWorker.register() call passes
  // those checks the same as a normal fetch.
  app.get("/api/uis", async (request, reply) => {
    reply.send({ uis: await ui.names(), current: await ui.select(request) });
  });

  app.get("/assets/*", async (request, reply) => {
    const rel = (request.params as { "*": string })["*"];
    const assetsDir = resolve(ui.dirOf(await ui.select(request)), "assets");
    const full = resolve(assetsDir, rel);
    if (rel.includes("\0") || !full.startsWith(assetsDir + sep)) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(full);
    } catch {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply
      .header("Content-Type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream")
      .send(bytes);
  });

  app.get("/sw.js", async (request, reply) => {
    let body: string;
    try {
      body = await ui.text(await ui.select(request), "sw.js");
    } catch {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.header("Content-Type", "application/javascript; charset=utf-8");
    reply.send(body);
  });
}

async function handleLogin(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): Promise<void> {
  const ip = request.ip ?? "unknown";
  const body = request.body as { password?: string; next?: string } | undefined;
  // Only trust it back as a same-page query string: must start with "?"
  // and stay within printable ASCII, so it can never turn into an
  // absolute or protocol-relative redirect target.
  const rawNext = body && typeof body.next === "string" ? body.next : "";
  const next = /^\?[\x20-\x7e]{0,2048}$/.test(rawNext) ? rawNext : "";

  if (ctx.rateLimiter.isBlocked(ip)) {
    reply.code(429).type("text/html; charset=utf-8").send(
      loginPage(
        request.cspNonce ?? "",
        "Too many failed attempts. Try again in a few minutes.",
        next,
      ),
    );
    return;
  }

  const password =
    body && typeof body.password === "string" ? body.password : "";
  if (password.length === 0) {
    reply.code(400).type("text/html; charset=utf-8").send(
      loginPage(request.cspNonce ?? "", "Password required.", next),
    );
    return;
  }

  const daemonResp = await fetch(`${ctx.config.hydraDaemonUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, label: "hydra-acp-browser" }),
  });

  if (daemonResp.status === 200) {
    const issued = (await daemonResp.json()) as { session_token: string };
    ctx.rateLimiter.recordSuccess(ip);
    reply.header(
      "Set-Cookie",
      buildSetCookie(issued.session_token, {
        secure: ctx.scheme === "https",
        maxAgeSeconds: COOKIE_MAX_AGE_SECONDS,
      }),
    );
    reply.code(303).header("Location", "/" + next).send();
    return;
  }

  ctx.rateLimiter.recordFailure(ip);
  let errMsg = "Incorrect password.";
  try {
    const errBody = (await daemonResp.json()) as { error?: string };
    if (daemonResp.status === 403 && errBody.error) {
      errMsg = errBody.error;
    } else if (daemonResp.status === 429) {
      errMsg = "Too many failed attempts on the daemon. Try again later.";
    }
  } catch {
    void 0;
  }
  log.warn(`login failed (HTTP ${daemonResp.status}) from ${ip}`);
  reply
    .code(daemonResp.status === 403 ? 403 : 401)
    .type("text/html; charset=utf-8")
    .send(loginPage(request.cspNonce ?? "", errMsg, next));
}

async function handleLogout(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): Promise<void> {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies.get(COOKIE_NAME);
  if (token) {
    try {
      await fetch(`${ctx.config.hydraDaemonUrl}/v1/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    } catch (err) {
      log.warn(`logout daemon call failed: ${(err as Error).message}`);
    }
  }
  reply.header("Set-Cookie", buildClearCookie());
  reply.code(303).header("Location", "/").send();
}

function injectNonce(html: string, nonce: string): string {
  return html.replaceAll("__CSP_NONCE__", nonce);
}

function loginPage(nonce: string, error?: string, next?: string): string {
  const errorHtml = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : "";
  const nextField = next
    ? `<input type="hidden" name="next" value="${escapeHtml(next)}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hydra</title>
<style nonce="${nonce}">
:root { color-scheme: dark; font-family: system-ui, sans-serif; }
body { background: #0e1116; color: #d6deeb; margin: 0; padding: 4rem 1.5rem; max-width: 26rem; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
form { display: flex; flex-direction: column; gap: 0.75rem; }
label { font-size: 0.95rem; color: #a8b3c7; }
input[type=password] {
  background: #1c2230;
  color: #d6deeb;
  border: 1px solid #2b3346;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  font: inherit;
}
input[type=password]:focus { outline: none; border-color: #4a90e2; }
button {
  background: #4a90e2;
  color: #fff;
  border: 0;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
}
button:hover { background: #5ba0f0; }
.error { color: #f06060; font-size: 0.95rem; margin: 0; }
.note { color: #7c8aa8; font-size: 0.9rem; margin-top: 1.5rem; }
code { background: #1c2230; padding: 0.1rem 0.4rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>Hydra</h1>
${errorHtml}
<form id="loginForm" method="POST" action="/login" autocomplete="off">
  ${nextField}
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autofocus required autocomplete="off">
  <button type="submit">Sign in</button>
</form>
<p class="note">Set the password on the daemon host with <code>hydra-acp auth password</code>.</p>
<script nonce="${nonce}">
// Disarm macOS Secure Event Input before the redirect navigation
// fires. Browsers hold the kernel-level keyboard lock as long as
// they think a password field is focused / present; same-origin
// navigation alone isn't enough to release it (Synergy + similar
// KVMs can't intercept keystrokes until the tab closes otherwise).
// Blurring + flipping the type to "text" tells the browser this is
// no longer a password input, which releases the lock immediately.
// Name attribute is unchanged so the POST body still carries the
// password.
(() => {
  const form = document.getElementById("loginForm");
  const pw = document.getElementById("password");
  if (!form || !(pw instanceof HTMLInputElement)) return;
  form.addEventListener("submit", () => {
    pw.blur();
    pw.type = "text";
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
