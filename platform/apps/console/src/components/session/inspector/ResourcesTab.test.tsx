import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

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

  it("если загрузка файла в сессию не удалась, сообщает и список не трогает", async () => {
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

describe("ResourcesTab: файлы агента", () => {
  // Ответы GET /v1/sessions/s1/outputs/:name и то, с каким beta-заголовком
  // пришёл каждый запрос: ссылка браузера заголовков не шлёт, а сервер без
  // anthropic-beta отвечает 400.
  function serveOutput(body: string | Uint8Array, type: string, status = 200) {
    const seen: { name: string; beta: string | null }[] = [];
    server.use(
      http.get("*/v1/sessions/s1/outputs/:name", ({ request, params }) => {
        seen.push({ name: decodeURIComponent(String(params.name)), beta: request.headers.get("anthropic-beta") });
        return status === 200
          ? new HttpResponse(body, { headers: { "content-type": type } })
          : HttpResponse.json({ error: { type: "api_error", message: "сбой" } }, { status });
      }),
    );
    return seen;
  }

  const saved: { download: string; href: string }[] = [];
  let anchorClick: MockInstance<() => void>;

  beforeEach(() => {
    saved.length = 0;
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ download: this.download, href: this.getAttribute("href") ?? "" });
    });
  });

  afterEach(() => {
    anchorClick.mockRestore();
  });

  it("у файла агента нет ссылки на адрес API: строка открывает просмотр", async () => {
    outputs([{ ...report, filename: "отчёт 1.md" }]);

    render(<ResourcesTab sessionId="s1" />);

    expect(await screen.findByRole("button", { name: "/mnt/session/outputs/отчёт 1.md" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("«Скачать» берёт файл через API с beta-заголовком и сохраняет его под своим именем", async () => {
    outputs([{ ...report, filename: "отчёт 1.md" }]);
    const seen = serveOutput("# Отчёт", "text/markdown");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Скачать отчёт 1.md" }));

    await waitFor(() => expect(saved).toEqual([{ download: "отчёт 1.md", href: "blob:preview" }]));
    expect(seen).toEqual([{ name: "отчёт 1.md", beta: expect.stringContaining("managed-agents-2026-04-01") }]);
  });

  it("если файл не скачался, сообщает об ошибке", async () => {
    outputs([report]);
    serveOutput("", "text/plain", 500);

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Скачать SMR_report.md" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Не удалось скачать файл SMR_report.md"));
    expect(saved).toEqual([]);
  });

  it("текстовый файл открывается в окне просмотра с содержимым и кнопкой «Скачать»", async () => {
    outputs([report]);
    serveOutput("# Итоги\nСумма 500 000", "text/markdown");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/SMR_report.md" }));

    const dialog = await screen.findByRole("dialog", { name: "SMR_report.md" });
    expect(await within(dialog).findByText(/Сумма 500 000/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Скачать" }));
    await waitFor(() => expect(saved).toEqual([{ download: "SMR_report.md", href: "blob:preview" }]));
  });

  it("HTML показывается как текст, страница не открывается", async () => {
    outputs([{ filename: "page.html", size_bytes: 48 }]);
    serveOutput("<script>alert(1)</script><b>жирный</b>", "text/html");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/page.html" }));

    const dialog = await screen.findByRole("dialog", { name: "page.html" });
    expect(await within(dialog).findByText("<script>alert(1)</script><b>жирный</b>")).toBeInTheDocument();
    expect(dialog.querySelector("iframe")).toBeNull();
  });

  it("длинный текст обрезается, и окно говорит, сколько показано", async () => {
    outputs([{ filename: "big.log", size_bytes: 600 * 1024 }]);
    serveOutput("x".repeat(600 * 1024), "text/plain");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/big.log" }));

    const dialog = await screen.findByRole("dialog", { name: "big.log" });
    expect(await within(dialog).findByText("Показаны первые 512 КБ из 600,0 КБ. Целиком файл можно скачать.")).toBeInTheDocument();
  });

  it("PDF показывается во встроенном просмотре", async () => {
    outputs([{ filename: "demo.pdf", size_bytes: 50_587 }]);
    serveOutput(new Uint8Array([37, 80, 68, 70]), "application/pdf");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/demo.pdf" }));

    const dialog = await screen.findByRole("dialog", { name: "demo.pdf" });
    const frame = await within(dialog).findByTitle("Просмотр demo.pdf");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "blob:preview");
  });

  it("SVG показывается исходным текстом: картинка со скриптом не открывается от имени консоли", async () => {
    outputs([{ filename: "logo.svg", size_bytes: 90 }]);
    serveOutput('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>', "image/svg+xml");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/logo.svg" }));

    const dialog = await screen.findByRole("dialog", { name: "logo.svg" });
    expect(await within(dialog).findByText('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')).toBeInTheDocument();
    expect(within(dialog).queryByRole("img")).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("картинка показывается как изображение", async () => {
    outputs([{ filename: "chart.png", size_bytes: 1_200 }]);
    serveOutput(new Uint8Array([137, 80, 78, 71]), "image/png");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/chart.png" }));

    const dialog = await screen.findByRole("dialog", { name: "chart.png" });
    expect(await within(dialog).findByRole("img", { name: "chart.png" })).toHaveAttribute("src", "blob:preview");
  });

  it("docx в консоли не показывается: окно предлагает скачать и открыть в Word, файл заранее не грузит", async () => {
    outputs([{ filename: "отчёт.docx", size_bytes: 36_000 }]);
    const seen = serveOutput(new Uint8Array([80, 75, 3, 4]), "application/octet-stream");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/отчёт.docx" }));

    const dialog = await screen.findByRole("dialog", { name: "отчёт.docx" });
    expect(within(dialog).getByText("В консоли этот формат не показывается. Скачайте файл и откройте его в Word.")).toBeInTheDocument();
    expect(seen).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Скачать" }));
    await waitFor(() => expect(saved).toEqual([{ download: "отчёт.docx", href: "blob:preview" }]));
  });

  it("если файл для просмотра не загрузился, окно говорит об этом и даёт повторить", async () => {
    outputs([report]);
    serveOutput("", "text/plain", 500);

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/SMR_report.md" }));

    const dialog = await screen.findByRole("dialog", { name: "SMR_report.md" });
    expect(await within(dialog).findByText("Файл не загрузился.")).toBeInTheDocument();
    serveOutput("# Итоги", "text/markdown");
    await userEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
    expect(await within(dialog).findByText(/# Итоги/)).toBeInTheDocument();
  });

  it("закрытие окна освобождает адрес blob", async () => {
    outputs([{ filename: "demo.pdf", size_bytes: 50_587 }]);
    serveOutput(new Uint8Array([37, 80, 68, 70]), "application/pdf");

    render(<ResourcesTab sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "/mnt/session/outputs/demo.pdf" }));
    const dialog = await screen.findByRole("dialog", { name: "demo.pdf" });
    await within(dialog).findByTitle("Просмотр demo.pdf");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
});
