// Stores of the platform MCP server on SQLite (builder-agent.md 3.1, 3.6, 3.7).

import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { Hono } from "hono";
import { createActionStore } from "../src/lib/platform-mcp/action-store";
import { buildActionsRoutes } from "../src/lib/platform-mcp/actions-routes";
import { createConfirmationStore } from "../src/lib/platform-mcp/confirmation-store";
import { PLATFORM_MCP_MIGRATIONS } from "../src/lib/platform-mcp/schema";
import { createMembershipRoles } from "../src/lib/platform-mcp/settings-store";
import { actionRow, confirmationRow, runStoreContract } from "./helpers/platform-mcp-stores-contract";

describe("platform MCP stores on SQLite", () => {
  it("passes the store contract", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await runStoreContract(sql, "ws_sqlite");
  });

  it("creates the schema in code and records each step once", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await createActionStore(sql).findByToolUse("ws", "s", "t");
    await createConfirmationStore(sql).findAllow("ws", "s", "t");
    const steps = await sql.prepare("SELECT id FROM platform_mcp_schema_migrations").all<{ id: string }>();
    expect((steps.results ?? []).map((row) => row.id)).toEqual(PLATFORM_MCP_MIGRATIONS.map((step) => step.id));
  });

  it("reads the role of a member from membership", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await sql.exec("CREATE TABLE membership (tenant_id TEXT, user_id TEXT, role TEXT)");
    await sql.prepare("INSERT INTO membership VALUES (?, ?, ?)").bind("ws_1", "user_admin", "admin").run();
    const roles = createMembershipRoles(sql);
    expect(await roles.roleOf("ws_1", "user_admin")).toBe("admin");
    expect(await roles.roleOf("ws_2", "user_admin")).toBeNull();
  });

  it("keeps the JSON columns as given", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const actions = createActionStore(sql);
    const row = actionRow({ inputRedacted: { list: [1, "два", null], nested: { a: true } }, agentVersion: null, durationMs: null, finishedAt: null });
    await actions.insert(row);
    expect((await actions.findByToolUse(row.workspaceId, row.sessionId, row.toolUseId))[0]).toEqual(row);
    const confirmations = createConfirmationStore(sql);
    const conf = confirmationRow({ opClasses: ["out_of_v1"], targetRevisions: ["a\"b"] });
    await confirmations.insert(conf);
    expect(await confirmations.findAllow(conf.workspaceId, conf.sessionId, conf.toolUseId)).toEqual(conf);
  });

  it("serves actions and confirmations to the console", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const actions = createActionStore(sql);
    const confirmations = createConfirmationStore(sql);
    await actions.insert(actionRow({ id: "act_1", createdAt: "2026-10-16T10:00:00.000Z" }));
    await actions.insert(actionRow({ id: "act_2", toolUseId: "tu_2", createdAt: "2026-10-16T10:01:00.000Z" }));
    await actions.insert(actionRow({ id: "act_3", toolUseId: "tu_3", sessionId: "sesn_b", createdAt: "2026-10-16T10:02:00.000Z" }));
    await actions.insert(actionRow({ id: "act_x", workspaceId: "ws_2", toolUseId: "tu_x" }));
    await confirmations.insert(confirmationRow());
    const app = new Hono<{ Variables: { tenant_id: string; auth_credential?: unknown } }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", "ws_1");
      if (c.req.header("x-credential")) c.set("auth_credential", { type: c.req.header("x-credential") });
      await next();
    });
    app.route("/v1/oma/platform-mcp/actions", buildActionsRoutes({ actions, confirmations }));
    const get = async (query: string, headers: Record<string, string> = {}) => {
      const response = await app.request(`/v1/oma/platform-mcp/actions${query}`, { headers });
      return { status: response.status, body: (await response.json()) as any };
    };

    const page = await get("?session_id=sesn_a&limit=1");
    expect(page.status).toBe(200);
    expect(page.body.actions.map((a: any) => a.id)).toEqual(["act_2"]);
    expect(page.body.actions[0]).toMatchObject({ tool: "create_agent", class: "create", tool_use_id: "tu_2", op_index: 0, result: "ok", masked_count: 2, input_redacted: { config: { name: "Агент" } } });
    expect(page.body.confirmations.map((c: any) => c.id)).toEqual(["conf_1"]);
    expect(page.body.confirmations[0]).toMatchObject({ result: "allow", op_classes: ["create", "update"], target_revisions: [null, "7"], used_at: null });
    const next = await get(`?session_id=sesn_a&limit=1&cursor=${encodeURIComponent(page.body.next_cursor)}`);
    expect(next.body.actions.map((a: any) => a.id)).toEqual(["act_1"]);
    expect(next.body.next_cursor).toBeNull();
    expect((await get("?from=2026-10-16T10:01:30.000Z")).body.actions.map((a: any) => a.id)).toEqual(["act_3"]);
    expect((await get("")).body.actions.map((a: any) => a.id)).toEqual(["act_3", "act_2", "act_1"]);
    expect((await get("?cursor=%%%")).status).toBe(400);
    expect((await get("?from=yesterday")).status).toBe(400);
    expect((await get("", { "x-credential": "platform_mcp_actor" })).status).toBe(403);
  });
});
