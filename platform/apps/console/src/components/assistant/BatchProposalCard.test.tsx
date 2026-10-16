import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { BatchProposalCard, batchTitle, ruObjects } from "./BatchProposalCard";
import { normalizePreview } from "../../lib/assistant/api";
import { errorBody, mockPlatformMcp, proposalItem, renderInRouter } from "./test-fixtures";

const op = (index: number, tool: string, kind: string, name: string, cls: string, extra: Record<string, unknown> = {}) => ({
  index,
  tool,
  kind,
  name,
  class: cls,
  before_yaml: cls === "edit" ? "a: 1\n" : null,
  after_yaml: cls === "edit" ? "a: 2\n" : `name: ${name}\n`,
  ...extra,
});

const CREATE_BATCH = {
  tool: "apply_changes",
  preview_digest: "b1",
  operations: [
    op(0, "create_skill", "skill", "Навык PR", "create"),
    op(1, "create_environment", "environment", "Песок", "create"),
    op(2, "create_agent", "agent", "Сводка PR", "create", { ref_note: "навык из строки 1" }),
  ],
};

describe("ruObjects", () => {
  it("склоняет «объект»", () => {
    expect(ruObjects(1)).toBe("1 объект");
    expect(ruObjects(2)).toBe("2 объекта");
    expect(ruObjects(5)).toBe("5 объектов");
    expect(ruObjects(11)).toBe("11 объектов");
    expect(ruObjects(21)).toBe("21 объект");
  });
});

describe("batchTitle", () => {
  it("создание, правка, смесь", () => {
    expect(batchTitle(normalizePreview(CREATE_BATCH))).toBe("Создать 3 объекта");
    expect(
      batchTitle(normalizePreview({ operations: [op(0, "update_agent", "agent", "А", "edit"), op(1, "update_environment", "environment", "Е", "edit")] })),
    ).toBe("Изменить 2 объекта");
    expect(
      batchTitle(normalizePreview({ operations: [op(0, "create_skill", "skill", "К", "create"), op(1, "update_agent", "agent", "А", "edit")] })),
    ).toBe("Применить 2 объекта");
  });
  it("заголовок от пользователя в аргументах не подменяет посчитанный сервером", () => {
    expect(batchTitle(normalizePreview({ title: "Создать 3 объекта", operations: [] }))).toBe("Создать 3 объекта");
  });
});

describe("BatchProposalCard", () => {
  const item = proposalItem({
    tool: "apply_changes",
    input: { operations: [] },
  });

  it("показывает каждый объект со своим классом", async () => {
    mockPlatformMcp([CREATE_BATCH]);
    renderInRouter(<BatchProposalCard item={item} sessionId="s1" />);
    expect(await screen.findByText("Создать 3 объекта")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "Объекты пачки" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Создать навык «Навык PR»")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Создание")).toBeInTheDocument();
    expect(within(rows[2]).getByText("навык из строки 1")).toBeInTheDocument();
  });

  it("по клику строка раскрывает YAML", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([CREATE_BATCH]);
    renderInRouter(<BatchProposalCard item={item} sessionId="s1" />);
    await screen.findByText("Создать 3 объекта");
    expect(screen.queryByText(/name: Песок/)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Создать окружение «Песок»/ }));
    expect(screen.getByText(/name: Песок/)).toBeInTheDocument();
  });

  it("правка в строке пачки раскрывается разницей", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([
      { tool: "apply_changes", preview_digest: "b2", operations: [op(0, "update_agent", "agent", "Сводка", "edit", { version_from: 1, version_to: 2 })] },
    ]);
    renderInRouter(<BatchProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: /Изменить агента «Сводка», версия 1 станет 2/ }));
    expect(screen.getByText("a: 1").closest("[data-diff='del']")).not.toBeNull();
    expect(screen.getByText("a: 2").closest("[data-diff='add']")).not.toBeNull();
  });

  it("одна кнопка на всю пачку шлёт отпечаток пачки", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([CREATE_BATCH]);
    renderInRouter(<BatchProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Создать" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ tool_use_id: "tu_1", result: "allow", preview_digest: "b1" });
  });

  it("операция вне v1 выключает кнопку пачки", async () => {
    mockPlatformMcp([
      {
        tool: "apply_changes",
        preview_digest: "b3",
        operations: [op(0, "create_skill", "skill", "К", "create"), op(1, "update_deployment", "deployment", "Д", "out_of_v1")],
      },
    ]);
    renderInRouter(<BatchProposalCard item={item} sessionId="s1" />);
    expect(
      await screen.findByText("Деплоймент работает. В первой версии ассистент меняет только деплоймент на паузе"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
  });

  it("stale на пачке: «Объекты изменились после предложения»", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([CREATE_BATCH, { ...CREATE_BATCH, preview_digest: "b9" }], () => ({
      status: 409,
      body: errorBody("stale"),
    }));
    renderInRouter(<BatchProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Создать" }));
    expect(await screen.findByText("Объекты изменились после предложения")).toBeInTheDocument();
  });

  it("применено: строка на каждый объект", () => {
    renderInRouter(
      <BatchProposalCard
        item={proposalItem({
          tool: "apply_changes",
          phase: "applied",
          applied: [
            { tool: "create_skill", kind: "skill", id: "skl_1", name: "Навык PR", version: 1, action: "create" },
            { tool: "create_agent", kind: "agent", id: "agent_1", name: "Сводка PR", version: null, action: "create" },
          ],
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByRole("link", { name: "Создан навык «Навык PR», версия 1" })).toHaveAttribute("href", "/skills");
    expect(screen.getByRole("link", { name: "Создан агент «Сводка PR»" })).toHaveAttribute("href", "/agents/agent_1");
  });
});
