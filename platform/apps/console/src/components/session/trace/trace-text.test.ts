import { describe, expect, it } from "vitest";
import { normalizeSpan, normalizeTurn, type TraceSpan } from "../../../lib/trace-api";
import {
  GROUP_LABEL,
  coverageNotes,
  durationCellText,
  eventLabel,
  errorBadgeText,
  expectedModelCoverage,
  formatClockMsRu,
  formatDateTimeMsRu,
  lostText,
  rowStatusText,
  sourceText,
  spanDurationMs,
  spanSubtitle,
  spanTitle,
  turnBadges,
  waitingSinceText,
} from "./trace-text";

const T0 = Date.UTC(2026, 9, 16, 9, 3, 0);
const sp = (over: Partial<TraceSpan> = {}): TraceSpan =>
  normalizeSpan({ span_id: "a100000000000001", kind: "event", name: "x", start_ms: T0, ...over });
const summary = (over: Record<string, unknown> = {}, turn: Partial<TraceSpan> = {}) =>
  normalizeTurn({ turn: sp({ kind: "turn", harness: "pi", ...turn }), state: "complete", ...over });

describe("spanTitle", () => {
  it("называет виды по таблице раздела 1.1", () => {
    expect(spanTitle(sp({ kind: "turn" }), { turnNumber: 3 })).toBe("Ход 3");
    expect(spanTitle(sp({ kind: "turn" }))).toBe("Ход");
    expect(spanTitle(sp({ kind: "sandbox" }))).toBe("Песочница");
    expect(spanTitle(sp({ kind: "harness_start" }))).toBe("Запуск агента");
    expect(spanTitle(sp({ kind: "acp_prompt" }))).toBe("Ход агента ACP");
    expect(spanTitle(sp({ kind: "agent_step" }))).toBe("Шаг агента");
    expect(spanTitle(sp({ kind: "model_call", name: "claude-sonnet-4-5" }))).toBe("Вызов модели");
    expect(spanTitle(sp({ kind: "tool_wait" }))).toBe("Ожидание вас");
    expect(spanTitle(sp({ kind: "tool_exec" }))).toBe("Выполнение");
    expect(spanTitle(sp({ kind: "outcome_eval" }))).toBe("Оценка результата");
    expect(spanTitle(sp({ kind: "compaction" }))).toBe("Сжатие контекста");
    expect(spanTitle(sp({ kind: "retry_wait" }))).toBe("Пауза перед повтором");
    expect(spanTitle(sp({ kind: "hook" }))).toBe("Хук");
  });

  it("события сервера получают русские подписи, незнакомое остаётся как есть", () => {
    expect(eventLabel("error")).toBe("Ошибка");
    expect(eventLabel("warning")).toBe("Предупреждение");
    expect(eventLabel("confirmation")).toBe("Подтверждение");
    expect(eventLabel("mcp_connection")).toBe("Подключение MCP");
    expect(eventLabel("Подтверждение")).toBe("Подтверждение");
    expect(eventLabel("something_new")).toBe("something_new");
    expect(spanTitle(sp({ kind: "event", name: "warning" }))).toBe("Предупреждение");
    expect(spanTitle(sp({ kind: "event", name: "" }))).toBe("Событие");
  });

  it("инструмент подписан своим именем, сабагент именем в кавычках, событие своим именем", () => {
    expect(spanTitle(sp({ kind: "tool_call", name: "bash", tool: { name: "bash", call_id: "c", kind: "builtin", mcp_server: null } }))).toBe("bash");
    expect(spanTitle(sp({ kind: "tool_call", name: "grep" }))).toBe("grep");
    expect(spanTitle(sp({ kind: "subagent", name: "researcher" }))).toBe("Сабагент «researcher»");
    expect(spanTitle(sp({ kind: "subagent", name: "" }))).toBe("Сабагент");
    expect(spanTitle(sp({ kind: "event", name: "Подключение MCP" }))).toBe("Подключение MCP");
  });

  it("называет фазы песочницы по-русски, неизвестную фазу её ключом", () => {
    expect(spanTitle(sp({ kind: "sandbox_phase", name: "acquire" }))).toBe("Выдача VM");
    expect(spanTitle(sp({ kind: "sandbox_phase", name: "restore" }))).toBe("Рабочая папка");
    expect(spanTitle(sp({ kind: "sandbox_phase", name: "inputs" }))).toBe("Входы сессии");
    expect(spanTitle(sp({ kind: "sandbox_phase", name: "vm_start" }))).toBe("Старт VM");
    expect(spanTitle(sp({ kind: "sandbox_phase", name: "packages" }))).toBe("Пакеты окружения");
    expect(spanTitle(sp({ kind: "sandbox_phase", name: "ca_load" }))).toBe("ca_load");
  });
});

