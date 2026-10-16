// Switch of the assistant per workspace (builder-agent.md 3.7) and the role
// reader from `membership`. No row means on. Reads go to the database every
// time, there is no cache.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AssistantSwitch } from "./ports";
import { ensurePlatformMcpSchema, toIso } from "./schema";

export interface AssistantSettings {
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface SettingsStore extends AssistantSwitch {
  get(workspaceId: string): Promise<AssistantSettings | null>;
  set(workspaceId: string, enabled: boolean, userId: string): Promise<AssistantSettings>;
}

export function createSettingsStore(sql: SqlClient, options: { now?: () => number } = {}): SettingsStore {
  const now = options.now ?? Date.now;

  async function get(workspaceId: string): Promise<AssistantSettings | null> {
    await ensurePlatformMcpSchema(sql);
    const row = await sql
      .prepare("SELECT enabled, updated_by, updated_at FROM platform_mcp_settings WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<{ enabled: number | string; updated_by: string; updated_at: number | string }>();
    if (row === null) return null;
    return { enabled: Number(row.enabled) === 1, updatedBy: row.updated_by, updatedAt: toIso(row.updated_at)! };
  }

  return {
    get,
    async isEnabled(workspaceId) {
      return (await get(workspaceId))?.enabled ?? true;
    },
    async set(workspaceId, enabled, userId) {
      await ensurePlatformMcpSchema(sql);
      const time = now();
      await sql
        .prepare(
          `INSERT INTO platform_mcp_settings (workspace_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?)
ON CONFLICT (workspace_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .bind(workspaceId, enabled ? 1 : 0, userId, time)
        .run();
      return { enabled, updatedBy: userId, updatedAt: new Date(time).toISOString() };
    },
  };
}

export type WorkspaceRole = "owner" | "admin" | "member";

export interface MembershipRoles {
  roleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null>;
}

/** Role of a member, as `P/http-routes/src/tenants/members.ts` reads it. */
export function createMembershipRoles(sql: SqlClient): MembershipRoles {
  return {
    async roleOf(workspaceId, userId) {
      const row = await sql
        .prepare("SELECT role FROM membership WHERE tenant_id = ? AND user_id = ?")
        .bind(workspaceId, userId)
        .first<{ role: string }>();
      const role = row?.role;
      return role === "owner" || role === "admin" || role === "member" ? role : null;
    },
  };
}
