import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createElement, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { server } from "../mocks/server";
import { ACTIVE_TENANT_KEY } from "./api";
import {
  HARNESS_CARDS_PATH,
  HarnessCardsApiError,
  isHarnessCardsUnsupported,
  requestHarnessCards,
  useArchivedHarnessCard,
  useCreateHarnessCard,
  useDeleteHarnessCard,
  useHarnessCards,
  useUpdateHarnessCard,
  type HarnessCard,
  type HarnessCardInput,
} from "./harness-cards-api";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function card(overrides: Partial<HarnessCard> = {}): HarnessCard {
  return {
    id: "hcard_1",
    harness_id: "aider-local",
    name: "Aider через ACP",
    command: "aider-acp",
    args: [],
    cwd: "/mnt/session/outputs",
    install: { npm: [], pip: ["aider-chat==0.86.1"] },
    protocols: ["openai-chat"],
    allowed_env: ["AIDER_AUTO_COMMITS"],
    status: "unverified",
    created_at: "2026-10-16T10:00:00.000Z",
    updated_at: "2026-10-16T11:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

const INPUT: HarnessCardInput = {
  name: "Aider через ACP",
  harness_id: "aider-local",
  command: "aider-acp",
  args: [],
  cwd: "/mnt/session/outputs",
  install: { npm: [], pip: ["aider-chat==0.86.1"] },
  protocols: ["openai-chat"],
  allowed_env: ["AIDER_AUTO_COMMITS"],
};

afterEach(() => {
  localStorage.removeItem(ACTIVE_TENANT_KEY);
});

describe("requestHarnessCards", () => {
  it("кладёт ошибку сервера вместе с полем, по которому окно подсветит ввод", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json(
          { error: "ID «claude-acp» занят встроенным harness", field: "harness_id" },
          { status: 400 },
        ),
      ),
    );

    const error = await requestHarnessCards(HARNESS_CARDS_PATH, {
      method: "POST",
      body: JSON.stringify(INPUT),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HarnessCardsApiError);
    expect((error as HarnessCardsApiError).message).toBe("ID «claude-acp» занят встроенным harness");
    expect((error as HarnessCardsApiError).field).toBe("harness_id");
    expect((error as HarnessCardsApiError).status).toBe(400);
  });

  it("отвечает ошибкой без поля, когда сервер его не назвал", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Harness с ID «aider-local» уже есть" }, { status: 409 }),
      ),
    );

    const error = (await requestHarnessCards(HARNESS_CARDS_PATH, { method: "POST", body: "{}" }).catch(
      (e: unknown) => e,
    )) as HarnessCardsApiError;

    expect(error.status).toBe(409);
    expect(error.field).toBeNull();
    expect(error.message).toBe("Harness с ID «aider-local» уже есть");
  });

  it("читает ошибку в формате Managed API и подставляет русский текст по статусу", async () => {
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json(
          { type: "error", error: { type: "api_error", message: "boom" } },
          { status: 500 },
        ),
      ),
    );

    const error = (await requestHarnessCards(HARNESS_CARDS_PATH).catch((e: unknown) => e)) as HarnessCardsApiError;

    expect(error.message).toBe("Ошибка сервера. Повторите попытку.");
  });

  it("распознаёт 501 на MySQL, где своих harness нет", async () => {
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Свои harness на MySQL не поддерживаются" }, { status: 501 }),
      ),
    );

    const error = await requestHarnessCards(HARNESS_CARDS_PATH).catch((e: unknown) => e);

    expect(isHarnessCardsUnsupported(error)).toBe(true);
    expect((error as Error).message).toBe("Свои harness на MySQL не поддерживаются");
    expect(isHarnessCardsUnsupported(new Error("x"))).toBe(false);
  });

  it("передаёт активное рабочее пространство заголовком", async () => {
    localStorage.setItem(ACTIVE_TENANT_KEY, "tenant_7");
    let seen: string | null = null;
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, ({ request }) => {
        seen = request.headers.get("x-active-tenant");
        return HttpResponse.json({ data: [] });
      }),
    );

    await requestHarnessCards(HARNESS_CARDS_PATH);

    expect(seen).toBe("tenant_7");
  });
});

