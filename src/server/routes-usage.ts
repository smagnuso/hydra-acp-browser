import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { computeUsage, parseSince } from "@hydra-acp/budgeter/usage";
import type { BucketSpec, CostAggregate, GroupBy } from "@hydra-acp/budgeter/usage";
import type { ServerContext } from "./http.js";

const BUCKETS = new Set<string>(["hour", "day", "week", "month", "weekday"]);
const GROUPS = new Set<string>(["dir", "session", "model", "agent"]);
const METRICS = new Set<string>(["cost", "tokens", "loc"]);
const SINCE_RE = /^\d{1,3}[hdwmy]$/;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 64;
// Raw sessions and events are shared across metric/split/range combinations;
// events are also kept on disk so a restart only fetches what is new.
const SNAPSHOT_TTL_MS = 120_000;

interface CacheEntry {
  at: number;
  value: Promise<CostAggregate>;
}

export function registerUsageRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  const cache = new Map<string, CacheEntry>();

  app.get("/api/usage", async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const since = q.since ?? "30d";
    const bucket = q.bucket;
    const by = q.by;
    const metric = q.metric ?? "cost";
    const depth = q.depth === undefined ? 2 : Number(q.depth);
    const refresh = q.refresh === "1";

    if (!SINCE_RE.test(since)) {
      reply.code(400).send({ error: "invalid since" });
      return;
    }
    if (bucket !== undefined && !BUCKETS.has(bucket)) {
      reply.code(400).send({ error: "invalid bucket" });
      return;
    }
    if (by !== undefined && !GROUPS.has(by)) {
      reply.code(400).send({ error: "invalid by" });
      return;
    }
    if (!Number.isInteger(depth) || depth < 1 || depth > 4) {
      reply.code(400).send({ error: "invalid depth" });
      return;
    }
    if (!METRICS.has(metric)) {
      reply.code(400).send({ error: "invalid metric" });
      return;
    }

    const token = request.sessionToken ?? ctx.config.hydraToken;
    const tokenId = createHash("sha256").update(token).digest("hex").slice(0, 16);
    const key = [tokenId, since, bucket ?? "", by ?? "", metric, depth].join("|");

    const now = Date.now();
    if (refresh) {
      cache.clear();
    }
    let entry = cache.get(key);
    if (entry === undefined || now - entry.at > CACHE_TTL_MS) {
      const value = computeUsage(
        {
          since: parseSince(since),
          bucket: bucket as BucketSpec | undefined,
          by: by as GroupBy | undefined,
          depth,
          metric: metric as "cost" | "tokens" | "loc",
        },
        { daemonUrl: ctx.config.hydraDaemonUrl, token },
        { cacheMs: SNAPSHOT_TTL_MS, persist: true, refresh },
      );
      entry = { at: now, value };
      cache.set(key, entry);
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      value.catch(() => {
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
      });
    }

    try {
      reply.send(await entry.value);
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });
}
