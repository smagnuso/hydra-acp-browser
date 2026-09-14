import { promises as fsp } from "node:fs";
import { resolve, sep } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HydraRestClient, foreignCwdOwner } from "../hydra/client.js";
import type { ServerContext } from "./http.js";
import { isEditedPath } from "./session-files.js";
import { readFileWindow } from "./file-window.js";

interface ListBody {
  sessionId?: string;
  path?: string;
}

interface ReadBody {
  sessionId?: string;
  path?: string;
  // 1-based first line of the window. Defaults to the top.
  fromLine?: number;
  lineCount?: number;
  // Full-line text to centre the window on, used by an edit-block link
  // whose tool call carried no line number. Searched here because the
  // client no longer holds the file to search it.
  locate?: string;
}

export interface FileEntry {
  name: string;
  kind: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
}

// Resolve a request `path` (relative to the session's cwd) and verify it is
// inside the cwd after symlink resolution. Returns the realpath if safe,
// otherwise throws PathScopeError.
export async function resolveScopedPath(
  cwd: string,
  requested: string,
): Promise<string> {
  const cwdReal = await fsp.realpath(cwd);
  const cwdReq = requested.length === 0 ? "." : requested;
  const target = resolve(cwdReal, cwdReq);
  let real: string;
  try {
    real = await fsp.realpath(target);
  } catch {
    real = target;
  }
  const cwdWithSep = cwdReal.endsWith(sep) ? cwdReal : cwdReal + sep;
  if (real !== cwdReal && !real.startsWith(cwdWithSep)) {
    throw new PathScopeError(
      `path escapes cwd: requested=${requested} resolved=${real} cwd=${cwdReal}`,
    );
  }
  return real;
}

export class PathScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathScopeError";
  }
}

// Both the cwd and the name of whichever other machine actually owns it
// (foreignCwdOwner — live federation or a dormant, never-forked bundle
// import), from the one list call. GET /v1/sessions is the only place
// `remote` appears: the single-session route is forwarded to the peer,
// which answers about its own session and so never reports itself as
// remote.
async function lookupSession(
  ctx: ServerContext,
  request: FastifyRequest,
  sessionId: string,
): Promise<{ cwd: string; remote?: string } | undefined> {
  const token = request.sessionToken ?? ctx.config.hydraToken;
  const client = HydraRestClient.forRequest(ctx.config.hydraDaemonUrl, token);
  const result = await client.listSessions({ all: true });
  const match = result.sessions.find((s) => s.sessionId === sessionId);
  if (!match?.cwd) return undefined;
  const remote = foreignCwdOwner(match);
  return remote !== undefined ? { cwd: match.cwd, remote } : { cwd: match.cwd };
}

export function registerFileRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.post("/api/files/list", async (request, reply) => {
    const body = (request.body ?? {}) as ListBody;
    if (!body.sessionId) {
      reply.code(400).send({ error: "sessionId required" });
      return;
    }
    const session = await lookupSession(ctx, request, body.sessionId);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    // A federated (or dormant-import) session's files live on another
    // machine, and this server can only read its own disk. Refusing is a
    // correctness requirement, not just a missing feature: the same
    // username on both machines means the other machine's cwd usually
    // exists here too, so resolving it locally succeeds and serves a
    // DIFFERENT machine's file under this session's name.
    if (session.remote) {
      reply.code(400).send({
        error: `files live on "${session.remote}" and cannot be read from here`,
      });
      return;
    }
    const cwd = session.cwd;
    let target: string;
    try {
      target = await resolveScopedPath(cwd, body.path ?? "");
    } catch (err) {
      if (err instanceof PathScopeError) {
        reply.code(400).send({ error: "path out of scope" });
        return;
      }
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      reply.code(404).send({ error: (err as Error).message });
      return;
    }
    if (!stat.isDirectory()) {
      reply.code(400).send({ error: "not a directory" });
      return;
    }
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      const childPath = resolve(target, d.name);
      let s;
      try {
        s = await fsp.stat(childPath);
      } catch {
        continue;
      }
      let kind: FileEntry["kind"] = "other";
      if (s.isDirectory()) {
        kind = "dir";
      } else if (s.isFile()) {
        kind = "file";
      }
      entries.push({
        name: d.name,
        kind,
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "dir" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    reply.send({ cwd, path: body.path ?? "", entries });
  });

  app.post("/api/files/read", async (request, reply) => {
    const body = (request.body ?? {}) as ReadBody;
    if (!body.sessionId) {
      reply.code(400).send({ error: "sessionId required" });
      return;
    }
    if (!body.path) {
      reply.code(400).send({ error: "path required" });
      return;
    }
    const session = await lookupSession(ctx, request, body.sessionId);
    if (!session) {
      reply.code(404).send({ error: "session not found" });
      return;
    }
    // A federated (or dormant-import) session's files live on another
    // machine, and this server can only read its own disk. Refusing is a
    // correctness requirement, not just a missing feature: the same
    // username on both machines means the other machine's cwd usually
    // exists here too, so resolving it locally succeeds and serves a
    // DIFFERENT machine's file under this session's name.
    if (session.remote) {
      reply.code(400).send({
        error: `files live on "${session.remote}" and cannot be read from here`,
      });
      return;
    }
    const cwd = session.cwd;
    let target: string;
    try {
      target = await resolveScopedPath(cwd, body.path);
    } catch (err) {
      if (!(err instanceof PathScopeError)) {
        reply.code(500).send({ error: (err as Error).message });
        return;
      }
      // Outside the cwd root. Permitted only for a file this session was
      // observed editing, compared on resolved paths — see
      // session-files.ts for why that is a per-file allowlist rather
      // than a wider root. Everything else stays refused.
      if (!(await isEditedPath(body.sessionId, body.path))) {
        reply.code(400).send({ error: "path out of scope" });
        return;
      }
      target = resolve(body.path);
    }
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (err) {
      reply.code(404).send({ error: (err as Error).message });
      return;
    }
    if (!stat.isFile()) {
      reply.code(400).send({ error: "not a file" });
      return;
    }
    // Probe for binary content without reading the file in: the whole
    // reason this route is windowed is that some of the files being
    // linked run to hundreds of KiB, and a 413 on a link that names a
    // line is a worse answer than showing the lines around it.
    if (await looksBinary(target)) {
      reply.code(415).send({ error: "binary file" });
      return;
    }
    let window;
    try {
      window = await readFileWindow(target, {
        ...(typeof body.fromLine === "number" ? { fromLine: body.fromLine } : {}),
        ...(typeof body.lineCount === "number" ? { lineCount: body.lineCount } : {}),
        ...(typeof body.locate === "string" ? { locate: body.locate } : {}),
      });
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
      return;
    }
    reply.send({ path: body.path, ...window });
  });
}

// Heuristic: a NUL byte in the first 8 KiB means binary. Reads only
// those bytes, so the check costs the same whatever the file's size.
async function looksBinary(path: string): Promise<boolean> {
  const handle = await fsp.open(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return containsBinary(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function containsBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}
