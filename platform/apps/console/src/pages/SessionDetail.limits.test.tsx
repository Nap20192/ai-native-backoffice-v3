import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { SessionDetail } from "./SessionDetail";

/**
 * Предел работы сессии на странице (docs/plans/multiagent.md, 3.Б, срез 4):
 * шапка показывает заметку по `budget_reached`, кнопка поднимает оба предела
 * вдвое правкой сессии с `_oma.limits`.
 */

type Frame = Record<string, unknown>;

/** Поток событий, которым управляет тест: push() отдаёт событие консоли так,
 *  как его отдал бы /events/stream. */
function createStream() {
  const queue: Frame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(frame: Frame) {
      queue.push(frame);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    iterate(signal?: AbortSignal): AsyncIterable<Frame> {
      signal?.addEventListener("abort", () => {
        closed = true;
        wake?.();
      });
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              for (;;) {
                const frame = queue.shift();
                if (frame) return { value: frame, done: false as const };
                if (closed) return { value: undefined, done: true as const };
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = null;
              }
            },
          };
        },
      };
    },
  };
}

const state = vi.hoisted(() => ({
  stream: null as ReturnType<typeof createStream> | null,
  history: [] as Frame[],
  limits: null as null | Record<string, number>,
}));

const api = vi.hoisted(() => ({
  sessions: {
    retrieve: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    threads: { list: vi.fn() },
    events: { list: vi.fn(), stream: vi.fn(), send: vi.fn() },
    resources: { list: vi.fn(), add: vi.fn() },
  },
  environments: { retrieve: vi.fn() },
  vaults: { retrieve: vi.fn() },
  agents: { retrieve: vi.fn() },
  files: { upload: vi.fn() },
}));

vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => api,
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

const USER_MESSAGE: Frame = {
  type: "user.message",
  id: "sevt_user_1",
  content: [{ type: "text", text: "Собери отчёт" }],
  processed_at: "2026-10-18T10:00:00.000Z",
};
const RUNNING: Frame = { type: "session.status_running", id: "sevt_run_1", processed_at: "2026-10-18T10:00:01.000Z" };
const STOPPED_AT_LIMIT: Frame = {
  type: "session.status_idle",
  id: "sevt_idle_1",
  stop_reason: { type: "budget_reached" },
  processed_at: "2026-10-18T10:00:09.000Z",
};

beforeEach(() => {
  state.stream = createStream();
  state.history = [USER_MESSAGE, RUNNING, STOPPED_AT_LIMIT];
  // Сервер отдаёт предел с израсходованным: токены ушли за предел на один запрос.
  state.limits = { max_tokens: 1000, max_child_turns: 20, used_tokens: 1500, used_child_turns: 3 };
  for (const fn of Object.values(toast)) fn.mockReset();
  api.sessions.retrieve.mockReset().mockImplementation(async () => ({
    id: "session-1",
    status: "idle",
    title: "Отчёт",
    agent: { id: "agent-1", name: "Аналитик" },
    environment_id: "env-1",
    vault_ids: [],
    created_at: "2026-10-18T09:59:00.000Z",
    updated_at: "2026-10-18T10:00:09.000Z",
    metadata: {},
    ...(state.limits ? { _oma: { limits: state.limits } } : {}),
  }));
  api.sessions.update.mockReset().mockImplementation(async (_id: string, body: Frame) => ({ id: "session-1", ...body }));
  api.environments.retrieve.mockReset().mockResolvedValue({ id: "env-1", name: "Основное" });
  api.agents.retrieve.mockReset().mockResolvedValue({ id: "agent-1", created_at: "2026-10-18T00:00:00.000Z" });
  api.sessions.resources.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  api.sessions.threads.list.mockReset().mockResolvedValue({ data: [] });
  server.use(http.get("*/v1/sessions/session-1/outputs", () => HttpResponse.json({ data: [], has_more: false })));
  api.sessions.events.list.mockReset().mockImplementation(async () => ({ data: state.history, next_page: null }));
  api.sessions.events.stream
    .mockReset()
    .mockImplementation(async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) =>
      state.stream!.iterate(options?.signal),
    );
  api.sessions.events.send.mockReset().mockImplementation(async (_id: string, body: { events: Frame[] }) => ({
    data: body.events.map((event, index) => ({ ...event, id: `sevt_server_${index}` })),
  }));
});

