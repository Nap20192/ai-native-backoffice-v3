import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { mockPlatformMcp } from "../components/assistant/test-fixtures";
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


const ask = (over: Frame = {}): Frame => ({
  type: "agent.tool_use",
  id: "toolu_ask",
  name: "bash",
  input: { command: "rm -rf build" },
  evaluated_permission: "ask",
  ...over,
});

function pushAsk(frame: Frame = ask()) {
  return act(async () => {
    state.stream!.push({ type: "session.status_running", id: "sevt_run_1" });
    state.stream!.push(frame);
    state.stream!.push({ type: "session.status_idle", id: "sevt_idle_1", stop_reason: { type: "requires_action", event_ids: [frame.id] } });
  });
}

describe("SessionDetail: запросы подтверждения", () => {
  it("показывает вызов с always_ask и отправляет обычный user.tool_confirmation", async () => {
    await openSession();
    await pushAsk();

    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    expect(group).toHaveTextContent("rm -rf build");
    await userEvent.click(within(group).getByRole("button", { name: "Разрешить" }));

    await waitFor(() =>
      expect(api.sessions.events.send).toHaveBeenCalledWith("session-1", {
        events: [{ type: "user.tool_confirmation", tool_use_id: "toolu_ask", result: "allow" }],
      }),
    );
  });

  it("отказ несёт причину", async () => {
    await openSession();
    await pushAsk();
    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    await userEvent.type(within(group).getByLabelText("Причина отказа"), "Не сейчас");
    await userEvent.click(within(group).getByRole("button", { name: "Отклонить" }));

    await waitFor(() =>
      expect(api.sessions.events.send).toHaveBeenCalledWith("session-1", {
        events: [{ type: "user.tool_confirmation", tool_use_id: "toolu_ask", result: "deny", deny_message: "Не сейчас" }],
      }),
    );
  });

  it("решение субагента уходит в его поток", async () => {
    await openSession();
    await pushAsk(ask({ session_thread_id: "sthr_sub" }));
    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    await userEvent.click(within(group).getByRole("button", { name: "Разрешить" }));

    await waitFor(() =>
      expect(api.sessions.events.send).toHaveBeenCalledWith("session-1", {
        events: [{ type: "user.tool_confirmation", tool_use_id: "toolu_ask", result: "allow", session_thread_id: "sthr_sub" }],
      }),
    );
  });

  it("блок исчезает, когда поток прислал решение", async () => {
    await openSession();
    await pushAsk();
    await screen.findByRole("group", { name: "Ожидает подтверждения" });
    await act(async () => {
      state.stream!.push({ type: "user.tool_confirmation", id: "sevt_conf", tool_use_id: "toolu_ask", result: "allow" });
    });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Ожидает подтверждения" })).toBeNull());
  });

  it("без вызовов с ask блока нет", async () => {
    await openSession();
    expect(screen.queryByRole("group", { name: "Ожидает подтверждения" })).toBeNull();
  });
});

/** Вызов записи сервера `platform` в обычной сессии, как его пишет Pi. */
const platformAsk = (over: Frame = {}): Frame => ({
  type: "agent.mcp_tool_use",
  id: "toolu_skill",
  mcp_server_name: "platform",
  name: "mcp__platform__create_skill",
  input: { display_title: "review" },
  evaluated_permission: "ask",
  ...over,
});

const SKILL_PREVIEW = {
  tool: "create_skill",
  preview_digest: "d-skill",
  can_confirm: true,
  owner_name: "Иван",
  operations: [
    {
      op_index: 0,
      tool: "create_skill",
      target_kind: "skill",
      name: "review",
      class: "create",
      before_yaml: null,
      after_yaml: "display_title: review\n",
      warnings: [],
    },
  ],
};

/** Типы событий, которые страница отправила сама через /v1/sessions/:id/events. */
function sentEventTypes(): string[] {
  return api.sessions.events.send.mock.calls.flatMap(([, body]) =>
    ((body as { events: Frame[] }).events ?? []).map((event) => String(event.type)),
  );
}

describe("SessionDetail: вызов записи платформы", () => {
  // Кнопка карточки создания называется «Создать», не «Применить»: так её
  // подписывает confirmLabelFor для create_* (ProposalCard.tsx).
  it("владелец видит карточку preview, «Создать» шлёт confirm с отпечатком из preview", async () => {
    const seen = mockPlatformMcp([SKILL_PREVIEW]);
    await openSession();
    await pushAsk(platformAsk());

    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    const card = await within(group).findByRole("article", { name: "Создать навык «review»" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Создать" })).toBeEnabled());
    expect(seen.previews).toEqual([{ session_id: "session-1", tool_use_id: "toolu_skill" }]);
    expect(within(group).queryByRole("button", { name: "Разрешить" })).toBeNull();
    expect(group).not.toHaveTextContent("панели ассистента");

    await userEvent.click(within(card).getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toEqual({
      session_id: "session-1",
      tool_use_id: "toolu_skill",
      result: "allow",
      preview_digest: "d-skill",
    });
    expect(await within(card).findByText("Отправлено. Жду результат")).toBeInTheDocument();
    // Решение записал сервер. Страница своё user.tool_confirmation не шлёт.
    expect(sentEventTypes()).not.toContain("user.tool_confirmation");

    // Сервер записал решение, поток принёс его: строка уходит.
    await act(async () => {
      state.stream!.push({ type: "user.tool_confirmation", id: "sevt_conf_skill", tool_use_id: "toolu_skill", result: "allow" });
    });
    await waitFor(() => expect(screen.queryByRole("group", { name: "Ожидает подтверждения" })).toBeNull());
  });

  it("отказ по карточке уходит в confirm, страница отказ не дублирует", async () => {
    const seen = mockPlatformMcp([SKILL_PREVIEW]);
    await openSession();
    await pushAsk(platformAsk());

    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    const card = await within(group).findByRole("article", { name: "Создать навык «review»" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Создать" })).toBeEnabled());
    await userEvent.click(within(card).getByRole("button", { name: "Отклонить" }));

    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ tool_use_id: "toolu_skill", result: "deny", preview_digest: "d-skill" });
    expect(sentEventTypes()).not.toContain("user.tool_confirmation");
  });

  it("не владелец видит карточку без кнопок и имя владельца", async () => {
    const seen = mockPlatformMcp([{ ...SKILL_PREVIEW, can_confirm: false, owner_name: "Анна" }]);
    await openSession();
    await pushAsk(platformAsk());

    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    expect(await within(group).findByText("Подтвердить может только Анна")).toBeInTheDocument();
    expect(within(group).getByText(/display_title: review/)).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "Создать" })).toBeNull();
    expect(within(group).queryByRole("button", { name: "Применить" })).toBeNull();
    expect(within(group).queryByRole("button", { name: "Разрешить" })).toBeNull();
    expect(within(group).queryByRole("button", { name: "Отклонить" })).toBeNull();
    expect(group).not.toHaveTextContent("панели ассистента");
    expect(seen.decisions).toHaveLength(0);
  });

  it("встроенный вызов с always_ask по-прежнему даёт «Разрешить» и «Отклонить» без preview", async () => {
    const seen = mockPlatformMcp([SKILL_PREVIEW]);
    await openSession();
    await pushAsk();

    const group = await screen.findByRole("group", { name: "Ожидает подтверждения" });
    expect(within(group).getByRole("button", { name: "Разрешить" })).toBeEnabled();
    expect(within(group).getByRole("button", { name: "Отклонить" })).toBeEnabled();
    expect(within(group).queryByRole("article")).toBeNull();
    expect(seen.previews).toHaveLength(0);
  });
});
