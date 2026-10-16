import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import changesFixture from "../mocks/trace-changes.json";
import overviewFixture from "../mocks/trace-pi-turn.json";
import {
  createTraceClient,
  downloadTrace,
  normalizeSpan,
  normalizeTurn,
  parseChangesPage,
  parseOverview,
  parseSearchPage,
  parseSpansPage,
  parseTurnsPage,
  traceExportFileName,
  traceExportPath,
  tracePath,
  useTraceClient,
} from "./trace-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("tracePath", () => {
  it("строит путь маршрута трейса сессии", () => {
    expect(tracePath("sesn_1")).toBe("/v1/oma/sessions/sesn_1/trace");
  });

  it("кодирует id и параметры, пропускает пустые значения", () => {
    expect(tracePath("sesn 1/x", { turn_id: "evt a", page: "cur+sor==", after: undefined })).toBe(
      "/v1/oma/sessions/sesn%201%2Fx/trace?turn_id=evt+a&page=cur%2Bsor%3D%3D",
    );
  });

  it("добавляет подпуть для поиска", () => {
    expect(tracePath("sesn_1", { q: "bash" }, "/search")).toBe("/v1/oma/sessions/sesn_1/trace/search?q=bash");
  });
});

describe("normalizeSpan", () => {
  it("заполняет необязательные поля значениями по умолчанию", () => {
    const span = normalizeSpan({ span_id: "a100000000000001", kind: "model_call", start_ms: 5 });
    expect(span).toMatchObject({
      span_id: "a100000000000001",
      parent_span_id: null,
      turn_id: null,
      thread_id: "sthr_primary",
      kind: "model_call",
      sources: ["events"],
      precision: "measured",
      start_ms: 5,
      end_ms: null,
      status: "ok",
      error: null,
      usage: null,
      tool: null,
      event_ids: [],
      attrs: {},
      version: 1,
      deleted: false,
    });
  });

  it("не затирает присланные значения", () => {
    const span = normalizeSpan({
      span_id: "a100000000000001",
      kind: "tool_call",
      start_ms: 1,
      end_ms: 9,
      status: "error",
      name: "bash",
      event_ids: ["e1", "e2"],
      version: 7,
    });
    expect(span).toMatchObject({ status: "error", name: "bash", end_ms: 9, event_ids: ["e1", "e2"], version: 7 });
  });
});

