export type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxCheckpointKind,
  SandboxCheckpointScope,
  SandboxPort,
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxMemoryWorkspacePort,
  SandboxProviderPort,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
  SandboxWorkspaceBackupPort,
  SandboxManagedWorkspaceLifecyclePort,
  SandboxSessionOutputMountPort,
  SandboxEnvironmentSnapshotPort,
} from "./ports";
export {
  supportsDuplexProcess,
  supportsEnvironmentSnapshot,
  supportsManagedWorkspaceLifecycle,
  supportsSandboxRuntime,
  supportsSessionOutputMount,
  supportsWorkspaceBackup,
  readS3MemoryBucket,
} from "./ports";
export {
  runWithSandboxLease,
  SandboxLeaseLostError,
  type RunWithSandboxLeaseOptions,
  type SandboxLeaseScheduler,
} from "./lease";

export {
  withSandboxExecutionGuard,
  SandboxExecutionFencedError,
  type SandboxExecutionGuard,
} from "./execution-guard";

export {
  DefaultSandboxOrchestrator,
  type SandboxOrchestrator,
  type SandboxCapabilities,
  type ProvisionInput,
  type OrchestratorMemoryMount,
  type OrchestratorBackupHandle,
  type WorkspaceBackupService,
  type DefaultSandboxOrchestratorDeps,
} from "./orchestrator";

export { createNoEnvironmentSandbox, isNoEnvironmentSandbox } from "./no-environment";

export {
  buildEnvironmentSetupScript,
  environmentPackageLists,
  PACKAGE_MANAGER_HOSTS,
  SandboxEnvironmentError,
  type SandboxEgress,
  type SandboxEnvironmentErrorCode,
  type SandboxEnvironmentImage,
  type SandboxEnvironmentNetworking,
  type SandboxEnvironmentPackages,
  type SandboxEnvironmentSnapshot,
  type SandboxEnvironmentSpec,
  type SandboxPackageManager,
  type SandboxShell,
  type SandboxVmResources,
} from "./environment-setup";
