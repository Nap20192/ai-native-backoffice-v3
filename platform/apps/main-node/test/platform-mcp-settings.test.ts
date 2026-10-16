// Switch of the assistant (builder-agent.md 3.7, 6.1 "выключатель").

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { handleJsonRpc } from "../src/lib/platform-mcp/handler";
import { buildSettingsRoutes } from "../src/lib/platform-mcp/settings-routes";
import { createMembershipRoles, createSettingsStore } from "../src/lib/platform-mcp/settings-store";
import { createFakePlatform } from "./helpers/platform-mcp-fake";

const WS = "ws_1";

async function setup() {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec("CREATE TABLE membership (tenant_id TEXT, user_id TEXT, role TEXT)");
  for (const [user, role] of [["user_owner", "owner"], ["user_admin", "admin"], ["user_member", "member"]]) {
    await sql.prepare("INSERT INTO membership VALUES (?, ?, ?)").bind(WS, user, role).run();
  }
  let clock = Date.parse("2026-10-16T12:00:00.000Z");
  const settings = createSettingsStore(sql, { now: () => (clock += 1000) });
  const app = new Hono<{ Variables: { tenant_id: string; user_id?: string; auth_credential?: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", WS);
    const user = c.req.header("x-user");
    if (user) c.set("user_id", user);
    const credential = c.req.header("x-credential");
    if (credential) c.set("auth_credential", { type: credential });
    await next();
  });
  app.route("/v1/oma/platform-mcp/settings", buildSettingsRoutes({ settings, roles: createMembershipRoles(sql) }));
  const get = async (user?: string, credential?: string) => {
    const response = await app.request("/v1/oma/platform-mcp/settings", {
      headers: { ...(user ? { "x-user": user } : {}), ...(credential ? { "x-credential": credential } : {}) },
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const post = async (body: unknown, user?: string, credential?: string) => {
    const response = await app.request("/v1/oma/platform-mcp/settings", {
      method: "POST",
      headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}), ...(credential ? { "x-credential": credential } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { settings, get, post };
}

describe("settings route", () => {
  it("is on without a row and tells who may change it", async () => {
    const { get } = await setup();
    expect(await get("user_member")).toEqual({ status: 200, body: { enabled: true, updated_by: null, updated_at: null, can_change: false } });
    expect((await get("user_owner")).body.can_change).toBe(true);
    expect((await get("user_admin")).body.can_change).toBe(true);
    expect((await get()).body).toMatchObject({ enabled: true, can_change: false });
  });

  it("lets the owner and an admin switch, a member gets 403", async () => {
    const { post, get } = await setup();
    const member = await post({ enabled: false }, "user_member");
    expect(member.status).toBe(403);
    expect(member.body.error.message).toBe("Включать и выключать ассистента может владелец или администратор пространства");
    expect((await get("user_member")).body.enabled).toBe(true);

    const owner = await post({ enabled: false }, "user_owner");
    expect(owner).toEqual({ status: 200, body: { enabled: false, updated_by: "user_owner", updated_at: "2026-10-16T12:00:01.000Z", can_change: true } });
    expect((await get("user_member")).body).toMatchObject({ enabled: false, updated_by: "user_owner" });
    expect((await post({ enabled: true }, "user_admin")).body).toMatchObject({ enabled: true, updated_by: "user_admin" });
  });

  it("refuses an API key without a user and the platform token", async () => {
    const { post, get } = await setup();
    expect((await post({ enabled: false })).status).toBe(403);
    expect((await post({ enabled: false }, "user_owner", "platform_mcp_actor")).status).toBe(403);
    expect((await get("user_owner", "platform_mcp_actor")).status).toBe(403);
    expect((await get("user_owner")).body.enabled).toBe(true);
  });

  it("checks the body", async () => {
    const { post } = await setup();
    expect((await post({ enabled: "no" }, "user_owner")).status).toBe(400);
    expect((await post("not json", "user_owner")).status).toBe(400);
    expect((await post({}, "user_owner")).status).toBe(400);
  });
});

describe("the switch in the platform MCP server", () => {
  it("refuses every tool while off, keeps tools/list, and works again after on", async () => {
    const { settings } = await setup();
    const fake = createFakePlatform();
    fake.setupAssistant();
    fake.deps.assistantSwitch = settings;
    const env = fake.addEnvironment({ name: "Песочница" });

    await settings.set("ws_1", false, "user_owner");
    const list = await handleJsonRpc(fake.deps, fake.actor(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (list.body as any).result.tools as { name: string }[];
    expect(tools).toHaveLength(28);
    for (const tool of tools) {
      const before = fake.writes().length;
      const result = await fake.call(tool.name, {});
      expect(result.isError, tool.name).toBe(true);
      expect(result.text, tool.name).toContain("Ассистент выключен");
      expect(fake.actionRows.at(-1), tool.name).toMatchObject({ tool: tool.name, result: "refused_disabled" });
      expect(fake.writes().length, tool.name).toBe(before);
    }

    const pending = fake.propose("update_environment", { environment_id: env.id, changes: { description: "Новое" } });
    // The owner still sees the buttons: the card blocks «Применить» by `disabled` (1.4).
    expect((await fake.preview(pending)).body).toMatchObject({ disabled: true, can_confirm: true });
    const refused = await fake.confirm(pending, { digest: "0".repeat(64) });
    expect([refused.status, refused.body.error.type]).toEqual([409, "disabled"]);

    await settings.set("ws_1", true, "user_owner");
    expect((await fake.call("list", { kind: "agents" })).isError).toBeFalsy();
    const confirmed = await fake.confirm(pending);
    expect(confirmed.status).toBe(200);

    // Off between the confirmation and the run: refused, nothing written.
    await settings.set("ws_1", false, "user_owner");
    const writes = fake.writes().length;
    const run = await fake.run("update_environment", { environment_id: env.id, changes: { description: "Новое" } }, pending);
    expect(run.isError).toBe(true);
    expect(fake.actionRows.at(-1)).toMatchObject({ result: "refused_disabled" });
    expect(fake.writes().length).toBe(writes);
  });

  it("stops the rest of a batch when switched off in the middle", async () => {
    const { settings } = await setup();
    const fake = createFakePlatform();
    fake.setupAssistant();
    fake.deps.assistantSwitch = settings;
    // The hook runs right before the write of each operation.
    fake.hooks.afterDigestCheck = async (info) => {
      if (info.tool === "create_agent") await settings.set("ws_1", false, "user_admin");
    };
    const args = {
      operations: [
        { tool: "create_memory_store", args: { name: "Первое" } },
        { tool: "create_agent", args: { config: { name: "Агент", model: "qwen3.6-35b" } } },
        { tool: "create_memory_store", args: { name: "Второе" } },
      ],
    };
    const done = await fake.confirmAndRun("apply_changes", args);
    expect(done.isError).toBe(true);
    const rows = fake.actionRows.filter((row) => row.toolUseId === done.toolUseId);
    expect(rows.map((row) => row.result)).toEqual(["ok", "ok", "refused_disabled"]);
  });
});