describe("useHarnessCards", () => {
  it("грузит страницы по курсору и ищет по q на сервере", async () => {
    const urls: URL[] = [];
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, ({ request }) => {
        const url = new URL(request.url);
        urls.push(url);
        return url.searchParams.get("cursor") === "next-1"
          ? HttpResponse.json({ data: [card({ id: "hcard_2", harness_id: "second" })] })
          : HttpResponse.json({ data: [card()], next_cursor: "next-1" });
      }),
    );

    const { result } = renderHook(() => useHarnessCards({ q: "aid" }), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);
    expect(urls[0].searchParams.get("q")).toBe("aid");
    expect(urls[0].searchParams.get("limit")).toBe("50");
    expect(urls[0].searchParams.has("cursor")).toBe(false);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items.map((c) => c.id)).toEqual(["hcard_1", "hcard_2"]));
    expect(urls[1].searchParams.get("cursor")).toBe("next-1");
    expect(result.current.hasMore).toBe(false);
  });

  it("отдаёт ошибку 501 для страницы, которая покажет своё сообщение", async () => {
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Свои harness на MySQL не поддерживаются" }, { status: 501 }),
      ),
    );

    const { result } = renderHook(() => useHarnessCards({}), { wrapper: wrapper() });

    await waitFor(() => expect(isHarnessCardsUnsupported(result.current.error)).toBe(true));
    expect(result.current.items).toEqual([]);
  });
});

describe("создание, правка и удаление", () => {
  it("создаёт карточку телом из формы и обновляет список", async () => {
    let body: unknown = null;
    let lists = 0;
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () => {
        lists += 1;
        return HttpResponse.json({ data: [] });
      }),
      http.post(`*${HARNESS_CARDS_PATH}`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(card(), { status: 201 });
      }),
    );
    const { result } = renderHook(
      () => ({ list: useHarnessCards({}), create: useCreateHarnessCard() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(lists).toBe(1));

    let created: HarnessCard | undefined;
    await act(async () => {
      created = await result.current.create.mutateAsync(INPUT);
    });

    expect(created?.id).toBe("hcard_1");
    expect(body).toEqual(INPUT);
    await waitFor(() => expect(lists).toBe(2));
  });

  it("правит карточку по id и шлёт только переданные поля", async () => {
    let seen: { url: string; body: unknown } | null = null;
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}/:id`, async ({ request, params }) => {
        seen = { url: String(params.id), body: await request.json() };
        return HttpResponse.json(card({ name: "Новое имя" }));
      }),
    );
    const { result } = renderHook(() => useUpdateHarnessCard(), { wrapper: wrapper() });

    let updated: HarnessCard | undefined;
    await act(async () => {
      updated = await result.current.mutateAsync({ id: "hcard_1", patch: { name: "Новое имя" } });
    });

    expect(updated?.name).toBe("Новое имя");
    expect(seen).toEqual({ url: "hcard_1", body: { name: "Новое имя" } });
  });

  it("удаляет карточку и возвращает ответ сервера", async () => {
    server.use(
      http.delete(`*${HARNESS_CARDS_PATH}/:id`, ({ params }) =>
        HttpResponse.json({ type: "harness_card_deleted", id: params.id }),
      ),
    );
    const { result } = renderHook(() => useDeleteHarnessCard(), { wrapper: wrapper() });

    let reply: unknown;
    await act(async () => {
      reply = await result.current.mutateAsync("hcard_1");
    });

    expect(reply).toEqual({ type: "harness_card_deleted", id: "hcard_1" });
  });

  it("отдаёт ошибку создания с полем из ответа сервера", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Укажите хотя бы один протокол", field: "protocols" }, { status: 400 }),
      ),
    );
    const { result } = renderHook(() => useCreateHarnessCard(), { wrapper: wrapper() });

    await act(async () => {
      await result.current.mutateAsync(INPUT).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(HarnessCardsApiError));
    expect((result.current.error as HarnessCardsApiError).field).toBe("protocols");
  });
});

describe("useArchivedHarnessCard", () => {
  it("находит удалённую карточку по точному harness_id", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({
          data: [
            card({ id: "hcard_a", harness_id: "aider-local-2", archived_at: null }),
            card({ id: "hcard_b", harness_id: "aider-local", archived_at: "2026-10-16T12:00:00.000Z" }),
          ],
        });
      }),
    );

    const { result } = renderHook(() => useArchivedHarnessCard("aider-local", true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.data?.id).toBe("hcard_b"));
    const url = seen as unknown as URL;
    expect(url.searchParams.get("include_archived")).toBe("true");
    expect(url.searchParams.get("q")).toBe("aider-local");
  });

  it("не ходит на сервер, пока запрос выключен, и молчит, когда карточки нет", async () => {
    let calls = 0;
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () => {
        calls += 1;
        return HttpResponse.json({ data: [] });
      }),
    );

    const off = renderHook(() => useArchivedHarnessCard("x", false), { wrapper: wrapper() });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(off.result.current.data).toBeUndefined();

    const on = renderHook(() => useArchivedHarnessCard("x", true), { wrapper: wrapper() });
    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    expect(on.result.current.data).toBeNull();
  });
});
