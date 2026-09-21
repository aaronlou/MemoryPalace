import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { SERVER_INSTRUCTIONS, registerTools, renderMarkdown } from "@memory-palace/runtime";
import { isAppError, toErrorPayload } from "@memory-palace/shared";
import { exportAll, importAll, wipeUser } from "@memory-palace/storage-pg";
/**
 * HTTP surface.
 *
 * Two audiences share this process:
 *  - the web UI, which is how the human inspects and corrects their memory;
 *  - MCP clients that cannot use stdio (remote or containerised agents).
 *
 * Built as a factory rather than a module-level side effect so tests can mount
 * the routes without binding a port.
 */
function statusFor(error) {
    if (!isAppError(error))
        return 500;
    switch (error.code) {
        case "NOT_FOUND":
            return 404;
        case "CONFLICT":
            return 409;
        case "VALIDATION_ERROR":
        case "CONFIG_ERROR":
            return 400;
        default:
            return 500;
    }
}
export function createApp(runtime) {
    const { palace, config, storage } = runtime;
    const app = new Hono();
    app.onError((error, c) => {
        const payload = toErrorPayload(error);
        const status = statusFor(error);
        if (status >= 500) {
            process.stderr.write(`api: ${status} ${c.req.method} ${c.req.path} — ${payload.message}\n`);
        }
        return c.json({ error: payload }, status);
    });
    app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: `no route for ${c.req.path}` } }, 404));
    // --- health -------------------------------------------------------------
    app.get("/health", (c) => c.json({
        ok: true,
        service: "memory-palace",
        version: "0.1.0",
        providers: runtime.llm.describe(),
    }));
    app.get("/api/stats", async (c) => c.json(await palace.stats(config.userId)));
    // --- the two verbs ------------------------------------------------------
    app.post("/api/remember", async (c) => {
        const body = await c.req.json();
        if (!body.content || body.content.trim() === "") {
            return c.json({ error: { code: "VALIDATION_ERROR", message: "content is required" } }, 400);
        }
        return c.json(await palace.remember({
            userId: config.userId,
            content: body.content,
            sourceKind: body.sourceKind ?? "user",
            agentId: body.agentId,
            occurredAt: body.occurredAt,
        }));
    });
    app.post("/api/recall", async (c) => {
        const body = await c.req.json();
        if (!body.query) {
            return c.json({ error: { code: "VALIDATION_ERROR", message: "query is required" } }, 400);
        }
        const query = {
            userId: config.userId,
            query: body.query,
            mode: body.mode ?? "auto",
            taskType: body.taskType,
            entities: body.entities,
            asOf: body.asOf,
            believedAt: body.believedAt,
            includeHistory: body.includeHistory ?? false,
            format: body.format ?? "json",
            limit: body.limit,
            tokenBudget: body.tokenBudget,
        };
        if (body.audit)
            return c.json(await palace.recallWithAudit(query));
        return c.json(await palace.recall(query));
    });
    // --- memories -----------------------------------------------------------
    app.get("/api/memories", async (c) => {
        const q = c.req.query();
        const filter = {};
        if (q["types"])
            filter.types = q["types"].split(",");
        if (q["statuses"])
            filter.statuses = q["statuses"].split(",");
        const limit = q["limit"] ? Number.parseInt(q["limit"], 10) : 50;
        if (q["q"]) {
            return c.json({
                memories: await palace.searchMemories(config.userId, { query: q["q"], filter, limit }),
            });
        }
        return c.json({
            memories: await palace.listMemories(config.userId, filter, {
                limit,
                orderBy: q["orderBy"] ?? "recordedAt",
            }),
        });
    });
    app.get("/api/memories/:id", async (c) => c.json(await palace.getMemory(config.userId, c.req.param("id"))));
    app.get("/api/memories/:id/history", async (c) => c.json({ history: await palace.getHistory(config.userId, c.req.param("id")) }));
    app.patch("/api/memories/:id", async (c) => {
        const body = await c.req.json();
        return c.json(await palace.updateMemory(config.userId, c.req.param("id"), body));
    });
    app.delete("/api/memories/:id", async (c) => {
        const hard = c.req.query("hard") === "true";
        return c.json(await palace.forgetMemories(config.userId, [c.req.param("id")], { hard }));
    });
    // --- confirmation queue -------------------------------------------------
    app.get("/api/pending", async (c) => c.json({ pending: await palace.listPending(config.userId, 100) }));
    app.post("/api/pending/:id/confirm", async (c) => c.json(await palace.confirmMemory(config.userId, c.req.param("id"))));
    app.post("/api/pending/:id/reject", async (c) => {
        const body = await c.req.json().catch(() => ({ reason: undefined }));
        return c.json(await palace.rejectMemory(config.userId, c.req.param("id"), body.reason));
    });
    // --- timeline -----------------------------------------------------------
    app.get("/api/timeline", async (c) => {
        const all = await palace.listMemories(config.userId, { statuses: ["active", "superseded", "archived", "pending"] }, { limit: 500 });
        const sorted = [...all].sort((a, b) => (a.validFrom ?? "").localeCompare(b.validFrom ?? ""));
        return c.json({ memories: sorted });
    });
    // --- agent policies -----------------------------------------------------
    app.get("/api/policies", async (c) => c.json({ policies: await storage.store.listAgentPolicies(config.userId) }));
    app.put("/api/policies/:agentId", async (c) => {
        const agentId = c.req.param("agentId");
        const body = await c.req.json();
        const existing = await palace.getAgentPolicy(config.userId, agentId);
        const policy = {
            userId: config.userId,
            agentId,
            allowedTypes: body.allowedTypes ?? existing.allowedTypes,
            requireConfirmationFor: body.requireConfirmationFor ?? existing.requireConfirmationFor,
            canWrite: body.canWrite ?? existing.canWrite,
            createdAt: existing.createdAt,
        };
        await palace.setAgentPolicy(policy);
        return c.json(policy);
    });
    // --- export / import / erase -------------------------------------------
    app.get("/api/export", async (c) => {
        const format = c.req.query("format") ?? "json";
        const includeEmbeddings = c.req.query("embeddings") === "true";
        const bundle = await exportAll(storage.db, config.userId, { includeEmbeddings });
        if (format === "markdown" || format === "md") {
            return c.text(renderMarkdown(bundle), 200, {
                "content-type": "text/markdown; charset=utf-8",
                "content-disposition": `attachment; filename="memory-palace-${dateStamp()}.md"`,
            });
        }
        return c.json(bundle, 200, {
            "content-disposition": `attachment; filename="memory-palace-${dateStamp()}.json"`,
        });
    });
    app.post("/api/import", async (c) => {
        const bundle = await c.req.json();
        const replace = c.req.query("replace") === "true";
        return c.json(await importAll(storage.db, bundle, { replace }));
    });
    /** Permanently erase everything for this user. Irreversible, on purpose. */
    app.post("/api/erase", async (c) => {
        if (c.req.query("confirm") !== "ERASE") {
            return c.json({ error: { code: "VALIDATION_ERROR", message: "refusing to erase without ?confirm=ERASE" } }, 400);
        }
        await wipeUser(storage.db, config.userId);
        return c.json({ erased: true, userId: config.userId });
    });
    return app;
}
/**
 * Mount the MCP Streamable HTTP endpoint.
 *
 * Kept separate from `createApp` because connecting a transport is async and
 * binds server state; the REST routes have no such requirement.
 */
