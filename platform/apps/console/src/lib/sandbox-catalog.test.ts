import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../mocks/server";
import {
  catalogWithUnbuiltOffice,
  disabledCatalogFixture,
  sandboxCatalogFixture,
  WORKPLACE_DIGEST,
} from "../test/sandbox-catalog-fixture";
import {
  findCatalogImage,
  parseSandboxCatalog,
  SANDBOX_CATALOG_PATH,
  shortDigest,
  useSandboxCatalog,
} from "./sandbox-catalog";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("parseSandboxCatalog", () => {
  it("читает ответ сервера как есть", () => {
    const parsed = parseSandboxCatalog(sandboxCatalogFixture());
    expect(parsed).toEqual(sandboxCatalogFixture());
  });

  it("берёт каталог без шаблонов и с одним образом сервера", () => {
    const parsed = parseSandboxCatalog(disabledCatalogFixture());
    expect(parsed?.enabled).toBe(false);
    expect(parsed?.images.map((image) => image.key)).toEqual(["default"]);
    expect(parsed?.templates).toEqual([]);
  });

  it.each([
    ["не объект", "строка"],
    ["пустое значение", null],
    ["массив", []],
    ["ответ другого маршрута", { id: "env_1", name: "Окружение", config: { type: "cloud" } }],
    ["нет списка образов", { enabled: true, default_image: "workplace", templates: [] }],
    ["нет образа по умолчанию", { enabled: true, images: [], templates: [] }],
    ["enabled не флаг", { enabled: "да", default_image: "x", images: [], templates: [] }],
  ])("возвращает null: %s", (_name, raw) => {
    expect(parseSandboxCatalog(raw)).toBeNull();
  });

  it("пропускает образ и шаблон с битой записью, остальные оставляет", () => {
    const raw = sandboxCatalogFixture();
    const parsed = parseSandboxCatalog({
      ...raw,
      images: [{ key: 7, label: "Без ключа" }, ...raw.images],
      templates: [{ id: "broken" }, ...raw.templates],
    });
    expect(parsed?.images.map((image) => image.key)).toEqual(["legacy", "workplace", "workplace-office"]);
    expect(parsed?.templates.map((item) => item.id)).toEqual(["basic", "documents", "data", "web"]);
  });

  it("берёт образ без состава и без размера", () => {
    const parsed = parseSandboxCatalog({
      enabled: true,
      default_image: "legacy",
      images: [{ key: "legacy", label: "Прежний", built: true }],
      templates: [],
    });
    expect(parsed?.images[0]).toMatchObject({
      key: "legacy",
      reason: null,
      image_digest: null,
      size_bytes: null,
      manifest: null,
      resources: { disk_gb: null, memory_mib: null, cpus: null },
    });
  });
});

describe("shortDigest", () => {
  it("оставляет sha256 и шесть знаков, дальше многоточие", () => {
    expect(shortDigest(WORKPLACE_DIGEST)).toBe("sha256:3fdbc2…");
  });

  it("не режет короткое значение", () => {
    expect(shortDigest("sha256:3f2a1c")).toBe("sha256:3f2a1c");
  });

  it("отдаёт null, когда дайджеста нет", () => {
    expect(shortDigest(null)).toBeNull();
    expect(shortDigest("")).toBeNull();
  });
});

describe("findCatalogImage", () => {
  it("ищет образ по ключу каталога", () => {
    const catalog = sandboxCatalogFixture();
    expect(findCatalogImage(catalog, "workplace")?.label).toBe("Рабочее место агента");
    expect(findCatalogImage(catalog, "нет такого")).toBeUndefined();
    expect(findCatalogImage(null, "workplace")).toBeUndefined();
  });
});

describe("useSandboxCatalog", () => {
  it("отдаёт каталог сервера, когда он включён", async () => {
    server.use(http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(sandboxCatalogFixture())));

    const { result } = renderHook(() => useSandboxCatalog(), { wrapper: wrapper() });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.catalog).toBeNull();
    await waitFor(() => expect(result.current.catalog).toEqual(sandboxCatalogFixture()));
    expect(result.current.isLoading).toBe(false);
  });

  it("считает каталог отсутствующим, когда сервер работает без каталога образов", async () => {
    server.use(http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(disabledCatalogFixture())));

    const { result } = renderHook(() => useSandboxCatalog(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toBeNull();
  });

  it("считает каталог отсутствующим, пока сервер не знает маршрут", async () => {
    server.use(
      http.get(`*${SANDBOX_CATALOG_PATH}`, () =>
        HttpResponse.json({ error: "Маршрут не найден" }, { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useSandboxCatalog(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toBeNull();
  });

  it("считает каталог отсутствующим, когда в ответе не страница каталога", async () => {
    server.use(
      http.get(`*${SANDBOX_CATALOG_PATH}`, () => new HttpResponse("<html></html>", { status: 200 })),
    );

    const { result } = renderHook(() => useSandboxCatalog(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toBeNull();
  });

  it("показывает собранный и несобранный образ как пришли", async () => {
    server.use(http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(catalogWithUnbuiltOffice())));

    const { result } = renderHook(() => useSandboxCatalog(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.catalog).not.toBeNull());
    const office = findCatalogImage(result.current.catalog, "workplace-office");
    expect(office?.built).toBe(false);
    expect(office?.reason).toBe("Каталог образа workplace-office-2026.10.1 не найден");
  });

  it("не ходит на сервер, пока запрос выключен", async () => {
    let calls = 0;
    server.use(
      http.get(`*${SANDBOX_CATALOG_PATH}`, () => {
        calls += 1;
        return HttpResponse.json(sandboxCatalogFixture());
      }),
    );

    const { result } = renderHook(() => useSandboxCatalog({ enabled: false }), { wrapper: wrapper() });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(result.current.catalog).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
