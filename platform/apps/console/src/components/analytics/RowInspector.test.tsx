import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { RowInspector } from "./RowInspector";

function Harness({
  onPrev = vi.fn(),
  onNext = vi.fn(),
  width = "request",
  prevDisabled = false,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  width?: "request" | "limit";
  prevDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" data-row-id="r1" onClick={() => setOpen(true)}>
        Строка r1
      </button>
      {open && (
        <RowInspector
          title="Запрос"
          subtitle="sevt_01"
          width={width}
          onClose={() => setOpen(false)}
          onPrev={onPrev}
          onNext={onNext}
          prevDisabled={prevDisabled}
          returnFocusSelector='[data-row-id="r1"]'
        >
          <p>Содержимое карточки</p>
        </RowInspector>
      )}
    </div>
  );
}

describe("RowInspector", () => {
  it("правая панель: dialog, не модальная, с крошкой и содержимым", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Строка r1" }));
    const dialog = screen.getByRole("dialog", { name: /Запрос/ });
    expect(dialog).toHaveAttribute("aria-modal", "false");
    expect(dialog).toHaveClass("fixed", "md:w-[560px]");
    expect(screen.getByText("sevt_01")).toBeInTheDocument();
    expect(screen.getByText("Содержимое карточки")).toBeInTheDocument();
  });

  it("панель квоты шире: 680 px", async () => {
    const user = userEvent.setup();
    render(<Harness width="limit" />);
    await user.click(screen.getByRole("button", { name: "Строка r1" }));
    expect(screen.getByRole("dialog")).toHaveClass("md:w-[680px]");
  });

  it("на узком экране занимает всю ширину с отступом 8 px", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Строка r1" }));
    expect(screen.getByRole("dialog")).toHaveClass("max-md:left-2", "right-2", "top-2");
  });

  it("кнопки «Предыдущая», «Следующая» и «Закрыть» работают", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<Harness onPrev={onPrev} onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: "Строка r1" }));
    await user.click(screen.getByRole("button", { name: "Предыдущая" }));
    await user.click(screen.getByRole("button", { name: "Следующая" }));
    expect(onPrev).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("на краю списка «Предыдущая» отключена", async () => {
    const user = userEvent.setup();
    render(<Harness prevDisabled />);
    await user.click(screen.getByRole("button", { name: "Строка r1" }));
    expect(screen.getByRole("button", { name: "Предыдущая" })).toBeDisabled();
  });

  it("Escape закрывает панель и возвращает фокус на строку списка", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const row = screen.getByRole("button", { name: "Строка r1" });
    await user.click(row);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row).toHaveFocus();
  });
});
