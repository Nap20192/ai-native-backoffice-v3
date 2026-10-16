// Store of harness cards (docs/plans/models-harness.md, 3.6 and 3.7).
// Every query is scoped to one workspace. SQL rules of analytics.md 4.7:
// `?` placeholders, Number() on BIGINT, a keyset cursor without OFFSET.
import { customAlphabet } from "nanoid";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { ensureHarnessCardSchema } from "./schema.js";
import {
  HarnessCardError,
  type HarnessCard,
  type HarnessCardCreateInput,
  type HarnessCardListOptions,
  type HarnessCardPage,
  type HarnessCardProtocol,
} from "./types.js";
import { validateHarnessCardInput } from "./validation.js";

export interface HarnessCardStore {
  list(workspaceId: string, options?: HarnessCardListOptions): Promise<HarnessCardPage>;
  /** Cards without `archived_at`, newest first. The harness catalog reads them. */
  listActive(workspaceId: string): Promise<HarnessCard[]>;
  /** A card by id, archived ones too. */
  get(workspaceId: string, id: string): Promise<HarnessCard | null>;
  /** A card by harness_id, archived ones too. A turn of an old agent needs it. */
  findByHarnessId(workspaceId: string, harnessId: string): Promise<HarnessCard | null>;
  create(workspaceId: string, body: unknown, createdBy?: string | null): Promise<HarnessCard>;
  update(workspaceId: string, id: string, body: unknown): Promise<HarnessCard>;
  archive(workspaceId: string, id: string): Promise<HarnessCard>;
}

export interface HarnessCardStoreOptions {
  /** Epoch milliseconds. */
  now?: () => number;
  ids?: () => string;
}

export const HARNESS_CARD_LIST_DEFAULT_LIMIT = 50;
export const HARNESS_CARD_LIST_MAX_LIMIT = 100;

const idSuffix = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

interface HarnessCardRow {
  id: string;
  harness_id: string;
  name: string;
  command: string;
  args_json: string;
  cwd: string | null;
  install_json: string;
  protocols_json: string;
  allowed_env_json: string;
  created_at: number | string;
  updated_at: number | string;
  archived_at: number | string | null;
}

const COLUMNS = "id, harness_id, name, command, args_json, cwd, install_json, protocols_json, allowed_env_json, created_at, updated_at, archived_at";

