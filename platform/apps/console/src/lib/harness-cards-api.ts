import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { getActiveTenantId, localizeApiError, readApiError } from "./api";

/**
 * Клиент карточек своих harness (`/v1/oma/harness_cards`). Типы повторяют
 * раздел 3.5 и 3.6 контракта docs/plans/models-harness.md.
 *
 * Запросы идут через собственный `fetch`, а не через `useApi`: сервер называет
 * поле с ошибкой (`{"error": "...", "field": "protocols"}`), а `ApiError`
 * консоли это поле теряет. Окно карточки подсвечивает ввод по `field`, поэтому
 * здесь ошибка его хранит. Заголовок рабочего пространства и cookie те же, что
 * у `useApi`. Ошибки страницы рисуют сами, тостов нет.
 */

export const HARNESS_CARDS_PATH = "/v1/oma/harness_cards";

/** Протоколы, которые разрешает карточка. Протокола `gemini` в карточке нет. */
export type CardProtocol = "anthropic-messages" | "openai-chat" | "openai-responses";

export interface HarnessCard {
  id: string;
  /** Так harness записывается в агента. Не меняется после создания. */
  harness_id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string | null;
  install: { npm: string[]; pip: string[] };
  protocols: CardProtocol[];
  /** Имена переменных окружения без значений. */
  allowed_env: string[];
  status: "unverified";
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface HarnessCardInput {
  name: string;
  harness_id: string;
  command: string;
  args: string[];
  cwd: string | null;
  install: { npm: string[]; pip: string[] };
  protocols: CardProtocol[];
  allowed_env: string[];
}

/** Изменение карточки: `harness_id` менять нельзя. */
export type HarnessCardPatch = Partial<Omit<HarnessCardInput, "harness_id">>;

export interface HarnessCardsPage {
  data: HarnessCard[];
  next_cursor?: string | null;
}

export interface HarnessCardDeleted {
  type: "harness_card_deleted";
  id: string;
}

/** Ошибка сервера с кодом ответа и полем, к которому она относится. */
export class HarnessCardsApiError extends Error {
  readonly status: number;
  readonly field: string | null;

  constructor(message: string, status: number, field: string | null) {
    super(message);
    this.name = "HarnessCardsApiError";
    this.status = status;
    this.field = field;
  }
}

/** Код 501 означает базу MySQL: своих harness на ней нет. */
export function isHarnessCardsUnsupported(error: unknown): boolean {
  return error instanceof HarnessCardsApiError && error.status === 501;
}

export async function requestHarnessCards<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const tenant = getActiveTenantId();
  if (tenant) headers.set("x-active-tenant", tenant);
  if (init.body) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "include" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new HarnessCardsApiError(
      "Ошибка сети. Проверьте соединение и повторите попытку.",
      0,
      null,
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    const field =
      body && typeof body === "object" && typeof (body as { field?: unknown }).field === "string"
        ? (body as { field: string }).field
        : null;
    throw new HarnessCardsApiError(
      localizeApiError(readApiError(body, response.status), response.status),
      response.status,
      field,
    );
  }
  return (await response.json()) as T;
}

const LIST_LIMIT = 50;

/** Адрес с параметрами запроса. Пустые и неопределённые значения отбрасываются. */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const text = search.toString();
  return text ? `${path}?${text}` : path;
}

/** Ключ кэша всех запросов карточек: по нему мутации сбрасывают списки. */
const CARDS_KEY = "harness-cards";

export interface HarnessCardsQuery {
  q?: string;
  include_archived?: boolean;
}

/** Список своих карточек: новые сверху, поиск `q` идёт на сервере, страницы по курсору. */
export function useHarnessCards(params: HarnessCardsQuery = {}) {
  const query = useInfiniteQuery<HarnessCardsPage, Error>({
    queryKey: [CARDS_KEY, "list", params.q ?? "", params.include_archived ?? false],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      requestHarnessCards<HarnessCardsPage>(
        withQuery(HARNESS_CARDS_PATH, {
          q: params.q || undefined,
          include_archived: params.include_archived ? "true" : undefined,
          limit: String(LIST_LIMIT),
          cursor: typeof pageParam === "string" ? pageParam : undefined,
        }),
        { signal },
      ),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const items = useMemo<HarnessCard[]>(
    () => query.data?.pages.flatMap((page) => page.data) ?? [],
    [query.data],
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    items,
    isLoading: query.isPending,
    isLoadingMore: isFetchingNextPage,
    hasMore: Boolean(hasNextPage),
    loadMore,
    refresh,
    error: query.error,
  };
}

/**
 * Удалённая карточка с этим `harness_id`, если такая есть. Карточка агента по
 * нему различает «Удалён» и «Не найден». `null`: удалённой карточки нет.
 */
export function useArchivedHarnessCard(harnessId: string, enabled: boolean) {
  return useQuery<HarnessCard | null, Error>({
    queryKey: [CARDS_KEY, "archived", harnessId],
    enabled: enabled && harnessId !== "",
    retry: false,
    queryFn: async ({ signal }) => {
      const page = await requestHarnessCards<HarnessCardsPage>(
        withQuery(HARNESS_CARDS_PATH, {
          q: harnessId,
          include_archived: "true",
          limit: "100",
        }),
        { signal },
      );
      return (
        page.data.find((card) => card.harness_id === harnessId && card.archived_at !== null) ?? null
      );
    },
  });
}

/** После любой правки карточек обновляются их списки и каталоги форм агента. */
function useRefreshAfterChange() {
  const client = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: [CARDS_KEY] }),
      client.invalidateQueries({ queryKey: ["catalog"] }),
    ]);
  }, [client]);
}

export function useCreateHarnessCard() {
  const refresh = useRefreshAfterChange();
  return useMutation<HarnessCard, Error, HarnessCardInput>({
    mutationFn: (input) =>
      requestHarnessCards<HarnessCard>(HARNESS_CARDS_PATH, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: refresh,
  });
}

export function useUpdateHarnessCard() {
  const refresh = useRefreshAfterChange();
  return useMutation<HarnessCard, Error, { id: string; patch: HarnessCardPatch }>({
    mutationFn: ({ id, patch }) =>
      requestHarnessCards<HarnessCard>(`${HARNESS_CARDS_PATH}/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify(patch),
      }),
    onSuccess: refresh,
  });
}

export function useDeleteHarnessCard() {
  const refresh = useRefreshAfterChange();
  return useMutation<HarnessCardDeleted, Error, string>({
    mutationFn: (id) =>
      requestHarnessCards<HarnessCardDeleted>(`${HARNESS_CARDS_PATH}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: refresh,
  });
}
