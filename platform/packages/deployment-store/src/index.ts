import type {
  Deployment,
  DeploymentResourceSecret,
} from "@open-managed-agents/domain/deployments";

export interface DeploymentRecord {
  deployment: Deployment;
  resourceSecrets: DeploymentResourceSecret[];
}

export interface StoredDeployment extends DeploymentRecord {
  revision: number;
}

export interface DeploymentLocation {
  workspaceId: string;
  deploymentId: string;
}

export interface InsertDeploymentRecord {
  workspaceId: string;
  record: DeploymentRecord;
}

export interface ReplaceDeploymentRecord extends DeploymentLocation {
  expectedRevision: number;
  next: DeploymentRecord;
}

export type ReplaceDeploymentRecordResult =
  | { type: "replaced"; record: StoredDeployment }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeploymentListPosition {
  createdAt: string;
  deploymentId: string;
}

export interface ListDeploymentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  agentId?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  status?: "active" | "paused";
  position?: DeploymentListPosition;
  /** Filters for dependency checks (docs/plans/crud.md, 1.3). */
  environmentId?: string;
  fileId?: string;
  memoryStoreId?: string;
  vaultId?: string;
}

/** True when the deployment matches the reference filters of a list. */
export function deploymentReferences(
  deployment: Deployment,
  filter: Pick<ListDeploymentRecords, "environmentId" | "fileId" | "memoryStoreId" | "vaultId">,
): boolean {
  return (filter.environmentId === undefined
      || deployment.environmentId === filter.environmentId)
    && (filter.fileId === undefined
      || deployment.resources.some((resource) =>
        resource.kind === "file" && resource.fileId === filter.fileId))
    && (filter.memoryStoreId === undefined
      || deployment.resources.some((resource) =>
        resource.kind === "memory_store"
        && resource.memoryStoreId === filter.memoryStoreId))
    && (filter.vaultId === undefined
      || deployment.vaultIds.includes(filter.vaultId));
}

export interface DeploymentStore {
  insert(input: InsertDeploymentRecord): Promise<StoredDeployment>;
  find(input: DeploymentLocation): Promise<StoredDeployment | null>;
  replace(input: ReplaceDeploymentRecord): Promise<ReplaceDeploymentRecordResult>;
  list(input: ListDeploymentRecords): Promise<StoredDeployment[]>;
}
