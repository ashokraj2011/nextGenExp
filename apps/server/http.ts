import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { z } from "zod";
import { ActionMessageSchema } from "@a2ui/web_core/v1_0";
import demo from "../../fixtures/host.json";
import { type Bootstrap } from "../../packages/contracts/api";
import { MAX_MESSAGE_LENGTH, type SelectionMode } from "../../packages/contracts/domain";
import { tsFixtures } from "../../packages/ts-adapter";
import type { GatewaySettings } from "./gateway";
import { Runtime } from "./runtime";
import { ApiError, Store, presentConversation } from "./store";
import { ExperienceService } from "./service";

type Options = {
  dataDir: string;
  gateway: GatewaySettings | null;
  projectRoot: string;
  port?: number;
  dev?: boolean;
  mode?: "live" | "test";
  selectionMode?: SelectionMode;
  inspectorEnabled?: boolean;
};
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const requestId = z.string().regex(idPattern);
const messageBody = z.object({ message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH), clientRequestId: requestId }).strict();
const createBody = z.object({ personaId: requestId, scenarioId: requestId }).strict();
const retryBody = z.object({ clientRequestId: requestId }).strict();
const actionBody = z.object({ clientRequestId: requestId, envelope: ActionMessageSchema }).strict();
const eventBody = z.object({
  eventId: requestId, experienceId: requestId, type: z.enum(["rendered", "render_fallback", "helpful", "unhelpful"]),
}).strict();
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
};

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
    throw new ApiError(415, "unsupported_content_type", "Send an application/json request.");
  }

  const limit = 12 * 1024;
  if (Number(req.headers["content-length"]) > limit) throw new ApiError(413, "request_too_large", "This request is too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new ApiError(413, "request_too_large", "This request is too large.");
    }
    chunks.push(chunk);
  }

  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new ApiError(400, "invalid_json", "The request could not be read.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_input", "Check the request fields and try again.");
  return parsed.data;
}

async function serveAsset(pathname: string, root: string, res: ServerResponse) {
  if (pathname !== "/" && pathname !== "/__test/a2ui" && !pathname.startsWith("/assets/")) {
    throw new ApiError(404, "not_found", "This page is unavailable.");
  }
  const path = resolve(root, "." + (pathname.startsWith("/assets/") ? decodeURIComponent(pathname) : "/index.html"));
  if (!path.startsWith(root + sep)) throw new ApiError(404, "not_found", "This file is unavailable.");
  if (!await stat(path).then((entry) => entry.isFile(), () => false)) {
    throw new ApiError(503, "build_unavailable", "Build the web app before starting this server.");
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(path)] ?? "application/octet-stream",
    "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(await readFile(path));
}

