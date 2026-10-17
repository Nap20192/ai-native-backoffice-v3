import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { SANDBOX_CATALOG_PATH } from "../lib/sandbox-catalog";
import { server } from "../mocks/server";
import {
  catalogWithUnbuiltOffice,
  disabledCatalogFixture,
  sandboxCatalogFixture,
} from "../test/sandbox-catalog-fixture";
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

function answerCatalog(catalog: unknown) {
  server.use(http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(catalog as never)));
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <I18nProvider>
          <EnvironmentsList />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openCreate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole("button", { name: "Новое окружение" })[0]!);
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByPlaceholderText("Рабочее окружение"), "Отчёты");
  return dialog;
}

describe("EnvironmentsList templates without a server catalog", () => {
  beforeEach(() => {
    server.use(
      http.get(`*${SANDBOX_CATALOG_PATH}`, () =>
        HttpResponse.json({ error: "Маршрут не найден" }, { status: 404 }),
      ),
    );
  });

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
    await user.click(await within(dialog).findByRole("radio", { name: /Документы/ }));
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

  it("keeps the code templates when the server answers without a catalog", async () => {
    answerCatalog(disabledCatalogFixture());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    expect(await within(dialog).findByRole("radio", { name: /Документы/ })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
  });
});

describe("EnvironmentsList templates from the server catalog", () => {
  it("lists the catalog templates after Пустое", async () => {
    answerCatalog(sandboxCatalogFixture());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    expect(await within(dialog).findByRole("radio", { name: /Базовое/ })).toBeInTheDocument();
    const cards = within(dialog)
      .getAllByRole("radio")
      .map((radio) => radio.closest("label")?.textContent ?? "");
    expect(cards).toHaveLength(5);
    ["Пустое", "Базовое", "Документы и офис", "Данные", "Веб"].forEach((label, index) => {
      expect(cards[index]).toMatch(new RegExp(`^${label}`));
    });
    // Кодовый шаблон «Документы» заменён шаблоном каталога.
    expect(within(dialog).queryByRole("radio", { name: /^Документы(?! и)/ })).not.toBeInTheDocument();
  });

  it("keeps Пустое as the default and sends it unchanged", async () => {
    answerCatalog(sandboxCatalogFixture());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    await within(dialog).findByRole("radio", { name: /Базовое/ });

    expect(within(dialog).getByRole("radio", { name: /Пустое/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));

    expect(create).toHaveBeenCalledWith({ name: "Отчёты", config: { type: "cloud" } });
  });

  it("creates the Документы и офис environment on the LibreOffice image", async () => {
    const catalog = sandboxCatalogFixture();
    answerCatalog(catalog);
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    await user.click(await within(dialog).findByRole("radio", { name: /Документы и офис/ }));
    const summary = within(dialog).getByRole("group", { name: "Что даёт шаблон «Документы и офис»" });
    expect(within(summary).getByText("Рабочее место с LibreOffice")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));

    expect(create).toHaveBeenCalledWith({
      name: "Отчёты",
      config: catalog.templates[1]!.config,
      metadata: { oma_template: "documents" },
    });
    expect(create.mock.calls[0]![0].config).toMatchObject({
      type: "cloud",
      image: "workplace-office",
      networking: {
        type: "limited",
        allow_package_managers: true,
        allow_mcp_servers: true,
        allow_web_search: false,
        allowed_hosts: [],
      },
    });
  });

  it("creates the Данные environment with its pip packages and the workplace image", async () => {
    answerCatalog(sandboxCatalogFixture());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    await user.click(await within(dialog).findByRole("radio", { name: /Данные/ }));
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));

    const body = create.mock.calls[0]![0];
    expect(body.config).toMatchObject({
      image: "workplace",
      packages: { type: "packages", apt: [], npm: [], pip: ["duckdb", "pyarrow", "scipy"] },
    });
    expect(body.metadata).toEqual({ oma_template: "data" });
  });

  it("creates the Веб environment with an unrestricted network", async () => {
    answerCatalog(sandboxCatalogFixture());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    await user.click(await within(dialog).findByRole("radio", { name: /Веб/ }));
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));

    expect(create.mock.calls[0]![0].config).toMatchObject({
      image: "workplace",
      networking: { type: "unrestricted" },
    });
  });

  it("sends the description together with the template", async () => {
    answerCatalog(sandboxCatalogFixture());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    await user.click(await within(dialog).findByRole("radio", { name: /Базовое/ }));
    await user.type(within(dialog).getByLabelText("Описание (необязательно)"), "Для отчётов");
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));

    expect(create.mock.calls[0]![0]).toMatchObject({
      name: "Отчёты",
      description: "Для отчётов",
      metadata: { oma_template: "basic" },
    });
  });

  it("disables a template whose image is not built", async () => {
    answerCatalog(catalogWithUnbuiltOffice());
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    const documents = await within(dialog).findByRole("radio", { name: /Документы и офис/ });
    expect(documents).toBeDisabled();
    expect(within(documents.closest("label")!).getByText("Образ не собран")).toBeInTheDocument();
    await user.click(documents);
    expect(within(dialog).getByRole("radio", { name: /Пустое/ })).toBeChecked();
  });

  it("shows only Пустое while the catalog loads, and Создать already works for it", async () => {
    server.use(
      http.get(`*${SANDBOX_CATALOG_PATH}`, async () => {
        await delay("infinite");
        return HttpResponse.json(sandboxCatalogFixture());
      }),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);

    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    expect(within(dialog).getByRole("status")).toHaveTextContent("Загружаем шаблоны");
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));
    expect(create).toHaveBeenCalledWith({ name: "Отчёты", config: { type: "cloud" } });
  });

  it("keeps the dialog name and the field labels the verification scripts rely on", async () => {
    answerCatalog(sandboxCatalogFixture());
    const user = userEvent.setup();
    show();
    await user.click(screen.getAllByRole("button", { name: "Новое окружение" })[0]!);

    const dialog = await screen.findByRole("dialog", { name: "Новое окружение" });
    expect(within(dialog).getByLabelText("Название", { exact: true })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Описание (необязательно)")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Создать" })).toBeInTheDocument();
  });
});
