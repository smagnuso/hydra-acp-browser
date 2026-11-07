// Builds the scratch world the README screenshots are taken from:
//   <root>/home   a HYDRA_ACP_HOME/HOME with config, token and fake sessions
//   <root>/work   git repos the sessions point at (file viewer + changes pane)
// Usage: node seed.mjs <root>
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? "/tmp/hydra-shots");
const here = dirname(fileURLToPath(import.meta.url));
const home = join(root, ".shots-home", ".hydra-acp");
const work = root;
const DAEMON_PORT = Number(process.env.SHOTS_DAEMON_PORT ?? 56524);

rmSync(root, { recursive: true, force: true });
mkdirSync(join(home, "sessions"), { recursive: true });
mkdirSync(work, { recursive: true });

const token = "shots-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
writeFileSync(join(home, "auth-token"), token + "\n");
chmodSync(join(home, "auth-token"), 0o600);

const agent = (name) => ({
  name,
  command: process.execPath,
  args: [join(here, "fake-agent.mjs")],
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify(
    {
      defaultAgent: "claude-acp",
      daemon: { host: "127.0.0.1", port: DAEMON_PORT, sessionIdleTimeoutSeconds: 0 },
      agents: {
        "claude-acp": agent("Claude Code"),
        "codex-acp": agent("Codex"),
        "gemini-acp": agent("Gemini CLI"),
      },
      extensions: {},
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------- repos

function repo(name, files, changed) {
  const dir = join(work, name);
  const put = (set) => {
    for (const [p, body] of Object.entries(set)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
  };
  mkdirSync(dir, { recursive: true });
  const git = (...a) =>
    execFileSync("git", a, { cwd: dir, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "Dana Reyes", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "Dana Reyes", GIT_COMMITTER_EMAIL: "dana@example.com" } });
  git("init", "-q", "-b", "main");
  put(files);
  git("add", "-A");
  git("commit", "-q", "-m", "Initial commit");
  put(changed);
  return dir;
}

const V = {};
V.serverOld = `import express from "express";
import { config } from "./config.js";
import { ordersRouter } from "./routes/orders.js";
import { usersRouter } from "./routes/users.js";

const app = express();
app.use(express.json());
app.use("/orders", ordersRouter);
app.use("/users", usersRouter);

app.listen(config.port, () => {
  console.log(\`listening on \${config.port}\`);
});
`;
V.serverNew = V.serverOld
  .replace(
    `import { ordersRouter }`,
    `import { rateLimit } from "./middleware/rateLimit.js";\nimport { ordersRouter }`,
  )
  .replace(
    `app.use(express.json());\n`,
    `app.use(express.json());\napp.use(rateLimit(config.rateLimit));\n`,
  );
V.configOld = `export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/acme",
};
`;
V.configNew = `export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/acme",
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
  },
};
`;
V.rlV1 = `import type { NextFunction, Request, Response } from "express";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit({ windowMs, max }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    next();
  };
}
`;
V.rlV2Old = `      res.status(429).json({ error: "rate_limited" });`;
V.rlV2New = `      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "rate_limited", retryAfter });`;
V.rlFinal = V.rlV1.replace(V.rlV2Old, V.rlV2New);
V.rlTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import { rateLimit } from "../src/middleware/rateLimit.js";

function run(limiter: ReturnType<typeof rateLimit>) {
  const res: any = {
    code: 200,
    headers: {} as Record<string, string>,
    status(c: number) { this.code = c; return this; },
    json() { return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  let passed = false;
  limiter({ ip: "10.0.0.1" } as any, res, () => { passed = true; });
  return { res, passed };
}

test("allows requests under the limit", () => {
  const limiter = rateLimit({ windowMs: 1000, max: 2 });
  assert.equal(run(limiter).passed, true);
  assert.equal(run(limiter).passed, true);
});

test("rejects with 429 and Retry-After over the limit", () => {
  const limiter = rateLimit({ windowMs: 1000, max: 1 });
  run(limiter);
  const { res, passed } = run(limiter);
  assert.equal(passed, false);
  assert.equal(res.code, 429);
  assert.ok(Number(res.headers["Retry-After"]) >= 1);
});
`;

const acmeApi = repo(
  "acme-api",
  {
    "package.json": JSON.stringify(
      { name: "acme-api", version: "2.4.0", type: "module", scripts: { test: "node --test", dev: "tsx src/server.ts" } },
      null,
      2,
    ) + "\n",
    "README.md": "# acme-api\n\nOrders and users service for the Acme storefront.\n\n## Running\n\n```sh\nnpm install\nnpm run dev\n```\n",
    "src/server.ts": V.serverOld,
    "src/config.ts": V.configOld,
    "src/routes/orders.ts": `import { Router } from "express";\n\nexport const ordersRouter = Router();\n\nordersRouter.get("/", (_req, res) => {\n  res.json([]);\n});\n`,
    "src/routes/users.ts": `import { Router } from "express";\n\nexport const usersRouter = Router();\n\nusersRouter.get("/:id", (req, res) => {\n  res.json({ id: req.params.id });\n});\n`,
  },
  {
    "src/server.ts": V.serverNew,
    "src/config.ts": V.configNew,
    "src/middleware/rateLimit.ts": V.rlFinal,
    "test/rateLimit.test.ts": V.rlTest,
  },
);
const acmeWeb = repo("acme-web", { "package.json": '{ "name": "acme-web" }\n', "src/checkout.ts": "export const total = (n: number[]) => n.reduce((a, b) => a + b, 0);\n" }, {});
const worker = repo("billing-worker", { "package.json": '{ "name": "billing-worker" }\n', "src/queue.ts": "export const queue: unknown[] = [];\n" }, {});
const docs = repo("acme-docs", { "README.md": "# Acme docs\n" }, {});
const infra = repo("infra", { "main.tf": "# terraform\n" }, {});

// ---------------------------------------------------------------- history

let rngState = 20260;
const rnd = () => {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
};
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randId = () => Array.from({ length: 16 }, () => B62[Math.floor(rnd() * 62)]).join("");
const NOW = Date.now();
const DAY = 86_400_000;
let seq = 0;
const uid = (p) => `${p}${(++seq).toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 10)}`;

function session({ id, title, agentId, model, cwd, mode = "build", turns, updatedAgo }) {
  const sid = `hydra_session_${randId()}`;
  const lines = [];
  let cost = 0;
  let tokens = 0;
  let loc = 0;
  let firstTs;
  let lastTs;
  const push = (ts, update) => {
    lines.push(JSON.stringify({ method: "session/update", params: { sessionId: sid, update }, recordedAt: Math.round(ts) }));
    lastTs = ts;
  };
  for (const t of turns) {
    let ts = NOW - t.ago * DAY;
    firstTs ??= ts;
    const mid = uid("m_");
    push(ts, { sessionUpdate: "prompt_received", messageId: mid, prompt: [{ type: "text", text: t.prompt }, ...(t.image ? [{ type: "image", data: t.image, mimeType: "image/png" }] : [])] });
    ts += 40;
    if (t.thought) {
      push((ts += 900), { sessionUpdate: "agent_thought_chunk", messageId: uid("msg_"), content: { type: "text", text: t.thought } });
    }
    for (const s of t.steps ?? []) {
      const tc = uid("toolu_");
      push((ts += 700), { sessionUpdate: "tool_call", toolCallId: tc, title: s.title, kind: s.kind, status: "pending", locations: [], rawInput: {} });
      const content = [];
      if (s.output !== undefined) {
        content.push({ type: "content", content: { type: "text", text: s.output } });
      }
      if (s.diff) {
        content.push({ type: "diff", path: s.diff.path, oldText: s.diff.oldText, newText: s.diff.newText });
        loc += s.diff.newText.split("\n").length - (s.diff.oldText ? s.diff.oldText.split("\n").length : 0);
      }
      push((ts += 1200), {
        sessionUpdate: "tool_call_update",
        toolCallId: tc,
        status: "completed",
        kind: s.kind,
        title: s.title,
        locations: s.path ? [{ path: s.path }] : [],
        rawInput: s.command ? { command: s.command } : s.path ? { filePath: s.path } : {},
        content,
      });
    }
    push((ts += 800), { sessionUpdate: "agent_message_chunk", messageId: uid("msg_"), content: { type: "text", text: t.reply } });
    push((ts += 300), { sessionUpdate: "turn_complete", messageId: mid, stopReason: "end_turn" });
    cost += t.cost * 2.5;
    tokens += t.tokens ?? 40_000;
    push((ts += 20), { sessionUpdate: "usage_update", used: tokens, size: 1_000_000, cost: { amount: Number(cost.toFixed(4)), currency: "USD" } });
  }
  const dir = join(home, "sessions", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.jsonl"), lines.join("\n") + "\n");
  const updatedAt = new Date(NOW - updatedAgo).toISOString();
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        version: 1,
        sessionId: sid,
        lineageId: `hydra_lineage_${randId()}`,
        upstreamSessionId: `up_${id}`,
        agentId,
        cwd,
        title,
        currentModel: model,
        currentMode: mode,
        currentUsage: { used: tokens, size: 1_000_000, costAmount: Number(cost.toFixed(4)), costCurrency: "USD" },
        upstreamGenerations: [{ upstreamSessionId: `up_${id}`, agentId, startedAt: new Date(firstTs).toISOString(), lifetimeCostAtStart: 0 }],
        interactive: true,
        attentionFlags: [],
        extensionState: {},
        createdAt: new Date(firstTs).toISOString(),
        updatedAt,
      },
      null,
      2,
    ),
  );
  const when = new Date(NOW - updatedAgo);
  utimesSync(join(dir, "history.jsonl"), when, when);
  utimesSync(join(dir, "meta.json"), when, when);
  void loc;
  return sid;
}

const edit = (path, oldText, newText) => ({
  kind: "edit",
  title: path.split("/").slice(-2).join("/"),
  path,
  output: "Edit applied successfully.",
  diff: { path, oldText, newText },
});
const read = (path) => ({ kind: "read", title: `Read ${path.split("/").pop()}`, path, output: "(file contents)" });
const grep = (pattern, output) => ({ kind: "search", title: `grep ${pattern}`, output });
const run = (command, output) => ({ kind: "execute", title: command, command, output });
const A = (p) => join(acmeApi, p);

function dashboardPng() {
  const bars = [14, 18, 12, 22, 19, 16, 71, 138, 119, 64, 21, 17, 15, 13];
  const html = `<html><body style="margin:0;background:#fff;font:14px system-ui,sans-serif;color:#1f2328">
<div style="padding:18px 24px;border-bottom:1px solid #d8dee4;display:flex;justify-content:space-between">
<b style="font-size:17px">acme-api / staging / HTTP 429 per minute</b><span style="color:#656d76">last 14 min</span></div>
<div style="padding:24px;display:flex;align-items:flex-end;gap:14px;height:240px">
${bars.map((b) => `<div style="flex:1;height:${Math.round(b * 1.6)}px;background:${b > 60 ? "#cf222e" : "#8c959f"};border-radius:3px 3px 0 0"></div>`).join("")}
</div>
<div style="padding:0 24px 18px;color:#656d76">Spike at 14:07: one client (10.0.4.17) sent 138 req/min. No limit configured.</div>
</body></html>`;
  const dir = join(root, ".img");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dash.html"), html);
  execFileSync("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(dir, "profile")}`, `--screenshot=${join(dir, "dash.png")}`, "--window-size=760,420", `file://${join(dir, "dash.html")}`], { stdio: "ignore" });
  return readFileSync(join(dir, "dash.png")).toString("base64");
}

const HERO_SESSION = session({
  id: "RateLimitHero",
  title: "Add rate limiting to the API",
  agentId: "claude-acp",
  model: "claude-opus-4-5",
  cwd: acmeApi,
  updatedAgo: 6 * 60_000,
  turns: [
    {
      ago: 0.09,
      cost: 1.84,
      tokens: 96_000,
      prompt: "We keep getting hammered by a few noisy clients. Can you add per-IP rate limiting to the API? Make the window and max configurable via env, and add tests.",
      thought: "I'll look at how the server is wired up first, then add a small in-memory limiter as Express middleware. Config should follow the existing env pattern in config.ts.",
      steps: [
        read(A("src/server.ts")),
        read(A("src/config.ts")),
        grep("rateLimit|express-rate-limit", "No matches found"),
        edit(A("src/config.ts"), V.configOld, V.configNew),
        edit(A("src/middleware/rateLimit.ts"), null, V.rlV1),
        edit(A("src/server.ts"), V.serverOld, V.serverNew),
        edit(A("test/rateLimit.test.ts"), null, V.rlTest.replace("rejects with 429 and Retry-After over the limit", "rejects with 429 over the limit").replace(/\n  assert.ok\(Number.*\n/, "\n")),
        run("npm test", "▶ allows requests under the limit\n  ✔ allows requests under the limit (1.2ms)\n▶ rejects with 429 over the limit\n  ✔ rejects with 429 over the limit (0.4ms)\n\nℹ tests 2\nℹ pass 2\nℹ fail 0"),
      ],
      reply:
        "Per-IP rate limiting is in place.\n\n- `src/middleware/rateLimit.ts` is a fixed-window limiter keyed on `req.ip`; it answers `429` once a client passes `max` requests inside `windowMs`.\n- `src/config.ts` gets a `rateLimit` block driven by `RATE_LIMIT_WINDOW_MS` (default 60s) and `RATE_LIMIT_MAX` (default 120).\n- `src/server.ts` installs it ahead of the routers, so every endpoint is covered.\n- `test/rateLimit.test.ts` covers the under-limit and over-limit paths, and `npm test` passes.\n\nThe buckets live in process memory, so with more than one replica each instance enforces its own limit. If you scale out, we should move this to Redis.",
    },
    {
      ago: 0.01,
      cost: 0.62,
      tokens: 58_000,
      prompt: "Nice. Here is the staging dashboard from when one client hammered us. Clients should know when to back off, can you send a Retry-After header on the 429s and assert on it in the test?",
      image: dashboardPng(),
      thought: "The bucket already knows when it resets, so Retry-After is just the remaining seconds, rounded up.",
      steps: [
        edit(A("src/middleware/rateLimit.ts"), V.rlV1, V.rlFinal),
        edit(A("test/rateLimit.test.ts"), V.rlTest.replace("rejects with 429 and Retry-After over the limit", "rejects with 429 over the limit").replace(/\n  assert.ok\(Number.*\n/, "\n"), V.rlTest),
        run("npm test", "ℹ tests 2\nℹ pass 2\nℹ fail 0"),
      ],
      reply: "Done. Rejected requests now carry `Retry-After: <seconds until the window resets>` (rounded up, minimum 1) and the same value in the JSON body as `retryAfter`. The over-limit test asserts the header is present and at least 1. Both tests pass.",
    },
  ],
});

const quick = (prompt, reply, cost, ago, steps = []) => ({ ago, prompt, reply, cost, steps, tokens: 52_000 });
const W = (r, p) => join(r, p);

session({
  id: "FlakyCheckout", title: "Fix flaky checkout test", agentId: "codex-acp", model: "gpt-5-codex", cwd: acmeWeb, updatedAgo: 2 * 3600_000,
  turns: [
    quick("checkout.spec fails about one run in five on CI. Can you find out why?", "The test races the mocked payment webhook against the redirect. I made the spec wait for the webhook before asserting.", 0.74, 0.5, [read(W(acmeWeb, "src/checkout.ts")), edit(W(acmeWeb, "src/checkout.ts"), "export const total = (n: number[]) => n.reduce((a, b) => a + b, 0);\n", "export const total = (n: number[]) => n.reduce((a, b) => a + b, 0);\nexport const settled = (p: Promise<unknown>) => p.then(() => true);\n")]),
    quick("Run it 50 times to be sure.", "50/50 green.", 0.31, 0.1),
  ],
});
session({
  id: "PostgresUpgrade", title: "Migrate to Postgres 16", agentId: "claude-acp", model: "claude-sonnet-4-5", cwd: acmeApi, updatedAgo: 5 * 3600_000,
  turns: [
    quick("What breaks if we move from Postgres 14 to 16?", "Mostly nothing. Two things to check: the `pg_stat_statements` column renames and our one use of `to_char` with timezone abbreviations.", 0.9, 4, [read(A("src/config.ts"))]),
    quick("Write the upgrade runbook.", "Runbook drafted with a dump/restore path and a pg_upgrade path, plus a rollback section.", 1.35, 3.2),
    quick("Add a pre-flight check script.", "Added `scripts/preflight.sh`; it checks extensions, disk headroom and replication lag.", 1.1, 2.4),
  ],
});
session({
  id: "AuthRefactor", title: "Refactor auth module", agentId: "claude-acp", model: "claude-opus-4-5", cwd: acmeWeb, updatedAgo: 26 * 3600_000,
  turns: [
    quick("Untangle the session and token logic in auth/. It's grown three ways to refresh.", "Collapsed to a single `refresh()` path with one retry policy.", 3.4, 9),
    quick("Update call sites and the tests.", "12 call sites updated, 3 obsolete tests removed.", 4.8, 8.4),
    quick("Any perf concern?", "No: refresh is now deduplicated, which removes a thundering herd.", 0.8, 8),
  ],
});
session({
  id: "OnboardingDocs", title: "Write onboarding docs", agentId: "gemini-acp", model: "gemini-2.5-pro", cwd: docs, updatedAgo: 3 * DAY,
  turns: [
    quick("Draft a first-week guide for new backend engineers.", "Drafted: environment setup, repo tour, on-call 101, first PR checklist.", 0.45, 12),
    quick("Tighten it and add a glossary.", "Cut 30% and added a 24-term glossary.", 0.38, 11.5),
  ],
});
session({
  id: "WorkerLeak", title: "Investigate memory leak in worker", agentId: "codex-acp", model: "gpt-5-codex", cwd: worker, updatedAgo: 4 * DAY,
  turns: [
    quick("RSS climbs ~40MB/hour in billing-worker. Find the leak.", "The retry queue keeps references to completed jobs. Clearing them on ack flattens the curve.", 2.1, 16, [edit(W(worker, "src/queue.ts"), "export const queue: unknown[] = [];\n", "export const queue: unknown[] = [];\nexport const ack = (i: number) => queue.splice(i, 1);\n")]),
    quick("Add a regression test with a heap snapshot assertion.", "Added; it fails on the old code and passes now.", 1.6, 15),
  ],
});
session({
  id: "TerraformModule", title: "Extract VPC terraform module", agentId: "gemini-acp", model: "gemini-2.5-pro", cwd: infra, updatedAgo: 6 * DAY,
  turns: [
    quick("Pull the VPC config out into a reusable module.", "Moved into modules/vpc with variables for CIDR and AZ count.", 0.7, 22),
    quick("Plan against staging.", "Plan is clean: 0 to add, 4 to change (tag-only).", 0.2, 21),
  ],
});
session({
  id: "ApiDocsGen", title: "Generate OpenAPI spec from routes", agentId: "claude-acp", model: "claude-sonnet-4-5", cwd: acmeApi, updatedAgo: 9 * DAY,
  turns: [
    quick("Generate an OpenAPI spec from the Express routes.", "Generated `openapi.yaml` for 14 endpoints and wired a CI check.", 2.2, 27, [read(A("src/server.ts"))]),
    quick("Add examples for the orders endpoints.", "Examples added.", 0.95, 26),
  ],
});

const FILLER = [
  ["Bump express to v5", "claude-acp", "claude-sonnet-4-5", acmeApi],
  ["Add dark mode to checkout", "claude-acp", "claude-opus-4-5", acmeWeb],
  ["Speed up the invoice export", "codex-acp", "gpt-5-codex", worker],
  ["Fix timezone bug in reports", "claude-acp", "claude-haiku-4-5", acmeApi],
  ["Summarize the Q3 incident reviews", "gemini-acp", "gemini-2.5-flash", docs],
  ["Replace moment with date-fns", "codex-acp", "gpt-5", acmeWeb],
  ["Add retries to the webhook sender", "claude-acp", "claude-opus-4-5", worker],
  ["Tighten the S3 bucket policies", "gemini-acp", "gemini-2.5-pro", infra],
  ["Cache product lookups", "claude-acp", "claude-sonnet-4-5", acmeApi],
  ["Triage flaky e2e suite", "codex-acp", "gpt-5-codex", acmeWeb],
  ["Draft the API deprecation notice", "claude-acp", "claude-haiku-4-5", docs],
  ["Port the cron jobs to the new scheduler", "claude-acp", "claude-opus-4-5", worker],
  ["Audit unused dependencies", "gemini-acp", "gemini-2.5-flash", acmeWeb],
  ["Add pagination to /orders", "claude-acp", "claude-sonnet-4-5", acmeApi],
  ["Write load test scenarios", "codex-acp", "gpt-5", acmeApi],
  ["Rotate the staging credentials", "claude-acp", "claude-sonnet-4-5", infra],
  ["Refactor the pricing engine", "claude-acp", "claude-opus-4-5", acmeApi],
  ["Document the deploy pipeline", "gemini-acp", "gemini-2.5-pro", docs],
];
const PRICE = { "claude-opus-4-5": 4.2, "claude-sonnet-4-5": 1.6, "claude-haiku-4-5": 0.4, "gpt-5-codex": 1.7, "gpt-5": 1.5, "gemini-2.5-pro": 1.0, "gemini-2.5-flash": 0.25 };
for (const [title, agentId, model, cwd] of FILLER) {
  const n = 2 + Math.floor(rnd() * 4);
  const start = 1.5 + rnd() * 27;
  const turns = Array.from({ length: n }, (_, i) => ({
    ago: Math.max(1.2, start - i * (0.15 + rnd() * 1.4)),
    prompt: `Continue on: ${title.toLowerCase()}`,
    reply: "Done.",
    cost: (0.3 + rnd() * 1.4) * PRICE[model] / 2.5,
    steps: [],
    tokens: 40_000,
  })).sort((a, b) => b.ago - a.ago);
  session({ id: "f", title, agentId, model, cwd, turns, updatedAgo: turns[turns.length - 1].ago * DAY });
}

writeFileSync(join(root, "env.json"), JSON.stringify({ token, home: join(root, ".shots-home"), hero: HERO_SESSION, daemonPort: DAEMON_PORT }, null, 2));
console.log(`seeded ${root}`);
