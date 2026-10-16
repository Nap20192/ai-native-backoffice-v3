import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../../i18n";
import { HARNESSES_PATH, MODEL_OPTIONS_PATH } from "../../lib/catalog-api";
import type { HarnessEntry, ModelOption } from "../../lib/catalog-api";
import { server } from "../../mocks/server";
import type { AgentRecord as Agent } from "../../types/agent";
import { AgentFormDialog } from "./AgentFormDialog";

const managed = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../lib/useManagedApi", () => ({
  useManagedApi: () => ({ agents: managed }),
}));

// Выпадающий список ходит в API через useApi и TanStack Query. Здесь важна
// только форма вокруг него, поэтому подставляем кнопку с подсказкой.
vi.mock("../../components/Combobox", () => ({
  Combobox: ({ placeholder }: { placeholder?: string }) => (
    <button type="button">{placeholder}</button>
  ),
}));

beforeAll(() => {
  // Radix Checkbox измеряет себя через ResizeObserver, которого в jsdom нет.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Radix Select и cmdk трогают API, которых в jsdom нет.
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

const CLAUDE_BLOCK = {
  agent: {
    id: "claude-acp",
    command: "sh",
    args: ["-c", "exec claude-agent-acp"],
    cwd: "/mnt/session/outputs",
    env: { OMA_CLAUDE_SETTINGS: '{"permissions":{"allow":["Read","Write","Edit"]}}' },
  },
  per_turn_timeout_ms: 600000,
};

function modelOption(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    handle: "verify-fake",
    label: "Claude Sonnet 4.6",
    source: "card",
    card_id: "mc_1",
    is_default: true,
    provider: "anthropic",
    wire_model: "claude-sonnet-4-6",
    api: "anthropic-messages",
    protocols: ["anthropic-messages"],
    context_window: 200000,
    max_output_tokens: 64000,
    effort_levels: ["low", "medium", "high", "max"],
    speed_fast: true,
    harnesses: ["pi", "claude-acp"],
    ...overrides,
  };
}

const ANTHROPIC_CARD = modelOption();
const OPENAI_CARD = modelOption({
  handle: "verify-oai",
  label: "GPT 5",
  card_id: "mc_2",
  is_default: false,
  provider: "openai",
  wire_model: "gpt-5",
  api: "openai-completions",
  protocols: ["openai-chat"],
  effort_levels: [],
  speed_fast: false,
  context_window: 128000,
  harnesses: ["pi"],
});
const BUILTIN_MODEL = modelOption({
  handle: "claude-haiku-4-5",
  label: "Claude Haiku 4.5",
  source: "builtin",
  card_id: null,
  is_default: false,
  effort_levels: ["low", "high"],
  speed_fast: false,
  context_window: null,
});

function harnessEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
    id: "claude-acp",
    source: "builtin",
    label: "Claude Agent",
    status: "ready",
    reason: null,
    runtime_harness: "acp-sandbox",
    protocols: ["anthropic-messages"],
    supports: { effort: false, speed: false, platform_tools: false, mcp: false },
    acp: CLAUDE_BLOCK,
    install: { npm: ["@agentclientprotocol/claude-agent-acp@0.91.0"], pip: [] },
    install_hint: "npm install -g @agentclientprotocol/claude-agent-acp",
    allowed_env: null,
    card_id: null,
    ...overrides,
  };
}

const PI_ENTRY = harnessEntry({
  id: "pi",
  label: "Pi agent-core",
  runtime_harness: null,
  protocols: ["*"],
  supports: { effort: true, speed: true, platform_tools: true, mcp: true },
  acp: null,
  install: { npm: [], pip: [] },
  install_hint: null,
});
const CLAUDE_ENTRY = harnessEntry();
const CODEX_ENTRY = harnessEntry({
  id: "codex-acp",
  label: "Codex",
  status: "unverified",
  protocols: ["openai-responses"],
  acp: { agent: { id: "codex-acp", command: "codex-acp", cwd: "/mnt/session/outputs" } },
  install: { npm: [], pip: [] },
});
const GEMINI_ENTRY = harnessEntry({
  id: "gemini",
  label: "Gemini CLI",
  status: "unavailable",
  reason: "Песочница этого сервера не запускает ACP-агентов",
  protocols: ["gemini"],
  acp: { agent: { id: "gemini", command: "gemini", args: ["--acp"] } },
  install: { npm: [], pip: [] },
});

