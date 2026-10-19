// @open-managed-agents/db-schema
//
// All table definitions live here. `./cf-auth` holds the SQLite tables
// (the name is left over from the Cloudflare D1 binding); `./node-pg`
// holds the same tables with PG-typed columns.
//
// Subpackages:
//   ./cf-auth      → SQLite (control plane + business)
//   ./node-sqlite  → SQLite barrel over ./cf-auth
//   ./node-pg      → single PG database
//
// Removed schemas, whose tables stay in existing databases and in the
// migrations (docs/plans/cleanup.md):
//   - the D1 sharding schema (./cf-router: tenant_shard, shard_pool,
//     memory_store_tenant), 4.3;
//   - the Linear, GitHub, Slack and Feishu integration tables
//     (./cf-integrations and node-pg/cf-integrations-*), 5.1.
//
// Adding a table:
//   1. Add it to ./cf-auth and to the matching node-pg/cf-auth-* file
//   2. Define using sqliteTable / pgTable with the conventions of the
//      neighbouring table files
//   3. Write the migration SQL by hand in apps/main-node/migrations/
//      (Postgres) and apps/main-node/migrations-sqlite/ (SQLite), with a
//      meta/_journal.json entry in each. This copy has no drizzle-kit
//      configs (platform/AGENTS.md, "База данных").
//   4. Commit the schema source and the SQL together

export * as cfAuth from "./cf-auth";
export * as nodePg from "./node-pg";

// Dependency-inversion port for adapters: Drizzle DB type union + helpers
// that paper over SQLite vs PG terminator differences (`.get()/.all()` vs
// awaitable chains). Adapters import `OmaDb` and `getOne`/`getAll`/`runOnce`
// from here and depend on no concrete driver.
export * from "./_shared/oma-db";
