import type {
  AgentsApplicationPort,
  AgentModelInput,
  AgentModelView,
  AgentView,
  ArchiveAgentCommand,
  ArchiveAgentResult,
  DeleteAgentCommand,
  DeleteAgentResult,
  UnarchiveAgentCommand,
  UnarchiveAgentResult,
  CreateAgentCommand,
  CreateAgentResult,
  ListAgentsPage,
  ListAgentsQuery,
  ListAgentsResult,
  ListAgentVersionsQuery,
  ListAgentVersionsResult,
  RetrieveAgentQuery,
  RetrieveAgentResult,
  UpdateAgentCommand,
  UpdateAgentResult,
  AgentContextManagementInput,
  AgentOpenMaInput,
} from "./port";
import {
  parseOpenAiModelSettings,
  resolveCompactionWireInput,
} from "./compaction-wire";
import type { AgentStore } from "@open-managed-agents/agent-store";
import {
  mergeMultiagentUpdate,
  reservedToolNameProblem,
  resolveMultiagentInput,
} from "./multiagent";
import {
  resolveAgentSkills,
  resolveAgentTools,
  validateMcpConfiguration,
} from "./definition-resolution";
import { dependencyConflictOf } from "../dependencies/application";
import type { DependenciesApplicationPort } from "../ports/dependencies";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeAgentCursor(agent: AgentView): string {
  return `agents.${encodeCursorPart(agent.createdAt)}.${encodeCursorPart(agent.id)}`;
}

