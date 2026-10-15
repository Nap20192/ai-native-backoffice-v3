import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../../i18n";
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
});

beforeEach(() => {
  managed.create.mockReset();
  managed.update.mockReset();
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
  render(
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
    </MemoryRouter>,
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
