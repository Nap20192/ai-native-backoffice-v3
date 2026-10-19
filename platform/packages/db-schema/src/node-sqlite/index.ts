// Node self-host SQLite schema: the cf-auth tables, all SQLite-typed
// (no PG-typed columns).
//
// Self-host SQLite runs on better-sqlite3 against the same SQLite engine
// D1 uses, so the cf-auth table definitions apply unchanged. The
// integration tables (cleanup.md 5.1) stay in the databases and in
// apps/main-node/migrations-sqlite/ without a TS definition.
//
// Migrations are written by hand; this copy has no drizzle-kit configs.

export * from "../cf-auth";
