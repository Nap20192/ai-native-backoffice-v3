import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DescribeAgentBox } from "./DescribeAgentBox";

describe("DescribeAgentBox", () => {
  it("спрашивает «Что хотите построить?» и подсказывает примером", () => {
    render(<DescribeAgentBox onSubmit={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Что хотите построить?" })).toHaveAttribute(
      "placeholder",
      expect.stringContaining("раз в день собирает новые заявки"),
    );
  });

  it("кнопка «Сгенерировать» выключена, пока поле пустое", async () => {
    render(<DescribeAgentBox onSubmit={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Сгенерировать" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "   ");
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox"), "Сводка заявок");
    expect(button).toBeEnabled();
  });

  it("отправляет обрезанный текст кнопкой и Enter, Shift+Enter переносит строку", async () => {
    const onSubmit = vi.fn();
    render(<DescribeAgentBox onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "  Сводка заявок  ");
    await userEvent.click(screen.getByRole("button", { name: "Сгенерировать" }));
    expect(onSubmit).toHaveBeenCalledWith("Сводка заявок");

    await userEvent.clear(box);
    await userEvent.type(box, "Первая{Shift>}{Enter}{/Shift}вторая");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenLastCalledWith("Первая\nвторая");
  });

  it("не отправляет во время набора через IME", async () => {
    const onSubmit = vi.fn();
    render(<DescribeAgentBox onSubmit={onSubmit} />);
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "текст");
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true });
    box.dispatchEvent(event);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("берёт стартовый текст из defaultValue", () => {
    render(<DescribeAgentBox onSubmit={vi.fn()} defaultValue="Уже написано" />);
    expect(screen.getByRole("textbox")).toHaveValue("Уже написано");
  });
});
