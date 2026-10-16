// Checks of a harness card body (docs/plans/models-harness.md, 3.5).
// The first problem wins and names its field. Messages never repeat a value
// from the body: a stray `env` with a key must not come back in the answer.
import { OMA_OVERLAY_AGENTS } from "@open-managed-agents/acp-runtime/known-agents";
import {
  CARD_PROTOCOLS,
  MODEL_KEY_ENV_NAMES,
  SERVER_INFERENCE_ENV_NAMES,
  isSecretLikeEnvName,
} from "../acp-env-policy.js";
import {
  HarnessCardError,
  type HarnessCardCreateInput,
  type HarnessCardProtocol,
  type HarnessCardUpdateInput,
} from "./types.js";

export const DEFAULT_HARNESS_CARD_CWD = "/mnt/session/outputs";

const EDITABLE_FIELDS = ["name", "command", "args", "cwd", "install", "protocols", "allowed_env"] as const;
const CREATE_FIELDS: ReadonlySet<string> = new Set(["harness_id", ...EDITABLE_FIELDS]);

const HARNESS_ID = /^[a-z][a-z0-9-]{1,39}$/;
const PROGRAM_NAME = /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/;
const ABSOLUTE_PROGRAM = /^\/[A-Za-z0-9._+\-/]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Package name with a version or a range: no spaces, no shell characters.
const PACKAGE = /^[A-Za-z0-9@._][A-Za-z0-9@/._+\-=<>!~,[\]:*^]*$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** IDs that would match a built-in harness, an ACP adapter or a state profile
 * (P/harness-inference-adapters/src/match.ts, P/acp-runtime/src/native-state.ts). */
export const RESERVED_HARNESS_IDS: ReadonlySet<string> = new Set([
  "pi",
  "default",
  "ai-sdk",
  "acp",
  "acp-sandbox",
  "acp-proxy",
  ...OMA_OVERLAY_AGENTS.flatMap((agent) => [agent.id, ...(agent.aliases ?? [])]),
  "claude-code",
  "codex",
  "codex-cli",
  "codex-acp-bridge",
  "gemini-cli",
  "kimi-code-acp",
  "dsh-acp",
  "deepseek-harness-acp",
]);

export function validateHarnessCardInput(body: unknown, options: { mode: "create" }): HarnessCardCreateInput;
export function validateHarnessCardInput(body: unknown, options: { mode: "update" }): HarnessCardUpdateInput;
export function validateHarnessCardInput(
  body: unknown,
  options: { mode: "create" | "update" },
): HarnessCardCreateInput | HarnessCardUpdateInput {
  if (!isRecord(body)) throw fail("Тело запроса должно быть объектом JSON", null);
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.has(key)) throw fail(`Поле «${key}» не поддерживается`, key);
  }
  if (options.mode === "update" && "harness_id" in body) {
    throw fail("ID harness нельзя изменить", "harness_id");
  }
  if (options.mode === "create") {
    for (const field of ["name", "harness_id", "command", "protocols"] as const) {
      if (body[field] === undefined) throw fail(REQUIRED[field], field);
    }
  }

  const out: HarnessCardUpdateInput = {};
  const id = options.mode === "create" ? harnessId(body.harness_id) : null;
  if (body.name !== undefined) out.name = name(body.name);
  if (body.command !== undefined) out.command = command(body.command);
  if (body.args !== undefined) out.args = args(body.args);
  if (body.cwd !== undefined) out.cwd = cwd(body.cwd);
  if (body.install !== undefined) out.install = install(body.install);
  if (body.protocols !== undefined) out.protocols = protocols(body.protocols);
  if (body.allowed_env !== undefined) out.allowed_env = allowedEnv(body.allowed_env);
  if (id === null) return out;
  return {
    harness_id: id,
    name: out.name!,
    command: out.command!,
    args: out.args ?? [],
    cwd: out.cwd !== undefined ? out.cwd : DEFAULT_HARNESS_CARD_CWD,
    install: out.install ?? { npm: [], pip: [] },
    protocols: out.protocols!,
    allowed_env: out.allowed_env ?? [],
  };
}