function decodeAgentCursor(cursor: string): {
  createdAt: string;
  agentId: string;
} | null {
  const [scope, createdAt, agentId, extra] = cursor.split(".");
  if (scope !== "agents" || createdAt === undefined || agentId === undefined || extra !== undefined) {
    return null;
  }
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedAgentId = decodeCursorPart(agentId);
  if (
    decodedCreatedAt === null ||
    decodedAgentId === null ||
    decodedAgentId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return {
    createdAt: decodedCreatedAt,
    agentId: decodedAgentId,
  };
}

function encodeAgentVersionCursor(agent: AgentView): string {
  return `agent-versions.${encodeCursorPart(agent.id)}.${agent.version}`;
}

function decodeAgentVersionCursor(
  cursor: string,
  expectedAgentId: string,
): number | null {
  const [scope, agentId, versionText, extra] = cursor.split(".");
  const version = Number(versionText);
  const decodedAgentId = agentId === undefined ? null : decodeCursorPart(agentId);
  if (
    scope !== "agent-versions" ||
    decodedAgentId !== expectedAgentId ||
    !Number.isInteger(version) ||
    version < 1 ||
    extra !== undefined
  ) {
    return null;
  }
  return version;
}

function normalizeModel(model: string | AgentModelInput): AgentModelView {
  if (typeof model === "string") return { id: model };
  return {
    id: model.id,
    ...(model.effort != null && { effort: model.effort }),
    ...(model.inferenceGeo != null && { inferenceGeo: model.inferenceGeo }),
    ...(model.providerOptions != null && {
      providerOptions: structuredClone(model.providerOptions),
    }),
    ...(model.speed != null && { speed: model.speed }),
    ...(model.maxTokens != null && { maxTokens: model.maxTokens }),
  };
}

function validateAgentModelCapacity(model: AgentModelView): string | null {
  if (model.maxTokens === undefined) return null;
  if (!Number.isInteger(model.maxTokens) || model.maxTokens < 1) {
    return "model.max_tokens must be a positive integer";
  }
  return null;
}

function isCompactEditType(type: string): boolean {
  return type === "compact" || type === "compact_20260112";
}

function validateContextManagement(
  contextManagement: AgentContextManagementInput | null | undefined,
): string | null {
  if (contextManagement == null) return null;
  for (const edit of contextManagement.edits) {
    if (!isCompactEditType(edit.type)) {
      return "context_management.edits only supports type compact or compact_20260112";
    }
    if (
      edit.trigger !== undefined
      && (edit.trigger.type !== "input_tokens"
        || !Number.isInteger(edit.trigger.value)
        || edit.trigger.value < 1)
    ) {
      return "context_management compact trigger must be input_tokens with a positive value";
    }
  }
  return null;
}

function validateOpenAiModelSettings(
  modelSettings: AgentOpenMaInput["openaiModelSettings"],
): string | null {
  if (modelSettings == null) return null;
  if (
    modelSettings.max_tokens !== undefined
    && (!Number.isInteger(modelSettings.max_tokens) || modelSettings.max_tokens < 1)
  ) {
    return "model_settings.max_tokens must be a positive integer";
  }
  for (const entry of modelSettings.context_management ?? []) {
    if (entry.type !== "compaction") {
      return "model_settings.context_management only supports type compaction";
    }
    if (
      !Number.isInteger(entry.compact_threshold)
      || entry.compact_threshold < 1
    ) {
      return "model_settings compaction compact_threshold must be a positive integer";
    }
  }
  return null;
}

function validateModelMaxTokensConflict(
  model: AgentModelView,
  openma: AgentOpenMaInput | null | undefined,
): string | null {
  const fromOpenAi = parseOpenAiModelSettings(openma?.openaiModelSettings)
    ?.modelMaxTokensFromOpenAi;
  if (fromOpenAi === undefined) return null;
  if (model.maxTokens !== undefined && model.maxTokens !== fromOpenAi) {
    return "Conflicting max_tokens between model.max_tokens and _oma.model_settings.max_tokens";
  }
  return null;
}

function mergeOpenMaCompactionInput(
  current: AgentView["openma"],
  patch: AgentOpenMaInput | undefined,
): AgentOpenMaInput | null {
  if (patch === undefined) return null;
  const merged: AgentOpenMaInput = {};
  if (patch.contextManagement !== undefined) {
    merged.contextManagement = patch.contextManagement;
  } else if (current?.contextManagement !== undefined) {
    merged.contextManagement = current.contextManagement;
  }
  if (patch.openaiModelSettings !== undefined) {
    merged.openaiModelSettings = patch.openaiModelSettings;
  } else if (current?.openaiModelSettings !== undefined) {
    merged.openaiModelSettings = current.openaiModelSettings;
  }
  if (
    merged.contextManagement === undefined
    && merged.openaiModelSettings === undefined
  ) {
    return null;
  }
  return merged;
}

function validateCompactionWire(
  openma: AgentOpenMaInput | null | undefined,
  model?: AgentModelView,
): string | null {
  const invalidContext = validateContextManagement(openma?.contextManagement);
  if (invalidContext !== null) return invalidContext;
  const invalidOpenAi = validateOpenAiModelSettings(openma?.openaiModelSettings);
  if (invalidOpenAi !== null) return invalidOpenAi;
  const resolved = resolveCompactionWireInput(openma);
  if (resolved.type === "error") return resolved.message;
  if (model !== undefined) {
    const maxTokensConflict = validateModelMaxTokensConflict(model, openma);
    if (maxTokensConflict !== null) return maxTokensConflict;
  }
  return null;
}

function applyOpenAiModelMaxTokens(
  model: AgentModelView,
  openma: AgentOpenMaInput | null | undefined,
): AgentModelView {
  const fromOpenAi = parseOpenAiModelSettings(openma?.openaiModelSettings)
    ?.modelMaxTokensFromOpenAi;
  if (fromOpenAi === undefined || model.maxTokens !== undefined) return model;
  return { ...model, maxTokens: fromOpenAi };
}

function normalizeOpenMaCreate(
  input: CreateAgentCommand["openma"],
): AgentView["openma"] {
  if (input === undefined) return undefined;
  const resolvedCompaction = resolveCompactionWireInput(input);
  const compactionPatch =
    resolvedCompaction.type === "ok" ? resolvedCompaction.patch : {};
  const extension = {
    ...compactionPatch,
    ...(input.auxiliaryModel != null && {
      auxiliaryModel: normalizeModel(input.auxiliaryModel),
    }),
    ...(input.appendablePrompts != null && {
      appendablePrompts: input.appendablePrompts,
    }),
    ...(input.harness != null && { harness: input.harness }),
    ...(input.enableGeneralSubagent != null && {
      enableGeneralSubagent: input.enableGeneralSubagent,
    }),
    ...(input.compatibility != null && {
      compatibility: structuredClone(input.compatibility),
    }),
  };
  return Object.keys(extension).length === 0 ? undefined : extension;
}

function patchOpenMa(
  current: AgentView["openma"],
  patch: UpdateAgentCommand["openma"],
): AgentView["openma"] {
  if (patch === undefined) return current;
  const next = { ...current };
  const assign = <Key extends keyof NonNullable<AgentView["openma"]>>(
    key: Key,
    value: NonNullable<AgentView["openma"]>[Key] | null | undefined,
  ) => {
    if (value === undefined) return;
    if (value === null) delete next[key];
    else next[key] = value;
  };
  assign(
    "auxiliaryModel",
    patch.auxiliaryModel == null
      ? patch.auxiliaryModel
      : normalizeModel(patch.auxiliaryModel),
  );
  assign("appendablePrompts", patch.appendablePrompts);
  if (patch.contextManagement !== undefined || patch.openaiModelSettings !== undefined) {
    const resolved = resolveCompactionWireInput(patch);
    if (resolved.type === "ok") {
      if (patch.contextManagement === null) delete next.contextManagement;
      else if (resolved.patch.contextManagement !== undefined) {
        next.contextManagement = resolved.patch.contextManagement;
      }
      if (patch.openaiModelSettings === null) delete next.openaiModelSettings;
      else if (resolved.patch.openaiModelSettings !== undefined) {
        next.openaiModelSettings = resolved.patch.openaiModelSettings;
      }
      if (resolved.patch.compactionWireFormat !== undefined) {
        next.compactionWireFormat = resolved.patch.compactionWireFormat;
      }
    }
  }
  assign("harness", patch.harness);
  assign("enableGeneralSubagent", patch.enableGeneralSubagent);
  assign(
    "compatibility",
    patch.compatibility == null
      ? patch.compatibility
      : structuredClone(patch.compatibility),
  );
  return Object.keys(next).length === 0 ? undefined : next;
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null,
): Record<string, string> {
  if (patch === null) return {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function validateMetadata(metadata: Record<string, string>): string | null {
  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    return "Agent metadata may contain at most 16 keys";
  }
  for (const [key, value] of entries) {
    if (key.length < 1 || key.length > 64) {
      return "Agent metadata keys must contain 1 to 64 characters";
    }
    if (value.length > 512) {
      return "Agent metadata values may contain at most 512 characters";
    }
  }
  return null;
}

export interface AgentsApplicationServiceDependencies {
  workspaceId: string;
  store: AgentStore;
  clock: { now(): Date };
  ids: { nextAgentId(): string };
  /** Archive and delete check dependencies with it (docs/plans/crud.md, 1.3). */
  dependencyCheck?: DependenciesApplicationPort;
}

function staleAgentVersion(
  agentId: string,
  expectedVersion: number | undefined,
  version: number,
): { type: "precondition_failed"; message: string } | null {
  if (expectedVersion === undefined || expectedVersion === version) return null;
  return {
    type: "precondition_failed",
    message: `Agent ${agentId} is at version ${version}, not ${expectedVersion}`,
  };
}

/** The answer when the store refused a write guarded by the expected version. */
function versionChanged(
  agentId: string,
  actualVersion: number,
): { type: "precondition_failed"; message: string } {
  return {
    type: "precondition_failed",
    message: `Agent ${agentId} changed concurrently: now at version ${actualVersion}`,
  };
}

export class AgentsApplicationService implements AgentsApplicationPort {
  constructor(private readonly dependencies: AgentsApplicationServiceDependencies) {}

  async createAgent(command: CreateAgentCommand): Promise<CreateAgentResult> {
    const metadata = command.metadata ?? {};
    const invalidMetadata = validateMetadata(metadata);
    if (invalidMetadata !== null) {
      return { type: "invalid_request", message: invalidMetadata };
    }
    const invalidMcpConfiguration = validateMcpConfiguration(
      command.mcpServers ?? [],
      command.tools ?? [],
    );
    if (invalidMcpConfiguration !== null) {
      return { type: "invalid_request", message: invalidMcpConfiguration };
    }
    let normalizedModel = normalizeModel(command.model);
    normalizedModel = applyOpenAiModelMaxTokens(normalizedModel, command.openma);
    const invalidModel = validateAgentModelCapacity(normalizedModel);
    if (invalidModel !== null) {
      return { type: "invalid_request", message: invalidModel };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const agentId = this.dependencies.ids.nextAgentId();
    const resolvedMultiagent = await resolveMultiagentInput(
      this.dependencies.store,
      this.dependencies.workspaceId,
      command.multiagent,
      { agentId, version: 1, name: command.name },
    );
    if (resolvedMultiagent.type === "invalid_request") {
      return resolvedMultiagent;
    }
    const tools = resolveAgentTools(command.tools ?? []);
    const reservedTool = reservedToolNameProblem(resolvedMultiagent.multiagent, tools);
    if (reservedTool !== null) {
      return { type: "invalid_request", message: reservedTool };
    }
    const invalidCompaction = validateCompactionWire(command.openma, normalizedModel);
    if (invalidCompaction !== null) {
      return { type: "invalid_request", message: invalidCompaction };
    }
    const openma = normalizeOpenMaCreate(command.openma);
    const agent = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      agent: {
        id: agentId,
        archivedAt: null,
        createdAt: timestamp,
        description: command.description ?? null,
        mcpServers: command.mcpServers ?? [],
        metadata,
        model: normalizedModel,
        multiagent: resolvedMultiagent.multiagent,
        name: command.name,
        ...(openma !== undefined && { openma }),
        skills: resolveAgentSkills(command.skills ?? []),
        system: command.system ?? null,
        tools,
        updatedAt: timestamp,
        version: 1,
      },
    });
    return { type: "created", agent };
  }

  async retrieveAgent(query: RetrieveAgentQuery): Promise<RetrieveAgentResult> {
    const agent = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: query.agentId,
    });
    if (agent === null) return { type: "not_found" };
    if (query.version !== undefined && query.version !== agent.version) {
      const version = await this.dependencies.store.findVersion({
        workspaceId: this.dependencies.workspaceId,
        agentId: query.agentId,
        version: query.version,
      });
      return version === null
        ? { type: "not_found" }
        : { type: "found", agent: version };
    }
    return { type: "found", agent };
  }

  async updateAgent(command: UpdateAgentCommand): Promise<UpdateAgentResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
    });
    if (current === null) return { type: "not_found" };
    if (current.archivedAt !== null) {
      return {
        type: "version_conflict",
        message: `Agent ${command.agentId} is archived and read-only`,
      };
    }
    if (
      command.expectedVersion !== undefined &&
      command.expectedVersion !== current.version
    ) {
      return {
        type: "version_conflict",
        message: `Agent version does not match: expected ${command.expectedVersion}, current ${current.version}`,
      };
    }
    const metadata =
      command.metadata === undefined
        ? current.metadata
        : patchMetadata(current.metadata, command.metadata);
    const invalidMetadata = validateMetadata(metadata);
    if (invalidMetadata !== null) {
      return { type: "invalid_request", message: invalidMetadata };
    }
    const mcpServers =
      command.mcpServers === undefined
        ? current.mcpServers
        : command.mcpServers ?? [];
    const tools =
      command.tools === undefined ? current.tools : command.tools ?? [];
    const invalidMcpConfiguration = validateMcpConfiguration(mcpServers, tools);
    if (invalidMcpConfiguration !== null) {
      return { type: "invalid_request", message: invalidMcpConfiguration };
    }
    const resolvedMultiagent = await mergeMultiagentUpdate(
      this.dependencies.store,
      this.dependencies.workspaceId,
      current.multiagent,
      command.multiagent,
      {
        agentId: current.id,
        version: current.version + 1,
        name: command.name ?? current.name,
      },
    );
    if (resolvedMultiagent.type === "invalid_request") {
      return resolvedMultiagent;
    }
    const nextModel =
      command.model !== undefined
        ? applyOpenAiModelMaxTokens(
            normalizeModel(command.model),
            command.openma,
          )
        : applyOpenAiModelMaxTokens(current.model, command.openma);
    const invalidModelCapacity = validateAgentModelCapacity(nextModel);
    if (invalidModelCapacity !== null) {
      return { type: "invalid_request", message: invalidModelCapacity };
    }
    const mergedOpenMa = mergeOpenMaCompactionInput(
      current.openma,
      command.openma,
    );
    const invalidCompaction = validateCompactionWire(mergedOpenMa, nextModel);
    if (invalidCompaction !== null) {
      return { type: "invalid_request", message: invalidCompaction };
    }
    const openma = patchOpenMa(current.openma, command.openma);
    const next: AgentView = {
      ...current,
      ...(command.description !== undefined && {
        description: command.description,
      }),
      ...(command.mcpServers !== undefined && {
        mcpServers: command.mcpServers ?? [],
      }),
      ...(command.metadata !== undefined && {
        metadata,
      }),
      ...((command.model !== undefined
        || command.openma?.openaiModelSettings !== undefined)
        && { model: nextModel }),
      multiagent: resolvedMultiagent.multiagent,
      ...(command.name !== undefined && { name: command.name }),
      ...(command.skills !== undefined && {
        skills: resolveAgentSkills(command.skills ?? []),
      }),
      ...(command.system !== undefined && { system: command.system }),
      ...(command.tools !== undefined && {
        tools: resolveAgentTools(command.tools ?? []),
      }),
      updatedAt: this.dependencies.clock.now().toISOString(),
      version: current.version + 1,
    };
    if (command.openma !== undefined) {
      if (openma === undefined) delete next.openma;
      else next.openma = openma;
    }
    const invalidModel = validateAgentModelCapacity(next.model);
    if (invalidModel !== null) {
      return { type: "invalid_request", message: invalidModel };
    }
    const reservedTool = reservedToolNameProblem(next.multiagent, next.tools);
    if (reservedTool !== null) {
      return { type: "invalid_request", message: reservedTool };
    }

    const result = await this.dependencies.store.replaceCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
      expectedVersion: current.version,
      next,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "version_conflict") {
      return {
        type: "version_conflict",
        message: `Agent version changed concurrently: current ${result.actualVersion}`,
      };
    }
    return { type: "updated", agent: result.agent };
  }

  async archiveAgent(command: ArchiveAgentCommand): Promise<ArchiveAgentResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
    });
    if (current === null) return { type: "not_found" };
    const stale = staleAgentVersion(command.agentId, command.expectedVersion, current.version);
    if (stale !== null) return stale;
    const conflict = await dependencyConflictOf(this.dependencies.dependencyCheck, {
      kind: "agent",
      id: command.agentId,
      operation: "archive",
    });
    if (conflict !== null) return conflict;
    // The early check answers before the dependency queries. The store checks
    // the version again inside the write: an update after the read gives 412.
    const result = await this.dependencies.store.archiveCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
      archivedAt: this.dependencies.clock.now().toISOString(),
      expectedVersion: command.expectedVersion,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "version_conflict") {
      return versionChanged(command.agentId, result.actualVersion);
    }
    return { type: "archived", agent: result.agent };
  }

  async unarchiveAgent(command: UnarchiveAgentCommand): Promise<UnarchiveAgentResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
    });
    if (current === null) return { type: "not_found" };
    const stale = staleAgentVersion(command.agentId, command.expectedVersion, current.version);
    if (stale !== null) return stale;
    if (current.archivedAt === null) return { type: "unarchived", agent: current };
    const result = await this.dependencies.store.unarchiveCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
      updatedAt: this.dependencies.clock.now().toISOString(),
      expectedVersion: command.expectedVersion,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "version_conflict") {
      return versionChanged(command.agentId, result.actualVersion);
    }
    return { type: "unarchived", agent: result.agent };
  }

  async deleteAgent(command: DeleteAgentCommand): Promise<DeleteAgentResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
    });
    if (current === null) return { type: "not_found" };
    const stale = staleAgentVersion(command.agentId, command.expectedVersion, current.version);
    if (stale !== null) return stale;
    const conflict = await dependencyConflictOf(this.dependencies.dependencyCheck, {
      kind: "agent",
      id: command.agentId,
      operation: "delete",
    });
    if (conflict !== null) return conflict;
    const result = await this.dependencies.store.deleteCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: command.agentId,
      expectedVersion: command.expectedVersion,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "version_conflict") {
      return versionChanged(command.agentId, result.actualVersion);
    }
    return { type: "deleted", agentId: command.agentId };
  }

  async listAgents(query: ListAgentsQuery): Promise<ListAgentsResult> {
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const after =
      query.cursor === undefined ? undefined : decodeAgentCursor(query.cursor);
    if (after === null) {
      return {
        type: "invalid_request",
        message: "Invalid agents page cursor",
      };
    }
    const records = await this.dependencies.store.listCurrent({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(after !== undefined && { after }),
    });
    const hasMore = records.length > pageSize;
    const agents = hasMore ? records.slice(0, pageSize) : records;
    return {
      type: "page",
      page: {
        agents,
        nextCursor:
          hasMore && agents.length > 0
            ? encodeAgentCursor(agents[agents.length - 1]!)
            : null,
      },
    };
  }

  async listAgentVersions(
    query: ListAgentVersionsQuery,
  ): Promise<ListAgentVersionsResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      agentId: query.agentId,
    });
    if (current === null) return { type: "not_found" };

    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const cursorVersion =
      query.cursor === undefined
        ? undefined
        : decodeAgentVersionCursor(query.cursor, query.agentId);
    if (cursorVersion === null) {
      return {
        type: "invalid_request",
        message: "Invalid agent versions page cursor",
      };
    }
    const historical = await this.dependencies.store.listVersions({
      workspaceId: this.dependencies.workspaceId,
      agentId: query.agentId,
      beforeVersion: cursorVersion ?? current.version,
      limit: pageSize + 1,
    });
    const candidates =
      cursorVersion === undefined ? [current, ...historical] : historical;
    const hasMore = candidates.length > pageSize;
    const agents = hasMore ? candidates.slice(0, pageSize) : candidates;
    return {
      type: "page",
      page: {
        agents,
        nextCursor:
          hasMore && agents.length > 0
            ? encodeAgentVersionCursor(agents[agents.length - 1]!)
            : null,
      },
    };
  }
}
