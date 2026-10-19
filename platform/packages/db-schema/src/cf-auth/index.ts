// CF MAIN_DB schema (SQLite / D1).
//
// Holds: tenant, membership, user, session, account, verification,
// agents, agent_versions, sessions, session_resources,
// session_memory_stores, memory_stores, memories, memory_versions,
// memory_blob_poller_lease, vaults, credentials, model_cards,
// environments, files, workspace_backups, eval_runs, kv_entries, api_keys.
//
// The tables runtimes, runtime_tokens, connect_runtime_codes and
// usage_events stay in existing databases, but no code reads or writes them,
// so their definitions were removed (docs/plans/cleanup.md, 4.3). The
// migrations keep their DDL.
//
// Migrations are written by hand; this copy has no drizzle-kit configs.

export * from "./auth";
export * from "./agents";
export * from "./managed-agents";
export * from "./sessions";
export * from "./memory";
export * from "./vaults";
export * from "./model-cards";
export * from "./environments";
export * from "./files";
export * from "./evals";
export * from "./kv";
export * from "./session-runtime";