/** Каталог моделей и harness, который сервер отдаёт форме. */
function serveCatalog({
  models = [ANTHROPIC_CARD, OPENAI_CARD, BUILTIN_MODEL],
  harnesses = [PI_ENTRY, CLAUDE_ENTRY, CODEX_ENTRY, GEMINI_ENTRY],
}: { models?: ModelOption[]; harnesses?: HarnessEntry[] } = {}) {
  server.use(
    http.get(`*${MODEL_OPTIONS_PATH}`, () =>
      HttpResponse.json({ builtin_available: true, data: models }),
    ),
    http.get(`*${HARNESSES_PATH}`, () => HttpResponse.json({ data: harnesses })),
  );
}

beforeEach(() => {
  managed.create.mockReset();
  managed.update.mockReset();
  serveCatalog();
});

const existingAgent = {
  id: "agent-1",
  type: "agent",
  name: "Юрист",
  model: "deepseek-chat",
  system: "Проверяй договоры.",
  version: 2,
  tools: [],
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
} as unknown as Agent;

function renderDialog(props: Partial<React.ComponentProps<typeof AgentFormDialog>> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onUpdated = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider>
          <AgentFormDialog
            open
            onClose={onClose}
            onCreated={onCreated}
            onUpdated={onUpdated}
            allAgents={[]}
            customSkills={[]}
            modelCards={[]}
            {...props}
          />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onCreated, onUpdated };
}

async function pickBlankTemplate() {
  await userEvent.click(screen.getByRole("button", { name: /Пустой агент/ }));
}

