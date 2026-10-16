// Store `session_owners` (builder-agent.md 3.1). The session guard writes the
// row after a successful `POST /v1/sessions` from the user of the request.
// The client never sets or changes it: the first write wins.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { OwnerLookup, SessionOwner } from "./ports";
import { ensurePlatformMcpSchema } from "./schema";

export interface SessionOwnerStore extends OwnerLookup {
  record(workspaceId: string, sessionId: string, userId: string): Promise<void>;
}

export interface SessionOwnerStoreOptions {
  /** Epoch milliseconds. */
  now?: () => number;
  /** Name for messages like «Писать в разговор с ассистентом может только Анна». */
  displayNameOf?: (userId: string) => Promise<string | null>;
}

export function createSessionOwnerStore(sql: SqlClient, options: SessionOwnerStoreOptions = {}): SessionOwnerStore {
  const now = options.now ?? Date.now;
  return {
    async record(workspaceId, sessionId, userId) {
      await ensurePlatformMcpSchema(sql);
      await sql
        .prepare(
          "INSERT INTO session_owners (workspace_id, session_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, session_id) DO NOTHING",
        )
        .bind(workspaceId, sessionId, userId, now())
        .run();
    },
    async ownerOf(workspaceId, sessionId): Promise<SessionOwner | null> {
      await ensurePlatformMcpSchema(sql);
      const row = await sql
        .prepare("SELECT user_id FROM session_owners WHERE workspace_id = ? AND session_id = ?")
        .bind(workspaceId, sessionId)
        .first<{ user_id: string }>();
      if (row === null) return null;
      const displayName = options.displayNameOf ? await options.displayNameOf(row.user_id) : null;
      return { userId: row.user_id, displayName };
    },
  };
}
