import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { FilesList } from "./FilesList";

const managed = vi.hoisted(() => ({
  files: { upload: vi.fn(), delete: vi.fn(), download: vi.fn() },
}));
const feed = vi.hoisted(() => ({ items: [] as unknown[], refresh: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("sonner", () => ({ toast }));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: { data: [] } }),
  useFilesInfiniteApiQuery: () => ({
    items: feed.items,
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: feed.refresh,
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});

const FILE = {
  id: "file_1",
  type: "file",
  filename: "отчёт.pdf",
  mime_type: "application/pdf",
  size_bytes: 2048,
  created_at: "2026-10-14T10:00:00.000Z",
  downloadable: true,
};

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };

beforeEach(() => {
  feed.items = [FILE];
  feed.refresh.mockReset();
  dependencies = { blocking: [], affected: [], truncated: false };
  managed.files.upload.mockReset().mockResolvedValue({ ...FILE, id: "file_new" });
  managed.files.delete.mockReset().mockResolvedValue({ id: "file_1", type: "file_deleted" });
  toast.success.mockReset();
  toast.error.mockReset();
  server.use(http.get("*/v1/oma/dependencies/file/:id", () => HttpResponse.json(dependencies)));
});

function renderPage() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <FilesList />
      </I18nProvider>
    </MemoryRouter>,
  );
}

async function openDelete() {
  renderPage();
  await waitFor(() => {
    fireEvent.contextMenu(screen.getByText("отчёт.pdf"));
    expect(screen.getByRole("menuitem", { name: "Удалить" })).toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole("menuitem", { name: "Удалить" }));
  return await screen.findByRole("dialog", { name: "Удалить файл «отчёт.pdf»?" });
}

describe("FilesList: удаление с зависимостями", () => {
  it("живой деплоймент мешает удалению: кнопка выключена", async () => {
    dependencies = {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: null }],
      affected: [],
      truncated: false,
    };
    const dialog = await openDelete();

    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(managed.files.delete).not.toHaveBeenCalled();
  });

  it("без зависимостей удаляет файл и обновляет список", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "session", id: "sesn_1", name: null, status: "terminated", note: "файл исчезнет из ресурсов" }],
      truncated: false,
    };
    const dialog = await openDelete();

    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(managed.files.delete).toHaveBeenCalledWith("file_1"));
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled());
  });
});

describe("FilesList: загрузка", () => {
  it("кнопка «Загрузить» отправляет выбранный файл", async () => {
    renderPage();
    const input = await screen.findByLabelText("Файл для загрузки");
    const file = new File(["данные"], "заметки.txt", { type: "text/plain" });

    await userEvent.upload(input, file);

    await waitFor(() => expect(managed.files.upload).toHaveBeenCalledWith({ file }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Файл «заметки.txt» загружен"));
    expect(feed.refresh).toHaveBeenCalled();
  });

  it("перетаскивание файла на страницу тоже загружает его", async () => {
    const { container } = renderPage();
    await screen.findByLabelText("Файл для загрузки");
    const file = new File(["x"], "перетащен.csv", { type: "text/csv" });

    const zone = container.querySelector("[data-file-drop]") as HTMLElement;
    expect(zone).not.toBeNull();
    fireEvent.drop(zone, { dataTransfer: { files: [file], types: ["Files"] } });

    await waitFor(() => expect(managed.files.upload).toHaveBeenCalledWith({ file }));
  });

  it("ошибка загрузки показывает тост и не обновляет список", async () => {
    managed.files.upload.mockRejectedValue(new Error("слишком большой"));
    renderPage();
    const input = await screen.findByLabelText("Файл для загрузки");

    await userEvent.upload(input, new File(["x"], "a.bin"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(feed.refresh).not.toHaveBeenCalled();
  });
});