afterEach(() => {
  state.stream?.close();
});

async function openSession() {
  const view = render(
    <MemoryRouter initialEntries={["/sessions/session-1"]}>
      <I18nProvider>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("textbox", { name: "Сообщение" });
  await waitFor(() => expect(api.sessions.events.list).toHaveBeenCalled());
  await waitFor(() => expect(api.sessions.events.stream).toHaveBeenCalled());
  return view;
}

const limitNote = () => screen.queryByText(/Предел работы сессии исчерпан/);
const raiseButton = () => screen.queryByRole("button", { name: "Поднять предел" });

describe("SessionDetail: предел работы сессии", () => {
  it("ход из истории встал с budget_reached: шапка пишет заметку и даёт кнопку", async () => {
    await openSession();

    expect(await screen.findByText(/Предел работы сессии исчерпан/)).toBeInTheDocument();
    expect(raiseButton()).toBeInTheDocument();
  });

  it("кнопка читает предел заново и шлёт правку с удвоенным пределом", async () => {
    await openSession();
    await screen.findByText(/Предел работы сессии исчерпан/);
    const retrievesBefore = api.sessions.retrieve.mock.calls.length;

    await userEvent.click(raiseButton()!);

    // Удваивается большее из предела и израсходованного: 1500 токенов больше
    // предела 1000, поэтому новый предел 3000, а ходов 2 * 20.
    await waitFor(() =>
      expect(api.sessions.update).toHaveBeenCalledWith("session-1", {
        _oma: { limits: { max_tokens: 3000, max_child_turns: 40 } },
      }),
    );
    expect(api.sessions.update).toHaveBeenCalledOnce();
    expect(api.sessions.retrieve.mock.calls.length).toBe(retrievesBefore + 1);
    expect(toast.success).toHaveBeenCalledWith("Предел поднят");
    // Поднятый предел больше не предлагают, даже пока ход не продолжился.
    await waitFor(() => expect(limitNote()).toBeNull());
    expect(raiseButton()).toBeNull();
  });

  it("правка с ошибкой оставляет заметку и кнопку", async () => {
    api.sessions.update.mockReset().mockRejectedValue(new Error("400"));
    await openSession();
    await screen.findByText(/Предел работы сессии исчерпан/);

    await userEvent.click(raiseButton()!);

    await waitFor(() => expect(api.sessions.update).toHaveBeenCalledOnce());
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(raiseButton()).toBeEnabled());
    expect(limitNote()).toBeInTheDocument();
  });

  it("сервер без _oma.limits: правка не уходит, пользователь видит причину", async () => {
    state.limits = null;
    await openSession();
    await screen.findByText(/Предел работы сессии исчерпан/);

    await userEvent.click(raiseButton()!);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Сервер не сообщил предел сессии"));
    expect(api.sessions.update).not.toHaveBeenCalled();
  });

  it("ход продолжился: заметка уходит, новый стоп по пределу возвращает её", async () => {
    await openSession();
    await screen.findByText(/Предел работы сессии исчерпан/);

    await act(async () => {
      state.stream!.push({ type: "session.status_running", id: "sevt_run_2" });
    });
    await waitFor(() => expect(limitNote()).toBeNull());

    await act(async () => {
      state.stream!.push({ type: "session.status_idle", id: "sevt_idle_2", stop_reason: { type: "budget_reached" } });
    });
    expect(await screen.findByText(/Предел работы сессии исчерпан/)).toBeInTheDocument();
  });

  it("ход кончился как обычно: заметки нет", async () => {
    state.history = [USER_MESSAGE, RUNNING, { ...STOPPED_AT_LIMIT, stop_reason: { type: "end_turn" } }];
    await openSession();

    await waitFor(() => expect(api.sessions.retrieve).toHaveBeenCalled());
    expect(limitNote()).toBeNull();
    expect(raiseButton()).toBeNull();
  });

  it("на пределе сообщение не уходит на сервер, а страница объясняет почему", async () => {
    await openSession();
    await screen.findByText(/Предел работы сессии исчерпан/);

    await userEvent.type(await screen.findByRole("textbox", { name: "Сообщение" }), "Продолжай");
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Предел работы сессии исчерпан. Сначала поднимите предел."),
    );
    expect(api.sessions.events.send).not.toHaveBeenCalled();
  });
});
