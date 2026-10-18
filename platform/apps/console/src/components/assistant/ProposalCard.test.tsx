import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../mocks/server";
import { ProposalCard, confirmLabelFor, proposalTitle } from "./ProposalCard";
import { normalizePreview } from "../../lib/assistant/api";
import {
  AGENT_EDIT_PREVIEW,
  SKILL_CREATE_PREVIEW,
  errorBody,
  mockPlatformMcp,
  proposalItem,
  renderInRouter,
} from "./test-fixtures";

const SID = "sesn_1";

describe("proposalTitle", () => {
  it("создание и правка", () => {
    expect(proposalTitle(normalizePreview(SKILL_CREATE_PREVIEW), "create_skill")).toBe("Создать навык «Навык PR»");
    expect(proposalTitle(normalizePreview(AGENT_EDIT_PREVIEW), "update_agent")).toBe(
      "Изменить агента «Сводка PR», версия 3 станет 4",
    );
  });
  it("деплоймент создаётся на паузе", () => {
    const p = normalizePreview({
      operations: [{ index: 0, tool: "create_deployment", kind: "deployment", name: "Утро", class: "create" }],
    });
    expect(proposalTitle(p, "create_deployment")).toBe("Создать деплоймент на паузе «Утро»");
  });
  it("до загрузки: по имени инструмента", () => {
    expect(proposalTitle(null, "create_environment")).toBe("Создать окружение");
    expect(proposalTitle(null, "update_agent")).toBe("Предложение ассистента");
  });
});

describe("confirmLabelFor", () => {
  it("запись памяти по свободному пути это создание: кнопка «Создать», по занятому «Применить»", () => {
    const op = (cls: string) => normalizePreview({ operations: [{ op_index: 0, tool: "write_memory", target_kind: "memory", class: cls }] });
    expect(confirmLabelFor("write_memory", op("create"))).toBe("Создать");
    expect(confirmLabelFor("write_memory", op("update"))).toBe("Применить");
    expect(confirmLabelFor("write_memory", null)).toBe("Применить");
  });
});

