import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { SessionDetail } from "./SessionDetail";

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
  sessionStatus: "idle",
  sendImpl: null as null | ((events: Frame[]) => Promise<unknown>),
  history: [] as Frame[],
  serverSeq: 0,
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

beforeEach(() => {
  state.stream = createStream();
  state.sessionStatus = "idle";
  state.sendImpl = null;
  state.history = [];
  state.serverSeq = 0;
  api.sessions.retrieve.mockReset().mockImplementation(async () => ({
    id: "session-1",
    status: state.sessionStatus,
    title: "Проверка",
    agent: { id: "agent-1", name: "Юрист" },
    environment_id: "env-1",
    vault_ids: [],
    created_at: "2026-10-15T14:00:00.000Z",
    metadata: {},
  }));
  api.environments.retrieve.mockReset().mockResolvedValue({ id: "env-1", name: "Основное" });
  api.agents.retrieve.mockReset().mockResolvedValue({ id: "agent-1", created_at: "2026-10-15T00:00:00.000Z" });
  api.sessions.archive.mockReset().mockResolvedValue({});
  api.sessions.resources.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  api.sessions.threads.list.mockReset().mockResolvedValue({ data: [] });
  // Инспектор ходит за файлами через fetch: отвечаем пусто.
  server.use(http.get("*/v1/sessions/session-1/outputs", () => HttpResponse.json({ data: [], has_more: false })));
  api.sessions.events.list.mockReset().mockImplementation(async () => ({
    data: state.history,
    next_page: null,
  }));
  api.sessions.events.stream
    .mockReset()
    .mockImplementation(async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) =>
      state.stream!.iterate(options?.signal),
    );
  api.sessions.events.send
    .mockReset()
    .mockImplementation(async (_id: string, body: { events: Frame[] }) => {
      if (state.sendImpl) return state.sendImpl(body.events);
      return { data: acceptedEvents(body.events) };
    });
});

afterEach(() => {
  state.stream?.close();
});

/** Что сервер вернул бы в ответ на POST: те же события с id и временем. */
function acceptedEvents(events: Frame[]): Frame[] {
  return events.map((event) => ({
    ...event,
    id: `sevt_server_${state.serverSeq++}`,
    processed_at: "2026-10-15T14:00:05.000Z",
  }));
}

function text(value: string): Frame {
  return { type: "text", text: value };
}

async function openSession(path = "/sessions/session-1") {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
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

/** Поле ввода перерисовывается, когда в разговоре появляются ходы, поэтому
 *  ищем его заново при каждой отправке. */
async function sendMessage(message: string) {
  const box = await screen.findByRole("textbox", { name: "Сообщение" });
  await userEvent.type(box, message);
  await userEvent.keyboard("{Enter}");
}

function prompts(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll("article[data-turn-id] [data-session-turn-prompt]"),
  ).map((node) => node.textContent ?? "");
}

function pushAgentTurn(answer: string) {
  const push = (frame: Frame) => act(() => state.stream!.push(frame));
  return (async () => {
    await push({ type: "session.status_running", id: "sevt_run_1" });
    await push({
      type: "agent.tool_use",
      id: "toolu_1",
      name: "bash",
      input: { command: "uname -r" },
    });
    await push({
      type: "agent.tool_result",
      id: "sevt_res_1",
      tool_use_id: "toolu_1",
      content: [text("kernel=6.12.76")],
    });
    await push({ type: "agent.message", id: "sevt_msg_1", content: [text(answer)] });
    await push({ type: "session.status_idle", id: "sevt_idle_1", stop_reason: { type: "end_turn" } });
  })();
}