describe("разбор ответов", () => {
  it("разбирает ответ маршрута по контракту раздела 3.2", () => {
    const overview = parseOverview(overviewFixture);
    expect(overview.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(overview.session_id).toBe("sesn_01TRACEFIXTURE");
    expect(overview.turns.map((turn) => turn.turn.turn_id)).toEqual(["evt_a1", "evt_b1", "evt_c1"]);
    expect(overview.turns[2]).toMatchObject({ state: "repaired", partial: true, lost: ["ttft", "tool_exec"] });
    expect(overview.spans).toHaveLength(27);
    expect(overview.spans_next).toBeNull();
    expect(overview.turns_before).toBeNull();
    expect(overview.collecting).toBe(false);
    expect(typeof overview.cursor).toBe("string");
  });

  it("отбрасывает строки без span_id, вида или времени начала", () => {
    const page = parseSpansPage({
      spans: [
        null,
        42,
        { span_id: "a100000000000001", kind: "turn", start_ms: 1 },
        { kind: "turn", start_ms: 1 },
        { span_id: "a100000000000002", kind: "нет такого вида", start_ms: 1 },
        { span_id: "a100000000000003", kind: "turn" },
      ],
      spans_next: "next-cursor",
    });
    expect(page.spans.map((span) => span.span_id)).toEqual(["a100000000000001"]);
    expect(page.spans_next).toBe("next-cursor");
  });

  it("страница поддерева хода: продолжение приходит как page_next, рядом сводка хода и признак сбора", () => {
    const page = parseSpansPage({
      turn_id: "evt_a1",
      turn: overviewFixture.turns[0],
      spans: [{ span_id: "a100000000000001", kind: "turn", start_ms: 1 }],
      page_next: "p2",
      collecting: true,
    });
    expect(page.spans_next).toBe("p2");
    expect(page.turn?.turn.turn_id).toBe("evt_a1");
    expect(page.collecting).toBe(true);
    expect(parseSpansPage({ spans: [], spans_next: "n" }).spans_next).toBe("n");
    expect(parseSpansPage({ spans: [] })).toMatchObject({ turn: null, collecting: null, spans_next: null });
  });

  it("страница изменений несёт признак сбора от сервера, если он есть", () => {
    expect(parseChangesPage({ spans: [], turns: [], cursor: "c", more: false, collecting: true }).collecting).toBe(true);
    expect(parseChangesPage({ spans: [], turns: [], cursor: "c", more: false }).collecting).toBeNull();
  });

  it("разбирает страницу ранних ходов", () => {
    const page = parseTurnsPage({ turns: overviewFixture.turns.slice(0, 1), turns_before: "before-1" });
    expect(page.turns).toHaveLength(1);
    expect(page.turns_before).toBe("before-1");
    expect(parseTurnsPage({}).turns).toEqual([]);
    expect(parseTurnsPage({}).turns_before).toBeNull();
  });

  it("разбирает страницу изменений с удалёнными строками и сводками", () => {
    const page = parseChangesPage(changesFixture);
    expect(page.more).toBe(false);
    expect(page.turns.map((turn) => turn.turn.turn_id)).toEqual(["evt_c1", "evt_d1"]);
    expect(page.spans.some((span) => span.deleted)).toBe(true);
    expect(page.cursor).toBe(changesFixture.cursor);
  });

  it("разбирает ответ поиска и ограничивает поля", () => {
    const page = parseSearchPage({
      matches: [{ span_id: "a100000000000001", turn_id: "evt_a1", kind: "tool_call", name: "grep" }, { span_id: 5 }],
      next: null,
      remaining_turns: 12,
    });
    expect(page.matches).toEqual([{ span_id: "a100000000000001", turn_id: "evt_a1", kind: "tool_call", name: "grep" }]);
    expect(page.remaining_turns).toBe(12);
    expect(parseSearchPage({}).remaining_turns).toBe(0);
  });

  it("терпит ответ сводки без необязательных полей", () => {
    const turn = normalizeTurn({ turn: { span_id: "a100000000000001", kind: "turn", start_ms: 1 } });
    expect(turn).toMatchObject({ state: "complete", partial: false, lost: [], span_count: null, version: 1 });
    expect(turn.coverage).toEqual({ model_calls: "absent", tools: "absent", sandbox: "attempts" });
  });
});

describe("клиент маршрутов", () => {
  function setup() {
    const calls: string[] = [];
    const answers = new Map<string, unknown>();
    const fetchJson = vi.fn(async (path: string) => {
      calls.push(path);
      const key = [...answers.keys()].find((prefix) => path === prefix);
      if (key === undefined) throw new Error(`нет ответа для ${path}`);
      return answers.get(key);
    });
    return { calls, answers, client: createTraceClient("sesn_1", fetchJson as never) };
  }

  it("getOverview читает маршрут без параметров", async () => {
    const { client, answers, calls } = setup();
    answers.set("/v1/oma/sessions/sesn_1/trace", overviewFixture);
    const overview = await client.getOverview();
    expect(calls).toEqual(["/v1/oma/sessions/sesn_1/trace"]);
    expect(overview.spans).toHaveLength(27);
  });

  it("getTurnsBefore, getTurnPage, getSpansPage, getChanges и search строят свои адреса", async () => {
    const { client, answers, calls } = setup();
    answers.set("/v1/oma/sessions/sesn_1/trace?turns_before=tb1", { turns: [], turns_before: null });
    answers.set("/v1/oma/sessions/sesn_1/trace?turn_id=evt_a1", { spans: [], spans_next: "p2" });
    answers.set("/v1/oma/sessions/sesn_1/trace?turn_id=evt_a1&page=p2", { spans: [], spans_next: null });
    answers.set("/v1/oma/sessions/sesn_1/trace?page=rest", { spans: [], spans_next: null });
    answers.set("/v1/oma/sessions/sesn_1/trace?after=cur1", { spans: [], turns: [], cursor: "cur2", more: true });
    answers.set("/v1/oma/sessions/sesn_1/trace/search?q=bash", { matches: [], next: "n1", remaining_turns: 3 });
    answers.set("/v1/oma/sessions/sesn_1/trace/search?q=bash&after=n1", { matches: [], next: null, remaining_turns: 0 });

    await client.getTurnsBefore("tb1");
    expect((await client.getTurnPage("evt_a1")).spans_next).toBe("p2");
    expect((await client.getTurnPage("evt_a1", "p2")).spans_next).toBeNull();
    await client.getSpansPage("rest");
    expect((await client.getChanges("cur1")).more).toBe(true);
    expect((await client.search("bash")).next).toBe("n1");
    await client.search("bash", "n1");

    expect(calls).toEqual([
      "/v1/oma/sessions/sesn_1/trace?turns_before=tb1",
      "/v1/oma/sessions/sesn_1/trace?turn_id=evt_a1",
      "/v1/oma/sessions/sesn_1/trace?turn_id=evt_a1&page=p2",
      "/v1/oma/sessions/sesn_1/trace?page=rest",
      "/v1/oma/sessions/sesn_1/trace?after=cur1",
      "/v1/oma/sessions/sesn_1/trace/search?q=bash",
      "/v1/oma/sessions/sesn_1/trace/search?q=bash&after=n1",
    ]);
  });
});

describe("useTraceClient", () => {
  it("ходит через api консоли без тоста об ошибке и с общими заголовками", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(overviewFixture));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useTraceClient("sesn_01TRACEFIXTURE"));

    const overview = await result.current.getOverview();

    expect(overview.turns).toHaveLength(3);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/v1/oma/sessions/sesn_01TRACEFIXTURE/trace");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("include");
  });

  it("отдаёт один и тот же клиент, пока не сменилась сессия", () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    const { result, rerender } = renderHook(({ id }) => useTraceClient(id), { initialProps: { id: "a" } });
    const first = result.current;
    rerender({ id: "a" });
    expect(result.current).toBe(first);
    rerender({ id: "b" });
    expect(result.current).not.toBe(first);
  });
});