describe("ProposalCard: создание", () => {
  it("запрашивает preview по session_id и tool_use_id и рисует YAML", async () => {
    const seen = mockPlatformMcp([SKILL_CREATE_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill" })} sessionId={SID} />);
    expect(await screen.findByText("Создать навык «Навык PR»")).toBeInTheDocument();
    expect(seen.previews).toEqual([{ session_id: SID, tool_use_id: "tu_1" }]);
    expect(screen.getByText(/display_title: Навык PR/)).toBeInTheDocument();
    expect(screen.getByText("Навык получит доступ к окружению «Песок»")).toBeInTheDocument();
    expect(screen.getByText("файлы: 2", { selector: "li" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Отклонить" })).toBeEnabled();
  });

  it("кнопка шлёт confirm с отпечатком этой карточки", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([SKILL_CREATE_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Создать" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toEqual({
      session_id: SID,
      tool_use_id: "tu_1",
      result: "allow",
      preview_digest: "s1",
    });
    expect(await screen.findByText("Отправлено. Жду результат")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Создать" })).toBeNull();
  });

  it("«Отклонить» сразу шлёт deny без причины", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([SKILL_CREATE_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Отклонить" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ result: "deny", preview_digest: "s1" });
    expect(seen.decisions[0]).not.toHaveProperty("deny_message");
    expect(screen.queryByLabelText("Причина отказа")).toBeNull();
    expect(await screen.findByText("Отклонено")).toBeInTheDocument();
  });

  it("«Отклонить с причиной» открывает поле, отказ уходит по «Отправить отказ»", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([SKILL_CREATE_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Отклонить с причиной" }));
    expect(seen.decisions).toHaveLength(0);
    await user.type(screen.getByLabelText("Причина отказа"), "не тот навык");
    await user.click(screen.getByRole("button", { name: "Отправить отказ" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ result: "deny", deny_message: "не тот навык", preview_digest: "s1" });
    expect(await screen.findByText("Отклонено")).toBeInTheDocument();
  });

  it("модель по id карточки: карточка пишет причину до клика, кнопка выключена", async () => {
    mockPlatformMcp([
      {
        tool: "create_agent",
        preview_digest: "m1",
        invalid: "«mdl-1» это id карточки модели. В поле model пиши handle модели «qwen3.6-35b»",
        operations: [{ index: 0, tool: "create_agent", kind: "agent", name: "Сводка", class: "create", after_yaml: "name: Сводка\nmodel: mdl-1\n" }],
      },
    ]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_agent" })} sessionId={SID} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("handle модели «qwen3.6-35b»");
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });

  it("«Обновить» заново запрашивает preview", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([SKILL_CREATE_PREVIEW, { ...SKILL_CREATE_PREVIEW, preview_digest: "s2" }]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(seen.previews).toHaveLength(2));
    await user.click(await screen.findByRole("button", { name: "Создать" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0].preview_digest).toBe("s2");
  });
});

describe("ProposalCard: правка", () => {
  it("рисует заголовок с версиями и разницу", async () => {
    mockPlatformMcp([AGENT_EDIT_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    expect(await screen.findByText("Изменить агента «Сводка PR», версия 3 станет 4")).toBeInTheDocument();
    expect(screen.getByText("system: старый промпт").closest("[data-diff='del']")).not.toBeNull();
    expect(screen.getByText("system: новый промпт").closest("[data-diff='add']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Применить" })).toBeEnabled();
  });

  it("409 stale: пишет, что объект изменился, и показывает новую разницу", async () => {
    const user = userEvent.setup();
    const changed = {
      ...AGENT_EDIT_PREVIEW,
      preview_digest: "d2",
      operations: [
        { ...AGENT_EDIT_PREVIEW.operations[0], before_yaml: "name: Сводка PR\nsystem: чужая правка\nmodel: qwen\n" },
      ],
    };
    const seen = mockPlatformMcp([AGENT_EDIT_PREVIEW, changed], (body) =>
      body.preview_digest === "d1"
        ? { status: 409, body: errorBody("stale") }
        : { status: 200, body: {} },
    );
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Применить" }));
    expect(await screen.findByText("Агент изменился после предложения")).toBeInTheDocument();
    expect(await screen.findByText("system: чужая правка")).toBeInTheDocument();
    expect(seen.previews).toHaveLength(2);
    // та же кнопка подтверждает новое состояние с новым отпечатком
    await user.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(2));
    expect(seen.decisions[1].preview_digest).toBe("d2");
    expect(await screen.findByText("Отправлено. Жду результат")).toBeInTheDocument();
  });

  it("stale с устаревшими аргументами: кнопка выключена, «Попросить пересобрать» шлёт deny", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp(
      [AGENT_EDIT_PREVIEW, { ...AGENT_EDIT_PREVIEW, preview_digest: "d2", args_stale: true }],
      (body) => (body.result === "allow" ? { status: 409, body: errorBody("stale") } : { status: 200, body: {} }),
    );
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Применить" }));
    expect(await screen.findByText(/Аргументы больше не подходят/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Попросить пересобрать" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(2));
    expect(seen.decisions[1]).toMatchObject({ result: "deny" });
    expect(String(seen.decisions[1].deny_message)).toMatch(/^stale/);
  });

  it("409 class выключает кнопку и называет причину", async () => {
    const user = userEvent.setup();
    // Сервер без причины: карточка берёт свой текст. Причину сервера проверяет confirm.test.ts (c9c247e).
    mockPlatformMcp([AGENT_EDIT_PREVIEW], () => ({ status: 409, body: errorBody("class", "") }));
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_deployment" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Применить" }));
    expect(
      await screen.findByText("Деплоймент работает. В первой версии ассистент меняет только деплоймент на паузе"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отклонить" })).toBeEnabled();
  });

  it("409 secret: значение скрыто, кнопка выключена", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([AGENT_EDIT_PREVIEW], () => ({ status: 409, body: errorBody("secret") }));
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Применить" }));
    expect(
      await screen.findByText("В черновике значение секрета пространства. Секрет задаётся только в хранилище секретов"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });

  it("409 disabled", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([AGENT_EDIT_PREVIEW], () => ({ status: 409, body: errorBody("disabled") }));
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Применить" }));
    expect(await screen.findByText("Ассистент выключен в пространстве")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });

  it("404 при confirm: «Объект не найден»", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([AGENT_EDIT_PREVIEW], () => ({ status: 404, body: errorBody("not_found_error") }));
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    await user.click(await screen.findByRole("button", { name: "Применить" }));
    expect(await screen.findByText("Объект не найден")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });
});

describe("ProposalCard: блокировки в preview", () => {
  it("ошибка схемы: причина, «Применить» выключена, «Отклонить» работает", async () => {
    mockPlatformMcp([
      { tool: "update_model_card", schema_error: "Поле provider не принимается", operations: [], preview_digest: null },
    ]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_model_card" })} sessionId={SID} />);
    expect(await screen.findByText("Поле provider не принимается")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Отклонить" })).toBeEnabled();
  });

  it("ассистент выключен", async () => {
    mockPlatformMcp([{ disabled: true, operations: [], preview_digest: null }]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_agent" })} sessionId={SID} />);
    expect(await screen.findByText("Ассистент выключен в пространстве")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });

  it("известное значение секрета", async () => {
    mockPlatformMcp([{ ...SKILL_CREATE_PREVIEW, secret: true }]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill" })} sessionId={SID} />);
    expect(
      await screen.findByText("В черновике значение секрета пространства. Секрет задаётся только в хранилище секретов"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });

  it("404 в preview: «Объект не найден»", async () => {
    mockPlatformMcp([{ status: 404, body: errorBody("not_found_error") }]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    expect(await screen.findByText("Объект не найден")).toBeInTheDocument();
  });

  it("сбой preview: «Обновить» остаётся", async () => {
    mockPlatformMcp([{ status: 500, body: errorBody("api_error") }]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    expect(await screen.findByText("Не удалось получить предложение. Нажмите «Обновить»")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Обновить" })).toBeEnabled();
  });

  it("другой участник видит карточку без кнопок", async () => {
    mockPlatformMcp([{ ...AGENT_EDIT_PREVIEW, can_confirm: false, owner_name: "Анна" }]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "update_agent" })} sessionId={SID} />);
    expect(await screen.findByText("Подтвердить может только Анна")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отклонить" })).toBeNull();
    expect(screen.getByText("system: новый промпт")).toBeInTheDocument();
  });
});

describe("ProposalCard: особые виды", () => {
  it("деплоймент: три запуска и строка про паузу", async () => {
    mockPlatformMcp([
      {
        tool: "create_deployment",
        preview_digest: "p1",
        operations: [
          {
            index: 0,
            tool: "create_deployment",
            kind: "deployment",
            name: "Утро",
            class: "create",
            after_yaml: "name: Утро\nschedule:\n  cron: 0 9 * * *\n",
            next_runs: ["17.10.2026 09:00", "18.10.2026 09:00", "19.10.2026 09:00"],
          },
        ],
      },
    ]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_deployment" })} sessionId={SID} />);
    expect(await screen.findByText("Создать деплоймент на паузе «Утро»")).toBeInTheDocument();
    expect(screen.getByText("Деплоймент создаётся на паузе. Запустить его можно в консоли")).toBeInTheDocument();
    const runs = screen.getByRole("list", { name: "Ближайшие запуски" });
    expect(within(runs).getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("ProposalCard: решение уже принято", () => {
  it("применено: строка со ссылкой, preview не запрашивается", async () => {
    const seen = mockPlatformMcp([SKILL_CREATE_PREVIEW]);
    renderInRouter(
      <ProposalCard
        item={proposalItem({
          tool: "create_environment",
          phase: "applied",
          applied: [{ tool: "create_environment", kind: "environment", id: "env_1", name: "Песок", version: null, action: "create" }],
        })}
        sessionId={SID}
      />,
    );
    const link = await screen.findByRole("link", { name: "Создано окружение «Песок»" });
    expect(link).toHaveAttribute("href", "/environments/env_1");
    expect(seen.previews).toHaveLength(0);
  });

  it("правка агента: «Применено, версия 4» и возврат версии 3", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([AGENT_EDIT_PREVIEW]);
    const posts: unknown[] = [];
    server.use(
      http.get("*/v1/agents/agent_1", ({ request }) => {
        expect(new URL(request.url).searchParams.get("version")).toBe("3");
        return HttpResponse.json({ id: "agent_1", name: "Сводка PR", system: "старый промпт", model: { id: "qwen" }, tools: [], mcp_servers: [], skills: [], version: 3 });
      }),
      http.post("*/v1/agents/agent_1", async ({ request }) => {
        posts.push(await request.json());
        return HttpResponse.json({ id: "agent_1", version: 5 });
      }),
    );
    renderInRouter(
      <ProposalCard
        item={proposalItem({
          tool: "update_agent",
          input: { agent_id: "agent_1", expected_version: 3, changes: { system: "новый" } },
          phase: "applied",
          applied: [{ tool: "update_agent", kind: "agent", id: "agent_1", name: "Сводка PR", version: 4, action: "update" }],
        })}
        sessionId={SID}
      />,
    );
    expect(await screen.findByText("Применено, версия 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Вернуть версию 3" }));
    expect(await screen.findByText("Возвращено, новая версия 5")).toBeInTheDocument();
    expect(posts[0]).toMatchObject({ version: 4, system: "старый промпт", name: "Сводка PR" });
  });

  it("отклонено: причина", () => {
    renderInRouter(
      <ProposalCard item={proposalItem({ tool: "create_skill", phase: "denied", denyMessage: "не надо" })} sessionId={SID} />,
    );
    expect(screen.getByText("Отклонено")).toBeInTheDocument();
    expect(screen.getByText("Причина: не надо")).toBeInTheDocument();
  });

  it("не вышло: текст ошибки", () => {
    renderInRouter(
      <ProposalCard
        item={proposalItem({ tool: "update_agent", phase: "failed", resultText: "Объект изменился после подтверждения" })}
        sessionId={SID}
      />,
    );
    expect(screen.getByText("Не применено")).toBeInTheDocument();
    expect(screen.getByText("Объект изменился после подтверждения")).toBeInTheDocument();
  });

  it("отправлено в историю: ждёт результат", () => {
    renderInRouter(<ProposalCard item={proposalItem({ tool: "create_skill", phase: "sent" })} sessionId={SID} />);
    expect(screen.getByText("Отправлено. Жду результат")).toBeInTheDocument();
  });
});