export async function mountMcp(app, runtime) {
    const server = new McpServer({ name: "memory-palace", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
    registerTools(server, runtime.palace, runtime.config.userId);
    // Stateless mode: no session id, JSON responses. Correct for a single-user
    // local server, and it removes an entire class of session-lifecycle bugs.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    // Only JSON-RPC goes here; the web UI lives under /.
    app.all("/mcp", async (c) => transport.handleRequest(c.req.raw));
}
/** Serve the static web UI. Registered last so it cannot shadow API routes. */
export function mountWebUi(app) {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const webRoot = resolve(process.env["MP_WEB_DIR"] ?? join(here, "..", "..", "web", "public"));
    const MIME = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".json": "application/json; charset=utf-8",
    };
    app.get("*", async (c) => {
        const requested = c.req.path === "/" ? "/index.html" : c.req.path;
        // normalize + prefix check stops ../ traversal out of the static root.
        const candidate = normalize(join(webRoot, requested));
        if (!candidate.startsWith(webRoot) || !existsSync(candidate)) {
            return c.text("Not found. Is the web UI present at apps/web/public?", 404);
        }
        const body = await readFile(candidate);
        return c.body(body, 200, {
            "content-type": MIME[extname(candidate)] ?? "application/octet-stream",
        });
    });
}
function dateStamp() {
    return new Date().toISOString().slice(0, 10);
}
//# sourceMappingURL=app.js.map