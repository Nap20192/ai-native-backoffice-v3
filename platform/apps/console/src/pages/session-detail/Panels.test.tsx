import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock("../../lib/api", () => ({
  useApi: () => ({ api: apiMock }),
}));

import { FilesPanel, ResourcePanel } from "./Panels";

beforeEach(() => {
  apiMock.mockReset();
});

describe("FilesPanel", () => {
  it("показывает размер файла русскими единицами и дату в формате dd.MM.yyyy HH:mm", async () => {
    apiMock.mockResolvedValue({
      data: [
        {
          filename: "отчёт.csv",
          size_bytes: 1536,
          uploaded_at: "2026-10-15T09:30:00.000Z",
          media_type: "text/csv",
        },
      ],
      has_more: false,
    });

    render(<FilesPanel sessionId="sess_1" onClose={() => {}} />);

    expect(await screen.findByText("отчёт.csv")).toBeInTheDocument();
    expect(screen.getByText(/1,5 КБ/)).toBeInTheDocument();
    expect(screen.getByText(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/)).toBeInTheDocument();
    expect(screen.queryByText(/\bKB\b/)).toBeNull();
  });

  it("для пустого списка показывает пустое состояние после загрузки", async () => {
    apiMock.mockResolvedValue({ data: [], has_more: false });

    render(<FilesPanel sessionId="sess_1" onClose={() => {}} />);

    expect(await screen.findByText("Файлов пока нет")).toBeInTheDocument();
  });

  it("пока файлы грузятся, показывает скелетон, а не пустое состояние", () => {
    apiMock.mockReturnValue(new Promise(() => {}));

    render(<FilesPanel sessionId="sess_1" onClose={() => {}} />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Файлов пока нет")).toBeNull();
  });

  it("при ошибке пишет по-русски и подписывает кнопку закрытия", async () => {
    apiMock.mockRejectedValue(new Error("boom"));

    render(<FilesPanel sessionId="sess_1" onClose={() => {}} />);

    expect(await screen.findByText("Не удалось загрузить")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть панель" })).toBeInTheDocument();
  });

  it("на узком экране ложится поверх рабочей области, шире xl стоит справа", () => {
    apiMock.mockReturnValue(new Promise(() => {}));

    render(<FilesPanel sessionId="sess_1" onClose={() => {}} />);

    const panel = screen.getByRole("complementary", { name: "Файлы сессии" });
    expect(panel).toHaveClass("absolute", "inset-0", "xl:static", "xl:w-[420px]");
  });
});

describe("ResourcePanel", () => {
  it("называет вид ресурса и ведёт по русской ссылке на карточку", async () => {
    apiMock.mockResolvedValue({ name: "Помощник по отпускам", description: "Оформляет заявки" });

    render(
      <MemoryRouter>
        <ResourcePanel panel={{ kind: "agent", id: "agent_1" }} onClose={() => {}} />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Помощник по отпускам")).toBeInTheDocument();
    expect(screen.getByText("Агент")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Открыть агента/ })).toHaveAttribute("href", "/agents/agent_1");
  });
});
