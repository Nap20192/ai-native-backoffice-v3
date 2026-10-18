import { describe, expect, it } from "vitest";

import { MemorySessionStore } from "@open-managed-agents/session-store-memory";
import type { Agent } from "@open-managed-agents/domain/agents";
import type {
  DeleteFileCommand,
  FilesApplicationPort,
  ListFilesQuery,
} from "@open-managed-agents/managed-agents-application";

import { createApp, providePort, type AppModule } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  deploymentSessionLauncherPort,
  sessionAgentSourcePort,
  sessionEnvironmentSourcePort,
  sessionLifecyclePort,
  sessionResourceResolverPort,
  sessionStorePort,
  sessionsModule,
} from "../src/modules/sessions";

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-sonnet-4-6" },
  multiagent: null,
  name: "Agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

function sessionsApp(started: object[], extra: AppModule[] = []) {
  return createApp({
    modules: [
      providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
      providePort(clockPort, {
        now: () => new Date("2026-08-26T12:00:00.000Z"),
      }),
      providePort(idGeneratorPort, {
        next: (namespace) => `${namespace}_01`,
      }),
      providePort(sessionStorePort, new MemorySessionStore()),
      providePort(sessionAgentSourcePort, {
        findCurrent: async () => structuredClone(agent),
        findVersion: async () => null,
      }),
      providePort(sessionEnvironmentSourcePort, {
        find: async () => ({
          id: "environment_01",
          archivedAt: null,
          config: { type: "self_hosted" as const },
          createdAt: "2026-08-26T00:00:00.000Z",
          description: null,
          metadata: {},
          name: "Runtime",
          updatedAt: "2026-08-26T00:00:00.000Z",
        }),
      }),
      providePort(sessionResourceResolverPort, {
        resolve: async () => ({
          type: "resolved" as const,
          resources: [],
          secrets: [],
        }),
      }),
      providePort(sessionLifecyclePort, {
        sessionStarted: async (input) => { started.push(input); },
        sessionStopped: async () => {},
        sessionDeleted: async () => {},
      }),
      ...extra,
      sessionsModule(),
    ],
  });
}

describe("Sessions application module", () => {
  it("constructs Sessions only from declared domain Ports", async () => {
    const started: object[] = [];
    const app = sessionsApp(started);

    await expect(app.port(managedAgentsPortTokens.sessions).createSession({
      agent: { type: "latest", agentId: "agent_01" },
      environmentId: "environment_01",
    })).resolves.toMatchObject({
      type: "created",
      session: {
        id: "session_01",
        agent: { id: "agent_01", version: 1 },
      },
    });
    expect(started).toHaveLength(1);
    expect(app.port(deploymentSessionLauncherPort)).toBe(
      app.port(managedAgentsPortTokens.sessions),
    );
  });

  it("deletes the output files of a deleted Session through the files Port", async () => {
    const calls: string[] = [];
    const files = {
      listFiles: async (query: ListFilesQuery) => {
        calls.push(`list:${query.scopeId}:${query.afterId ?? "top"}`);
        const listed = calls.filter((call) => call.startsWith("list:")).length;
        return {
          type: "page" as const,
          page: {
            files: listed === 1 ? [fileMetadata("file_out", query.scopeId)] : [],
            hasMore: false,
            firstId: null,
            lastId: null,
          },
        };
      },
      deleteFile: async (command: DeleteFileCommand) => {
        calls.push(`delete:${command.fileId}`);
        return { type: "deleted" as const, fileId: command.fileId };
      },
    } as FilesApplicationPort;
    const app = sessionsApp([], [providePort(managedAgentsPortTokens.files, files)]);
    const sessions = app.port(managedAgentsPortTokens.sessions);
    await sessions.createSession({
      agent: { type: "latest", agentId: "agent_01" },
      environmentId: "environment_01",
    });

    await expect(sessions.deleteSession({ sessionId: "session_01" }))
      .resolves.toEqual({ type: "deleted", sessionId: "session_01" });
    expect(calls).toEqual(["list:session_01:top", "delete:file_out"]);
  });
});

function fileMetadata(id: string, sessionId: string | undefined) {
  return {
    id,
    createdAt: "2026-08-26T12:00:00.000Z",
    filename: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 4,
    ...(sessionId === undefined ? {} : { scope: { type: "session" as const, id: sessionId } }),
  };
}
