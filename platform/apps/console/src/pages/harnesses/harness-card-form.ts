/**
 * Форма карточки своего harness: перевод между полями окна и телом запроса
 * `/v1/oma/harness_cards` (раздел 3.5 контракта docs/plans/models-harness.md).
 * Проверяет только обязательные поля. Правила имён, пакетов и переменных
 * держит сервер, а окно показывает его ответ у поля из `field`.
 */
import type {
  CardProtocol,
  HarnessCard,
  HarnessCardInput,
  HarnessCardPatch,
} from "../../lib/harness-cards-api";

export const DEFAULT_CWD = "/mnt/session/outputs";

export interface HarnessCardForm {
  name: string;
  harnessId: string;
  command: string;
  /** Аргументы, по одному в строке. */
  argsText: string;
  cwd: string;
  npmText: string;
  pipText: string;
  protocols: CardProtocol[];
  /** Имена переменных окружения, по одному в строке. */
  envText: string;
}

export const EMPTY_CARD_FORM: HarnessCardForm = {
  name: "",
  harnessId: "",
  command: "",
  argsText: "",
  cwd: DEFAULT_CWD,
  npmText: "",
  pipText: "",
  protocols: [],
  envText: "",
};

/** Протоколы, которые можно отметить в карточке. `gemini` карточка не берёт. */
export const CARD_PROTOCOL_OPTIONS: ReadonlyArray<{ value: CardProtocol; label: string }> = [
  { value: "anthropic-messages", label: "Anthropic Messages" },
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
];

/** Строки текста без пробелов по краям. Пустые строки пропускаются. */
export function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function cardToForm(card: HarnessCard): HarnessCardForm {
  return {
    name: card.name,
    harnessId: card.harness_id,
    command: card.command,
    argsText: card.args.join("\n"),
    cwd: card.cwd ?? "",
    npmText: card.install.npm.join("\n"),
    pipText: card.install.pip.join("\n"),
    protocols: [...card.protocols],
    envText: card.allowed_env.join("\n"),
  };
}

export function formToInput(form: HarnessCardForm): HarnessCardInput {
  const cwd = form.cwd.trim();
  return {
    name: form.name.trim(),
    harness_id: form.harnessId.trim(),
    command: form.command.trim(),
    args: linesOf(form.argsText),
    cwd: cwd === "" ? null : cwd,
    install: { npm: linesOf(form.npmText), pip: linesOf(form.pipText) },
    protocols: [...form.protocols],
    allowed_env: linesOf(form.envText),
  };
}

/** Тело правки: те же поля без `harness_id`, который менять нельзя. */
export function formToPatch(form: HarnessCardForm): HarnessCardPatch {
  const input: Partial<HarnessCardInput> = formToInput(form);
  delete input.harness_id;
  return input;
}

export type CardFormField =
  | "name"
  | "harnessId"
  | "command"
  | "args"
  | "cwd"
  | "npm"
  | "pip"
  | "protocols"
  | "env";

export interface CardFormProblem {
  field: CardFormField;
  message: string;
}

/** Первое незаполненное обязательное поле или `null`. */
export function validateCardForm(
  form: HarnessCardForm,
  mode: "create" | "edit",
): CardFormProblem | null {
  if (form.name.trim() === "") return { field: "name", message: "Укажите название" };
  if (mode === "create" && form.harnessId.trim() === "") {
    return { field: "harnessId", message: "Укажите ID" };
  }
  if (form.command.trim() === "") return { field: "command", message: "Укажите команду" };
  if (form.protocols.length === 0) {
    return { field: "protocols", message: "Выберите хотя бы один протокол" };
  }
  return null;
}

const SERVER_FIELDS: Record<string, CardFormField> = {
  name: "name",
  harness_id: "harnessId",
  command: "command",
  args: "args",
  cwd: "cwd",
  install: "npm",
  "install.npm": "npm",
  "install.pip": "pip",
  protocols: "protocols",
  allowed_env: "env",
};

/** Поле формы для поля из ответа сервера. Незнакомое поле даёт `null`. */
export function fieldForServerError(field: string | null | undefined): CardFormField | null {
  if (!field) return null;
  return SERVER_FIELDS[field] ?? null;
}
