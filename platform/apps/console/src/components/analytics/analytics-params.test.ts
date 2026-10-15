import { describe, expect, it } from "vitest";

import {
  bucketFor,
  DEFAULT_RANGE,
  hasActiveFilters,
  parseAnalyticsParams,
  resolveRange,
  serializeAnalyticsParams,
  toApiFilters,
  utcToday,
  validateCustomRange,
  zoomToDay,
} from "./analytics-params";

const NOW = new Date("2026-10-16T09:15:00.000Z");

describe("resolveRange", () => {
  it("считает периоды по UTC от сегодняшнего дня", () => {
    expect(resolveRange({ kind: "preset", preset: "30d" }, NOW)).toEqual({
      from: "2026-09-17",
      to: "2026-10-16",
    });
    expect(resolveRange({ kind: "preset", preset: "7d" }, NOW)).toEqual({
      from: "2026-10-10",
      to: "2026-10-16",
    });
    expect(resolveRange({ kind: "preset", preset: "mtd" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-16",
    });
    expect(resolveRange({ kind: "preset", preset: "last_month" }, NOW)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("прошлый месяц января это декабрь прошлого года", () => {
    expect(
      resolveRange({ kind: "preset", preset: "last_month" }, new Date("2026-01-15T12:00:00Z")),
    ).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("берёт сутки по UTC, а не по поясу браузера", () => {
    const lateEvening = new Date("2026-10-17T02:00:00+05:00");
    expect(utcToday(lateEvening)).toBe("2026-10-16");
  });

  it("свой период возвращает как есть", () => {
    expect(resolveRange({ kind: "custom", from: "2026-10-01", to: "2026-10-03" }, NOW)).toEqual({
      from: "2026-10-01",
      to: "2026-10-03",
    });
  });
});

describe("parseAnalyticsParams", () => {
  it("пустой адрес даёт значения по умолчанию", () => {
    const state = parseAnalyticsParams(new URLSearchParams());
    expect(state.range).toEqual(DEFAULT_RANGE);
    expect(state.group_by).toBe("model");
    expect(state.model).toEqual([]);
    expect(state.status).toBe("");
    expect(state.request).toBe("");
  });

  it("читает периоды, списки и поля журнала", () => {
    const state = parseAnalyticsParams(
      new URLSearchParams(
        "range=7d&model=a,b&agent_id=agent_1&harness=pi&card_id=mc_1&group_by=agent&status=error&session_id=sesn_1&q=abc&request=sevt_1&focus=mc_1:itpm",
      ),
    );
    expect(state.range).toEqual({ kind: "preset", preset: "7d" });
    expect(state.model).toEqual(["a", "b"]);
    expect(state.agent_id).toEqual(["agent_1"]);
    expect(state.harness).toEqual(["pi"]);
    expect(state.card_id).toEqual(["mc_1"]);
    expect(state.group_by).toBe("agent");
    expect(state.status).toBe("error");
    expect(state.session_id).toBe("sesn_1");
    expect(state.q).toBe("abc");
    expect(state.request).toBe("sevt_1");
    expect(state.focus).toBe("mc_1:itpm");
  });

  it("свой период берёт из from и to", () => {
    const state = parseAnalyticsParams(new URLSearchParams("from=2026-10-01&to=2026-10-05"));
    expect(state.range).toEqual({ kind: "custom", from: "2026-10-01", to: "2026-10-05" });
  });

  it("испорченные значения возвращаются к умолчаниям", () => {
    const state = parseAnalyticsParams(
      new URLSearchParams("range=yesterday&group_by=colour&status=maybe&from=2026-10-09&to=2026-10-01"),
    );
    expect(state.range).toEqual(DEFAULT_RANGE);
    expect(state.group_by).toBe("model");
    expect(state.status).toBe("");
  });

  it("период длиннее 92 дней из адреса не принимается", () => {
    const state = parseAnalyticsParams(new URLSearchParams("from=2026-01-01&to=2026-10-01"));
    expect(state.range).toEqual(DEFAULT_RANGE);
  });
});

describe("serializeAnalyticsParams", () => {
  it("значения по умолчанию в адрес не пишутся", () => {
    expect(serializeAnalyticsParams(parseAnalyticsParams(new URLSearchParams())).toString()).toBe("");
  });

  it("пишет только отличия", () => {
    const sp = serializeAnalyticsParams({
      ...parseAnalyticsParams(new URLSearchParams()),
      range: { kind: "preset", preset: "7d" },
      model: ["a", "b"],
      group_by: "agent",
    });
    expect(sp.get("range")).toBe("7d");
    expect(sp.get("model")).toBe("a,b");
    expect(sp.get("group_by")).toBe("agent");
    expect(sp.has("agent_id")).toBe(false);
    expect(sp.has("from")).toBe(false);
  });

  it("для своего периода пишет from и to без range", () => {
    const sp = serializeAnalyticsParams({
      ...parseAnalyticsParams(new URLSearchParams()),
      range: { kind: "custom", from: "2026-10-01", to: "2026-10-05" },
    });
    expect(sp.get("from")).toBe("2026-10-01");
    expect(sp.get("to")).toBe("2026-10-05");
    expect(sp.has("range")).toBe(false);
  });

  it("туда и обратно даёт то же состояние", () => {
    const original = new URLSearchParams(
      "range=mtd&model=a&status=ok&session_id=sesn_9&request=sevt_2&focus=mc_1:otpm&q=sonnet",
    );
    const state = parseAnalyticsParams(original);
    expect(parseAnalyticsParams(serializeAnalyticsParams(state))).toEqual(state);
  });
});

describe("hasActiveFilters", () => {
  it("по умолчанию Сбросить не нужна", () => {
    expect(hasActiveFilters(parseAnalyticsParams(new URLSearchParams()))).toBe(false);
  });

  it("любое отличие от умолчаний включает Сбросить", () => {
    for (const query of ["range=7d", "model=a", "group_by=agent", "status=ok", "q=x", "session_id=s", "from=2026-10-01&to=2026-10-02"]) {
      expect(hasActiveFilters(parseAnalyticsParams(new URLSearchParams(query))), query).toBe(true);
    }
  });

  it("открытая запись и квота не считаются фильтрами", () => {
    expect(
      hasActiveFilters(parseAnalyticsParams(new URLSearchParams("request=sevt_1&focus=mc_1:itpm"))),
    ).toBe(false);
  });
});

describe("validateCustomRange", () => {
  it("принимает период до 92 дней", () => {
    expect(validateCustomRange("2026-07-17", "2026-10-16")).toBeNull();
    expect(validateCustomRange("2026-10-16", "2026-10-16")).toBeNull();
  });

  it("отклоняет начало позже конца, длинный период и неверную дату", () => {
    expect(validateCustomRange("2026-10-17", "2026-10-16")).toBe("Начало периода позже конца.");
    expect(validateCustomRange("2026-07-16", "2026-10-16")).toBe("Период не больше 92 дней.");
    expect(validateCustomRange("", "2026-10-16")).toBe("Укажите обе даты периода.");
    expect(validateCustomRange("2026-13-40", "2026-10-16")).toBe("Укажите обе даты периода.");
  });
});

describe("bucketFor и zoomToDay", () => {
  it("одни сутки рисуются по часам, остальное по дням", () => {
    expect(bucketFor("2026-10-15", "2026-10-15")).toBe("hour");
    expect(bucketFor("2026-10-14", "2026-10-15")).toBe("day");
  });

  it("приближение до дня даёт свой период из одних суток", () => {
    expect(zoomToDay("2026-10-15")).toEqual({ kind: "custom", from: "2026-10-15", to: "2026-10-15" });
  });
});

describe("toApiFilters", () => {
  it("отдаёт списки фильтров для клиента API", () => {
    const state = parseAnalyticsParams(new URLSearchParams("model=a,b&agent_id=agent_1&harness=pi&card_id=none"));
    expect(toApiFilters(state)).toEqual({
      agent_id: ["agent_1"],
      model: ["a", "b"],
      harness: ["pi"],
      card_id: ["none"],
    });
  });
});
