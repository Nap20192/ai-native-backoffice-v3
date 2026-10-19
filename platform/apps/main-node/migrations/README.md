# Migration history after the OpenAI Agents merge

The merge joins two histories that started from the same schema:

- Released `main` added `model_cards.pi_config` in PostgreSQL
  `0022_chief_phantom_reporter.sql`, SQLite `0022_loud_the_captain.sql`, and
  Cloudflare `0019_shallow_spiral.sql`.
- The local branch added durable executions, environment service keys, and
  environment work generations with later timestamps.

All historical SQL filenames, contents, and journal timestamps are preserved.
Journal indices are consecutive; later snapshots follow the released snapshot
and include both sets of columns. Some preserved SQL filenames consequently
share a numeric prefix. Do not rename them to match the new journal indices.

Node runs `reconcilePiModelConfigMigration()` immediately before its normal
migrator. Empty databases and databases upgraded from released `main` use the
normal migration history. For the known local SQLite/PostgreSQL history, the
repair checks the exact applied migration hash and missing column, then adds
`pi_config` and records its original migration atomically. This covers databases
whose later Drizzle timestamp would otherwise skip the earlier migration.
Stored model cards survive, and repeated startup is safe. Unknown histories
are not rewritten, and migration errors fail startup.

MySQL support was removed (docs/plans/cleanup.md, 5.3); its snapshot
upgrades left with it. Cloudflare keeps its original SQL filenames so D1 can
apply the previously missing migration by name.

Regression coverage lives in `test/migration-merge.test.ts`. It runs real
SQLite migrations for an empty database and both prior histories. This copy has
no drizzle-kit configs, so new migrations are written by hand in both folders
(platform/AGENTS.md) and no tool checks the snapshot chains.