const REQUIRED = {
  name: "Укажите название harness",
  harness_id: "Укажите ID harness",
  command: "Укажите команду запуска",
  protocols: "Выберите хотя бы один протокол модели",
} as const;

function fail(message: string, field: string | null): HarnessCardError {
  return new HarnessCardError(400, message, field);
}

function harnessId(value: unknown): string {
  if (typeof value !== "string" || !HARNESS_ID.test(value)) {
    throw fail(
      "ID: от 2 до 40 знаков, строчная латиница, цифры и дефис, первая буква",
      "harness_id",
    );
  }
  if (RESERVED_HARNESS_IDS.has(value)) {
    throw fail(`ID «${value}» занят встроенным harness`, "harness_id");
  }
  return value;
}

function name(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || trimmed.length > 80 || CONTROL.test(trimmed)) {
    throw fail("Название: от 1 до 80 знаков", "name");
  }
  return trimmed;
}

function command(value: unknown): string {
  const valid = typeof value === "string"
    && value.length <= 200
    && !/^\.+$/.test(value)
    && (PROGRAM_NAME.test(value) || ABSOLUTE_PROGRAM.test(value));
  if (!valid) {
    throw fail(
      "Команда: имя программы или абсолютный путь без пробелов, до 200 знаков",
      "command",
    );
  }
  return value;
}

function args(value: unknown): string[] {
  const valid = Array.isArray(value)
    && value.length <= 32
    && value.every((item) => typeof item === "string" && item.length <= 2000 && !item.includes("\0"));
  if (!valid) {
    throw fail("Аргументы: список строк, не больше 32, каждая до 2000 знаков", "args");
  }
  return [...value];
}

function cwd(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1024 || CONTROL.test(value)) {
    throw fail("Рабочая папка: абсолютный путь", "cwd");
  }
  return value;
}

function install(value: unknown): { npm: string[]; pip: string[] } {
  const problem = () =>
    fail(
      "Пакеты: до 20 на менеджер, имя с версией без пробелов и ссылок, не с дефиса",
      "install",
    );
  if (!isRecord(value)) throw problem();
  for (const key of Object.keys(value)) {
    if (key !== "npm" && key !== "pip") throw problem();
  }
  const list = (items: unknown): string[] => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 20 || !items.every(isPackageName)) throw problem();
    return [...items];
  };
  return { npm: list(value.npm), pip: list(value.pip) };
}

function isPackageName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 214
    && PACKAGE.test(value)
    && !value.includes("://")
    && !value.toLowerCase().startsWith("git+")
    && !URL_SCHEME.test(value);
}

function protocols(value: unknown): HarnessCardProtocol[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw fail(`Выберите хотя бы один протокол: ${CARD_PROTOCOLS.join(", ")}`, "protocols");
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !(CARD_PROTOCOLS as readonly string[]).includes(item)) {
      throw fail(`Протоколы карточки: ${CARD_PROTOCOLS.join(", ")}`, "protocols");
    }
    if (seen.has(item)) throw fail(`Протокол «${item}» указан дважды`, "protocols");
    seen.add(item);
  }
  return [...seen] as HarnessCardProtocol[];
}

function allowedEnv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw fail("Переменные окружения: список имён, не больше 32", "allowed_env");
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !ENV_NAME.test(item)) {
      throw fail("Имя переменной: латиница, цифры и подчёркивание", "allowed_env");
    }
    if (seen.has(item)) throw fail(`Переменная «${item}» указана дважды`, "allowed_env");
    if (SERVER_INFERENCE_ENV_NAMES.has(item)) {
      throw fail(`Переменную «${item}» задаёт сервер`, "allowed_env");
    }
    if (MODEL_KEY_ENV_NAMES.has(item) || isSecretLikeEnvName(item)) {
      throw fail(
        `Переменная «${item}» похожа на секрет. Ключи сюда не кладите: модель подключается через прокси сервера`,
        "allowed_env",
      );
    }
    seen.add(item);
  }
  return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
