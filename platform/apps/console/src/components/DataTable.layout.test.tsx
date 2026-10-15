import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { I18nProvider } from "../i18n";
import { DataTable, type ColumnDef } from "./DataTable";

type Row = { id: string; name: string; model: string; version: string; created: string };

const columns: ColumnDef<Row, unknown>[] = [
  { id: "name", accessorKey: "name", header: "Название", size: 240, meta: { grow: true }, enableHiding: false },
  { id: "model", accessorKey: "model", header: "Модель", size: 200, meta: { priority: 1 } },
  { id: "version", accessorKey: "version", header: "Версия", size: 160, meta: { priority: 2 } },
  { id: "created", accessorKey: "created", header: "Создано", size: 120 },
];

const data: Row[] = [
  { id: "a1", name: "Документовед", model: "claude-sonnet-4-6", version: "15.10.2026 17:45", created: "15.10.2026" },
];

function setPhone(phone: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: phone,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

/** ResizeObserver, который сразу сообщает заданную ширину карточки. */
function stubCardWidth(width: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <I18nProvider>
        <DataTable<Row>
          columns={columns}
          data={data}
          getRowId={(row) => row.id}
          title="Агенты"
          subtitle="Агенты выполняют задачи по вашим инструкциям."
          {...props}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setPhone(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("DataTable page header", () => {
  it("opens with the page h1 and description above the list card", () => {
    renderTable({ createLabel: "Новый агент", onCreate: () => undefined });

    const heading = screen.getByRole("heading", { level: 1, name: "Агенты" });
    expect(screen.getByText("Агенты выполняют задачи по вашим инструкциям.")).toBeInTheDocument();
    const listRoot = screen.getByTestId("data-table-list-root");
    expect(listRoot).not.toContainElement(heading);
    expect(heading.compareDocumentPosition(listRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("data-table-page")).toContainElement(listRoot);
  });

  it("puts the main action first in the page header, before the secondary ones", () => {
    renderTable({
      createLabel: "Новый навык",
      onCreate: () => undefined,
      headerActions: <button type="button">Установить по ссылке</button>,
    });

    const header = screen.getByRole("banner");
    const labels = within(header)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["Новый навык", "Установить по ссылке"]);
    expect(within(screen.getByRole("toolbar")).queryByRole("button", { name: "Новый навык" })).toBeNull();
  });

  it("keeps search and filters in the toolbar under the header", () => {
    renderTable({ onSearchChange: () => undefined, searchValue: "", searchPlaceholder: "Поиск агентов…" });

    expect(within(screen.getByRole("toolbar")).getByPlaceholderText("Поиск агентов…")).toBeInTheDocument();
  });
});

describe("DataTable columns", () => {
  it("lets the growing column take the free width and fixes the rest", () => {
    renderTable();

    const widths = Array.from(
      screen.getByTestId("data-body-table").querySelectorAll("col"),
      (col) => col.getAttribute("style"),
    );
    expect(widths).toEqual([null, "width: 200px;", "width: 160px;", "width: 120px;"]);
  });

  it("hides secondary columns, the largest priority number first, until the table fits the card", () => {
    // Карточка 640px, внутри 600px: все столбцы дают 720px. Первой уходит
    // «Версия» (priority 2), без неё 560px, и «Модель» (priority 1) остаётся.
    stubCardWidth(640);
    renderTable({ defaultHiddenColumns: [] });

    const headers = Array.from(
      screen.getByTestId("data-header-table").querySelectorAll("thead th"),
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Название", "Модель", "Создано"]);
    const cells = Array.from(
      screen.getByTestId("data-body-table").querySelectorAll("tbody tr:first-child td"),
      (td) => td.textContent,
    );
    expect(cells).toEqual(["Документовед", "claude-sonnet-4-6", "15.10.2026"]);
  });

  it("keeps every column when the card is wide enough", () => {
    stubCardWidth(1100);
    renderTable({ defaultHiddenColumns: [] });

    const headers = Array.from(
      screen.getByTestId("data-header-table").querySelectorAll("thead th"),
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Название", "Модель", "Версия", "Создано"]);
  });

  it("does not offer the column menu on a phone, where the list is a stack of cards", () => {
    setPhone(true);
    renderTable();

    expect(screen.queryByRole("button", { name: /Столбцы/ })).toBeNull();
    expect(screen.getByTestId("data-stack")).toBeInTheDocument();
  });

  it("hides an empty toolbar instead of leaving a blank 64px strip", async () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(styles).toMatch(/\.console-list-toolbar:empty\s*\{[^}]*display: none;/);
    await act(async () => undefined);
  });
});
