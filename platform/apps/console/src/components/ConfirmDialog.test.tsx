import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmDialog } from "./ConfirmDialog";

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Удалить навык?"
      message="Действие нельзя отменить."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe("ConfirmDialog", () => {
  it("asks the question and reads the message from the dialog description", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Удалить навык?" });
    expect(dialog).toHaveAccessibleDescription("Действие нельзя отменить.");
  });

  it("offers a ghost cancel and a primary action with Russian default labels", async () => {
    const { onConfirm, onCancel } = renderDialog();

    const cancel = screen.getByRole("button", { name: "Отмена" });
    const confirm = screen.getByRole("button", { name: "Подтвердить" });
    expect(cancel).toHaveClass("h-10", "text-ddc-ghost-text");
    expect(confirm).toHaveClass("h-10", "bg-ddc-primary");

    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
    await userEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("paints a destructive action with the danger button", () => {
    renderDialog({ destructive: true, confirmLabel: "Удалить" });

    expect(screen.getByRole("button", { name: "Удалить" })).toHaveClass("bg-ddc-danger", "text-white");
  });

  it("locks both buttons, keeps the label and refuses to close while busy", async () => {
    const { onCancel } = renderDialog({ busy: true, destructive: true, confirmLabel: "Удалить" });

    const confirm = screen.getByRole("button", { name: /Удалить/ });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(confirm).toHaveTextContent("Удалить");
    expect(screen.getByRole("button", { name: "Отмена" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Закрыть" })).toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes on Escape when idle", async () => {
    const { onCancel } = renderDialog();

    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("has no body band between the header and the footer", () => {
    renderDialog();

    expect(document.querySelector("[data-console-modal-body]")).toBeNull();
    const header = document.querySelector('[data-slot="dialog-header"]');
    expect(header?.className).not.toContain("border-b");
  });
});
