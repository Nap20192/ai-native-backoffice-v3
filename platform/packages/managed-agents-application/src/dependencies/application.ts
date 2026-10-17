// Dependency check of archive and delete (docs/plans/crud.md, 1.2, 1.3).
// Rules:
// - a live session is a session out of the archive with status idle,
//   running or rescheduling;
// - a live deployment is a deployment out of the archive;
// - each list holds at most 50 rows sorted by kind and then by id, and
//   `truncated` tells that more rows exist.
import type { AgentRecord, AgentStore } from "@open-managed-agents/agent-store";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import type { Deployment } from "@open-managed-agents/domain/deployments";
import type { Session } from "@open-managed-agents/domain/sessions";
import type {
  DeploymentStore,
  ListDeploymentRecords,
} from "@open-managed-agents/deployment-store";
import type { EnvironmentStore } from "@open-managed-agents/environment-store";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import type { FileStore } from "@open-managed-agents/file-store";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import type {
  ListSessionRecords,
  SessionStore,
} from "@open-managed-agents/session-store";
import type { SkillStore } from "@open-managed-agents/skill-store";
import type { VaultStore } from "@open-managed-agents/vault-store";
import type {
  CheckDependenciesQuery,
  CheckDependenciesResult,
  DependenciesApplicationPort,
  DependencyConflict,
  DependencyEntry,
  DependencyReport,
} from "../ports/dependencies";

/** Rows per list in a report. */
export const DEPENDENCY_LIST_LIMIT = 50;
/** Rows read per store query: one more than a full list shows the cut. */
const SCAN_LIMIT = DEPENDENCY_LIST_LIMIT + 1;
/** Rows read when the store cannot filter by the live state itself. */
const WIDE_SCAN_LIMIT = 500;

const LIVE_SESSION_STATUSES = ["idle", "running", "rescheduling"] as const;

export interface DependenciesApplicationServiceDependencies {
  workspaceId: string;
  agents: AgentStore;
  sessions: SessionStore;
  deployments: DeploymentStore;
  environments: EnvironmentStore;
  environmentWork: EnvironmentWorkStore;
  files: FileStore;
  skills: SkillStore;
  memoryStores: MemoryStoreStore;
  memories: MemoryDocumentStore;
  vaults: VaultStore;
  credentials: CredentialStore;
}

/** Rows of one list plus the sign that a store query hit its limit. */
interface Rows {
  entries: DependencyEntry[];
  cut: boolean;
}

function rows(entries: DependencyEntry[], cut = false): Rows {
  return { entries, cut };
}

