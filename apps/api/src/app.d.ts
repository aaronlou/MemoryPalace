import type { Runtime } from "@memory-palace/runtime"
import { Hono } from "hono"
export declare function createApp(runtime: Runtime): Hono
/**
 * Mount the MCP Streamable HTTP endpoint.
 *
 * Kept separate from `createApp` because connecting a transport is async and
 * binds server state; the REST routes have no such requirement.
 */
export declare function mountMcp(app: Hono, runtime: Runtime): Promise<void>
/** Serve the static web UI. Registered last so it cannot shadow API routes. */
export declare function mountWebUi(app: Hono): void
//# sourceMappingURL=app.d.ts.map
