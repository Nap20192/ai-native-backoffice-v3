// One contract for the stores of the platform MCP server (builder-agent.md
// 3.1, 3.6, 3.7). SQLite runs it always, Postgres with OMA_TEST_POSTGRES_URL.

import { expect } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { createActionStore } from "../../src/lib/platform-mcp/action-store";
import { createConfirmationStore } from "../../src/lib/platform-mcp/confirmation-store";
import { createSessionOwnerStore } from "../../src/lib/platform-mcp/owner-store";
import { ensurePlatformMcpSchema } from "../../src/lib/platform-mcp/schema";
import { createSettingsStore } from "../../src/lib/platform-mcp/settings-store";
import type { ActionRow, ConfirmationRow } from "../../src/lib/platform-mcp/ports";

export function actionRow(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: "act_1",
    workspaceId: "ws_1",
    userId: "user_1",
    sessionId: "sesn_a",
    agentId: "agent_b",
    agentVersion: 3,
    model: "qwen3.6-35b",
    tool: "create_agent",
    class: "create",
    toolUseId: "tu_1",
    opIndex: 0,
    inputDigest: "d".repeat(64),
    inputRedacted: { config: { name: "Агент" } },
    targetKind: "agent",
    targetId: "agent_new",
    targetRevision: "1",
    result: "ok",
    errorMessage: null,
    confirmationId: "conf_1",
    previewDigest: "p".repeat(64),
    maskedCount: 2,
    createdAt: "2026-10-16T10:00:00.000Z",
    finishedAt: "2026-10-16T10:00:01.500Z",
    durationMs: 1500,
    ...overrides,
  };
}

export function confirmationRow(overrides: Partial<ConfirmationRow> = {}): ConfirmationRow {
  return {
    id: "conf_1",
    workspaceId: "ws_1",
    sessionId: "sesn_a",
    toolUseId: "tu_1",
    userId: "user_1",
    result: "allow",
    previewDigest: "p".repeat(64),
    opClasses: ["create", "update"],
    targetRevisions: [null, "7"],
    eventId: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    usedAt: null,
    ...overrides,
  };
}

