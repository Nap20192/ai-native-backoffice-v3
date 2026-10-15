import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { CommandPalette } from "./CommandPalette";
import { Modal } from "./Modal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("Linear global surfaces", () => {
  it("centres modals as a DDC card under a dimmed, blurred backdrop", () => {
    render(
      <Modal open onClose={() => undefined} title="Create agent" footer={<button>Save</button>}>
        Form
      </Modal>,
    );

    const dialog = screen.getByRole("dialog");
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    const header = dialog.querySelector('[data-slot="dialog-header"]');
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');

    expect(dialog).toHaveClass("top-1/2", "left-1/2", "-translate-x-1/2", "-translate-y-1/2");
    expect(dialog).not.toHaveClass("top-[var(--overlay-top)]");
    expect(dialog).toHaveClass("rounded-2xl", "border-ddc-border", "bg-ddc-surface", "shadow-card");
    expect(overlay).toHaveClass("bg-ddc-overlay", "backdrop-blur-xs");
    expect(overlay).not.toHaveClass("bg-transparent");
    expect(header).toHaveClass("border-b", "border-ddc-divider");
    expect(footer).toHaveClass("border-t", "border-ddc-divider", "bg-ddc-footer");
    expect(header).toHaveClass("px-6", "pt-5", "pb-4");
    expect(dialog.querySelector('[data-console-modal-body]')).toHaveClass("px-6", "py-5");
    expect(footer).toHaveClass("px-6", "py-4");
  });

  it("closes through a Russian-labelled button", () => {
    render(
      <Modal open onClose={() => undefined} title="Create agent">
        Form
      </Modal>,
    );

    expect(screen.getByRole("button", { name: "Закрыть" })).toBeInTheDocument();
  });

  it("keeps intent groups stable and does not print shortcut badges", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/agents"]}>
        <I18nProvider>
          <CommandPalette />
        </I18nProvider>
      </MemoryRouter>,
    );

    await user.keyboard("{Control>}k{/Control}");

    const headings = screen
      .getAllByText(/^(Недавние|Действия|Переходы)$/)
      .map((node) => node.textContent);
    expect(headings).toEqual(["Недавние", "Действия", "Переходы"]);
    expect(document.querySelector('[data-slot="command-shortcut"]')).toBeNull();
  });

  it("uses the shared Linear action-row and popover geometry for menus", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(document.querySelector('[data-slot="dropdown-menu-content"]'))
      .toHaveClass("rounded-[var(--console-radius-popover)]");
    expect(screen.getByRole("menuitem", { name: "Archive" }))
      .toHaveClass("h-[var(--menu-action-row-h)]");
  });
});