describe("AgentFormDialog template step", () => {
  it("opens as a Russian dialog with a template search and cancel", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Новый агент" });
    expect(dialog).toHaveAccessibleDescription("Выберите шаблон или соберите агента с нуля.");
    expect(within(dialog).getByRole("searchbox", { name: "Поиск шаблонов" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Пустой агент/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Отмена" })).toBeInTheDocument();
  });

  it("filters templates by their Russian text and offers to reset an empty search", async () => {
    renderDialog();
    const search = screen.getByRole("searchbox", { name: "Поиск шаблонов" });

    await userEvent.type(search, "исследов");
    expect(screen.getByRole("button", { name: /Глубокий исследователь/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Пустой агент/ })).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "яяяяя");
    expect(screen.getByText("Шаблоны не найдены")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Сбросить поиск" }));
    expect(screen.getByRole("button", { name: /Пустой агент/ })).toBeInTheDocument();
  });
});

describe("AgentFormDialog form step", () => {
  it("shows the five Russian tabs after a template is picked and can go back", async () => {
    renderDialog();
    await pickBlankTemplate();

    const tabs = screen.getByRole("tablist", { name: "Разделы настроек агента" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Основное",
      "Инструменты",
      "Навыки",
      "MCP-серверы",
      "Мультиагентность",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "К шаблонам" }));
    expect(screen.getByRole("searchbox", { name: "Поиск шаблонов" })).toBeInTheDocument();
  });

  it("keeps the create button disabled until the agent has a name", async () => {
    renderDialog();
    await pickBlankTemplate();

    const create = screen.getByRole("button", { name: "Создать агента" });
    expect(create).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Название" }), "Мой агент");
    expect(create).toBeEnabled();
  });

  it("counts picked skills in the tab and in the footer", async () => {
    renderDialog();
    await pickBlankTemplate();

    await userEvent.click(screen.getByRole("tab", { name: "Навыки" }));
    expect(screen.getByText("Своих навыков пока нет.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Excel (xlsx)" }));
    expect(screen.getByRole("tab", { name: /^Навыки/ })).toHaveTextContent("1");
    expect(screen.getByText("Навыки: 1")).toBeInTheDocument();
  });

  it("creates the agent from the form and reports it to the parent", async () => {
    managed.create.mockResolvedValue({ id: "agent-new" });
    const { onClose, onCreated } = renderDialog();
    await pickBlankTemplate();

    await userEvent.type(screen.getByRole("textbox", { name: "Название" }), "Мой агент");
    await userEvent.click(screen.getByRole("button", { name: "Создать агента" }));

    await waitFor(() => expect(managed.create).toHaveBeenCalledOnce());
    expect(managed.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Мой агент" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalled();
  });

  it("locks the dialog while the agent is being saved", async () => {
    managed.create.mockReturnValue(new Promise(() => {}));
    const { onClose } = renderDialog();
    await pickBlankTemplate();

    await userEvent.type(screen.getByRole("textbox", { name: "Название" }), "Мой агент");
    await userEvent.click(screen.getByRole("button", { name: "Создать агента" }));

    const busy = await screen.findByRole("button", { name: /Создание…/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();

    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("round-trips the form through YAML and reports a broken config in Russian", async () => {
    renderDialog();
    await pickBlankTemplate();
    await userEvent.type(screen.getByRole("textbox", { name: "Название" }), "Мой агент");

    await userEvent.click(screen.getByRole("button", { name: "YAML" }));
    expect(screen.getByRole("button", { name: "YAML" })).toHaveAttribute("aria-pressed", "true");
    const editor = screen.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
    expect((editor as HTMLTextAreaElement).value).toContain("name: Мой агент");
    expect(screen.getByText("Редактор YAML")).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "name: [" } });
    await userEvent.click(screen.getByRole("button", { name: "Форма" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Некорректный YAML/);
    expect(screen.getByRole("button", { name: "YAML" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(editor, { target: { value: "name: Другой агент" } });
    await userEvent.click(screen.getByRole("button", { name: "Форма" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Название" })).toHaveValue("Другой агент");
  });
});

describe("AgentFormDialog edit mode", () => {
  it("skips the template step and prefills the form", async () => {
    renderDialog({ agent: existingAgent });

    const dialog = screen.getByRole("dialog", { name: "Изменение агента" });
    expect(dialog).toHaveAccessibleDescription("Редактирование v2");
    expect(screen.queryByRole("searchbox", { name: "Поиск шаблонов" })).toBeNull();
    expect(screen.queryByRole("button", { name: "К шаблонам" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Название" })).toHaveValue("Юрист");
    expect(screen.getByRole("button", { name: "Сохранить изменения" })).toBeEnabled();
  });
});

describe("AgentFormDialog: подсказки по-русски", () => {
  it("на вкладке инструментов называет вариант так же, как он подписан в списке", async () => {
    renderDialog();
    await pickBlankTemplate();
    await userEvent.click(screen.getByRole("tab", { name: "Инструменты" }));

    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain("По умолчанию");
    expect(panel.textContent).not.toMatch(/\bdefault\b/);
  });

  it("у закреплённой версии навыка подсказка и пояснение без английского latest", async () => {
    renderDialog();
    await pickBlankTemplate();
    await userEvent.click(screen.getByRole("tab", { name: "Навыки" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Excel (xlsx)" }));

    const panel = screen.getByRole("tabpanel");
    const version = within(panel).getByRole("textbox", { name: "Версия навыка xlsx" });
    expect(version).toHaveAttribute("placeholder", "последняя");
    expect(panel.textContent).toContain("последнюю версию");
    expect(panel.textContent).not.toMatch(/\blatest\b/);
  });

  it("у версии вызываемого агента подсказка «последняя»", async () => {
    renderDialog({
      agent: {
        ...existingAgent,
        multiagent: { type: "coordinator", agents: [{ type: "agent", id: "agent-2" }] },
      } as unknown as Agent,
    });
    await userEvent.click(screen.getByRole("tab", { name: /^Мультиагентность/ }));

    const version = screen.getByRole("spinbutton");
    expect(version).toHaveAttribute("placeholder", "последняя");
  });
});

async function openBlankForm() {
  renderDialog();
  await pickBlankTemplate();
  await userEvent.type(screen.getByRole("textbox", { name: "Название" }), "Мой агент");
  // Модель по умолчанию приходит из каталога и появляется в поле.
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Модель" })).toHaveTextContent("Claude Sonnet 4.6"),
  );
}

async function pickHarness(name: RegExp) {
  await userEvent.click(screen.getByRole("combobox", { name: "Harness" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

async function pickEffort(name: string) {
  await userEvent.click(screen.getByRole("combobox", { name: "Усилие" }));
  await userEvent.click(await screen.findByRole("option", { name }));
}

describe("AgentFormDialog: раздел «Основное»", () => {
  it("ведёт поля в порядке контракта: Harness, модель с усилием рядом, скорость, описание, промпт", async () => {
    await openBlankForm();

    const panel = screen.getByRole("tabpanel");
    const labels = Array.from(panel.querySelectorAll("label, span[class~='mb-1.5']")).map(
      (node) => node.textContent?.replace("*", "").trim(),
    );
    const order = ["Название", "Harness", "Модель", "Усилие", "Скорость", "Описание", "Системный промпт"];
    const positions = order.map((label) => labels.indexOf(label));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // Ниже без изменений: вспомогательная модель, идентификаторы промптов, метаданные.
    expect(labels.indexOf("Вспомогательная модель")).toBeGreaterThan(labels.indexOf("Системный промпт"));
    expect(labels.indexOf("Метаданные (JSON)")).toBeGreaterThan(
      labels.indexOf("Идентификаторы добавляемых промптов"),
    );
  });

  it("по умолчанию берёт встроенный цикл и карточку модели по умолчанию", async () => {
    await openBlankForm();

    expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent("Встроенный цикл");
    expect(screen.getByText("Платформа сама ведёт ход", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Карточка · Anthropic · 200 тыс. токенов")).toBeInTheDocument();
  });

  it("без карточек, но со встроенными моделями агент создаётся из формы", async () => {
    serveCatalog({ models: [BUILTIN_MODEL] });
    managed.create.mockResolvedValue({ id: "agent-new" });
    renderDialog();
    await pickBlankTemplate();
    await userEvent.type(screen.getByRole("textbox", { name: "Название" }), "Мой агент");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Модель" })).toHaveTextContent("Claude Haiku 4.5"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Создать агента" }));

    await waitFor(() => expect(managed.create).toHaveBeenCalledOnce());
    expect(managed.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Мой агент", model: "claude-haiku-4-5" }),
    );
  });

  it("без единой модели предупреждает и зовёт добавить карточку", async () => {
    serveCatalog({ models: [] });
    renderDialog();
    await pickBlankTemplate();

    const warning = await screen.findByText(/Модели не настроены/);
    expect(warning).toHaveTextContent(
      "Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY",
    );
    expect(within(warning.closest(".callout-warning") as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/model-cards",
    );
  });

  it("если каталог моделей не загрузился, говорит об этом и не стирает модель агента", async () => {
    server.use(
      http.get(`*${MODEL_OPTIONS_PATH}`, () =>
        HttpResponse.json({ error: "Маршрут не найден" }, { status: 404 }),
      ),
    );
    renderDialog({ agent: existingAgent });

    expect(await screen.findByText(/Не удалось загрузить список моделей/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Модель" })).toHaveTextContent("deepseek-chat");
  });
});

describe("AgentFormDialog: усилие и скорость", () => {
  it("даёт выбрать усилие из уровней модели и пишет его в агента", async () => {
    managed.create.mockResolvedValue({ id: "agent-new" });
    await openBlankForm();

    await userEvent.click(screen.getByRole("combobox", { name: "Усилие" }));
    const levels = (await screen.findAllByRole("option")).map((node) => node.textContent);
    expect(levels).toEqual(["По умолчанию", "Низкое", "Среднее", "Высокое", "Максимальное"]);
    await userEvent.click(screen.getByRole("option", { name: "Высокое" }));
    await userEvent.click(screen.getByRole("button", { name: "Создать агента" }));

    await waitFor(() => expect(managed.create).toHaveBeenCalledOnce());
    expect(managed.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: "verify-fake", effort: "high" } }),
    );
  });

  it("у модели без уровней усилие выключено с подсказкой", async () => {
    await openBlankForm();

    await userEvent.click(screen.getByRole("combobox", { name: "Модель" }));
    await userEvent.click(await screen.findByRole("option", { name: /GPT 5/ }));

    const effort = screen.getByRole("combobox", { name: "Усилие" });
    expect(effort).toBeDisabled();
    expect(effort).toHaveAccessibleDescription("Модель не поддерживает усилие");
  });

  it("смена модели сохраняет усилие, если у новой модели есть тот же уровень", async () => {
    await openBlankForm();
    await pickEffort("Высокое");

    await userEvent.click(screen.getByRole("combobox", { name: "Модель" }));
    await userEvent.click(await screen.findByRole("option", { name: /Claude Haiku 4\.5/ }));

    expect(screen.getByRole("combobox", { name: "Усилие" })).toHaveTextContent("Высокое");
    expect(screen.queryByText("Усилие сброшено: модель его не поддерживает")).toBeNull();
  });

  it("смена модели сбрасывает усилие, которого у новой нет, и пишет об этом", async () => {
    await openBlankForm();
    await pickEffort("Максимальное");

    await userEvent.click(screen.getByRole("combobox", { name: "Модель" }));
    await userEvent.click(await screen.findByRole("option", { name: /Claude Haiku 4\.5/ }));

    expect(screen.getByRole("combobox", { name: "Усилие" })).toHaveTextContent("По умолчанию");
    expect(screen.getByText("Усилие сброшено: модель его не поддерживает")).toBeInTheDocument();
  });

  it("переключатель скорости виден у модели с быстрой скоростью и пишет её в агента", async () => {
    managed.create.mockResolvedValue({ id: "agent-new" });
    await openBlankForm();

    const group = screen.getByRole("group", { name: "Скорость" });
    expect(within(group).getByRole("button", { name: "Обычная" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(group).getByRole("button", { name: "Быстрая" }));
    expect(within(group).getByRole("button", { name: "Быстрая" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Создать агента" }));

    await waitFor(() => expect(managed.create).toHaveBeenCalledOnce());
    expect(managed.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: "verify-fake", speed: "fast" } }),
    );
  });

  it("у модели без быстрой скорости переключателя нет", async () => {
    await openBlankForm();

    await userEvent.click(screen.getByRole("combobox", { name: "Модель" }));
    await userEvent.click(await screen.findByRole("option", { name: /Claude Haiku 4\.5/ }));

    expect(screen.queryByRole("group", { name: "Скорость" })).toBeNull();
  });

  it("YAML хранит усилие и скорость и возвращает их в форму", async () => {
    await openBlankForm();
    await pickEffort("Низкое");
    await userEvent.click(
      within(screen.getByRole("group", { name: "Скорость" })).getByRole("button", { name: "Быстрая" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "YAML" }));
    const editor = screen.getByRole("textbox", { name: "Конфигурация агента в формате YAML" });
    const text = (editor as HTMLTextAreaElement).value;
    expect(text).toContain("effort: low");
    expect(text).toContain("speed: fast");

    await userEvent.click(screen.getByRole("button", { name: "Форма" }));
    expect(screen.getByRole("combobox", { name: "Усилие" })).toHaveTextContent("Низкое");
  });
});

describe("AgentFormDialog: harness", () => {
  it("несовместимые варианты выключены, причина читается в строке и в ARIA", async () => {
    await openBlankForm();

    await userEvent.click(screen.getByRole("combobox", { name: "Harness" }));

    const gemini = await screen.findByRole("option", { name: /Gemini CLI в песочнице/ });
    expect(gemini).toHaveAttribute("aria-disabled", "true");
    expect(gemini).toHaveTextContent("Песочница этого сервера не запускает ACP-агентов");
    expect(document.getElementById(gemini.getAttribute("aria-describedby") as string)).toHaveTextContent(
      "Песочница этого сервера не запускает ACP-агентов",
    );
    const codex = screen.getByRole("option", { name: /Codex в песочнице/ });
    expect(codex).toHaveAttribute("aria-disabled", "true");
    expect(codex).toHaveTextContent("Нет подходящих моделей: нужна модель с протоколом openai-responses");
  });

  it("выбор Claude Code описывает вариант и называет пакеты окружения", async () => {
    await openBlankForm();

    await pickHarness(/Claude Code в песочнице/);

    expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent(
      "Claude Code в песочнице",
    );
    expect(screen.getByText(/ключа в VM нет/)).toBeInTheDocument();
    const requirement = screen.getByText(/В окружении сессии должны стоять пакеты/);
    expect(requirement).toHaveTextContent("npm @agentclientprotocol/claude-agent-acp@0.91.0");
    expect(within(requirement.parentElement as HTMLElement).getByRole("link", { name: "Окружения" }))
      .toHaveAttribute("href", "/environments");
  });

  it("при ACP скрыты усилие, скорость и вспомогательная модель", async () => {
    await openBlankForm();
    expect(screen.getByRole("combobox", { name: "Усилие" })).toBeInTheDocument();

    await pickHarness(/Claude Code в песочнице/);

    expect(screen.queryByRole("combobox", { name: "Усилие" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Скорость" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Вспомогательная модель" })).toBeNull();
    expect(screen.getByText("Усилие и скорость ACP-агенту не передаются")).toBeInTheDocument();
    expect(screen.getByText("ACP-агент пока не получает системный промпт")).toBeInTheDocument();
  });

  it("при ACP вкладки «Инструменты» и «MCP-серверы» показывают пояснение, а не поля", async () => {
    await openBlankForm();
    await pickHarness(/Claude Code в песочнице/);

    await userEvent.click(screen.getByRole("tab", { name: "Инструменты" }));
    let panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Claude Code работает своими инструментами");
    expect(panel).toHaveTextContent("OMA_CLAUDE_SETTINGS");
    expect(within(panel).queryByText("Политика по умолчанию")).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "MCP-серверы" }));
    panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent(
      "MCP-серверы агента до Claude Code в песочнице не доходят: на этом сервере у ACP-агентов нет шлюза MCP.",
    );
    expect(within(panel).queryByRole("button", { name: "Свой сервер" })).toBeNull();
  });

  it("значения вкладок на месте после возврата на встроенный цикл", async () => {
    await openBlankForm();
    await userEvent.click(screen.getByRole("tab", { name: "Навыки" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Excel (xlsx)" }));
    await userEvent.click(screen.getByRole("tab", { name: "Основное" }));
    await pickHarness(/Claude Code в песочнице/);

    await userEvent.click(screen.getByRole("tab", { name: "Инструменты" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Claude Code работает своими инструментами");

    await userEvent.click(screen.getByRole("tab", { name: "Основное" }));
    await pickHarness(/Встроенный цикл/);

    await userEvent.click(screen.getByRole("tab", { name: "Инструменты" }));
    expect(screen.getByText("Политика по умолчанию")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /^Навыки/ }));
    expect(screen.getByRole("checkbox", { name: "Excel (xlsx)" })).toBeChecked();
  });

  it("смена на harness, который не берёт текущую модель, заменяет её и пишет об этом", async () => {
    await openBlankForm();
    await userEvent.click(screen.getByRole("combobox", { name: "Модель" }));
    await userEvent.click(await screen.findByRole("option", { name: /GPT 5/ }));
    expect(screen.getByRole("combobox", { name: "Модель" })).toHaveTextContent("GPT 5");

    await pickHarness(/Claude Code в песочнице/);

    expect(screen.getByRole("combobox", { name: "Модель" })).toHaveTextContent("Claude Sonnet 4.6");
    expect(
      screen.getByText("Модель заменена: verify-oai не работает с Claude Code в песочнице"),
    ).toBeInTheDocument();
  });

  it("в списке моделей при ACP несовместимая модель выключена с причиной", async () => {
    await openBlankForm();
    await pickHarness(/Claude Code в песочнице/);

    await userEvent.click(screen.getByRole("combobox", { name: "Модель" }));

    const row = await screen.findByRole("option", { name: /GPT 5/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent(
      "Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели verify-oai: openai-chat",
    );
  });

  it("создаёт ACP-агента с блоком из каталога и без усилия и скорости", async () => {
    managed.create.mockResolvedValue({ id: "agent-new" });
    await openBlankForm();
    await pickEffort("Высокое");
    await pickHarness(/Claude Code в песочнице/);

    await userEvent.click(screen.getByRole("button", { name: "Создать агента" }));

    await waitFor(() => expect(managed.create).toHaveBeenCalledOnce());
    const payload = managed.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.model).toBe("verify-fake");
    expect(payload._oma).toEqual({ harness: "acp-sandbox", acp: CLAUDE_BLOCK });
  });

  it("агент с устаревшим ai-sdk показывает «AI SDK (устарел)» и уходит с тем же значением", async () => {
    managed.update.mockResolvedValue({ ...existingAgent, version: 3 });
    renderDialog({
      agent: { ...existingAgent, _oma: { harness: "ai-sdk" } } as unknown as Agent,
    });

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent("AI SDK (устарел)"),
    );
    expect(screen.getByText("Старый harness. Выберите встроенный цикл.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => expect(managed.update).toHaveBeenCalledOnce());
    expect((managed.update.mock.calls[0][1] as { _oma: { harness: string } })._oma.harness).toBe(
      "ai-sdk",
    );
  });

  it("агент на Claude Code открывается без усилия и скорости, блок агента сохраняется как есть", async () => {
    const ownBlock = {
      agent: { id: "claude-acp", command: "sh", args: ["-c", "exec my-wrapper"], env: { MY_FLAG: "1" } },
      per_turn_timeout_ms: 900000,
    };
    managed.update.mockResolvedValue({ ...existingAgent, version: 3 });
    renderDialog({
      agent: {
        ...existingAgent,
        model: { id: "verify-fake" },
        _oma: { harness: "acp-sandbox", acp: ownBlock },
      } as unknown as Agent,
    });

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent(
        "Claude Code в песочнице",
      ),
    );
    expect(screen.queryByRole("combobox", { name: "Усилие" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => expect(managed.update).toHaveBeenCalledOnce());
    const body = managed.update.mock.calls[0][1] as { _oma: { acp: unknown; harness: string } };
    expect(body._oma.harness).toBe("acp-sandbox");
    expect(body._oma.acp).toEqual(ownBlock);
  });

  it("возврат агента с ACP на встроенный цикл шлёт null вместо harness и acp", async () => {
    managed.update.mockResolvedValue({ ...existingAgent, version: 3 });
    renderDialog({
      agent: {
        ...existingAgent,
        model: { id: "verify-fake" },
        _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK },
      } as unknown as Agent,
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent(
        "Claude Code в песочнице",
      ),
    );

    await pickHarness(/Встроенный цикл/);
    await userEvent.click(screen.getByRole("button", { name: "Сохранить изменения" }));

    await waitFor(() => expect(managed.update).toHaveBeenCalledOnce());
    expect((managed.update.mock.calls[0][1] as { _oma: unknown })._oma).toEqual({
      harness: null,
      acp: null,
    });
  });
});