export function createHarnessCardStore(
  sql: SqlClient,
  options: HarnessCardStoreOptions = {},
): HarnessCardStore {
  const now = options.now ?? Date.now;
  const ids = options.ids ?? (() => `hcard_${idSuffix()}`);

  async function rowById(workspaceId: string, id: string): Promise<HarnessCardRow | null> {
    await ensureHarnessCardSchema(sql);
    return sql
      .prepare(`SELECT ${COLUMNS} FROM harness_cards WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<HarnessCardRow>();
  }

  async function existing(workspaceId: string, id: string): Promise<HarnessCardRow> {
    const row = await rowById(workspaceId, id);
    if (row === null) throw new HarnessCardError(404, "Harness не найден");
    return row;
  }

  return {
    async list(workspaceId, listOptions = {}) {
      const limit = listOptions.limit ?? HARNESS_CARD_LIST_DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > HARNESS_CARD_LIST_MAX_LIMIT) {
        throw new HarnessCardError(400, "limit: целое число от 1 до 100", "limit");
      }
      const cursor = listOptions.cursor === undefined ? null : decodeCursor(listOptions.cursor);
      await ensureHarnessCardSchema(sql);
      const where = ["workspace_id = ?"];
      const params: unknown[] = [workspaceId];
      if (listOptions.include_archived !== true) where.push("archived_at IS NULL");
      const q = listOptions.q?.trim().toLowerCase() ?? "";
      if (q.length > 0) {
        const pattern = `%${escapeLike(q)}%`;
        where.push("(LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(harness_id) LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }
      if (cursor !== null) {
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const rows = await sql
        .prepare(
          `SELECT ${COLUMNS} FROM harness_cards WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .bind(...params, limit + 1)
        .all<HarnessCardRow>();
      const found = rows.results ?? [];
      const page = found.slice(0, limit);
      const last = page.at(-1);
      return {
        data: page.map(toCard),
        next_cursor: found.length > limit && last !== undefined
          ? encodeCursor(Number(last.created_at), last.id)
          : null,
      };
    },

    async listActive(workspaceId) {
      await ensureHarnessCardSchema(sql);
      const rows = await sql
        .prepare(
          `SELECT ${COLUMNS} FROM harness_cards WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id DESC`,
        )
        .bind(workspaceId)
        .all<HarnessCardRow>();
      return (rows.results ?? []).map(toCard);
    },

    async get(workspaceId, id) {
      const row = await rowById(workspaceId, id);
      return row === null ? null : toCard(row);
    },

    async findByHarnessId(workspaceId, harnessId) {
      await ensureHarnessCardSchema(sql);
      const row = await sql
        .prepare(`SELECT ${COLUMNS} FROM harness_cards WHERE workspace_id = ? AND harness_id = ?`)
        .bind(workspaceId, harnessId)
        .first<HarnessCardRow>();
      return row === null ? null : toCard(row);
    },

    async create(workspaceId, body, createdBy = null) {
      const input = validateHarnessCardInput(body, { mode: "create" });
      await ensureHarnessCardSchema(sql);
      const taken = await sql
        .prepare("SELECT id FROM harness_cards WHERE workspace_id = ? AND harness_id = ?")
        .bind(workspaceId, input.harness_id)
        .first<{ id: string }>();
      if (taken !== null) throw duplicate(input.harness_id);
      const time = now();
      const id = ids();
      try {
        await sql
          .prepare(
            `INSERT INTO harness_cards (workspace_id, id, harness_id, name, command, args_json, cwd, install_json, protocols_json, allowed_env_json, status, created_by, created_at, updated_at, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .bind(
            workspaceId,
            id,
            input.harness_id,
            input.name,
            input.command,
            JSON.stringify(input.args),
            input.cwd,
            JSON.stringify(input.install),
            JSON.stringify(input.protocols),
            JSON.stringify(input.allowed_env),
            "unverified",
            createdBy ?? null,
            time,
            time,
          )
          .run();
      } catch (error) {
        if (isHarnessIdConflict(error)) throw duplicate(input.harness_id);
        throw error;
      }
      return toCard({
        id,
        harness_id: input.harness_id,
        name: input.name,
        command: input.command,
        args_json: JSON.stringify(input.args),
        cwd: input.cwd,
        install_json: JSON.stringify(input.install),
        protocols_json: JSON.stringify(input.protocols),
        allowed_env_json: JSON.stringify(input.allowed_env),
        created_at: time,
        updated_at: time,
        archived_at: null,
      });
    },

    async update(workspaceId, id, body) {
      const patch = validateHarnessCardInput(body, { mode: "update" });
      const row = await existing(workspaceId, id);
      if (row.archived_at !== null) {
        throw new HarnessCardError(409, `Harness «${row.name}» удалён, изменить его нельзя`);
      }
      const current = toCard(row);
      const next: HarnessCardCreateInput = {
        harness_id: current.harness_id,
        name: patch.name ?? current.name,
        command: patch.command ?? current.command,
        args: patch.args ?? current.args,
        cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
        install: patch.install ?? current.install,
        protocols: patch.protocols ?? current.protocols,
        allowed_env: patch.allowed_env ?? current.allowed_env,
      };
      const time = now();
      await sql
        .prepare(
          `UPDATE harness_cards SET name = ?, command = ?, args_json = ?, cwd = ?, install_json = ?, protocols_json = ?, allowed_env_json = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .bind(
          next.name,
          next.command,
          JSON.stringify(next.args),
          next.cwd,
          JSON.stringify(next.install),
          JSON.stringify(next.protocols),
          JSON.stringify(next.allowed_env),
          time,
          workspaceId,
          id,
        )
        .run();
      return { ...current, ...next, updated_at: new Date(time).toISOString() };
    },

    async archive(workspaceId, id) {
      const row = await existing(workspaceId, id);
      if (row.archived_at !== null) return toCard(row);
      const time = now();
      await sql
        .prepare("UPDATE harness_cards SET archived_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND archived_at IS NULL")
        .bind(time, time, workspaceId, id)
        .run();
      const iso = new Date(time).toISOString();
      return { ...toCard(row), archived_at: iso, updated_at: iso };
    },
  };
}

function duplicate(harnessId: string): HarnessCardError {
  return new HarnessCardError(409, `Harness с ID «${harnessId}» уже есть`, "harness_id");
}

/** SQLite: "UNIQUE constraint failed: harness_cards.workspace_id, harness_cards.harness_id".
 * Postgres: code 23505 on harness_cards_ws_harness_uq. */
function isHarnessIdConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message, constraint_name: constraint } = error as {
    code?: unknown;
    message?: unknown;
    constraint_name?: unknown;
  };
  const text = `${typeof message === "string" ? message : ""} ${typeof constraint === "string" ? constraint : ""}`;
  const unique = code === "23505" || /unique constraint/i.test(text) || /duplicate key/i.test(text);
  return unique && /harness_id|harness_cards_ws_harness_uq/i.test(text);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}

function decodeCursor(value: string): { createdAt: number; id: string } {
  const bad = new HarnessCardError(400, "Курсор не распознан", "cursor");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw bad;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw bad;
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== 2
    || !Number.isSafeInteger(parsed[0])
    || typeof parsed[1] !== "string"
  ) {
    throw bad;
  }
  return { createdAt: parsed[0] as number, id: parsed[1] as string };
}

function toCard(row: HarnessCardRow): HarnessCard {
  return {
    id: row.id,
    harness_id: row.harness_id,
    name: row.name,
    command: row.command,
    args: parseJson<string[]>(row.args_json, []),
    cwd: row.cwd,
    install: parseJson<{ npm: string[]; pip: string[] }>(row.install_json, { npm: [], pip: [] }),
    protocols: parseJson<HarnessCardProtocol[]>(row.protocols_json, []),
    allowed_env: parseJson<string[]>(row.allowed_env_json, []),
    status: "unverified",
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    archived_at: row.archived_at === null ? null : iso(row.archived_at),
  };
}

function iso(value: number | string): string {
  return new Date(Number(value)).toISOString();
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
