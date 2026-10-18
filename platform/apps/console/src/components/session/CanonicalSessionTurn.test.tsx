import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectCanonicalChatTurns,
  type CanonicalChatTurn,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import { buildTranscriptBlocks, collectToolCalls, type SessionEvent } from "../../lib/session-stats";
import {
  CanonicalSessionTurn,
  projectCanonicalSessionTurn,
  sessionErrorMessages,
  type CanonicalSessionTurnProps,
} from "./CanonicalSessionTurn";
import { formatClockRu, formatGapRu } from "./format-ru";

const T0 = Date.parse("2026-10-16T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const text = (value: string) => [{ type: "text", text: value }];

const FINAL_MESSAGE =
  "\n\nФайл `hello.py` создан и выполнен. Вывод:\n\n```\nHello, World!\n```";

/** Ход «создай python hello world»: три запроса, write, bash (ошибка), bash (успех). */
function helloWorldEvents(): WireSessionEvent[] {
  return [
    { type: "user.message", id: "u1", content: text("создай python hello world и распечатай"), processed_at: at(0) },
    { type: "session.status_running", id: "s1", processed_at: at(1) },
    { type: "span.model_request_start", id: "r1", processed_at: at(2) },
    { type: "agent.thinking", id: "th1", processed_at: at(4) },
    { type: "agent.message", id: "m1", content: text("Создам файл `hello.py` и запущу его."), processed_at: at(5) },
    { type: "agent.tool_use", id: "t1", name: "write", input: { path: "hello.py", content: "print('Hello, World!')" }, processed_at: at(6) },
    { type: "agent.tool_result", id: "t1r", tool_use_id: "t1", content: text("Записано"), processed_at: at(7) },
    { type: "agent.tool_use", id: "t2", name: "bash", input: { command: "python hello.py" }, processed_at: at(8) },
    { type: "agent.tool_result", id: "t2r", tool_use_id: "t2", content: text("python: not found"), is_error: true, processed_at: at(9) },
    {
      type: "span.model_request_end",
      id: "r1e",
      model_request_start_id: "r1",
      model_usage: { input_tokens: 6000, output_tokens: 275, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
      processed_at: at(10),
    },
    { type: "span.model_request_start", id: "r2", processed_at: at(11) },
    { type: "agent.tool_use", id: "t3", name: "bash", input: { command: "python3 hello.py" }, processed_at: at(12) },
    { type: "agent.tool_result", id: "t3r", tool_use_id: "t3", content: text("Hello, World!"), processed_at: at(13) },
    { type: "span.model_request_end", id: "r2e", model_request_start_id: "r2", processed_at: at(14) },
    { type: "span.model_request_start", id: "r3", processed_at: at(15) },
    { type: "agent.message", id: "m2", content: text(FINAL_MESSAGE), processed_at: at(20) },
    { type: "span.model_request_end", id: "r3e", model_request_start_id: "r3", processed_at: at(21) },
    { type: "session.status_idle", id: "s2", processed_at: at(28) },
  ];
}

function turnFrom(events: WireSessionEvent[]): CanonicalChatTurn {
  const [turn] = projectCanonicalChatTurns(events);
  if (!turn) throw new Error("из событий не получился ход");
  return turn;
}

function setup(
  events: WireSessionEvent[],
  overrides: Partial<CanonicalSessionTurnProps> = {},
) {
  const turn = turnFrom(events);
  const blocks = buildTranscriptBlocks(turn.rawEvents as unknown as SessionEvent[]);
  const props: CanonicalSessionTurnProps = {
    turn,
    blocks,
    agentName: "Deep researcher",
    selectedEventId: null,
    selectedBlockId: null,
    expandSelected: true,
    hoveredBlockId: null,
    onSelectEvent: vi.fn(),
    onJumpToBlock: vi.fn(),
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <CanonicalSessionTurn {...props} />
    </MemoryRouter>,
  );
  const rerender = (next: Partial<CanonicalSessionTurnProps>) =>
    view.rerender(
      <MemoryRouter>
        <CanonicalSessionTurn {...props} {...next} />
      </MemoryRouter>,
    );
  return { ...view, props, blocks, rerender };
}

const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
const callRow = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-event-id="${id}"]`);

function mockHeight(height: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
}

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  vi.restoreAllMocks();
});

describe("CanonicalSessionTurn: каркас хода", () => {
  it("рисует ход как article с id и статусом", () => {
    const { container } = setup(helloWorldEvents());

    const article = container.querySelector("article[data-turn-id]");
    expect(article).not.toBeNull();
    expect(article).toHaveAttribute("data-session-turn-status", "completed");
  });

  it("ставит блоки по порядку: пользователь, карточки запросов", () => {
    const { container } = setup(helloWorldEvents());

    const order = Array.from(container.querySelectorAll("[data-block-id]")).map(
      (node) => (node as HTMLElement).dataset.blockId,
    );
    expect(order).toEqual(["u1", "r1", "r2", "r3"]);
  });
});

describe("CanonicalSessionTurn: реплика пользователя", () => {
  it("пишет плашку «Пользователь», время и текст реплики", () => {
    const { container } = setup(helloWorldEvents());

    const user = block(container, "u1")!;
    expect(within(user).getByText("Пользователь")).toBeInTheDocument();
    expect(within(user).getByText(formatClockRu(T0))).toBeInTheDocument();
    expect(user.querySelector("[data-session-turn-prompt]")).toHaveTextContent(
      "создай python hello world и распечатай",
    );
  });

  it("показывает реплику из текста хода, когда блока пользователя нет", () => {
    const turn = turnFrom(helloWorldEvents());
    const { container } = render(
      <MemoryRouter>
        <CanonicalSessionTurn
          agentName="Агент"
          blocks={[]}
          expandSelected
          hoveredBlockId={null}
          onJumpToBlock={vi.fn()}
          onSelectEvent={vi.fn()}
          selectedBlockId={null}
          selectedEventId={null}
          turn={turn}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector("[data-session-turn-prompt]")).toHaveTextContent(
      "создай python hello world и распечатай",
    );
  });

  it("подписывает пробуждение по расписанию", () => {
    const { container } = setup([
      {
        type: "user.message",
        id: "u1",
        content: text("Проверь почту"),
        metadata: { harness: "schedule", kind: "wakeup", scheduled_at: at(0) },
        processed_at: at(0),
      },
      { type: "session.status_idle", id: "s", processed_at: at(1) },
    ]);

    expect(within(block(container, "u1")!).getByText("Пробуждение по расписанию")).toBeInTheDocument();
  });

  it("реплика без подтверждения сервером помечена «Отправляется»", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("Привет"), status: "pending", processed_at: null },
    ]);

    expect(within(block(container, "u1")!).getByText("Отправляется…")).toBeInTheDocument();
  });

  it("клик по карточке выбирает блок", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents());

    await user.click(container.querySelector("[data-session-turn-prompt]")!);

    expect(props.onSelectEvent).toHaveBeenCalledWith("u1");
  });
});

describe("CanonicalSessionTurn: метка агента и «Думал»", () => {
  it("ставит метку агента с временем один раз перед серией карточек", () => {
    const { container } = setup(helloWorldEvents());

    const headers = container.querySelectorAll("[data-agent-header]");
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveTextContent("Deep researcher");
    expect(headers[0]).toHaveTextContent(formatClockRu(T0 + 2000));
    expect(
      headers[0]!.compareDocumentPosition(block(container, "r1")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("повторяет метку агента после блока не агента", () => {
    const events = helloWorldEvents();
    events.splice(14, 0, {
      type: "user.define_outcome",
      id: "o1",
      outcome_id: "out-1",
      description: "Отчёт",
      rubric: { type: "text", content: "- Критерий" },
      processed_at: at(14),
    });
    const { container } = setup(events);

    expect(container.querySelectorAll("[data-agent-header]")).toHaveLength(2);
  });

  it("пишет «Думал 2 с» вверху карточки, если была мысль", () => {
    const { container } = setup(helloWorldEvents());

    expect(within(block(container, "r1")!).getByText("Думал 2 с")).toBeInTheDocument();
    expect(within(block(container, "r2")!).queryByText(/Думал/)).not.toBeInTheDocument();
  });

  it("мысль без времени подписана просто «Думал»", () => {
    const events = helloWorldEvents().map((event) => {
      if (event.type === "agent.thinking") {
        const { processed_at: _drop, ...rest } = event;
        return rest as WireSessionEvent;
      }
      return event;
    });
    const { container } = setup(events);

    expect(within(block(container, "r1")!).getByText("Думал")).toBeInTheDocument();
  });

  it("клик по подписи «Думал» выделяет группу", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents());

    await user.click(within(block(container, "r1")!).getByText("Думал 2 с"));

    expect(props.onSelectEvent).toHaveBeenCalledWith("r1");
    expect(props.onSelectEvent).toHaveBeenCalledTimes(1);
  });

  it("у карточки с запросом нет токенов, хотя событие конца запроса их несёт", () => {
    const { container } = setup(helloWorldEvents());

    expect(container.querySelector("[data-session-usage]")).toBeNull();
    expect(block(container, "r1")).not.toHaveTextContent(/[↑↓]|тыс\./);
  });

  it("запрос к модели с ошибкой помечен красной плашкой «Ошибка запроса»", () => {
    const events = helloWorldEvents().map((event) =>
      event.type === "span.model_request_end" && event.id === "r2e" ? { ...event, is_error: true } : event,
    );
    const { container } = setup(events);

    const badge = within(block(container, "r2")!).getByText("Ошибка запроса");
    expect(badge.className).toContain("ddc-tone-danger");
    expect(within(block(container, "r1")!).queryByText("Ошибка запроса")).not.toBeInTheDocument();
  });
});

describe("CanonicalSessionTurn: текст агента", () => {
  it("рисует ответ Markdown и помечает итоговый ответ", () => {
    const { container } = setup(helloWorldEvents());

    const answer = container.querySelector("[data-session-turn-answer]");
    expect(answer).not.toBeNull();
    expect(answer!.textContent).toContain("Файл hello.py создан и выполнен. Вывод:");
    expect(answer!.querySelector("pre code")?.textContent?.trim()).toBe("Hello, World!");
  });

  it("показывает каждое сообщение целиком и по одному разу", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("вопрос"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.message", id: "m1", content: text("Готово."), processed_at: at(2) },
      { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "ls" }, processed_at: at(3) },
      { type: "agent.tool_result", id: "t1r", tool_use_id: "t1", content: text("a.txt"), processed_at: at(4) },
      { type: "span.model_request_end", id: "r1e", model_request_start_id: "r1", processed_at: at(5) },
      { type: "span.model_request_start", id: "r2", processed_at: at(6) },
      { type: "agent.message", id: "m2", content: text("Готово. Итог: файл создан."), processed_at: at(7) },
      { type: "span.model_request_end", id: "r2e", model_request_start_id: "r2", processed_at: at(8) },
      { type: "session.status_idle", id: "s", processed_at: at(9) },
    ]);

    const count = (needle: string) => (container.textContent ?? "").split(needle).length - 1;
    expect(count("Готово. Итог: файл создан.")).toBe(1);
    expect(container.querySelector("[data-session-turn-answer]")?.textContent?.trim()).toBe(
      "Готово. Итог: файл создан.",
    );
    expect(container.querySelectorAll("[data-session-agent-text]")).toHaveLength(2);
  });

  it("длинный ответ сворачивается: «Читать дальше», затем «Свернуть»", async () => {
    mockHeight(900);
    const user = userEvent.setup();
    const { container } = setup(helloWorldEvents());
    const clamp = block(container, "r3")!.querySelector<HTMLElement>("[data-session-clamp]")!;

    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
    await user.click(within(block(container, "r3")!).getByRole("button", { name: "Читать дальше" }));
    expect(clamp).toHaveAttribute("data-clamp-state", "expanded");
    await user.click(within(block(container, "r3")!).getByRole("button", { name: "Свернуть" }));
    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
  });

  it("«Читать дальше» не выбирает блок", async () => {
    mockHeight(900);
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents());

    await user.click(within(block(container, "r3")!).getByRole("button", { name: "Читать дальше" }));

    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });
});

describe("CanonicalSessionTurn: строки вызовов", () => {
  it("пишет имя моноширинным, аргумент в одну строку с обрезкой и длительность справа", () => {
    const { container } = setup(helloWorldEvents());

    const row = callRow(container, "t3")!;
    const name = within(row).getByText("bash");
    expect(name).toHaveClass("font-mono");
    expect(name).toHaveClass("font-semibold");
    const preview = within(row).getByText("python3 hello.py");
    expect(preview).toHaveClass("truncate");
    expect(preview).toHaveClass("font-mono");
    expect(preview).toHaveAttribute("title", "python3 hello.py");
    expect(within(row).getByText("1 с")).toBeInTheDocument();
    expect(row.querySelector("svg")).not.toBeNull();
  });

  it("для write и edit показывает путь файла", () => {
    const { container } = setup(helloWorldEvents());

    expect(within(callRow(container, "t1")!).getByText("hello.py")).toBeInTheDocument();
  });

  it("у упавшего вызова есть красная плашка «Ошибка», у успешного её нет", () => {
    const { container } = setup(helloWorldEvents());

    const failed = within(callRow(container, "t2")!).getByText("Ошибка");
    expect(failed.className).toContain("ddc-tone-danger");
    expect(within(callRow(container, "t3")!).queryByText("Ошибка")).not.toBeInTheDocument();
  });

  it("помечает отклонённый и прерванный вызовы", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("вопрос"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.tool_use", id: "d1", name: "bash", input: { command: "rm -rf /" }, processed_at: at(2) },
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "d1", result: "deny", processed_at: at(3) },
      { type: "agent.tool_use", id: "i1", name: "bash", input: { command: "sleep 99" }, processed_at: at(4) },
      { type: "session.status_idle", id: "s", processed_at: at(5) },
    ]);

    expect(within(callRow(container, "d1")!).getByText("Отклонено")).toBeInTheDocument();
    expect(within(callRow(container, "i1")!).getByText("Прервано")).toBeInTheDocument();
  });

  it("у вызова без результата показывает ожидание, а не длительность", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("вопрос"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.tool_use", id: "run1", name: "bash", input: { command: "make" }, processed_at: at(2) },
    ]);

    expect(within(callRow(container, "run1")!).getByText("Выполняется")).toBeInTheDocument();
  });

  it("вызов, который ждёт подтверждения, подписан «Ждёт вас»", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("вопрос"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.tool_use", id: "ask1", name: "bash", input: { command: "make" }, evaluated_permission: "ask", processed_at: at(2) },
    ]);

    expect(within(callRow(container, "ask1")!).getByText("Ждёт вас")).toBeInTheDocument();
  });

  describe("ход встал на requires_action", () => {
    const asked: WireSessionEvent[] = [
      { type: "user.message", id: "u1", content: text("Запиши акт"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.mcp_tool_use", id: "ask1", name: "mcp__crm__write_act", mcp_server_name: "crm", input: { id: 7 }, evaluated_permission: "ask", processed_at: at(2) },
      { type: "span.model_request_end", id: "r1e", model_request_start_id: "r1", processed_at: at(3) },
      { type: "session.status_idle", id: "s", stop_reason: { type: "requires_action", event_ids: ["ask1"] }, processed_at: at(4) },
    ];

    it("вызов ждёт вас, а не прерван", () => {
      const { container } = setup(asked);

      expect(within(callRow(container, "ask1")!).getByText("Ждёт вас")).toBeInTheDocument();
      expect(within(callRow(container, "ask1")!).queryByText("Прервано")).toBeNull();
    });

    it("после «Разрешить» вызов выполняется и больше не ждёт вас", () => {
      const all = [...asked, { type: "user.tool_confirmation", id: "c1", tool_use_id: "ask1", result: "allow", processed_at: at(10) }] as WireSessionEvent[];
      const turn = turnFrom(all);
      const blocks = buildTranscriptBlocks(turn.rawEvents as unknown as SessionEvent[], { toolCalls: collectToolCalls(all as unknown as SessionEvent[]) });

      const { container } = setup(all, { blocks });

      expect(within(callRow(container, "ask1")!).queryByText("Ждёт вас")).toBeNull();
      expect(within(callRow(container, "ask1")!).getByText("Выполняется")).toBeInTheDocument();
    });
  });

  it("свёрнутая строка не показывает ввод и вывод", () => {
    const { container } = setup(helloWorldEvents());

    expect(container.querySelector("[data-tool-output]")).toBeNull();
    expect(within(callRow(container, "t3")!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("клик по строке выбирает событие вызова и не выбирает карточку", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents());

    await user.click(within(callRow(container, "t3")!).getByRole("button"));

    expect(props.onSelectEvent).toHaveBeenCalledTimes(1);
    expect(props.onSelectEvent).toHaveBeenCalledWith("t3");
  });

  it("вызов не раскрывается, пока выбор пришёл из «Инструментов» или мини-карты", () => {
    const { container } = setup(helloWorldEvents(), { selectedEventId: "t3", selectedBlockId: "r2", expandSelected: false });

    const row = callRow(container, "t3")!;
    expect(row).toHaveAttribute("data-selected", "true");
    expect(within(row).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("[data-tool-output]")).toBeNull();
  });

  it("выбранный вызов раскрывается, выбор результата раскрывает тот же вызов", () => {
    const { container, rerender } = setup(helloWorldEvents(), { selectedEventId: "t3", selectedBlockId: "r2" });
    expect(within(callRow(container, "t3")!).getByRole("button", { name: /bash/ })).toHaveAttribute("aria-expanded", "true");

    rerender({ selectedEventId: "t3r", selectedBlockId: "r2" });
    expect(within(callRow(container, "t3")!).getByRole("button", { name: /bash/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("повторный клик по раскрытому вызову снимает выбор", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents(), { selectedEventId: "t3", selectedBlockId: "r2" });

    await user.click(within(callRow(container, "t3")!).getByRole("button", { name: /bash/ }));

    expect(props.onSelectEvent).toHaveBeenCalledWith(null);
  });

  it("выбранная строка вызова получает рамку, а карточка вокруг неё нет", () => {
    const { container } = setup(helloWorldEvents(), { selectedEventId: "t3", selectedBlockId: "r2" });

    expect(callRow(container, "t3")!.className).toContain("ring-ddc-ring");
    expect(block(container, "r2")).toHaveAttribute("data-selected", "false");
  });
});

describe("CanonicalSessionTurn: раскрытый вызов", () => {
  const bashOutput =
    "VERIFY_OK_1\nkernel=6.12.76\n\u001b[2m2026-10-15T14:31:55Z\u001b[0m \u001b[33m WARN\u001b[0m runtime: seccomp";

  function bashEvents(output: unknown, isError = false): WireSessionEvent[] {
    return [
      { type: "user.message", id: "u1", content: text("Запусти uname"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.tool_use", id: "b1", name: "bash", input: { command: "uname -r" }, processed_at: at(2) },
      { type: "agent.tool_result", id: "b1r", tool_use_id: "b1", content: output, is_error: isError, processed_at: at(3) },
      { type: "span.model_request_end", id: "r1e", model_request_start_id: "r1", processed_at: at(4) },
      { type: "session.status_idle", id: "s", processed_at: at(5) },
    ];
  }

  const open = (events: WireSessionEvent[]) =>
    setup(events, { selectedEventId: "b1", selectedBlockId: "r1" });

  it("bash: команда с приглашением $ и блок вывода", () => {
    const { container } = open(bashEvents(text("Linux")));

    const row = callRow(container, "b1")!;
    expect(row.querySelector("[data-tool-command]")).toHaveTextContent("$ uname -r");
    expect(row.querySelector("[data-tool-output]")).toHaveTextContent("Linux");
  });

  it("показывает вывод текстом из content-блоков, а не JSON-массивом", () => {
    const { container } = open(bashEvents(text(bashOutput)));

    const body = container.querySelector("[data-tool-output]")!.textContent ?? "";
    expect(body).not.toContain('"type"');
    expect(body).not.toContain("\\n");
    expect(body.trimStart().startsWith("[")).toBe(false);
    expect(body.split("\n")).toContain("kernel=6.12.76");
  });

  it("убирает управляющие последовательности ANSI из вывода", () => {
    const { container } = open(bashEvents(text(bashOutput)));

    const body = container.querySelector("[data-tool-output]")!.textContent ?? "";
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("\\u001b");
    expect(body).toContain("2026-10-15T14:31:55Z  WARN runtime: seccomp");
  });

  it("склеивает несколько текстовых блоков построчно", () => {
    const { container } = open(bashEvents([...text("первая строка"), ...text("вторая строка")]));

    expect(container.querySelector("[data-tool-output]")!.textContent).toContain(
      "первая строка\nвторая строка",
    );
  });

  it("оставляет JSON для структурированного вывода без текстовых блоков", () => {
    const { container } = open(bashEvents({ rows: 3 }));

    expect(container.querySelector("[data-tool-output]")!.textContent).toContain('"rows"');
  });

  it("у неудачного вызова текст ошибки стоит в красном блоке один раз", () => {
    const { container } = open(bashEvents(text("команда не найдена"), true));

    const outputs = container.querySelectorAll("[data-tool-output]");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.className).toContain("ddc-tone-danger");
    expect((outputs[0]!.textContent ?? "").split("команда не найдена").length - 1).toBe(1);
    expect(callRow(container, "b1")!.querySelector("[data-tool-command]")).toHaveTextContent("uname -r");
  });

  it("длинный вывод сворачивается с кнопкой «Читать дальше»", () => {
    mockHeight(900);
    const { container } = open(bashEvents(text("строка\n".repeat(100))));

    const clamp = container.querySelector("[data-tool-output] [data-session-clamp]");
    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
  });

  it("копирует вывод кнопкой «Копировать»", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = open(bashEvents(text("Linux")));

    const output = container.querySelector<HTMLElement>("[data-tool-output]")!;
    await user.click(within(output).getByRole("button", { name: "Копировать" }));

    expect(writeText).toHaveBeenCalledWith("Linux");
  });

  it("write: путь файла с копированием и содержимое с подсветкой по расширению", () => {
    const { container } = setup(helloWorldEvents(), { selectedEventId: "t1", selectedBlockId: "r1" });

    const row = callRow(container, "t1")!;
    expect(row.querySelector("[data-tool-path]")).toHaveTextContent("hello.py");
    expect(within(row).getAllByRole("button", { name: "Копировать" }).length).toBeGreaterThan(0);
    expect(row.querySelector("code.hljs")).not.toBeNull();
    expect(row).toHaveTextContent("print('Hello, World!')");
  });

  it("write в файл без известного расширения показывает содержимое без подсветки", () => {
    const events = helloWorldEvents().map((event) =>
      event.type === "agent.tool_use" && event.id === "t1"
        ? { ...event, input: { path: "/mnt/out/report.md", content: "# Отчёт" } }
        : event,
    );
    const { container } = setup(events, { selectedEventId: "t1", selectedBlockId: "r1" });

    const row = callRow(container, "t1")!;
    expect(row).toHaveTextContent("# Отчёт");
    expect(row.querySelector("code.hljs")).toBeNull();
  });

  it("edit: путь, старый и новый текст", () => {
    const { container } = setup(
      [
        { type: "user.message", id: "u1", content: text("правь"), processed_at: at(0) },
        { type: "span.model_request_start", id: "r1", processed_at: at(1) },
        {
          type: "agent.tool_use",
          id: "e1",
          name: "edit",
          input: { file_path: "/w/a.txt", old_string: "было", new_string: "стало" },
          processed_at: at(2),
        },
        { type: "agent.tool_result", id: "e1r", tool_use_id: "e1", content: text("ok"), processed_at: at(3) },
      ],
      { selectedEventId: "e1", selectedBlockId: "r1" },
    );

    const row = callRow(container, "e1")!;
    expect(row.querySelector("[data-tool-path]")).toHaveTextContent("/w/a.txt");
    expect(row.querySelector("[data-tool-old]")).toHaveTextContent("было");
    expect(row.querySelector("[data-tool-new]")).toHaveTextContent("стало");
  });

  it("write с полем filePath, как его пишет наш харнесс: путь, подсветка, путь в строке вызова", () => {
    const { container } = setup(
      [
        { type: "user.message", id: "u1", content: text("создай"), processed_at: at(0) },
        { type: "span.model_request_start", id: "r1", processed_at: at(1) },
        {
          type: "agent.tool_use",
          id: "w1",
          name: "write",
          input: { content: "print(\"Hello, World!\")", filePath: "/workspace/hello.py" },
          processed_at: at(2),
        },
        { type: "agent.tool_result", id: "w1r", tool_use_id: "w1", content: text("/workspace/hello.py"), processed_at: at(3) },
        {
          type: "agent.tool_use",
          id: "e1",
          name: "edit",
          input: { filePath: "/w/a.txt", oldString: "было", newString: "стало" },
          processed_at: at(4),
        },
        { type: "agent.tool_result", id: "e1r", tool_use_id: "e1", content: text("ok"), processed_at: at(5) },
      ],
      { selectedEventId: "w1", selectedBlockId: "r1" },
    );

    const write = callRow(container, "w1")!;
    expect(write.querySelector("[data-tool-path]")).toHaveTextContent("/workspace/hello.py");
    expect(write.querySelector("code.hljs")).not.toBeNull();
    expect(within(write).getAllByRole("button")[0]).toHaveTextContent("/workspace/hello.py");
  });

  it("edit с полями oldString и newString показывает старый и новый текст", () => {
    const { container } = setup(
      [
        { type: "user.message", id: "u1", content: text("правь"), processed_at: at(0) },
        { type: "span.model_request_start", id: "r1", processed_at: at(1) },
        { type: "agent.tool_use", id: "e1", name: "edit", input: { filePath: "/w/a.txt", oldString: "было", newString: "стало" }, processed_at: at(2) },
        { type: "agent.tool_result", id: "e1r", tool_use_id: "e1", content: text("ok"), processed_at: at(3) },
      ],
      { selectedEventId: "e1", selectedBlockId: "r1" },
    );

    const row = callRow(container, "e1")!;
    expect(row.querySelector("[data-tool-path]")).toHaveTextContent("/w/a.txt");
    expect(row.querySelector("[data-tool-old]")).toHaveTextContent("было");
    expect(row.querySelector("[data-tool-new]")).toHaveTextContent("стало");
  });

  it("другие инструменты: ввод с копированием и красный блок ошибки", () => {
    const { container } = setup(
      [
        { type: "user.message", id: "u1", content: text("найди"), processed_at: at(0) },
        { type: "span.model_request_start", id: "r1", processed_at: at(1) },
        { type: "agent.tool_use", id: "w1", name: "web_search", input: { query: "малые реакторы 2026" }, processed_at: at(2) },
        {
          type: "agent.tool_result",
          id: "w1r",
          tool_use_id: "w1",
          content: text("url_not_allowed"),
          is_error: true,
          processed_at: at(3),
        },
      ],
      { selectedEventId: "w1", selectedBlockId: "r1" },
    );

    const row = callRow(container, "w1")!;
    expect(row.querySelector("[data-tool-command]")).toHaveTextContent("малые реакторы 2026");
    expect(row.querySelector("[data-tool-output]")).toHaveTextContent("url_not_allowed");
    expect(row.querySelector("[data-tool-output]")!.className).toContain("ddc-tone-danger");
  });

  it("отклонённый вызов без вывода объясняет, что он не выполнялся", () => {
    const { container } = setup(
      [
        { type: "user.message", id: "u1", content: text("вопрос"), processed_at: at(0) },
        { type: "span.model_request_start", id: "r1", processed_at: at(1) },
        { type: "agent.tool_use", id: "d1", name: "bash", input: { command: "rm x" }, processed_at: at(2) },
        { type: "user.tool_confirmation", id: "c1", tool_use_id: "d1", result: "deny", processed_at: at(3) },
      ],
      { selectedEventId: "d1", selectedBlockId: "r1" },
    );

    expect(callRow(container, "d1")).toHaveTextContent("Вы отклонили этот вызов, он не выполнялся.");
  });
});

describe("CanonicalSessionTurn: выбор и наведение", () => {
  it("выбранный блок получает рамку и пометку", () => {
    const { container } = setup(helloWorldEvents(), { selectedEventId: "m2", selectedBlockId: "r3" });

    const card = block(container, "r3")!;
    expect(card).toHaveAttribute("data-selected", "true");
    expect(card.className).toContain("ring-ddc-ring");
    expect(block(container, "r1")).toHaveAttribute("data-selected", "false");
  });

  it("клик по карточке запроса выбирает id первого события группы", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents());

    await user.click(container.querySelector("[data-session-turn-answer]")!);

    expect(props.onSelectEvent).toHaveBeenCalledWith("r3");
  });

  it("выделение текста мышью не выбирает блок", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(helloWorldEvents());
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "создай python",
    } as unknown as Selection);

    await user.click(container.querySelector("[data-session-turn-prompt]")!);

    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("наведённый с мини-карты блок помечен", () => {
    const { container } = setup(helloWorldEvents(), { hoveredBlockId: "r2" });

    expect(block(container, "r2")).toHaveAttribute("data-hovered", "true");
    expect(block(container, "r1")).toHaveAttribute("data-hovered", "false");
  });
});

describe("CanonicalSessionTurn: результат и оценка", () => {
  const OUTCOME_ID = "outcome-1";
  function outcomeEvents(): WireSessionEvent[] {
    return [
      { type: "user.message", id: "u1", content: text("Сделай отчёт"), processed_at: at(0) },
      {
        type: "user.define_outcome",
        id: "o1",
        outcome_id: OUTCOME_ID,
        description: "Отчёт с источниками",
        rubric: { type: "text", content: "- Есть ссылки\n- Есть выводы" },
        max_iterations: 3,
        processed_at: at(1),
      },
      { type: "span.outcome_evaluation_start", id: "es0", outcome_id: OUTCOME_ID, iteration: 0, processed_at: at(2) },
      {
        type: "span.outcome_evaluation_end",
        id: "ee0",
        outcome_id: OUTCOME_ID,
        iteration: 0,
        result: "needs_revision",
        explanation: "Нет ссылок",
        processed_at: at(3),
      },
      { type: "span.outcome_evaluation_start", id: "es1", outcome_id: OUTCOME_ID, iteration: 1, processed_at: at(4) },
      {
        type: "span.outcome_evaluation_end",
        id: "ee1",
        outcome_id: OUTCOME_ID,
        iteration: 1,
        result: "satisfied",
        explanation: "Всё в порядке",
        processed_at: at(5),
      },
      { type: "session.status_idle", id: "s", processed_at: at(6) },
    ];
  }

  it("рисует блок «Задан результат» и блоки оценки", () => {
    const { container } = setup(outcomeEvents());

    expect(within(block(container, "o1")!).getByText("Задан результат")).toBeInTheDocument();
    expect(within(block(container, "es0")!).getByText("Итерация 1")).toBeInTheDocument();
    expect(within(block(container, "es1")!).getByText("Итерация 2")).toBeInTheDocument();
    expect(within(block(container, "es1")!).getByText("Выполнено")).toBeInTheDocument();
  });

  it("«Критерии» ведёт к блоку результата", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(outcomeEvents());

    await user.click(within(block(container, "es0")!).getByRole("button", { name: "Критерии" }));

    expect(props.onJumpToBlock).toHaveBeenCalledWith("o1");
  });

  it("«Далее» и «Назад» ведут к соседним оценкам", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(outcomeEvents());

    await user.click(within(block(container, "es0")!).getByRole("button", { name: "Далее" }));
    await user.click(within(block(container, "es1")!).getByRole("button", { name: "Назад" }));

    expect(props.onJumpToBlock).toHaveBeenNthCalledWith(1, "es1");
    expect(props.onJumpToBlock).toHaveBeenNthCalledWith(2, "es0");
    expect(within(block(container, "es0")!).getByRole("button", { name: "Назад" })).toBeDisabled();
    expect(within(block(container, "es1")!).getByRole("button", { name: "Далее" })).toBeDisabled();
  });

  it("клик по блоку оценки выбирает его", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(outcomeEvents());

    await user.click(within(block(container, "es0")!).getByText("Нет ссылок"));

    expect(props.onSelectEvent).toHaveBeenCalledWith("es0");
  });
});

describe("CanonicalSessionTurn: разрыв времени", () => {
  it("рисует серую плашку с датой и длительностью простоя", () => {
    const gapMs = 13 * 3_600_000 + 56 * 60_000;
    const events: WireSessionEvent[] = [
      { type: "user.message", id: "u1", content: text("Привет"), processed_at: at(0) },
      { type: "agent.message", id: "m1", content: text("Здравствуйте"), processed_at: at(1) },
      { type: "session.status_idle", id: "s1", processed_at: at(2) },
    ];
    const turn = turnFrom(events);
    const blocks = buildTranscriptBlocks(turn.rawEvents as unknown as SessionEvent[], {
      previousEventMs: T0 - gapMs,
    });
    const { container } = setup(events, { blocks });

    const gap = container.querySelector("[data-block-kind='gap']")!;
    expect(gap).toHaveTextContent(formatGapRu(T0, gapMs));
    expect(gap.firstElementChild?.className).toContain("bg-ddc-surface-sunken");
  });
});

describe("CanonicalSessionTurn: ошибки и предупреждения", () => {
  const NO_CARD =
    "No model card matched and ANTHROPIC_API_KEY is unset — configure a model card or set the env var";

  function errorTurnEvents(error: unknown): WireSessionEvent[] {
    return [
      { type: "user.message", id: "u1", content: text("привет"), processed_at: at(0) },
      { type: "session.status_running", id: "r", processed_at: at(1) },
      { type: "session.error", id: "e1", error, processed_at: at(2) },
      { type: "session.status_idle", id: "i", processed_at: at(3) },
    ];
  }

  const errorBox = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-session-turn-status-message="error"]');

  it("пишет по-русски «Ошибка сессии» и причину из error.message", () => {
    const { container } = setup(
      errorTurnEvents({ type: "unknown_error", message: NO_CARD, retryStatus: "exhausted" }),
    );

    const box = errorBox(container);
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain("Ошибка сессии");
    expect(box!.textContent).toContain(NO_CARD);
    expect(container.textContent).not.toContain("Session error");
  });

  it("принимает причину строкой", () => {
    const { container } = setup(errorTurnEvents("Не удалось запустить песочницу"));

    expect(errorBox(container)?.textContent).toContain("Не удалось запустить песочницу");
  });

  it("для отсутствующей карточки модели даёт подсказку со ссылкой на «Карточки моделей»", () => {
    const { container } = setup(errorTurnEvents({ type: "unknown_error", message: NO_CARD }));

    const link = errorBox(container)?.querySelector<HTMLAnchorElement>('a[href="/model-cards"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("Карточки моделей");
    expect(errorBox(container)!.textContent).toContain("карточк");
  });

  it("не добавляет подсказку про карточки к другим ошибкам", () => {
    const { container } = setup(errorTurnEvents({ type: "unknown_error", message: "sandbox boot failed" }));

    expect(errorBox(container)?.querySelector("a")).toBeNull();
  });

  it("для сбоя установки пакетов окружения даёт русскую подсказку", () => {
    const { container } = setup(
      errorTurnEvents({
        type: "unknown_error",
        message:
          "LiteBoxSandbox: environment packages failed to install (exit 100) (networking is limited and package managers are not allowed): E: Unable to locate package jq",
      }),
    );

    const box = errorBox(container);
    expect(box?.textContent).toContain("Не установились пакеты окружения");
    expect(box?.textContent).toContain("Разрешить сетевой доступ менеджерам пакетов");
    expect(box?.querySelector('a[href="/environments"]')?.textContent).toBe("Окружения");
  });

  it("переполнение контекста модели объясняет по-русски, а текст сервера прячет в «Текст ошибки»", () => {
    const raw =
      '400: {"message":"litellm.ContextWindowExceededError: litellm.BadRequestError: This model\'s maximum context length is 262144 tokens."}';
    const { container } = setup(errorTurnEvents({ type: "unknown_error", message: raw }));

    const box = errorBox(container)!;
    expect(box.textContent).toContain("Разговор не поместился в контекст модели");
    const details = box.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("summary")?.textContent).toBe("Текст ошибки");
    expect(details!.textContent).toContain("ContextWindowExceededError");
    const visible = [...box.querySelectorAll(":scope > p")].map((node) => node.textContent).join(" ");
    expect(visible).not.toContain("ContextWindowExceededError");
  });

  it("ошибку без подсказки показывает целиком, без «Текст ошибки»", () => {
    const { container } = setup(errorTurnEvents({ type: "unknown_error", message: "sandbox boot failed" }));

    expect(errorBox(container)?.querySelector("details")).toBeNull();
    expect(errorBox(container)?.textContent).toContain("sandbox boot failed");
  });

  it("без причины в событии говорит, что ход завершился ошибкой", () => {
    const { container } = setup(errorTurnEvents(undefined));

    const box = errorBox(container);
    expect(box?.textContent).toContain("Ошибка сессии");
    expect(box?.textContent).toContain("Ход завершился ошибкой.");
    expect(container.textContent).not.toContain("Session error");
  });

  it("не показывает одну и ту же причину несколько раз при повторах", () => {
    const events = errorTurnEvents({ type: "unknown_error", message: "boom", retryStatus: "retrying" });
    events.splice(3, 0, {
      type: "session.error",
      id: "e2",
      error: { type: "unknown_error", message: "boom", retryStatus: "exhausted" },
      processed_at: at(3),
    });
    const { container } = setup(events);

    expect((errorBox(container)?.textContent ?? "").split("boom").length - 1).toBe(1);
    expect(container.querySelectorAll('[data-session-turn-status-message="error"]')).toHaveLength(1);
  });

  it("клик по ошибке выбирает её событие", async () => {
    const user = userEvent.setup();
    const { container, props } = setup(errorTurnEvents({ type: "unknown_error", message: "boom" }));

    await user.click(within(errorBox(container)!).getByText("Ошибка сессии"));

    expect(props.onSelectEvent).toHaveBeenCalledWith("e1");
  });

  it("предупреждение сессии выводит текст в блоке состояния", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("привет"), processed_at: at(0) },
      { type: "session.warning", id: "w1", source: "agent", message: "Контекст почти заполнен", processed_at: at(1) },
      { type: "session.status_idle", id: "i", processed_at: at(2) },
    ]);

    const warning = block(container, "w1")!;
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveTextContent("Контекст почти заполнен");
  });
});

describe("CanonicalSessionTurn: сообщения между агентами", () => {
  it("показывает отправленное и полученное сообщение с именем агента", () => {
    const { container } = setup([
      { type: "user.message", id: "u1", content: text("вопрос"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(1) },
      { type: "agent.thread_message_sent", id: "ts1", to_agent_name: "Исследователь", content: text("Найди данные"), processed_at: at(2) },
      { type: "agent.thread_message_received", id: "tr1", from_agent_name: "Исследователь", content: text("Нашёл"), processed_at: at(3) },
    ]);

    const card = block(container, "r1")!;
    expect(card).toHaveTextContent("Отправлено агенту «Исследователь»");
    expect(card).toHaveTextContent("Найди данные");
    expect(card).toHaveTextContent("Получено от агента «Исследователь»");
    expect(card).toHaveTextContent("Нашёл");
  });
});

describe("CanonicalSessionTurn: дополнения хода", () => {
  it("показывает план и заметки хода из модели отображения", () => {
    const turn = turnFrom(helloWorldEvents());
    const withExtras = {
      ...turn,
      render: { ...turn.render, plan: [{ content: "Сначала файл" }], notes: ["Лимит истории"] },
    } as unknown as CanonicalChatTurn;
    const { container } = render(
      <MemoryRouter>
        <CanonicalSessionTurn
          agentName="Агент"
          blocks={buildTranscriptBlocks(turn.rawEvents as unknown as SessionEvent[])}
          expandSelected
          hoveredBlockId={null}
          onJumpToBlock={vi.fn()}
          onSelectEvent={vi.fn()}
          selectedBlockId={null}
          selectedEventId={null}
          turn={withExtras}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector("[data-session-turn-plan]")).toHaveTextContent("Сначала файл");
    expect(container).toHaveTextContent("Лимит истории");
  });
});

describe("sessionErrorMessages", () => {
  it("собирает причины всех session.error без повторов", () => {
    const events: WireSessionEvent[] = [
      { type: "session.error", error: { message: "boom" } },
      { type: "session.error", error: "boom" },
      { type: "session.error", message: "другое" },
      { type: "agent.message" },
    ];

    expect(sessionErrorMessages(events)).toEqual(["boom", "другое"]);
  });
});

describe("projectCanonicalSessionTurn", () => {
  it("переносит id и статус хода в состояние оболочки чата", () => {
    const state = projectCanonicalSessionTurn(turnFrom(helloWorldEvents()));

    expect(state.id).toBe(turnFrom(helloWorldEvents()).id);
    expect(state.status).toBe("completed");
  });

  it("берёт причину ошибки из событий, а не английскую подпись пакета", () => {
    const state = projectCanonicalSessionTurn(
      turnFrom([
        { type: "user.message", id: "u1", content: text("привет"), processed_at: at(0) },
        { type: "session.error", id: "e1", error: { type: "unknown_error", message: "Песочница упала" }, processed_at: at(1) },
        { type: "session.status_idle", id: "i", processed_at: at(2) },
      ]),
    );

    expect(state.status).toBe("failed");
    expect(JSON.stringify(state)).toContain("Песочница упала");
    expect(JSON.stringify(state)).not.toContain("Session error");
  });
});