describe("spanSubtitle", () => {
  it("показывает серым модель, аргумент инструмента и тип песочницы", () => {
    expect(spanSubtitle(sp({ kind: "model_call", model: "claude-sonnet-4-5" }), {})).toBe("claude-sonnet-4-5");
    expect(spanSubtitle(sp({ kind: "tool_call", name: "bash" }), { toolInput: "ls -la" })).toBe("ls -la");
    expect(spanSubtitle(sp({ kind: "tool_call", name: "bash" }), {})).toBeNull();
    expect(spanSubtitle(sp({ kind: "sandbox", attrs: { reused: true } }), {})).toBe("тёплая");
    expect(spanSubtitle(sp({ kind: "sandbox", attrs: { attempt: 2 } }), {})).toBe("попытка 2");
    expect(spanSubtitle(sp({ kind: "turn", name: "Аналитик" }), {})).toBe("Аналитик");
    expect(spanSubtitle(sp({ kind: "event", name: "Предупреждение", attrs: { message: "Вывод обрезан" } }), {})).toBe("Вывод обрезан");
    expect(spanSubtitle(sp({ kind: "event", name: "Подключение MCP", attrs: { server: "crm" } }), {})).toBe("crm");
    expect(spanSubtitle(sp({ kind: "sandbox_phase", name: "acquire" }), {})).toBeNull();
  });

  it("ожидание и выполнение берут имя инструмента у вызова, если у них своего нет", () => {
    expect(spanSubtitle(sp({ kind: "tool_exec", name: "exec" }), { parentToolName: "bash" })).toBe("bash");
    expect(spanSubtitle(sp({ kind: "tool_wait", name: "wait" }), { parentToolName: "write" })).toBe("write");
    expect(spanSubtitle(sp({ kind: "tool_exec", name: "exec", tool: { name: "grep", call_id: "c", kind: "builtin", mcp_server: null } }), { parentToolName: "bash" })).toBe("grep");
    expect(spanSubtitle(sp({ kind: "tool_exec", name: "exec" }), {})).toBeNull();
  });

  it("ход без имени агента не подписывается словом «turn», подтверждение пишет решение", () => {
    expect(spanSubtitle(sp({ kind: "turn", name: "turn" }), {})).toBeNull();
    expect(spanSubtitle(sp({ kind: "event", name: "confirmation", attrs: { result: "allow" } }), {})).toBe("разрешено");
    expect(spanSubtitle(sp({ kind: "event", name: "confirmation", attrs: { result: "deny" } }), {})).toBe("отклонено");
  });
});

describe("длительность", () => {
  const ctx = { nowMs: T0 + 5_000, lastTurnEndMs: T0 + 3_000 };

  it("считает по концу, а у идущего и ждущего узла до своей границы", () => {
    expect(spanDurationMs(sp({ end_ms: T0 + 1_200 }), ctx)).toBe(1_200);
    expect(spanDurationMs(sp({ end_ms: null, status: "running" }), ctx)).toBe(5_000);
    expect(spanDurationMs(sp({ end_ms: null, status: "waiting" }), ctx)).toBe(3_000);
    expect(spanDurationMs(sp({ end_ms: null, status: "interrupted" }), ctx)).toBe(0);
  });

  it("пишет ячейку: время, ≈ для узла по событиям, идёт, ждёт, прочерк для мгновенного", () => {
    expect(durationCellText(sp({ kind: "model_call", end_ms: T0 + 2_600 }), ctx)).toBe("2,6 с");
    expect(durationCellText(sp({ kind: "model_call", end_ms: T0 + 2_600, precision: "by_events" }), ctx)).toBe("≈ 2,6 с");
    expect(durationCellText(sp({ kind: "model_call", end_ms: null, status: "running" }), ctx)).toBe("идёт");
    expect(durationCellText(sp({ kind: "tool_call", end_ms: null, status: "waiting" }), ctx)).toBe("ждёт");
    expect(durationCellText(sp({ kind: "event", end_ms: T0 }), ctx)).toBe("–");
  });
});

