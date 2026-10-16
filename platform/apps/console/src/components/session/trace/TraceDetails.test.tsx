import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import overviewFixture from "../../../mocks/trace-pi-turn.json";
import { normalizeSpan, normalizeTurn, parseOverview } from "../../../lib/trace-api";
import type { SessionEvent } from "../../../lib/session-stats";
import { TraceTree } from "../../../lib/trace-tree";
import { EMPTY_VALUE } from "../format-ru";
import { TraceDetails, type TraceDetailsProps } from "./TraceDetails";

const id = (prefix: string, n: number) => prefix + n.toString(16).padStart(14, "0");
const T0 = 1_792_150_000_000;
const NOW = T0 + 1_700_000;

const overview = parseOverview(overviewFixture);
const tree = new TraceTree();
for (const turn of overview.turns) tree.upsert(turn.turn);
for (const span of overview.spans) tree.upsert(span);

const events = new Map<string, SessionEvent>([
  ["evt_b_use1", { type: "agent.tool_use", id: "evt_b_use1", name: "bash", input: { command: "sleep 0.4; echo VERIFY_OK" } }],
  [
    "evt_b_res1",
    { type: "agent.tool_result", id: "evt_b_res1", tool_use_id: "evt_b_use1", content: [{ type: "text", text: "1234.56\nVERIFY_OK" }] },
  ],
  ["evt_b_use2", { type: "agent.tool_use", id: "evt_b_use2", name: "bash", input: { command: "false" } }],
  [
    "evt_b_res2",
    { type: "agent.tool_result", id: "evt_b_res2", tool_use_id: "evt_b_use2", is_error: true, content: [{ type: "text", text: "exit 1" }] },
  ],
]);

function detailsFor(spanId: string, over: Partial<TraceDetailsProps> = {}): TraceDetailsProps {
  const node = tree.get(spanId)!;
  const summary = overview.turns.find((turn) => turn.turn.span_id === spanId) ?? null;
  return {
    span: node.span,
    node,
    summary,
    turnNumber: summary ? overview.turns.indexOf(summary) + 1 : undefined,
    eventsById: events,
    durationContext: { nowMs: NOW, lastTurnEndMs: T0 + 1_633_100 },
    layout: "panel",
    onClose: vi.fn(),
    onShowInTranscript: vi.fn(),
    onOpenThread: vi.fn(),
    ...over,
  };
}

const value = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TraceDetails: общее", () => {
  it("заголовок: подпись, статус, закрытие", () => {
    const props = detailsFor(id("b1", 32));
    render(<TraceDetails {...props} />);
    expect(screen.getByRole("heading", { name: "bash" })).toBeInTheDocument();
    expect(screen.getByText("Успешно")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть детали" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("начало с миллисекундами, длительность, источник и точность", () => {
    render(<TraceDetails {...detailsFor(id("b1", 16))} />);
    expect(value("Начало").textContent).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(value("Длительность").textContent).toBe("2,6 с");
    expect(value("Источник").textContent).toBe("события платформы");
    expect(value("Точность").textContent).toBe("измерено");
  });

  it("узел по событиям помечен приблизительным временем", () => {
    render(<TraceDetails {...detailsFor(id("c1", 16))} />);
    expect(value("Точность").textContent).toBe("по событиям, время приблизительное");
    expect(value("Длительность").textContent).toBe("≈ 2,5 с");
  });

  it("узел OTel подписан «со слов агента» и показывает таблицу параметров", () => {
    const span = normalizeSpan({
      span_id: id("f1", 1), kind: "agent_step", name: "claude_code.interaction", start_ms: T0, end_ms: T0 + 900,
      sources: ["otel"], attrs: { agent_id: "ag1", "gen_ai.operation.name": "invoke_agent" },
    });
    render(<TraceDetails {...detailsFor(id("b1", 1), { span, node: null, summary: null })} />);
    expect(value("Источник").textContent).toBe("OpenTelemetry (со слов агента)");
    expect(screen.getByText("Данные сообщил сам агент, платформа их не проверяла.")).toBeInTheDocument();
    const params = screen.getByRole("region", { name: "Параметры" });
    expect(within(params).getByText("gen_ai.operation.name")).toBeInTheDocument();
    expect(within(params).getByText("invoke_agent")).toBeInTheDocument();
  });

  it("лист на телефоне помечен раскладкой sheet", () => {
    const { container } = render(<TraceDetails {...detailsFor(id("b1", 32), { layout: "sheet" })} />);
    expect(container.querySelector("[data-trace-details]")).toHaveAttribute("data-layout", "sheet");
  });
});