/** Runs every store against `sql`. `ws` keeps parallel runs apart on a shared database. */
export async function runStoreContract(sql: SqlClient, ws: string): Promise<void> {
  const other = `${ws}_other`;
  await Promise.all([ensurePlatformMcpSchema(sql), ensurePlatformMcpSchema(sql)]);
  await ensurePlatformMcpSchema(sql);

  // Owners: the first write wins, the lookup is scoped to the workspace.
  const owners = createSessionOwnerStore(sql, {
    now: () => Date.parse("2026-10-16T10:00:00.000Z"),
    displayNameOf: async (userId) => (userId === "user_1" ? "Анна" : null),
  });
  await owners.record(ws, "sesn_a", "user_1");
  await owners.record(ws, "sesn_a", "user_2");
  expect(await owners.ownerOf(ws, "sesn_a")).toEqual({ userId: "user_1", displayName: "Анна" });
  expect(await owners.ownerOf(other, "sesn_a")).toBeNull();
  expect(await owners.ownerOf(ws, "sesn_missing")).toBeNull();

  // Actions: the triple is unique, lookups are scoped.
  const actions = createActionStore(sql);
  const first = actionRow({ workspaceId: ws });
  expect(await actions.insert(first)).toEqual({ inserted: true });
  expect(await actions.insert({ ...first, id: "act_dup", result: "error" })).toEqual({ inserted: false });
  expect(await actions.insert({ ...first, id: "act_2", opIndex: 1, tool: "create_session", targetKind: "session", targetId: "sesn_created", inputRedacted: null })).toEqual({ inserted: true });
  expect(await actions.insert({ ...first, id: "act_3", toolUseId: "tu_2", tool: "create_session", targetId: "sesn_failed", result: "error", errorMessage: "Маршрут ответил 400" })).toEqual({ inserted: true });
  expect(await actions.insert({ ...first, id: "act_4", sessionId: "sesn_other_chat", toolUseId: "tu_9", tool: "create_session", targetId: "sesn_elsewhere", userId: "user_2", createdAt: "2026-10-16T11:00:00.000Z" })).toEqual({ inserted: true });

  const byToolUse = await actions.findByToolUse(ws, "sesn_a", "tu_1");
  expect(byToolUse.map((row) => row.id)).toEqual(["act_1", "act_2"]);
  expect(byToolUse[0]).toEqual(first);
  expect(byToolUse[1]!.inputRedacted).toBeNull();
  expect(await actions.findByToolUse(other, "sesn_a", "tu_1")).toEqual([]);

  expect(await actions.findSessionCreatedBy(ws, "sesn_a", "sesn_created")).toBe(true);
  expect(await actions.findSessionCreatedBy(ws, "sesn_a", "sesn_failed")).toBe(false);
  expect(await actions.findSessionCreatedBy(ws, "sesn_a", "sesn_elsewhere")).toBe(false);
  expect(await actions.findSessionCreatedBy(ws, "sesn_other_chat", "sesn_elsewhere")).toBe(true);
  expect(await actions.findSessionCreatedBy(other, "sesn_a", "sesn_created")).toBe(false);

  const all = await actions.list(ws, { limit: 2 });
  expect(all.data.map((row) => row.id)).toEqual(["act_4", "act_3"]);
  const rest = await actions.list(ws, { limit: 2, cursor: all.next_cursor! });
  expect(rest.data.map((row) => row.id)).toEqual(["act_2", "act_1"]);
  expect(rest.next_cursor).toBeNull();
  expect((await actions.list(ws, { sessionId: "sesn_a" })).data).toHaveLength(3);
  expect((await actions.list(ws, { userId: "user_2" })).data.map((row) => row.id)).toEqual(["act_4"]);
  expect((await actions.list(ws, { targetId: "sesn_created" })).data.map((row) => row.id)).toEqual(["act_2"]);
  expect((await actions.list(ws, { from: "2026-10-16T10:30:00.000Z" })).data.map((row) => row.id)).toEqual(["act_4"]);
  expect((await actions.list(ws, { to: "2026-10-16T10:30:00.000Z" })).data).toHaveLength(3);
  expect((await actions.list(other, {})).data).toEqual([]);

  // Confirmations: newest allow, one use.
  const confirmations = createConfirmationStore(sql);
  // Ids of confirmations are global, so a shared database needs unique ones.
  const cid = (name: string) => `${ws}_${name}`;
  const allow = confirmationRow({ workspaceId: ws, id: cid("conf_1") });
  await confirmations.insert(allow);
  await confirmations.insert(confirmationRow({ workspaceId: ws, id: cid("conf_deny"), result: "deny", createdAt: "2026-10-16T10:05:00.000Z" }));
  expect(await confirmations.findAllow(ws, "sesn_a", "tu_1")).toEqual(allow);
  await confirmations.attachEvent(cid("conf_1"), "sevt_9");
  const newer = confirmationRow({ workspaceId: ws, id: cid("conf_2"), createdAt: "2026-10-16T10:01:00.000Z" });
  await confirmations.insert(newer);
  expect((await confirmations.findAllow(ws, "sesn_a", "tu_1"))!.id).toBe(cid("conf_2"));
  await confirmations.delete(cid("conf_2"));
  expect(await confirmations.findAllow(ws, "sesn_a", "tu_1")).toEqual({ ...allow, eventId: "sevt_9" });
  expect(await confirmations.findAllow(other, "sesn_a", "tu_1")).toBeNull();
  const used = await Promise.all([
    confirmations.markUsed(cid("conf_1"), "2026-10-16T10:02:00.000Z"),
    confirmations.markUsed(cid("conf_1"), "2026-10-16T10:02:00.000Z"),
  ]);
  expect(used.sort()).toEqual([false, true]);
  expect((await confirmations.findAllow(ws, "sesn_a", "tu_1"))!.usedAt).toBe("2026-10-16T10:02:00.000Z");
  expect((await confirmations.list(ws, { sessionId: "sesn_a" })).data.map((row) => row.id)).toEqual([cid("conf_deny"), cid("conf_1")]);
  expect((await confirmations.list(other, {})).data).toEqual([]);

  // Settings: no row means on; the last write wins.
  const settings = createSettingsStore(sql, { now: () => Date.parse("2026-10-16T12:00:00.000Z") });
  expect(await settings.isEnabled(ws)).toBe(true);
  expect(await settings.get(ws)).toBeNull();
  await settings.set(ws, false, "user_1");
  expect(await settings.isEnabled(ws)).toBe(false);
  expect(await settings.isEnabled(other)).toBe(true);
  expect(await settings.get(ws)).toEqual({ enabled: false, updatedBy: "user_1", updatedAt: "2026-10-16T12:00:00.000Z" });
  await settings.set(ws, true, "user_2");
  expect(await settings.get(ws)).toMatchObject({ enabled: true, updatedBy: "user_2" });

}

export async function cleanupStores(sql: SqlClient, ws: string): Promise<void> {
  const other = `${ws}_other`;
  for (const table of ["platform_mcp_actions", "platform_mcp_confirmations", "session_owners", "platform_mcp_settings"]) {
    await sql.prepare(`DELETE FROM ${table} WHERE workspace_id IN (?, ?)`).bind(ws, other).run();
  }
}