describe("время", () => {
  it("добавляет миллисекунды к времени суток и к дате", () => {
    expect(formatClockMsRu(T0 + 123)).toMatch(/^\d{2}:\d{2}:\d{2}\.123$/);
    expect(formatDateTimeMsRu(T0 + 7)).toMatch(/^[а-я]{2}, \d{1,2} [а-я.]+, \d{2}:\d{2}:\d{2}\.007$/);
  });

  it("пишет «ждёт с ЧЧ:ММ» по началу ожидания", () => {
    expect(waitingSinceText(sp({ start_ms: T0 }))).toMatch(/^ждёт с \d{2}:\d{2}$/);
  });
});

describe("статус и ошибки в строке", () => {
  it("пишет короткий статус только когда он что-то значит", () => {
    expect(rowStatusText(sp({ status: "ok" }))).toBeNull();
    expect(rowStatusText(sp({ status: "error" }))).toBe("ошибка");
    expect(rowStatusText(sp({ status: "running" }))).toBe("идёт");
    expect(rowStatusText(sp({ status: "denied" }))).toBe("отклонено");
    expect(rowStatusText(sp({ status: "interrupted" }))).toBe("прервано");
    expect(rowStatusText(sp({ status: "cancelled" }))).toBe("отменено");
    expect(rowStatusText(sp({ status: "waiting" }))).toBe("ждёт");
    expect(rowStatusText(sp({ kind: "turn", status: "ok", attrs: { stop_reason: "requires_action" } }))).toBe("ждёт подтверждения");
  });

  it("поднимает ошибку к ходу: число из сводки или признак has_error", () => {
    expect(errorBadgeText(sp({ kind: "turn" }), summary({ error_count: 2 }))).toBe("ошибок: 2");
    expect(errorBadgeText(sp({ kind: "turn", attrs: { has_error: true } }), null)).toBe("есть ошибки");
    expect(errorBadgeText(sp({ kind: "subagent", attrs: { has_error: true } }), null)).toBe("есть ошибки");
    expect(errorBadgeText(sp({ kind: "turn" }), summary({ error_count: 0 }))).toBeNull();
    expect(errorBadgeText(sp({ kind: "tool_call", status: "error" }), null)).toBeNull();
  });
});

describe("значки хода", () => {
  it("«неполный» с подсказкой из lost", () => {
    const badges = turnBadges(summary({ partial: true, lost: ["ttft", "tool_exec"] }));
    const partial = badges.find((badge) => badge.key === "partial")!;
    expect(partial.text).toBe("неполный");
    expect(partial.hint).toContain("время до первого токена");
    expect(partial.hint).toContain("выполнение инструментов");
    expect(partial.tone).toBe("warning");
  });

  it("«неполный» без перечня потерь говорит о сбое", () => {
    const partial = turnBadges(summary({ partial: true, lost: [] })).find((badge) => badge.key === "partial")!;
    expect(partial.hint).toMatch(/сбо/);
  });

  it("значок покрытия: нет данных и только ход агента; по событиям и измеренный ход без значка", () => {
    const level0 = turnBadges(summary({ coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } }, { harness: "custom" }));
    expect(level0.map((badge) => badge.text)).toEqual(["нет данных"]);
    const acp = turnBadges(summary({ coverage: { model_calls: "turn_only", tools: "by_events", sandbox: "attempts" } }));
    expect(acp.map((badge) => badge.text)).toEqual(["только ход агента"]);
    // Время по событиям строка и так показывает знаком ≈, отдельный значок только шумит.
    expect(turnBadges(summary({ coverage: { model_calls: "by_events", tools: "by_events", sandbox: "attempts" } }))).toEqual([]);
    expect(turnBadges(summary({ coverage: { model_calls: "measured", tools: "measured", sandbox: "phases" } }))).toEqual([]);
  });

  it("harness, который обязан сообщать вызовы, но данных нет, получает предупреждение «данные не пришли»", () => {
    const badges = turnBadges(summary({ coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } }, { harness: "pi" }));
    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({ text: "данные не пришли", tone: "warning" });
  });

  it("ход, которого ещё нет в таблице, помечен только «не построен»", () => {
    const badges = turnBadges(summary({ state: "not_built", coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } }, { harness: null }));
    expect(badges.map((badge) => badge.text)).toEqual(["не построен"]);
  });
});

