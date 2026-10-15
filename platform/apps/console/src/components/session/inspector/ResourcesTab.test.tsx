import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";

const api = vi.hoisted(() => ({
  sessions: { resources: { list: vi.fn(), add: vi.fn() } },
  files: { upload: vi.fn() },
}));
vi.mock("../../../lib/useManagedApi", () => ({ useManagedApi: () => api }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { ResourcesTab } from "./ResourcesTab";

const fileResource = {
  id: "sesrsc_1",
  type: "file",
  file_id: "file_1",
  mount_path: "/mnt/session/uploads/file_1",
  created_at: "2026-10-15T00:00:00.000Z",
  updated_at: "2026-10-15T00:00:00.000Z",
};
const repoResource = {
  id: "sesrsc_2",
  type: "github_repository",
  url: "https://github.com/acme/app",
  mount_path: "/workspace/app",
  created_at: "2026-10-15T00:00:00.000Z",
  updated_at: "2026-10-15T00:00:00.000Z",
};
const memoryResource = {
  id: "sesrsc_3",
  type: "memory_store",
  memory_store_id: "memstore_1",
  name: "Предпочтения",
  mount_path: "/mnt/memory/preferences",
};

function outputs(data: unknown[] | "error") {
  server.use(
    http.get("*/v1/sessions/s1/outputs", () =>
      data === "error"
        ? HttpResponse.json({ error: { type: "api_error", message: "x" } }, { status: 500 })
        : HttpResponse.json({ data, has_more: false }),
    ),
  );
}

const report = {
  filename: "SMR_report.md",
  size_bytes: 18_022,
  uploaded_at: "2026-10-16T01:00:00.000Z",
  media_type: "text/markdown",
};

beforeEach(() => {
  api.sessions.resources.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  api.sessions.resources.add.mockReset().mockResolvedValue({});
  api.files.upload.mockReset().mockResolvedValue({ id: "file_new", filename: "a.txt" });
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("ResourcesTab: список", () => {
  it("пока грузится, показывает скелетон для диктора", () => {
    api.sessions.resources.list.mockReturnValue(new Promise(() => {}));
    outputs([]);

    render(<ResourcesTab sessionId="s1" />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Загрузка ресурсов…");
  });

  it("рисует таблицу «Путь» и «Размер»: ресурсы по точке монтирования, выходные файлы с размером", async () => {
    api.sessions.resources.list.mockResolvedValue({
      data: [fileResource, repoResource, memoryResource],
      next_page: null,
    });
    outputs([report]);

    render(<ResourcesTab sessionId="s1" />);

    expect(await screen.findByText("/mnt/session/outputs/SMR_report.md")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Путь" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Размер" })).toBeInTheDocument();
    expect(screen.getByText("/mnt/session/uploads/file_1")).toHaveClass("font-mono");
    expect(screen.getByText("/workspace/app")).toBeInTheDocument();
    expect(screen.getByText("/mnt/memory/preferences")).toBeInTheDocument();
    const outputRow = screen.getByText("/mnt/session/outputs/SMR_report.md").closest("tr")!;
    expect(within(outputRow).getByText("17,6 КБ")).toBeInTheDocument();
  });

  it("выходной файл скачивается по клику на строку: ссылка с download и именем в адресе", async () => {
    outputs([{ ...report, filename: "отчёт 1.md" }]);

    render(<ResourcesTab sessionId="s1" />);

    const link = await screen.findByRole("link", { name: "/mnt/session/outputs/отчёт 1.md" });
    expect(link).toHaveAttribute("href", "/v1/sessions/s1/outputs/%D0%BE%D1%82%D1%87%D1%91%D1%82%201.md");
    expect(link).toHaveAttribute("download", "отчёт 1.md");
  });

  it("поиск «Найти ресурс» оставляет строки с совпадением в пути", async () => {
    api.sessions.resources.list.mockResolvedValue({ data: [fileResource, repoResource], next_page: null });
    outputs([report]);

    render(<ResourcesTab sessionId="s1" />);
    await screen.findByText("/workspace/app");

    await userEvent.type(screen.getByRole("searchbox", { name: "Найти ресурс" }), "WORKSPACE");

    expect(screen.getByText("/workspace/app")).toBeInTheDocument();
    expect(screen.queryByText("/mnt/session/uploads/file_1")).toBeNull();
    expect(screen.queryByText("/mnt/session/outputs/SMR_report.md")).toBeNull();
  });

  it("поиск без совпадений говорит об этом", async () => {
    api.sessions.resources.list.mockResolvedValue({ data: [fileResource], next_page: null });
    outputs([]);

    render(<ResourcesTab sessionId="s1" />);
    await screen.findByText("/mnt/session/uploads/file_1");

    await userEvent.type(screen.getByRole("searchbox", { name: "Найти ресурс" }), "нет такого");

    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("без ресурсов и файлов показывает пустое состояние", async () => {
    outputs([]);

    render(<ResourcesTab sessionId="s1" />);

    expect(await screen.findByText("Ресурсов пока нет")).toBeInTheDocument();
  });

  it("если список выходных файлов не отдался, ресурсы всё равно видны", async () => {
    api.sessions.resources.list.mockResolvedValue({ data: [fileResource], next_page: null });
    outputs("error");

    render(<ResourcesTab sessionId="s1" />);

    expect(await screen.findByText("/mnt/session/uploads/file_1")).toBeInTheDocument();
  });

  it("при ошибке загрузки ресурсов предлагает повторить", async () => {
    api.sessions.resources.list.mockRejectedValueOnce(new Error("нет"));
    outputs([]);

    render(<ResourcesTab sessionId="s1" />);

    expect(await screen.findByText("Не удалось загрузить ресурсы")).toBeInTheDocument();
    api.sessions.resources.list.mockResolvedValue({ data: [fileResource], next_page: null });
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));

    expect(await screen.findByText("/mnt/session/uploads/file_1")).toBeInTheDocument();
  });
});

describe("ResourcesTab: добавление", () => {
  it("меню «Добавить ресурс»: файл доступен, репозиторий и хранилище памяти только при создании", async () => {
    outputs([]);
    render(<ResourcesTab sessionId="s1" />);
    await screen.findByText("Ресурсов пока нет");

    await userEvent.click(screen.getByRole("button", { name: "Добавить ресурс" }));

    expect(await screen.findByRole("menuitem", { name: "Файл" })).not.toHaveAttribute("aria-disabled", "true");
    const repo = screen.getByRole("menuitem", { name: /Репозиторий GitHub/ });
    const memory = screen.getByRole("menuitem", { name: /Хранилище памяти/ });
    expect(repo).toHaveAttribute("aria-disabled", "true");
    expect(memory).toHaveAttribute("aria-disabled", "true");
    expect(repo).toHaveTextContent("Только при создании сессии");
    expect(memory).toHaveTextContent("Только при создании сессии");
  });

  it("выбранный файл загружается, добавляется в сессию, и список обновляется", async () => {
    outputs([]);
    const { container } = render(<ResourcesTab sessionId="s1" />);
    await screen.findByText("Ресурсов пока нет");
    api.sessions.resources.list.mockResolvedValue({
      data: [{ ...fileResource, mount_path: "/mnt/session/uploads/file_new" }],
      next_page: null,
    });

    const file = new File(["данные"], "a.txt", { type: "text/plain" });
    await userEvent.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    await waitFor(() => expect(api.files.upload).toHaveBeenCalledWith({ file }));
    await waitFor(() =>
      expect(api.sessions.resources.add).toHaveBeenCalledWith("s1", { type: "file", file_id: "file_new" }),
    );
    expect(await screen.findByText("/mnt/session/uploads/file_new")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Файл добавлен");
  });

  it("если загрузка не удалась, сообщает и список не трогает", async () => {
    outputs([]);
    api.files.upload.mockRejectedValue(new Error("нет"));
    const { container } = render(<ResourcesTab sessionId="s1" />);
    await screen.findByText("Ресурсов пока нет");

    await userEvent.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["x"], "a.txt"),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Не удалось добавить файл"));
    expect(api.sessions.resources.add).not.toHaveBeenCalled();
  });
});