function report(blocking: Rows[], affected: Rows[]): DependencyReport {
  const finish = (parts: Rows[]) => {
    const seen = new Set<string>();
    const entries = parts
      .flatMap((part) => part.entries)
      .filter((entry) => {
        const key = `${entry.kind}\u0000${entry.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    return {
      entries: entries.slice(0, DEPENDENCY_LIST_LIMIT),
      cut: entries.length > DEPENDENCY_LIST_LIMIT || parts.some((part) => part.cut),
    };
  };
  const blockingRows = finish(blocking);
  const affectedRows = finish(affected);
  return {
    blocking: blockingRows.entries,
    affected: affectedRows.entries,
    truncated: blockingRows.cut || affectedRows.cut,
  };
}

const EMPTY_REPORT: DependencyReport = { blocking: [], affected: [], truncated: false };

function sessionStatus(session: Session): string {
  return session.archivedAt === null ? session.status : "archived";
}

function isLiveSession(session: Session): boolean {
  return session.archivedAt === null
    && (LIVE_SESSION_STATUSES as readonly string[]).includes(session.status);
}

function sessionEntry(session: Session, note: string): DependencyEntry {
  return {
    kind: "session",
    id: session.id,
    name: session.title,
    status: sessionStatus(session),
    note,
  };
}

function deploymentStatus(deployment: Deployment): string {
  return deployment.archivedAt === null ? deployment.status : "archived";
}

function deploymentEntry(deployment: Deployment, note: string): DependencyEntry {
  return {
    kind: "deployment",
    id: deployment.id,
    name: deployment.name,
    status: deploymentStatus(deployment),
    note,
  };
}

function agentEntry(agent: AgentRecord, note: string): DependencyEntry {
  return {
    kind: "agent",
    id: agent.id,
    name: agent.name,
    status: agent.archivedAt === null ? "active" : "archived",
    note,
  };
}

type SessionFilter = Pick<
  ListSessionRecords,
  "agentId" | "deploymentId" | "environmentId" | "fileId" | "memoryStoreId" | "vaultId"
>;
type DeploymentFilter = Pick<
  ListDeploymentRecords,
  "agentId" | "environmentId" | "fileId" | "memoryStoreId" | "vaultId"
>;

/** Archive or delete answer when a dependency blocks it, else null. */
export async function dependencyConflictOf(
  check: DependenciesApplicationPort | undefined,
  query: CheckDependenciesQuery,
): Promise<DependencyConflict | null> {
  if (check === undefined) return null;
  const result = await check.checkDependencies(query);
  if (result.type !== "report" || result.report.blocking.length === 0) return null;
  const noun = query.operation === "archive" ? "archive" : "delete";
  return {
    type: "dependency_conflict",
    message: `Cannot ${noun} ${query.kind} ${query.id}: remove the blocking dependencies first`,
    dependencies: result.report,
  };
}

export class DependenciesApplicationService implements DependenciesApplicationPort {
  constructor(
    private readonly dependencies: DependenciesApplicationServiceDependencies,
  ) {}

  async checkDependencies(
    query: CheckDependenciesQuery,
  ): Promise<CheckDependenciesResult> {
    switch (query.kind) {
      case "agent":
        return this.agent(query);
      case "environment":
        return this.environment(query);
      case "session":
        return this.session(query);
      case "deployment":
        return this.deployment(query);
      case "file":
        return this.file(query);
      case "skill":
        return this.skill(query);
      case "skill_version":
        return this.skillVersion(query);
      case "memory_store":
        return this.memoryStore(query);
      case "memory":
      case "session_resource":
        return { type: "report", report: EMPTY_REPORT };
      case "model":
        return this.model(query);
      case "vault":
        return this.vault(query);
    }
  }

  private get workspaceId(): string {
    return this.dependencies.workspaceId;
  }

  private async liveSessions(filter: SessionFilter, note: string): Promise<Rows> {
    const records = await this.dependencies.sessions.listCurrent({
      workspaceId: this.workspaceId,
      limit: SCAN_LIMIT,
      includeArchived: false,
      order: "asc",
      statuses: [...LIVE_SESSION_STATUSES],
      ...filter,
    });
    return rows(
      records.map((record) => sessionEntry(record.session, note)),
      records.length >= SCAN_LIMIT,
    );
  }

  /** Sessions that are not live: archived or terminated. */
  private async restingSessions(filter: SessionFilter, note: string): Promise<Rows> {
    const records = await this.dependencies.sessions.listCurrent({
      workspaceId: this.workspaceId,
      limit: WIDE_SCAN_LIMIT,
      includeArchived: true,
      order: "asc",
      ...filter,
    });
    return rows(
      records
        .filter((record) => !isLiveSession(record.session))
        .map((record) => sessionEntry(record.session, note)),
      records.length >= WIDE_SCAN_LIMIT,
    );
  }

  private async deploymentsWhere(
    filter: DeploymentFilter,
    state: "active" | "paused" | "live" | "archived",
    note: string,
  ): Promise<Rows> {
    const archived = state === "archived";
    const records = await this.dependencies.deployments.list({
      workspaceId: this.workspaceId,
      limit: archived ? WIDE_SCAN_LIMIT : SCAN_LIMIT,
      includeArchived: archived,
      ...(state === "active" || state === "paused" ? { status: state } : {}),
      ...filter,
    });
    const selected = archived
      ? records.filter((record) => record.deployment.archivedAt !== null)
      : records;
    return rows(
      selected.map((record) => deploymentEntry(record.deployment, note)),
      records.length >= (archived ? WIDE_SCAN_LIMIT : SCAN_LIMIT),
    );
  }

  private async agentsWhere(
    filter: { skillId?: string; skillVersion?: string; model?: string },
    state: "live" | "archived" | "any_version",
    note: (agent: AgentRecord) => string,
  ): Promise<Rows> {
    const records = await this.dependencies.agents.listReferencing({
      workspaceId: this.workspaceId,
      limit: WIDE_SCAN_LIMIT,
      includeArchived: state !== "live",
      allVersions: state === "any_version",
      ...filter,
    });
    const selected = state === "archived"
      ? records.filter((agent) => agent.archivedAt !== null)
      : records;
    const seen = new Set<string>();
    const entries: DependencyEntry[] = [];
    for (const agent of selected) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      entries.push(agentEntry(agent, note(agent)));
    }
    return rows(entries, records.length >= WIDE_SCAN_LIMIT);
  }

  private async agent(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.agents.findCurrent({
      workspaceId: this.workspaceId,
      agentId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const filter = { agentId: query.id };
    if (query.operation === "archive") {
      return {
        type: "report",
        report: report(
          [await this.deploymentsWhere(filter, "active", "активный деплоймент, запуски упадут")],
          [
            await this.deploymentsWhere(filter, "paused", "деплоймент не снимется с паузы"),
            await this.liveSessions(filter, "сессия доработает на снимке агента"),
          ],
        ),
      };
    }
    return {
      type: "report",
      report: report(
        [
          await this.deploymentsWhere(filter, "live", "деплоймент запускает этого агента"),
          await this.liveSessions(filter, "сессия работает с этим агентом"),
        ],
        [
          await this.deploymentsWhere(filter, "archived", "деплоймент в архиве"),
          await this.restingSessions(filter, "сессия сохранит снимок агента"),
        ],
      ),
    };
  }

  private async environment(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.environments.find({
      workspaceId: this.workspaceId,
      environmentId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const filter = { environmentId: query.id };
    if (query.operation === "archive") {
      return {
        type: "report",
        report: report(
          [await this.deploymentsWhere(filter, "active", "активный деплоймент, запуски упадут")],
          [
            await this.deploymentsWhere(filter, "paused", "деплоймент не снимется с паузы"),
            await this.liveSessions(filter, "сессия продолжит работу"),
          ],
        ),
      };
    }
    return {
      type: "report",
      report: report(
        [
          await this.deploymentsWhere(filter, "live", "деплоймент запускает сессии в этом окружении"),
          await this.liveSessions(filter, "сессия работает в этом окружении"),
          await this.openEnvironmentWork(query.id),
        ],
        [
          await this.deploymentsWhere(filter, "archived", "деплоймент в архиве"),
          await this.restingSessions(filter, "сессия останется без окружения"),
        ],
      ),
    };
  }

  private async openEnvironmentWork(environmentId: string): Promise<Rows> {
    const records = await this.dependencies.environmentWork.list({
      workspaceId: this.workspaceId,
      environmentId,
      limit: WIDE_SCAN_LIMIT,
    });
    return rows(
      records
        .filter((record) => record.work.state !== "stopped")
        .map((record) => ({
          kind: "environment_work" as const,
          id: record.work.id,
          name: null,
          status: record.work.state,
          note: "задание окружения не закрыто",
        })),
      records.length >= WIDE_SCAN_LIMIT,
    );
  }

  private async session(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.sessions.findCurrent({
      workspaceId: this.workspaceId,
      sessionId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const session = found.session;
    const affected: Rows[] = [];
    if (session.status === "running" || session.status === "rescheduling") {
      affected.push(rows([sessionEntry(session, "ход остановится")]));
    }
    if (session.deploymentId != null) {
      const deployment = await this.dependencies.deployments.find({
        workspaceId: this.workspaceId,
        deploymentId: session.deploymentId,
      });
      if (deployment !== null) {
        affected.push(rows([deploymentEntry(
          deployment.deployment,
          "прогон деплоймента ссылается на эту сессию",
        )]));
      }
    }
    const outputs = await this.dependencies.files.list({
      workspaceId: this.workspaceId,
      limit: SCAN_LIMIT,
      scopeId: session.id,
    });
    affected.push(rows(
      outputs.map((file) => ({
        kind: "file" as const,
        id: file.id,
        name: file.filename,
        status: null,
        note: query.operation === "delete"
          ? "выходной файл сессии"
          : "выходной файл останется",
      })),
      outputs.length >= SCAN_LIMIT,
    ));
    return { type: "report", report: report([], affected) };
  }

  private async deployment(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.deployments.find({
      workspaceId: this.workspaceId,
      deploymentId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const running = await this.dependencies.sessions.listCurrent({
      workspaceId: this.workspaceId,
      limit: SCAN_LIMIT,
      includeArchived: false,
      order: "asc",
      deploymentId: query.id,
      statuses: ["running", "rescheduling"],
    });
    return {
      type: "report",
      report: report([], [rows(
        running.map((record) => sessionEntry(record.session, "прогон в работе")),
        running.length >= SCAN_LIMIT,
      )]),
    };
  }

  private async file(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.files.find({
      workspaceId: this.workspaceId,
      fileId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const filter = { fileId: query.id };
    return {
      type: "report",
      report: report(
        [
          await this.deploymentsWhere(filter, "live", "деплоймент подключает этот файл"),
          await this.liveSessions(filter, "сессия подключает этот файл"),
        ],
        [await this.restingSessions(filter, "файл пропадёт из истории сессии")],
      ),
    };
  }

  private async skill(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.skills.findSkill({
      workspaceId: this.workspaceId,
      skillId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const filter = { skillId: query.id };
    return {
      type: "report",
      report: report(
        [await this.agentsWhere(filter, "live", () => "агент использует этот навык")],
        [await this.agentsWhere(filter, "archived", () => "агент в архиве")],
      ),
    };
  }

  private async skillVersion(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    if (query.version === undefined || query.version.length === 0) {
      return { type: "invalid_request", message: "version is required for kind skill_version" };
    }
    const skill = await this.dependencies.skills.findSkill({
      workspaceId: this.workspaceId,
      skillId: query.id,
    });
    if (skill === null) return { type: "not_found" };
    const target = await this.dependencies.skills.findVersion({
      workspaceId: this.workspaceId,
      skillId: query.id,
      version: query.version,
    });
    if (target === null) return { type: "not_found" };
    const blocking: Rows[] = [
      await this.agentsWhere(
        { skillId: query.id, skillVersion: query.version },
        "live",
        () => "агент закреплён на этой версии",
      ),
    ];
    const other = await this.dependencies.skills.findLatestVersionExcluding({
      workspaceId: this.workspaceId,
      skillId: query.id,
      excludedVersion: query.version,
    });
    if (other === null) {
      blocking.push(rows([{
        kind: "skill_version",
        id: query.version,
        name: target.version.name,
        status: null,
        note: "Это последняя версия. Удалите навык целиком",
      }]));
    }
    const affected: Rows[] = [];
    if (other !== null && skill.skill.latestVersion === query.version) {
      affected.push(await this.agentsWhere(
        { skillId: query.id, skillVersion: "latest" },
        "live",
        () => "агент перейдёт на предыдущую версию",
      ));
    }
    return { type: "report", report: report(blocking, affected) };
  }

  private async memoryStore(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.memoryStores.find({
      workspaceId: this.workspaceId,
      memoryStoreId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const filter = { memoryStoreId: query.id };
    if (query.operation === "archive") {
      return {
        type: "report",
        report: report(
          [await this.deploymentsWhere(filter, "active", "активный деплоймент, запуски упадут")],
          [
            await this.deploymentsWhere(filter, "paused", "деплоймент не снимется с паузы"),
            await this.liveSessions(filter, "сессия подключает это хранилище"),
          ],
        ),
      };
    }
    const memories = await this.dependencies.memories.listCurrent({
      workspaceId: this.workspaceId,
      memoryStoreId: query.id,
      limit: SCAN_LIMIT,
      depth: 1_000,
      pathPrefix: "/",
    });
    const memoryRows = memories.items.flatMap((item) =>
      item.kind === "memory"
        ? [{
            kind: "memory" as const,
            id: item.record.memory.id,
            name: item.record.memory.path,
            status: null,
            note: "запись и её версии удалятся вместе с хранилищем",
          }]
        : []);
    return {
      type: "report",
      report: report(
        [
          await this.deploymentsWhere(filter, "live", "деплоймент подключает это хранилище"),
          await this.liveSessions(filter, "сессия подключает это хранилище"),
        ],
        [rows(memoryRows, memories.hasMore)],
      ),
    };
  }

  private async model(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const filter = { model: query.id };
    return {
      type: "report",
      report: report(
        [await this.agentsWhere(filter, "live", () => "агент работает на этой модели")],
        [await this.agentsWhere(filter, "archived", () => "агент в архиве")],
      ),
    };
  }

  private async vault(query: CheckDependenciesQuery): Promise<CheckDependenciesResult> {
    const found = await this.dependencies.vaults.find({
      workspaceId: this.workspaceId,
      vaultId: query.id,
    });
    if (found === null) return { type: "not_found" };
    const filter = { vaultId: query.id };
    if (query.operation === "archive") {
      return {
        type: "report",
        report: report(
          [await this.deploymentsWhere(filter, "active", "активный деплоймент, запуски упадут")],
          [await this.liveSessions(filter, "сессия подключает это хранилище секретов")],
        ),
      };
    }
    const credentials = await this.dependencies.credentials.list({
      workspaceId: this.workspaceId,
      vaultId: query.id,
      limit: SCAN_LIMIT,
      includeArchived: true,
    });
    return {
      type: "report",
      report: report(
        [
          await this.deploymentsWhere(filter, "live", "деплоймент подключает это хранилище секретов"),
          await this.liveSessions(filter, "сессия подключает это хранилище секретов"),
        ],
        [rows(
          credentials.map((record) => ({
            kind: "credential" as const,
            id: record.credential.id,
            name: record.credential.displayName ?? null,
            status: record.credential.archivedAt === null ? "active" : "archived",
            note: "учётные данные удалятся вместе с хранилищем",
          })),
          credentials.length >= SCAN_LIMIT,
        )],
      ),
    };
  }
}