describe("выгрузка трейса", () => {
  it("traceExportPath ведёт на файл OTLP всего трейса и кодирует id сессии", () => {
    expect(traceExportPath("sesn_1")).toBe("/v1/oma/sessions/sesn_1/trace/otlp.json");
    expect(traceExportPath("sesn 1/x")).toBe("/v1/oma/sessions/sesn%201%2Fx/trace/otlp.json");
  });

  it("traceExportFileName называет файл по id сессии", () => {
    expect(traceExportFileName("sesn_1")).toBe("trace-sesn_1.otlp.json");
  });

  describe("downloadTrace", () => {
    const originals = new Map<string, PropertyDescriptor | undefined>();

    /** jsdom не умеет сохранять файлы: подменяем адреса blob и щелчок по ссылке, остальное оставляем как есть. */
    function stubBrowserDownload() {
      const created: Blob[] = [];
      const revoked: string[] = [];
      const clicks: Array<{ download: string; href: string }> = [];
      const replace = (name: "createObjectURL" | "revokeObjectURL", value: unknown) => {
        if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(URL, name));
        Object.defineProperty(URL, name, { configurable: true, writable: true, value });
      };
      replace("createObjectURL", (blob: Blob) => {
        created.push(blob);
        return "blob:trace";
      });
      replace("revokeObjectURL", (url: string) => {
        revoked.push(url);
      });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push({ download: this.download, href: this.href });
      });
      return { created, revoked, clicks };
    }

    afterEach(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(URL, name, descriptor);
        else Reflect.deleteProperty(URL, name);
      }
      originals.clear();
      vi.useRealTimers();
    });

    it("запрашивает файл и сохраняет ответ под именем сессии", async () => {
      const browser = stubBrowserDownload();
      const body = '{"resourceSpans":[]}';
      const fetchRaw = vi.fn(async (_path: string) => new Response(body, { headers: { "content-type": "application/json" } }));

      await downloadTrace("sesn_1", fetchRaw);

      expect(fetchRaw).toHaveBeenCalledWith("/v1/oma/sessions/sesn_1/trace/otlp.json");
      expect(browser.clicks).toEqual([{ download: "trace-sesn_1.otlp.json", href: "blob:trace" }]);
      expect(browser.created).toHaveLength(1);
      expect(await browser.created[0]!.text()).toBe(body);
    });

    it("не освобождает адрес файла сразу: браузер ещё читает его, а трейс бывает большим", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const browser = stubBrowserDownload();

      await downloadTrace("sesn_1", async () => new Response("{}"));

      expect(browser.revoked).toEqual([]);
      vi.runAllTimers();
      expect(browser.revoked).toEqual(["blob:trace"]);
    });

    it("при ошибке запроса файл не сохраняется, а ошибка доходит до вызывающего", async () => {
      const browser = stubBrowserDownload();

      await expect(
        downloadTrace("sesn_1", async () => {
          throw new Error("сеть пропала");
        }),
      ).rejects.toThrow("сеть пропала");

      expect(browser.created).toEqual([]);
      expect(browser.clicks).toEqual([]);
    });
  });
});
