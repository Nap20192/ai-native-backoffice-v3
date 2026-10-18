import type { AgentModelInput } from "./agents";
import type {
  AgentMcpServerInput,
  AgentSkillInput,
  AgentToolInput,
} from "../domain/agent-definition";
import type { SendableSessionEvent } from "./session-events";
import type {
  MonetaryAmount,
  Session,
  SessionAgent,
  SessionLimitsInput,
  SessionLimitsView,
  SessionStats,
  SessionStatus,
  SessionUsage,
} from "../domain/session";
import type { SessionResourceInput } from "../domain/session-resource";

export type {
  MonetaryAmount,
  SessionLimitsInput,
  SessionLimitsView,
  SessionStatus,
} from "../domain/session";
export type {
  RepositoryCheckoutInput,
  SessionResourceInput,
} from "../domain/session-resource";

export type SpendLimit = MonetaryAmount;

export type SessionAgentSelector =
  | { type: "latest"; agentId: string }
  | { type: "versioned"; agentId: string; version: number }
  | {
      type: "overrides";
      agentId: string;
      version?: number;
      mcpServers?: AgentMcpServerInput[];
      model?: string | AgentModelInput;
      skills?: AgentSkillInput[];
      system?: string | null;
      tools?: AgentToolInput[];
    };

export interface CreateSessionCommand {
  agent: SessionAgentSelector;
  environmentId: string;
  budget?: SpendLimit;
  initialEvents?: InitialSessionEvent[];
  limits?: SessionLimitsInput;
  metadata?: Record<string, string>;
  resources?: SessionResourceInput[];
  title?: string | null;
  vaultIds?: string[];
}

export type InitialSessionEvent = Extract<
  SendableSessionEvent,
  { type: "user.message" | "user.define_outcome" }
>;

export interface RetrieveSessionQuery {
  sessionId: string;
}

export interface UpdateSessionCommand {
  sessionId: string;
  agent?: {
    mcpServers?: AgentMcpServerInput[];
    tools?: AgentToolInput[];
  };
  budget?: SpendLimit | null;
  /** Each value must be above the work counted against it. A Session that
   * stopped on `budget_reached` goes on after the raise. */
  limits?: SessionLimitsInput;
  metadata?: Record<string, string | null> | null;
  title?: string | null;
  vaultIds?: string[];
}

export interface ListSessionsQuery {
  pageSize?: number;
  cursor?: string;
  agentId?: string;
  agentVersion?: number;
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  deploymentId?: string;
  includeArchived?: boolean;
  memoryStoreId?: string;
  order?: "asc" | "desc";
  statuses?: SessionStatus[];
}

export interface DeleteSessionCommand {
  sessionId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export interface ArchiveSessionCommand {
  sessionId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export interface UnarchiveSessionCommand {
  sessionId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export type SessionAgentView = SessionAgent;
export type SessionStatsView = SessionStats;
export type SessionUsageView = SessionUsage;
export type SessionView = Session;

export type CreateSessionResult =
  | { type: "created"; session: SessionView }
  | { type: "invalid_request"; message: string }
  | { type: "dependency_not_found"; message: string };

export type RetrieveSessionResult =
  | { type: "found"; session: SessionView; revision?: number; limits?: SessionLimitsView }
  | { type: "not_found" };

export type UpdateSessionResult =
  | { type: "updated"; session: SessionView; limits?: SessionLimitsView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export interface ListSessionsPage {
  sessions: SessionView[];
  nextCursor: string | null;
  previousCursor: string | null;
}

export type ListSessionsResult =
  | { type: "page"; page: ListSessionsPage }
  | { type: "invalid_request"; message: string };

export type DeleteSessionResult =
  | { type: "deleted"; sessionId: string }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

export type ArchiveSessionResult =
  | { type: "archived"; session: SessionView; revision?: number }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

/** Restore from the archive. The status stays as it was. */
export type UnarchiveSessionResult =
  | { type: "unarchived"; session: SessionView; revision?: number }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

export interface SessionsApplicationPort {
  createSession(command: CreateSessionCommand): Promise<CreateSessionResult>;
  retrieveSession(query: RetrieveSessionQuery): Promise<RetrieveSessionResult>;
  updateSession(command: UpdateSessionCommand): Promise<UpdateSessionResult>;
  listSessions(query: ListSessionsQuery): Promise<ListSessionsResult>;
  deleteSession(command: DeleteSessionCommand): Promise<DeleteSessionResult>;
  archiveSession(command: ArchiveSessionCommand): Promise<ArchiveSessionResult>;
  unarchiveSession(command: UnarchiveSessionCommand): Promise<UnarchiveSessionResult>;
}
