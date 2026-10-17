// Dependencies of archive and delete (docs/plans/crud.md, 1.2 and 1.3).
// A blocking dependency stops the operation, an affected one only tells
// what changes. The same report goes to GET /v1/oma/dependencies and to the
// 409 dependency_conflict_error of archive and delete.

/** Objects whose archive or delete is checked. */
export type DependencyTargetKind =
  | "agent"
  | "environment"
  | "session"
  | "deployment"
  | "file"
  | "skill"
  | "skill_version"
  | "memory_store"
  | "memory"
  | "session_resource"
  | "model"
  | "vault";

export type DependencyOperation = "archive" | "delete";

/** Kinds of rows a report lists. */
export type DependencyEntryKind =
  | "agent"
  | "session"
  | "deployment"
  | "environment_work"
  | "file"
  | "skill_version"
  | "memory"
  | "credential"
  | "model_card";

export interface DependencyEntry {
  kind: DependencyEntryKind;
  id: string;
  name: string | null;
  status: string | null;
  note: string | null;
}

/** Each list holds at most 50 rows, sorted by kind and then by id. */
export interface DependencyReport {
  blocking: DependencyEntry[];
  affected: DependencyEntry[];
  truncated: boolean;
}

export interface CheckDependenciesQuery {
  kind: DependencyTargetKind;
  id: string;
  operation: DependencyOperation;
  /** Version of a skill for kind skill_version; `id` is the skill then. */
  version?: string;
}

export type CheckDependenciesResult =
  | { type: "report"; report: DependencyReport }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string };

/** The result an archive or delete returns when a dependency blocks it. */
export interface DependencyConflict {
  type: "dependency_conflict";
  message: string;
  dependencies: DependencyReport;
}

export interface DependenciesApplicationPort {
  checkDependencies(query: CheckDependenciesQuery): Promise<CheckDependenciesResult>;
}