describe("coverageNotes", () => {
  it("harness без отчёта о вызовах модели объясняет молчание", () => {
    const notes = coverageNotes(summary({ coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } }, { harness: "custom" }));
    expect(notes).toEqual(["Нет данных о вызовах модели: harness их не сообщает."]);
  });

  it("harness, который должен был сообщить, но данных нет, вызывает предупреждение", () => {
    const notes = coverageNotes(summary({ coverage: { model_calls: "absent", tools: "measured", sandbox: "phases" } }, { harness: "pi" }));
    expect(notes).toEqual(["Данные о вызовах модели не пришли."]);
  });

  it("ACP-агент показывает ход целиком", () => {
    const notes = coverageNotes(summary({ coverage: { model_calls: "turn_only", tools: "by_events", sandbox: "attempts" } }, { harness: "claude-acp" }));
    expect(notes[0]).toMatch(/вызов модели виден целиком/i);
  });

  it("ход по событиям объясняет приблизительное время", () => {
    const notes = coverageNotes(summary({ coverage: { model_calls: "by_events", tools: "by_events", sandbox: "attempts" } }, { harness: "ai-sdk" }));
    expect(notes).toEqual(["Время вызовов и инструментов взято из меток событий, поэтому оно приблизительное."]);
  });

  it("ход, который ещё не построен, заметок о покрытии не даёт", () => {
    expect(coverageNotes(summary({ state: "not_built", coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } }, { harness: null }))).toEqual([]);
  });

  it("полное покрытие не даёт заметок", () => {
    expect(coverageNotes(summary({ coverage: { model_calls: "measured", tools: "measured", sandbox: "phases" } }))).toEqual([]);
  });
});

describe("прочее", () => {
  it("ждёт от harness покрытие по таблице 2.5", () => {
    expect(expectedModelCoverage("pi")).toBe("measured");
    expect(expectedModelCoverage("default")).toBe("measured");
    expect(expectedModelCoverage(null)).toBe("measured");
    expect(expectedModelCoverage("acp-sandbox")).toBe("turn_only");
    expect(expectedModelCoverage("acp-proxy")).toBe("turn_only");
    expect(expectedModelCoverage("ai-sdk")).toBe("by_events");
    expect(expectedModelCoverage("claude-acp")).toBe("turn_only");
    expect(expectedModelCoverage("codex-acp")).toBe("turn_only");
    expect(expectedModelCoverage("my-own")).toBe("absent");
  });

  it("подписывает источники и потери", () => {
    expect(sourceText(["events"])).toBe("события платформы");
    expect(sourceText(["events", "otel"])).toBe("события платформы, OpenTelemetry (со слов агента)");
    expect(lostText(["harness_timing", "sandbox_phases", "что-то новое"])).toBe("время harness, фазы песочницы, что-то новое");
  });

  it("подписывает группы фильтра", () => {
    expect(GROUP_LABEL).toEqual({
      turn: "Ход",
      model: "Модель",
      tool: "Инструмент",
      subagent: "Сабагент",
      sandbox: "Песочница",
      wait: "Ожидание",
    });
  });
});
