import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { I18nProvider } from "../i18n";
import { DataTable, type ColumnDef } from "./DataTable";

type Row = { id: string; name: string; status: string };

const columns: ColumnDef<Row, unknown>[] = [
  { id: "name", accessorKey: "name", header: "Название", size: 240, enableHiding: false },
  { id: "id", accessorKey: "id", header: "ID", size: 160 },
  { id: "status", accessorKey: "status", header: "Статус", size: 120 },
];

const data: Row[] = [{ id: "agent-1", name: "Researcher", status: "active" }];

function setViewport(phone: boolean) {
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

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <I18nProvider>
        <DataTable<Row>
          columns={columns}
          data={data}
          getRowId={(row) => row.id}
          title="Агенты"
          {...props}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  setViewport(false);
});

afterEach(() => {
  localStorage.clear();
});

describe("DataTable: столбец ID", () => {
  it("скрывает ID по умолчанию и оставляет название первым", () => {
    renderTable();

    const headers = Array.from(
      screen.getByTestId("data-header-table").querySelectorAll("thead th"),
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Название", "Статус"]);
    expect(screen.queryByText("agent-1")).not.toBeInTheDocument();
  });

  it("показывает ID, когда список просит ничего не скрывать", () => {
    renderTable({ defaultHiddenColumns: [] });

    const headers = Array.from(
      screen.getByTestId("data-header-table").querySelectorAll("thead th"),
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Название", "ID", "Статус"]);
  });

  it("предлагает включить ID в меню столбцов", () => {
    renderTable();

    expect(screen.getByRole("button", { name: /Столбцы/ })).toBeInTheDocument();
  });
});

describe("DataTable на телефоне", () => {
  beforeEach(() => setViewport(true));

  it("рисует стопку карточек вместо таблицы со шапкой и горизонтальной прокруткой", () => {
    renderTable();

    expect(screen.getByTestId("data-stack")).toBeInTheDocument();
    expect(screen.queryByTestId("data-body-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("data-header-table")).not.toBeInTheDocument();
    expect(document.querySelector("table")).toBeNull();
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
  });

  it("берёт заголовком карточки первый видимый столбец, остальные идут парами подпись и значение", () => {
    renderTable();

    const card = screen.getByTestId("data-stack-row");
    expect(card.querySelector(".console-stack-title")).toHaveTextContent("Researcher");
    const field = card.querySelector(".console-stack-field") as HTMLElement;
    expect(within(field).getByText("Статус")).toBeInTheDocument();
    expect(field.querySelector("dd")).toHaveTextContent("active");
    expect(within(card).queryByText("agent-1")).not.toBeInTheDocument();
  });

  it("открывает строку по нажатию и по Enter", () => {
    const onRowClick = vi.fn();
    renderTable({ onRowClick });

    const card = screen.getByTestId("data-stack-row");
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: "Enter" });

    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenCalledWith(data[0]);
  });

  it("даёт видимую кнопку действий строки, которая не открывает строку", () => {
    const onRowClick = vi.fn();
    renderTable({
      onRowClick,
      rowActions: () => [{ label: "В архив", onSelect: () => undefined }],
    });

    const actions = screen.getByRole("button", { name: "Действия" });
    fireEvent.click(actions);

    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("показывает скелетон карточек, пока идёт загрузка", () => {
    renderTable({ loading: true, data: [] });

    expect(screen.getByTestId("data-stack")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("data-stack-row")).not.toBeInTheDocument();
  });
});

describe("DataTable: стили списка", () => {
  const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

  it("делает список карточкой DDC без градиента на самой карточке", () => {
    const rule = styles.match(/\.console-list-root\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("border: 1px solid var(--ddc-border);");
    expect(rule).toContain("background: var(--ddc-surface);");
    expect(rule).toContain("overflow: hidden;");
    expect(rule).not.toContain("gradient");
  });

  it("на телефоне переносит панель и растягивает поиск, без горизонтальной прокрутки панели", () => {
    const phone = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    expect(phone).toMatch(/\.console-list-toolbar\s*\{[^}]*flex-wrap: wrap;[^}]*overflow: visible;/);
    expect(phone).toMatch(/\.console-list-search\s*\{[^}]*width: 100%;/);
    expect(phone).not.toContain("overflow-x: auto");
  });
});
