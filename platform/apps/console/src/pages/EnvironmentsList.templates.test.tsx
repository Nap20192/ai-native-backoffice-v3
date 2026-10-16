import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { EnvironmentsList } from "./EnvironmentsList";

const create = vi.hoisted(() => vi.fn());

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    error: null,
  }),
}));
vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => ({ environments: { create, delete: vi.fn() } }),
}));

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: "env_01" });
});

function show() {
  render(
    <MemoryRouter>
      <I18nProvider>
        <EnvironmentsList />
      </I18nProvider>
    </MemoryRouter>,
  );
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: "Новое окружение" })[0]!);
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByPlaceholderText("Рабочее окружение"), "Отчёты");
  return dialog;
}

describe("EnvironmentsList templates", () => {
  it("creates an empty environment by default", async () => {
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    expect(within(dialog).getByRole("radio", { name: /Пустое/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));
    expect(create).toHaveBeenCalledWith({ name: "Отчёты", config: { type: "cloud" } });
  });

  it("fills the document packages from the Документы template", async () => {
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    await user.click(within(dialog).getByRole("radio", { name: /Документы/ }));
    expect(within(dialog).getByText(/python-docx/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));
    expect(create).toHaveBeenCalledWith({
      name: "Отчёты",
      config: {
        type: "cloud",
        packages: {
          type: "packages",
          apt: ["python3-pip", "fonts-dejavu-core"],
          pip: ["python-docx", "openpyxl", "python-pptx", "pypdf", "reportlab", "pdfplumber"],
        },
      },
      metadata: { oma_template: "documents" },
    });
  });
});