export async function startApp(options: Options) {
  const now = Date.now;
  const selectionMode = options.selectionMode ?? "semantic_rerank";
  const store = new Store(join(options.dataDir, "app.sqlite"));
  let runtime: Runtime | null;
  try {
    runtime = options.gateway ? await Runtime.open(store, join(options.dataDir, "sfield.sqlite"), options.gateway, now) : null;
  } catch (error) {
    store.close();
    throw error;
  }
  const experience = new ExperienceService(store, runtime, selectionMode, now);
  const inspectorEnabled = options.inspectorEnabled ?? true;
  const mode = options.mode ?? "live";
  let vite: ViteDevServer | undefined;
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      const failure = error instanceof ApiError ? error : new ApiError(500, "server_error", "Something went wrong. Please try again.");
      json(res, { code: failure.code, message: failure.message }, failure.status);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const port = (server.address() as AddressInfo).port;
    const host = req.headers.host;
    if (host !== "127.0.0.1:" + port && host !== "localhost:" + port) {
      throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
    }
    const origin = "http://" + host;
    const url = new URL(req.url ?? "/", origin);
    if (url.origin !== origin) throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
    const { pathname } = url;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!pathname.startsWith("/api/")) {
      if (vite) {
        vite.middlewares(req, res, () => { if (!res.headersSent) res.writeHead(404).end(); });
      } else if (req.method === "GET") {
        return serveAsset(pathname, join(options.projectRoot, "dist"), res);
      } else {
        throw new ApiError(405, "method_unavailable", "This request method is unavailable.");
      }
      return;
    }
    if (req.method !== "GET" && ((req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site")) {
      throw new ApiError(403, "origin_unavailable", "Use the local demo address.");
    }

    const token = req.headers.cookie?.match(/(?:^|;\s*)pzn_session=(local_[a-f0-9]{32})(?:;|$)/)?.[1];
    const { id: principalId, created } = store.session(token);
    if (created) res.setHeader("Set-Cookie", "pzn_session=" + principalId + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000");

    const [resource, id, operation, extra] = pathname.slice(5).split("/");
    if (extra !== undefined || (id && !idPattern.test(id))) throw new ApiError(404, "not_found", "This item is unavailable.");
    const method = req.method;
    if (resource === "bootstrap" && method === "GET" && !id) {
      const state: Bootstrap = {
        conversations: store.conversations(principalId),
        personas: demo.personas.map(({ personaId, displayName, allowedScenarios }) => ({ personaId, displayName, allowedScenarios })),
        scenarios: tsFixtures.scenarios.map(({ scenarioId, label }) => ({ scenarioId, label })),
        defaultPersonaId: demo.defaultPersonaId, defaultScenarioId: demo.defaultScenarioId,
        gatewayConfigured: Boolean(runtime), mode, selectionMode, inspectorEnabled,
      };
      return json(res, state);
    }
    if (resource === "conversations") {
      if (method === "POST" && !id) {
        const { personaId, scenarioId } = await body(req, createBody);
        const conversation = experience.createConversation(principalId, personaId, scenarioId);
        return json(res, { ...presentConversation(conversation), turns: [] }, 201);
      }
      if (id) {
        const conversation = store.conversation(id, principalId);
        if (method === "GET" && !operation) {
          return json(res, { ...presentConversation(conversation), turns: store.conversationTurns(id).map((turn) => turn.public) });
        }
        if (method === "POST" && operation === "turns") {
          const { message, clientRequestId } = await body(req, messageBody);
          const fresh = store.conversation(conversation.id, principalId);
          return json(res, experience.submit(fresh, message, clientRequestId), 202);
        }
      }
    }
    if (resource === "turns" && id) {
      const turn = store.ownTurn(id, principalId);
      if (method === "GET" && !operation) return json(res, turn.public);
      if (method === "POST" && operation === "cancel") return json(res, experience.cancel(turn));
      if (method === "POST" && operation === "retry") {
        const { clientRequestId } = await body(req, retryBody);
        return json(res, experience.retry(store.ownTurn(id, principalId), clientRequestId), 202);
      }
      if (method === "GET" && operation === "events") {
        const rawCursor = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
        let cursor = typeof rawCursor === "string" && /^\d{1,15}$/.test(rawCursor) ? Number(rawCursor) : -1;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive", "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        streams.add(res);
        const flush = () => {
          if (res.writableEnded || res.destroyed) return;
          const live = store.ownTurn(id, principalId);
          const known = store.replay(live, cursor);
          if (!known) {
            res.end("event: gap\ndata: {}\n\n");
            return;
          }
          for (const event of known) {
            res.write("id: " + event.sequence + "\nevent: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
            cursor = event.sequence;
          }
          if (live.public.status !== "working") res.end();
        };
        const unsubscribe = store.subscribe(id, flush);
        const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": keepalive\n\n"); }, 12_000);
        heartbeat.unref();
        res.once("close", () => { unsubscribe(); clearInterval(heartbeat); streams.delete(res); });
        flush();
        return;
      }
    }
    if (resource === "experiences" && id && operation === "actions" && method === "POST") {
      const { envelope, clientRequestId } = await body(req, actionBody);
      return json(res, experience.followUp(principalId, id, envelope, clientRequestId), 202);
    }
    if (resource === "events" && !id && method === "POST") {
      const data = await body(req, eventBody);
      store.analytics(principalId, data.experienceId, data.eventId, data.type, now());
      return json(res, { received: true });
    }
    if (resource === "debug" && inspectorEnabled && id === "turns" && operation && method === "GET") {
      const turn = store.ownTurn(operation, principalId);
      const conversation = store.conversation(turn.scope.conversationId, principalId);
      return json(res, {
        turnId: turn.public.id, personaId: conversation.personaId, scenarioId: conversation.scenarioId, ordinal: turn.ordinal,
        catalog: turn.catalog ? { id: turn.catalog.snapshotId, ...turn.catalog.catalog } : null,
        propensity: turn.propensity ?? null,
        selectedContextId: turn.route?.contextId ?? null, routeDecisionId: turn.route?.routeDecisionId ?? null,
        contentDecisionId: turn.decision?.decisionId ?? null,
        catalogScopeId: turn.catalogScopeId ?? null, tsScopeId: turn.tsScopeId ?? null,
        routerRunId: turn.attempts.route?.runId ?? null, composerRunId: turn.attempts.compose?.runId ?? null,
        metricReadSucceeded: Boolean(turn.proof),
        ...turn.trace,
      });
    }
    throw new ApiError(404, "not_found", "This route is unavailable.");
  }

  try {
    if (options.dev) {
      const { createServer: createVite } = await import("vite");
      vite = await createVite({ root: options.projectRoot, server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
    }
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); accept(); });
    });
    experience.reconcile();
  } catch (error) {
    await vite?.close();
    await experience.close();
    throw error;
  }

  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    async close() {
      for (const stream of streams) stream.end();
      await vite?.close();
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      await experience.close();
    },
  };
}
