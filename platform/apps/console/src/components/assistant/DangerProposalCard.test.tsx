import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ProposalCard } from "./ProposalCard";
import { mockPlatformMcp, proposalItem, renderInRouter } from "./test-fixtures";

// Красная карточка опасной операции помощника (docs/plans/crud.md, 3.4).

const SID = "sesn_chat";

const DELETE_FILE_PREVIEW = {
  tool: "delete_object",
  class: "danger",
  preview_digest: "del1",
  irreversible: true,
  operations: [
    {
      op_index: 0,
      tool: "delete_object",
      target_kind: "file",
      target_id: "file_1",
      class: "danger",
      name: null,
      before_yaml: "id: file_1\nfilename: report.txt\n",
      after_yaml: "null\n",
      warnings: [],
      irreversible: true,
      details: { card: { operation: "delete", kind: "file", id: "file_1" }, note: "Это нельзя отменить" },
      dependencies: {
        blocking: [],
        affected: [{ kind: "session", id: "sesn_old", name: "Старая сессия", status: "terminated", note: null }],
        truncated: false,
      },
    },
  ],
};

const ARCHIVE_SESSION_PREVIEW = {
  tool: "archive_object",
  class: "danger",
  preview_digest: "arc1",
  operations: [
    {
      op_index: 0,
      tool: "archive_object",
      target_kind: "session",
      target_id: "sesn_1",
      class: "danger",
      name: "Отчёт",
      before_yaml: "title: Отчёт\narchived_at: null\n",
      after_yaml: "title: Отчёт\narchived_at: при подтверждении\n",
      warnings: [],
      irreversible: false,
      details: { card: { operation: "archive", kind: "session", id: "sesn_1" }, note: "Объект можно вернуть из архива" },
      dependencies: { blocking: [], affected: [], truncated: false },
    },
  ],
};

const BLOCKED_PREVIEW = {
  tool: "delete_object",
  class: "out_of_v1",
  reason: "Сначала уберите зависимости",
  preview_digest: "blk1",
  irreversible: true,
  operations: [
    {
      op_index: 0,
      tool: "delete_object",
      target_kind: "environment",
      target_id: "env_1",
      class: "out_of_v1",
      reason: "Сначала уберите зависимости",
      name: "Песок",
      warnings: [],
      irreversible: true,
      details: { card: { operation: "delete", kind: "environment", id: "env_1" }, note: "Это нельзя отменить" },
      dependencies: {
        blocking: [{ kind: "session", id: "sesn_live", name: "Живая", status: "idle", note: null }],
        affected: [],
        truncated: false,
      },
    },
  ],
};

describe("ProposalCard: опасная операция", () => {
  it("удаление: красная карточка, «Опасное», список «Затронет», «Это нельзя отменить», кнопка «Удалить»", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([DELETE_FILE_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "delete_object", input: { kind: "file", id: "file_1" } })} sessionId={SID} />);
    const card = await screen.findByRole("article", { name: "Удалить файл file_1" });
    expect(card).toHaveAttribute("data-danger", "true");
    expect(within(card).getByText("Опасное")).toBeInTheDocument();
    expect(within(card).getByText("Это нельзя отменить")).toBeInTheDocument();
    const affected = within(card).getByRole("region", { name: "Затронет" });
    expect(within(affected).getByText(/Старая сессия/)).toBeInTheDocument();
    expect(within(card).queryByRole("region", { name: "Мешает" })).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ result: "allow", preview_digest: "del1", tool_use_id: "tu_1" });
  });

  it("архив: заголовок «Архивировать», строка про возврат из архива, кнопка «В архив»", async () => {
    mockPlatformMcp([ARCHIVE_SESSION_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "archive_object", input: { kind: "session", id: "sesn_1" } })} sessionId={SID} />);
    const card = await screen.findByRole("article", { name: "Архивировать сессию «Отчёт»" });
    expect(card).toHaveAttribute("data-danger", "true");
    expect(within(card).getByText("Объект можно вернуть из архива")).toBeInTheDocument();
    expect(within(card).queryByText("Это нельзя отменить")).toBeNull();
    expect(within(card).getByRole("button", { name: "В архив" })).toBeEnabled();
  });

  it("блокирующие зависимости: список «Мешает», причина, кнопки подтверждения нет", async () => {
    mockPlatformMcp([BLOCKED_PREVIEW]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "delete_object", input: { kind: "environment", id: "env_1" } })} sessionId={SID} />);
    const card = await screen.findByRole("article", { name: "Удалить окружение «Песок»" });
    const blocking = within(card).getByRole("region", { name: "Мешает" });
    expect(within(blocking).getByText(/Живая/)).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent("Сначала уберите зависимости");
    expect(within(card).queryByRole("button", { name: "Удалить" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Отклонить" })).toBeEnabled();
  });

  it("возврат из архива это правка: карточка не красная, кнопка «Вернуть из архива»", async () => {
    mockPlatformMcp([
      {
        tool: "unarchive_object",
        class: "update",
        preview_digest: "un1",
        operations: [
          {
            op_index: 0,
            tool: "unarchive_object",
            target_kind: "agent",
            target_id: "agent_1",
            class: "update",
            name: "Сводка",
            before_yaml: "archived_at: '2026-10-01'\n",
            after_yaml: "archived_at: null\n",
            warnings: [],
            details: { card: { operation: "unarchive", kind: "agent", id: "agent_1" } },
          },
        ],
      },
    ]);
    renderInRouter(<ProposalCard item={proposalItem({ tool: "unarchive_object", input: { kind: "agent", id: "agent_1" } })} sessionId={SID} />);
    const card = await screen.findByRole("article", { name: "Вернуть из архива агента «Сводка»" });
    expect(card).not.toHaveAttribute("data-danger");
    expect(within(card).getByRole("button", { name: "Вернуть из архива" })).toBeEnabled();
  });
});