describe("TraceDetails: вызов модели", () => {
  it("модель, токены, первый токен и причина остановки", () => {
    render(<TraceDetails {...detailsFor(id("b1", 16))} />);
    expect(value("Модель").textContent).toBe("claude-sonnet-4-5");
    expect(value("Токены на входе").textContent).toBe("10");
    expect(value("Токены на выходе").textContent).toBe("5");
    expect(value("Чтение кэша").textContent).toBe("0");
    expect(value("Запись кэша").textContent).toBe("0");
    expect(value("Первый токен").textContent).toBe("640 мс");
    expect(value("Причина остановки").textContent).toBe("tool_use");
  });

  it("если время первого токена потеряно, пишет прочерк", () => {
    render(<TraceDetails {...detailsFor(id("c1", 16))} />);
    expect(value("Первый токен").textContent).toBe(EMPTY_VALUE);
  });
});

describe("TraceDetails: инструмент", () => {
  it("ввод и результат берёт из событий, выполнение показывает отдельно", () => {
    render(<TraceDetails {...detailsFor(id("b1", 32))} />);
    expect(screen.getByRole("region", { name: "Ввод" })).toHaveTextContent("sleep 0.4; echo VERIFY_OK");
    expect(screen.getByRole("region", { name: "Результат" })).toHaveTextContent("1234.56");
    expect(screen.getByRole("region", { name: "Результат" })).toHaveTextContent("VERIFY_OK");
    expect(value("Выполнение").textContent).toBe("2,8 с");
    expect(screen.queryByText("Ожидание", { selector: "dt" })).toBeNull();
  });

  it("упавший вызов показывает ошибку красным блоком", () => {
    render(<TraceDetails {...detailsFor(id("b1", 34))} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Команда завершилась с кодом 1");
    expect(alert).toHaveTextContent("tool_error");
    expect(alert.className).toContain("text-ddc-danger-text");
  });

  it("ждущий вызов показывает ожидание без выполнения и без результата", () => {
    render(<TraceDetails {...detailsFor(id("c1", 64))} />);
    expect(screen.getByText("Ждёт подтверждения")).toBeInTheDocument();
    expect(value("Ожидание").textContent).toBe("ждёт");
    expect(screen.getByRole("region", { name: "Ввод" })).toHaveTextContent("Событие не загружено");
    expect(screen.queryByRole("region", { name: "Результат" })).toBeNull();
  });

  it("если событий нет в сессии, говорит об этом", () => {
    render(<TraceDetails {...detailsFor(id("b1", 32), { eventsById: new Map() })} />);
    expect(screen.getByRole("region", { name: "Ввод" })).toHaveTextContent("Событие не загружено");
  });
});

describe("TraceDetails: песочница и сабагент", () => {
  it("песочница: образ, пакеты, признак тёплой и список фаз с длительностью", () => {
    render(<TraceDetails {...detailsFor(id("b1", 2))} />);
    expect(value("Образ").textContent).toBe("debian-bookworm");
    expect(value("Пакеты").textContent).toBe("python3, curl");
    expect(value("Тёплая").textContent).toBe("нет");
    const phases = screen.getByRole("region", { name: "Фазы" });
    expect(within(phases).getByText("Выдача VM")).toBeInTheDocument();
    expect(within(phases).getByText("Старт VM")).toBeInTheDocument();
    expect(within(phases).getAllByRole("listitem")).toHaveLength(4);
  });

  it("тёплая песочница", () => {
    render(<TraceDetails {...detailsFor(id("c1", 2))} />);
    expect(value("Тёплая").textContent).toBe("да");
  });

  it("сабагент: поток, состояние и кнопка «Открыть поток»", () => {
    const props = detailsFor(id("c1", 33));
    render(<TraceDetails {...props} />);
    expect(value("Поток").textContent).toBe("sthr_researcher");
    expect(value("Состояние потока").textContent).toBe("открыт, ждёт сообщений");
    fireEvent.click(screen.getByRole("button", { name: "Открыть поток" }));
    expect(props.onOpenThread).toHaveBeenCalledWith("sthr_researcher");
  });

  it("без обработчика потока кнопки нет", () => {
    render(<TraceDetails {...detailsFor(id("c1", 33), { onOpenThread: undefined })} />);
    expect(screen.queryByRole("button", { name: "Открыть поток" })).toBeNull();
  });
});

describe("TraceDetails: подтверждение", () => {
  const confirmation = normalizeSpan({
    span_id: id("d1", 2), kind: "event", name: "confirmation", start_ms: T0 + 1_700_050, end_ms: T0 + 1_700_050,
    attrs: { link_span_id: id("c1", 64), result: "allow", tool_use_id: "toolu_c3" },
  });

  it("ссылается на вызов инструмента из прошлого хода: кнопка «К вызову» выбирает его", () => {
    const props = detailsFor(id("b1", 1), { span: confirmation, node: null, summary: null, linkedSpanId: id("c1", 64), onSelectSpan: vi.fn() });
    render(<TraceDetails {...props} />);
    expect(screen.getByRole("heading", { name: "Подтверждение" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "К вызову" }));
    expect(props.onSelectSpan).toHaveBeenCalledWith(id("c1", 64));
  });

  it("если вызова нет в загруженных ходах, кнопки нет", () => {
    render(<TraceDetails {...detailsFor(id("b1", 1), { span: confirmation, node: null, summary: null, linkedSpanId: null, onSelectSpan: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: "К вызову" })).toBeNull();
  });
});

describe("TraceDetails: ход", () => {
  it("восстановленный ход: состояние, потери, пояснения о покрытии", () => {
    render(<TraceDetails {...detailsFor(id("c1", 1))} />);
    expect(screen.getByRole("heading", { name: "Ход 3" })).toBeInTheDocument();
    expect(value("Состояние хода").textContent).toBe("восстановлен после сбоя");
    expect(value("Потеряно").textContent).toBe("время до первого токена, выполнение инструментов");
    expect(value("Harness").textContent).toBe("pi");
    expect(value("Завершение").textContent).toBe("ждёт подтверждения");
  });

  it("ход по событиям объясняет приблизительное время", () => {
    render(<TraceDetails {...detailsFor(id("c1", 1))} />);
    expect(screen.getByText("Время вызовов и инструментов взято из меток событий, поэтому оно приблизительное.")).toBeInTheDocument();
  });

  it("ход harness без отчёта о работе объясняет нехватку данных", () => {
    const turn = normalizeSpan({ span_id: id("e1", 1), turn_id: "evt_e", kind: "turn", name: "Молчун", harness: "custom", start_ms: T0, end_ms: T0 + 5_000 });
    const summary = normalizeTurn({ turn, state: "complete", coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } });
    render(<TraceDetails {...detailsFor(id("b1", 1), { span: turn, node: null, summary })} />);
    expect(screen.getByText("Нет данных о вызовах модели: harness их не сообщает.")).toBeInTheDocument();
  });

  it("очередь хода показана, если сервер её посчитал", () => {
    render(<TraceDetails {...detailsFor(id("b1", 1))} />);
    expect(value("В очереди").textContent).toBe("12 мс");
  });
});

describe("TraceDetails: действия", () => {
  it("«В разговоре» открывает событие узла", () => {
    const props = detailsFor(id("b1", 32));
    render(<TraceDetails {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "В разговоре" }));
    expect(props.onShowInTranscript).toHaveBeenCalledWith("evt_b_use1");
  });

  it("у выполнения инструмента «В разговоре» открывает событие вызова", () => {
    const props = detailsFor(id("b1", 33));
    render(<TraceDetails {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "В разговоре" }));
    expect(props.onShowInTranscript).toHaveBeenCalledWith("evt_b_use1");
  });

  it("у узла без события кнопка «В разговоре» недоступна", () => {
    render(<TraceDetails {...detailsFor(id("b1", 3))} />);
    expect(screen.getByRole("button", { name: "В разговоре" })).toBeDisabled();
  });

  it("«Копировать ID» кладёт span_id в буфер и сообщает об этом", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<TraceDetails {...detailsFor(id("b1", 32))} />);
    fireEvent.click(screen.getByRole("button", { name: "Копировать ID" }));
    expect(writeText).toHaveBeenCalledWith(id("b1", 32));
    await waitFor(() => expect(screen.getByRole("button", { name: "ID скопирован" })).toBeInTheDocument());
  });

  it("если буфер недоступен, сообщает об ошибке", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("запрещено"); }) },
    });
    render(<TraceDetails {...detailsFor(id("b1", 32))} />);
    fireEvent.click(screen.getByRole("button", { name: "Копировать ID" }));
    await waitFor(() => expect(screen.getByText("Не удалось скопировать")).toBeInTheDocument());
  });
});
