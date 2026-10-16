import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import { I18nProvider } from "../i18n";
import { ModelCardsList } from "./ModelCardsList";

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api: vi.fn(async () => ({ data: [] })) }),
}));

vi.mock("../lib/useApiQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/useApiQuery")>()),
  useOmaInfiniteApiQuery: () => ({
    items: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
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
});

function Probe() {
  const location = useLocation();
  return <output data-testid="state">{JSON.stringify(location.state)}</output>;
}

function renderWith(state: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/model-cards", state }]}>
      <I18nProvider>
        <ModelCardsList />
        <Probe />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("ModelCardsList: черновик ассистента", () => {
  it("открывает окно с полями черновика, ключ пустой", async () => {
    renderWith({
      modelCardDraft: { provider: "openai", model_id: "qwen3.6-35b", model: "qwen3.6-35b", pi_config: { reasoning: true }, is_default: true },
    });

    const dialog = await screen.findByRole("dialog", { name: "Новая карточка модели" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText(/ID модели/)).toHaveValue("qwen3.6-35b");
    expect(screen.getByLabelText(/Название модели у провайдера|Модель у провайдера|Модель/, { selector: "#modelcard-wire-model" })).toHaveValue("qwen3.6-35b");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value ?? "").toBe("");
    expect(document.querySelector<HTMLInputElement>("#modelcard-pi-config, textarea")?.value ?? "").toContain("reasoning");
    // состояние маршрута сброшено: обновление страницы не откроет окно снова
    expect(screen.getByTestId("state")).toHaveTextContent("null");
  });

  it("не принимает ключ, адрес и заголовки, даже если они есть в состоянии", async () => {
    renderWith({
      modelCardDraft: {
        model_id: "m1",
        provider: "openai",
        api_key: "sk-live-123456789",
        base_url: "https://evil.example/v1",
        custom_headers: { Authorization: "x" },
      },
    });

    await screen.findByRole("dialog", { name: "Новая карточка модели" });
    const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).map((el) => el.value);
    expect(values.join("|")).not.toContain("sk-live");
    expect(values.join("|")).not.toContain("evil.example");
    expect(values.join("|")).not.toContain("Authorization");
  });

  it("без черновика окно закрыто", () => {
    renderWith(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("мусорное состояние не открывает окно", () => {
    renderWith({ modelCardDraft: "строка" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
