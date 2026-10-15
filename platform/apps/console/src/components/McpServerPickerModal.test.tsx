import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { McpServerPickerModal } from "./McpServerPickerModal";

function renderPicker(props: Partial<React.ComponentProps<typeof McpServerPickerModal>> = {}) {
  const onClose = vi.fn();
  const onPick = vi.fn();
  render(<McpServerPickerModal open onClose={onClose} onPick={onPick} {...props} />);
  return { onClose, onPick };
}

describe("McpServerPickerModal", () => {
  it("is a Russian dialog with a search field", () => {
    renderPicker();

    const dialog = screen.getByRole("dialog", { name: "Выбор MCP-сервера" });
    expect(dialog).toHaveAccessibleDescription("Реестр известных MCP-серверов.");
    expect(within(dialog).getByRole("searchbox", { name: "Поиск сервисов" })).toBeInTheDocument();
  });

  it("picks a known server and closes itself", async () => {
    const { onPick, onClose } = renderPicker();

    await userEvent.click(screen.getByRole("button", { name: /Airtable/ }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "airtable" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("marks a server that is already in the form and refuses to pick it twice", async () => {
    const { onPick } = renderPicker({ alreadyAddedUrls: ["https://mcp.airtable.com/mcp"] });

    const row = screen.getByRole("button", { name: /Airtable/ });
    expect(row).toBeDisabled();
    expect(row).toHaveTextContent("Добавлен");

    await userEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("filters by name and explains an empty result in Russian", async () => {
    renderPicker();
    const search = screen.getByRole("searchbox", { name: "Поиск сервисов" });

    await userEvent.type(search, "amplit");
    expect(screen.getByRole("button", { name: /Amplitude/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Airtable/ })).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "яяяяя");
    expect(screen.getByText(/Ничего не найдено/)).toBeInTheDocument();
  });
});