describe("SessionDetail: реплика пользователя в ходе разговора", () => {
  it("видна сразу после отправки, пока поток не прислал user.message", async () => {
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");

    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await waitFor(() => expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]));
  });

  it("остаётся на месте, пока агент работает, и после завершения хода (старый сервер)", async () => {
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await pushAgentTurn("Сеть доступна");

    await waitFor(() => expect(screen.getByText("Сеть доступна")).toBeInTheDocument());
    await waitFor(() =>
      expect(container.querySelector("article[data-turn-id]")).toHaveAttribute(
        "data-session-turn-status",
        "completed",
      ),
    );
    expect(container.querySelectorAll("article[data-turn-id]")).toHaveLength(1);
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
  });

  it("остаётся видна и в новой сессии, которую сервер создал со статусом «Выполняется»", async () => {
    state.sessionStatus = "running";
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await pushAgentTurn("Сеть доступна");

    await waitFor(() => expect(screen.getByText("Сеть доступна")).toBeInTheDocument());
    expect(container.querySelectorAll("article[data-turn-id]")).toHaveLength(1);
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
  });

  it("не двоится, когда сервер присылает user.message в потоке после ответа на POST", async () => {
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await act(async () => {
      state.stream!.push({
        type: "user.message",
        id: "sevt_server_0",
        content: [text("Проверь сеть из песочницы")],
      });
    });
    await pushAgentTurn("Сеть доступна");

    await waitFor(() => expect(screen.getByText("Сеть доступна")).toBeInTheDocument());
    expect(container.querySelectorAll("article[data-turn-id]")).toHaveLength(1);
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
  });

  it("не двоится, когда user.message из потока пришёл раньше ответа на POST", async () => {
    let answer: (value: unknown) => void = () => {};
    state.sendImpl = (events) =>
      new Promise((resolve) => {
        answer = () => resolve({ data: acceptedEvents(events) });
      });
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await act(async () => {
      state.stream!.push({
        type: "user.message",
        id: "sevt_server_0",
        content: [text("Проверь сеть из песочницы")],
      });
    });
    await pushAgentTurn("Сеть доступна");
    await act(async () => {
      answer(null);
    });

    await waitFor(() => expect(screen.getByText("Сеть доступна")).toBeInTheDocument());
    expect(container.querySelectorAll("article[data-turn-id]")).toHaveLength(1);
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
  });

  it("убирается, если сервер отклонил отправку", async () => {
    state.sendImpl = async () => {
      throw new Error("Сервер отклонил запрос");
    };
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());

    await waitFor(() => expect(prompts(container)).toEqual([]));
    expect(screen.queryByText("Проверь сеть из песочницы")).toBeNull();
  });

  it("две одинаковые реплики подряд остаются двумя ходами", async () => {
    const { container } = await openSession();

    await sendMessage("Повтори");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledTimes(1));
    await pushAgentTurn("Первый ответ");
    await waitFor(() => expect(screen.getByText("Первый ответ")).toBeInTheDocument());

    await sendMessage("Повтори");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(prompts(container)).toEqual(["Повтори", "Повтори"]));
  });
  it("при постановке в очередь показывается один раз, а после перехода в ход становится его репликой", async () => {
    const { container } = await openSession();

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await act(async () => {
      state.stream!.push({
        type: "system.user_message_pending",
        event_id: "evt-queued-1",
        pending_seq: 1,
        enqueued_at: 1,
        session_thread_id: "sthr_primary",
        event: {
          type: "user.message",
          id: "evt-queued-1",
          content: [text("Проверь сеть из песочницы")],
        },
      });
    });

    await waitFor(() => expect(prompts(container)).toEqual([]));
    expect(screen.getAllByText("Проверь сеть из песочницы")).toHaveLength(1);

    await act(async () => {
      state.stream!.push({ type: "system.user_message_promoted", event_id: "evt-queued-1" });
      state.stream!.push({
        type: "user.message",
        id: "evt-queued-1",
        content: [text("Проверь сеть из песочницы")],
      });
    });
    await pushAgentTurn("Сеть доступна");

    await waitFor(() => expect(screen.getByText("Сеть доступна")).toBeInTheDocument());
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
    expect(screen.getAllByText("Проверь сеть из песочницы")).toHaveLength(1);
  });
});

describe("SessionDetail: реплика после user.message из потока", () => {
  /** id строк user.message на вкладке «События» инспектора. */
  function userMessageRows(container: HTMLElement) {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[role="table"][aria-label="События"] [role="row"][data-event-id]'),
    )
      .filter((row) => row.textContent?.startsWith("user.message"))
      .map((row) => row.dataset.eventId);
  }

  it("несёт id события сервера: «События» показывают тот же id, что журнал", async () => {
    const { container } = await openSession("/sessions/session-1?inspector=events");

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await act(async () => {
      state.stream!.push({
        type: "user.message",
        id: "sevt_server_0",
        processed_at: "2026-10-15T14:00:05.000Z",
        content: [text("Проверь сеть из песочницы")],
      });
    });

    await waitFor(() => expect(userMessageRows(container)).toEqual(["sevt_server_0"]));
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
  });

  it("несёт id события сервера, когда поток опередил ответ на POST", async () => {
    let answer: (value: unknown) => void = () => {};
    state.sendImpl = (events) =>
      new Promise((resolve) => {
        answer = () => resolve({ data: acceptedEvents(events) });
      });
    const { container } = await openSession("/sessions/session-1?inspector=events");

    await sendMessage("Проверь сеть из песочницы");
    await waitFor(() => expect(api.sessions.events.send).toHaveBeenCalledOnce());
    await act(async () => {
      state.stream!.push({
        type: "user.message",
        id: "sevt_server_0",
        processed_at: "2026-10-15T14:00:05.000Z",
        content: [text("Проверь сеть из песочницы")],
      });
    });
    await act(async () => {
      answer(null);
    });

    await waitFor(() => expect(userMessageRows(container)).toEqual(["sevt_server_0"]));
    expect(prompts(container)).toEqual(["Проверь сеть из песочницы"]);
  });
});
