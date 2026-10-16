import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { buildPageContext } from "../../lib/assistant/page-context";
import { server } from "../../mocks/server";
import { AssistantSwitch } from "./AssistantSwitch";
import { ChangesTab } from "./ChangesTab";
import { ContextChip } from "./ContextChip";
import { InstallPrompt } from "./InstallPrompt";
import { StarterCards } from "./StarterCards";
import { VersionNotice, versionChange } from "./VersionNotice";

describe("StarterCards", () => {
  it("четыре карточки по странице, клик отправляет текст карточки", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<StarterCards kind="session" onPick={onPick} />);
    expect(screen.getByText("Чем помочь?")).toBeInTheDocument();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Найти ошибки",
      "Разобрать скорость",
      "Ход разговора",
      "Что улучшить",
    ]);
    await user.click(screen.getByRole("button", { name: "Найти ошибки" }));
    expect(onPick).toHaveBeenCalledWith(expect.stringContaining("ошибки"));
  });

  it("для страницы агента свой набор", () => {
    render(<StarterCards kind="agent" onPick={() => {}} />);
    expect(screen.getByRole("button", { name: "Улучшить системный промпт" })).toBeInTheDocument();
  });

  it("выключенные карточки не отправляют", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<StarterCards kind="other" onPick={onPick} disabled />);
    await user.click(screen.getByRole("button", { name: "Создать агента" }));
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("ContextChip", () => {
  it("называет агента по имени и версии и убирается крестиком", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/v1/agents/a1", () => HttpResponse.json({ id: "a1", name: "Сводка PR", version: 3 })),
    );
    const onRemove = vi.fn();
    render(<ContextChip ctx={buildPageContext({ pathname: "/agents/a1", search: "" })} onRemove={onRemove} />);
    expect(await screen.findByText("Агент «Сводка PR», версия 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Убрать контекст" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("сессию называет по заголовку", async () => {
    server.use(http.get("*/v1/sessions/s1", () => HttpResponse.json({ id: "s1", title: "Отчёт" })));
    render(<ContextChip ctx={buildPageContext({ pathname: "/sessions/s1", search: "" })} onRemove={() => {}} />);
    expect(await screen.findByText("Сессия «Отчёт»")).toBeInTheDocument();
  });

  it("пока имя не пришло или запрос упал, показывает id", async () => {
    server.use(http.get("*/v1/agents/a2", () => HttpResponse.json({}, { status: 404 })));
    render(<ContextChip ctx={buildPageContext({ pathname: "/agents/a2", search: "" })} onRemove={() => {}} />);
    expect(screen.getByText("Агент a2")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Агент a2")).toBeInTheDocument());
  });

  it("список и главная не ходят в сеть", () => {
    render(<ContextChip ctx={buildPageContext({ pathname: "/skills", search: "" })} onRemove={() => {}} />);
    expect(screen.getByText("Список: Навыки")).toBeInTheDocument();
  });
});

describe("versionChange", () => {
  it("рост версии даёт уведомление", () => {
    expect(versionChange(3, 4)).toEqual({ from: 3, to: 4 });
  });
  it("первый разговор и та же версия не дают уведомления", () => {
    expect(versionChange(null, 4)).toBeNull();
    expect(versionChange(4, 4)).toBeNull();
    expect(versionChange(5, 4)).toBeNull();
  });
});

describe("VersionNotice", () => {
  it("пишет «версия 3 стала 4» и ведёт к разнице", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <MemoryRouter>
        <VersionNotice agentId="agent_b" from={3} to={4} onDismiss={onDismiss} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Ассистента изменили: версия 3 стала 4")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Что изменилось" })).toHaveAttribute("href", "/agents/agent_b?version=4&tab=versions");
    await user.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("InstallPrompt", () => {
  const models = [
    { id: "qwen3.6-35b", label: "qwen3.6-35b", provider: "openai" },
    { id: "claude-x", label: "claude-x", provider: "anthropic" },
  ];

  it("пишет, что ассистента нет, и ставит с выбранной моделью", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(<InstallPrompt models={models} busy={false} error={null} onInstall={onInstall} />);
    expect(screen.getByText("Ассистента здесь ещё нет")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Модель"), "qwen3.6-35b");
    await user.click(screen.getByRole("button", { name: "Установить" }));
    expect(onInstall).toHaveBeenCalledWith("qwen3.6-35b");
  });

  it("без выбора ставит с моделью из шаблона", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn();
    render(<InstallPrompt models={models} busy={false} error={null} onInstall={onInstall} />);
    await user.click(screen.getByRole("button", { name: "Установить" }));
    expect(onInstall).toHaveBeenCalledWith(null);
  });

  it("во время установки кнопка выключена, ошибка видна", () => {
    render(<InstallPrompt models={models} busy error="Не удалось установить" onInstall={() => {}} />);
    expect(screen.getByRole("button", { name: /Устанавлива/ })).toBeDisabled();
    expect(screen.getByText("Не удалось установить")).toBeInTheDocument();
  });
});

describe("AssistantSwitch", () => {
  const base = { enabled: true, updatedBy: null, updatedAt: null };

  it("участник без права не видит меню", () => {
    const { container } = render(
      <AssistantSwitch settings={{ ...base, canChange: false }} onChange={async () => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("владелец или администратор выключает после подтверждения", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => {});
    render(<AssistantSwitch settings={{ ...base, canChange: true }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Меню ассистента" }));
    await user.click(await screen.findByRole("menuitem", { name: "Выключить ассистента в пространстве" }));
    expect(onChange).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Выключить" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
  });

  it("выключенного включает без вопроса", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => {});
    render(<AssistantSwitch settings={{ ...base, enabled: false, canChange: true }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Меню ассистента" }));
    await user.click(await screen.findByRole("menuitem", { name: "Включить ассистента" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
  });
});

describe("ChangesTab", () => {
  it("без сессии пишет, что действий нет", () => {
    render(
      <MemoryRouter>
        <ChangesTab sessionId={null} />
      </MemoryRouter>,
    );
    expect(screen.getByText("В этом разговоре действий пока нет")).toBeInTheDocument();
  });

  it("рисует строки журнала с понятным результатом и ссылкой", async () => {
    server.use(
      http.get("*/v1/oma/platform-mcp/actions", ({ request }) => {
        expect(new URL(request.url).searchParams.get("session_id")).toBe("s1");
        return HttpResponse.json({
          data: [
            { id: "a1", created_at: "2026-10-16T10:00:00Z", tool: "list", class: "read", result: "ok" },
            {
              id: "a2",
              created_at: "2026-10-16T10:01:00Z",
              tool: "create_skill",
              class: "create",
              result: "ok",
              target_kind: "skill",
              target_id: "skl_1",
            },
            { id: "a3", created_at: "2026-10-16T10:02:00Z", tool: "update_agent", class: "edit", result: "refused_stale", target_kind: "agent", target_id: "agent_1" },
          ],
        });
      }),
    );
    render(
      <MemoryRouter>
        <ChangesTab sessionId="s1" />
      </MemoryRouter>,
    );
    const list = await screen.findByRole("list", { name: "Журнал действий" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("create_skill")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Выполнено")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Объект изменился")).toBeInTheDocument();
    expect(within(rows[2]).getByRole("link", { name: /agent_1/ })).toHaveAttribute("href", "/agents/agent_1");
  });

  it("ошибка загрузки не ломает вкладку", async () => {
    server.use(http.get("*/v1/oma/platform-mcp/actions", () => HttpResponse.json({}, { status: 500 })));
    render(
      <MemoryRouter>
        <ChangesTab sessionId="s1" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Не удалось загрузить журнал")).toBeInTheDocument();
  });
});
