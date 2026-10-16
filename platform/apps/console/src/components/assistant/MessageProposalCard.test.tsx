import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { MessageProposalCard } from "./MessageProposalCard";
import { errorBody, mockPlatformMcp, proposalItem, renderInRouter } from "./test-fixtures";

const LONG = Array.from({ length: 60 }, (_, i) => `Строка задания ${i + 1}`).join("\n");

const PREVIEW = {
  tool: "send_message",
  preview_digest: "m1",
  operations: [{ index: 0, tool: "send_message", kind: "message", name: "Проверка", class: "edit", target_id: "sesn_2" }],
  message: {
    session_id: "sesn_2",
    session_title: "Проверка",
    text: LONG,
    agent_name: "Сводка PR",
    environment_name: "Песок",
  },
};

describe("MessageProposalCard", () => {
  const item = proposalItem({ tool: "send_message", input: { session_id: "sesn_2", text: "x" } });

  it("заголовок называет сессию", async () => {
    mockPlatformMcp([PREVIEW]);
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    expect(await screen.findByText("Отправить первое сообщение в сессию «Проверка»")).toBeInTheDocument();
  });

  it("показывает полный текст сообщения без сворачивания", async () => {
    mockPlatformMcp([PREVIEW]);
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    await screen.findByText("Отправить первое сообщение в сессию «Проверка»");
    const box = screen.getByLabelText("Текст сообщения");
    expect(box.textContent).toBe(LONG);
    expect(screen.queryByRole("button", { name: "Показать целиком" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Свернуть|Показать/ })).toBeNull();
  });

  it("агент, окружение и строка про немедленный запуск", async () => {
    mockPlatformMcp([PREVIEW]);
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    await screen.findByText("Отправить первое сообщение в сессию «Проверка»");
    expect(screen.getByText("Сводка PR")).toBeInTheDocument();
    expect(screen.getByText("Песок")).toBeInTheDocument();
    expect(screen.getByText("Агент начнёт работу сразу после отправки")).toBeInTheDocument();
  });

  it("текст сообщения выводится как текст, а не как разметка", async () => {
    mockPlatformMcp([{ ...PREVIEW, message: { ...PREVIEW.message, text: "<img src=x onerror=alert(1)> **жирный**" } }]);
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    await screen.findByText("Отправить первое сообщение в сессию «Проверка»");
    const box = screen.getByLabelText("Текст сообщения");
    expect(box.textContent).toBe("<img src=x onerror=alert(1)> **жирный**");
    expect(box.querySelector("img")).toBeNull();
  });

  it("кнопка «Отправить» шлёт отпечаток этой карточки", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([PREVIEW]);
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ result: "allow", preview_digest: "m1" });
  });

  it("409 class: причина про первое сообщение, кнопка выключена", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([PREVIEW], () => ({ status: 409, body: errorBody("class") }));
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Отправить" }));
    expect(
      await screen.findByText("В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
  });

  it("preview уже с классом «вне v1»: то же", async () => {
    mockPlatformMcp([
      { ...PREVIEW, operations: [{ ...PREVIEW.operations[0], class: "out_of_v1" }] },
    ]);
    renderInRouter(<MessageProposalCard item={item} sessionId="s1" />);
    expect(
      await screen.findByText("В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отправить" })).toBeDisabled();
  });

  it("применено: ссылка на сессию", () => {
    renderInRouter(
      <MessageProposalCard
        item={proposalItem({
          tool: "send_message",
          phase: "applied",
          applied: [{ tool: "send_message", kind: "message", id: "sesn_2", name: "Проверка", version: null, action: "create" }],
        })}
        sessionId="s1"
      />,
    );
    expect(screen.getByRole("link", { name: "Отправлено первое сообщение в сессию «Проверка»" })).toHaveAttribute(
      "href",
      "/sessions/sesn_2",
    );
  });
});
