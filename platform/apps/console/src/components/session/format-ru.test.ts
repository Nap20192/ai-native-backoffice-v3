import { describe, expect, it } from "vitest";

import {
  EMPTY_VALUE,
  formatBytesRu,
  formatDateRu,
  formatDateTimeRu,
  formatDurationRu,
  formatRelativeRu,
  plural,
} from "./format-ru";

describe("plural", () => {
  const word = (n: number) => plural(n, "вызов", "вызова", "вызовов");

  it("склоняет по последней цифре", () => {
    expect(word(1)).toBe("вызов");
    expect(word(2)).toBe("вызова");
    expect(word(4)).toBe("вызова");
    expect(word(5)).toBe("вызовов");
    expect(word(21)).toBe("вызов");
    expect(word(22)).toBe("вызова");
    expect(word(0)).toBe("вызовов");
  });

  it("числа 11-14 всегда во множественной форме", () => {
    expect(word(11)).toBe("вызовов");
    expect(word(12)).toBe("вызовов");
    expect(word(14)).toBe("вызовов");
    expect(word(111)).toBe("вызовов");
  });
});

describe("formatDurationRu", () => {
  it("пишет миллисекунды, секунды и минуты по-русски", () => {
    expect(formatDurationRu(0.4)).toBe("<1 мс");
    expect(formatDurationRu(123)).toBe("123 мс");
    expect(formatDurationRu(1230)).toBe("1,23 с");
    expect(formatDurationRu(137_000)).toBe("2 мин 17 с");
  });

  it("не выдаёт «1 мин 60 с» при округлении вверх", () => {
    expect(formatDurationRu(119_600)).toBe("2 мин 0 с");
  });

  it("для неверных значений даёт прочерк", () => {
    expect(formatDurationRu(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatDurationRu(-5)).toBe(EMPTY_VALUE);
  });
});

describe("formatRelativeRu", () => {
  it("выбирает единицу по размеру интервала", () => {
    expect(formatRelativeRu(12_000)).toBe("12 с назад");
    expect(formatRelativeRu(5 * 60_000)).toBe("5 мин назад");
    expect(formatRelativeRu(3 * 3_600_000)).toBe("3 ч назад");
    expect(formatRelativeRu(4 * 86_400_000)).toBe("4 дн. назад");
    expect(formatRelativeRu(60 * 86_400_000)).toBe("2 мес. назад");
    expect(formatRelativeRu(800 * 86_400_000)).toBe("2 г. назад");
  });

  it("считает будущее время так же, как прошлое", () => {
    expect(formatRelativeRu(-5 * 60_000)).toBe("5 мин назад");
  });
});

describe("formatBytesRu", () => {
  it("пишет размеры русскими единицами с десятичной запятой", () => {
    expect(formatBytesRu(512)).toBe("512 Б");
    expect(formatBytesRu(1536)).toBe("1,5 КБ");
    expect(formatBytesRu(3 * 1024 * 1024)).toBe("3,0 МБ");
    expect(formatBytesRu(5 * 1024 * 1024 * 1024)).toBe("5,00 ГБ");
  });
});

describe("formatDateRu и formatDateTimeRu", () => {
  const moment = new Date(2026, 9, 15, 14, 5);

  it("дата в виде dd.MM.yyyy", () => {
    expect(formatDateRu(moment)).toBe("15.10.2026");
  });

  it("дата и время в виде dd.MM.yyyy HH:mm", () => {
    expect(formatDateTimeRu(moment)).toBe("15.10.2026 14:05");
  });

  it("для неверной даты даёт прочерк", () => {
    expect(formatDateRu("не дата")).toBe(EMPTY_VALUE);
    expect(formatDateTimeRu("не дата")).toBe(EMPTY_VALUE);
  });
});
