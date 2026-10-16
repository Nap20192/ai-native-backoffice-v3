import { describe, expect, it } from "vitest";

import * as formats from "./format-ru";
import {
  EMPTY_VALUE,
  formatBytesRu,
  formatClockRu,
  formatDateRu,
  formatDateTimeRu,
  formatDurationRu,
  formatEventDateTimeRu,
  formatGapRu,
  formatMinimapTimeRu,
  formatPercentRu,
  formatRelativeRu,
  formatShortDurationRu,
  formatTokensRu,
  plural,
  sessionErrorText,
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

describe("sessionErrorText", () => {
  it("берёт message из объекта ошибки API", () => {
    expect(sessionErrorText({ type: "unknown_error", message: "boom", retry_status: "exhausted" })).toBe("boom");
  });

  it("принимает строку и подставляет общий текст без причины", () => {
    expect(sessionErrorText("sandbox failed")).toBe("sandbox failed");
    expect(sessionErrorText(undefined)).toBe("Ход завершился ошибкой.");
    expect(sessionErrorText({ type: "unknown_error" })).toBe("Ход завершился ошибкой.");
  });
});

describe("formatShortDurationRu", () => {
  it("пишет миллисекунды, секунды, минуты и часы", () => {
    expect(formatShortDurationRu(0.4)).toBe("<1 мс");
    expect(formatShortDurationRu(119)).toBe("119 мс");
    expect(formatShortDurationRu(1_100)).toBe("1,1 с");
    expect(formatShortDurationRu(57_700)).toBe("57,7 с");
    expect(formatShortDurationRu(185_000)).toBe("3 мин 5 с");
    expect(formatShortDurationRu(14 * 3_600_000 + 2 * 60_000)).toBe("14 ч 2 мин");
  });

  it("не пишет нулевую десятую и нулевую младшую единицу", () => {
    expect(formatShortDurationRu(1_000)).toBe("1 с");
    expect(formatShortDurationRu(180_000)).toBe("3 мин");
    expect(formatShortDurationRu(2 * 3_600_000)).toBe("2 ч");
  });

  it("не выдаёт «60 с» и «60 мин» при округлении вверх", () => {
    expect(formatShortDurationRu(59_980)).toBe("1 мин");
    expect(formatShortDurationRu(3_599_700)).toBe("1 ч");
  });

  it("для пустого и неверного значения даёт прочерк", () => {
    expect(formatShortDurationRu(null)).toBe(EMPTY_VALUE);
    expect(formatShortDurationRu(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatShortDurationRu(-1)).toBe(EMPTY_VALUE);
  });
});

describe("formatTokensRu", () => {
  it("сокращает тысячи и миллионы с запятой", () => {
    expect(formatTokensRu(0)).toBe("0");
    expect(formatTokensRu(275)).toBe("275");
    expect(formatTokensRu(6_500)).toBe("6,5 тыс.");
    expect(formatTokensRu(411_100)).toBe("411,1 тыс.");
    expect(formatTokensRu(1_200_000)).toBe("1,2 млн");
  });

  it("не пишет нулевую десятую и переходит к следующей единице", () => {
    expect(formatTokensRu(30_000)).toBe("30 тыс.");
    expect(formatTokensRu(999_999)).toBe("1 млн");
    expect(formatTokensRu(2_500_000_000)).toBe("2,5 млрд");
  });
});

describe("форматы денег", () => {
  it("страница сессии не пишет суммы, форматов для долларов и центов в модуле нет", () => {
    for (const name of ["formatUsdMicrosRu", "formatCentsRu"]) expect(formats).not.toHaveProperty(name);
  });
});

describe("formatPercentRu", () => {
  it("доля в проценты с пробелом", () => {
    expect(formatPercentRu(0.35)).toBe("35 %");
    expect(formatPercentRu(6 / 17)).toBe("35 %");
    expect(formatPercentRu(1)).toBe("100 %");
    expect(formatPercentRu(0)).toBe("0 %");
  });

  it("малую ненулевую долю пишет «<1 %»", () => {
    expect(formatPercentRu(0.004)).toBe("<1 %");
  });
});

describe("время событий", () => {
  const moment = Date.UTC(2026, 9, 15, 11, 40, 1);

  it("formatClockRu: часы, минуты, секунды", () => {
    expect(formatClockRu(moment, "UTC")).toBe("11:40:01");
    expect(formatClockRu(Date.UTC(2026, 9, 16, 0, 5, 9), "UTC")).toBe("00:05:09");
  });

  it("formatClockRu: часовой пояс сдвигает время", () => {
    expect(formatClockRu(moment, "Europe/Moscow")).toBe("14:40:01");
  });

  it("formatEventDateTimeRu: день недели, дата, время", () => {
    expect(formatEventDateTimeRu(Date.UTC(2026, 9, 15, 11, 39, 27), "UTC")).toBe("чт, 15 окт., 11:39:27");
    expect(formatEventDateTimeRu(Date.UTC(2026, 9, 18, 8, 0, 0), "UTC")).toBe("вс, 18 окт., 08:00:00");
  });

  it("formatMinimapTimeRu: дата и время без дня недели", () => {
    expect(formatMinimapTimeRu(Date.UTC(2026, 9, 15, 11, 41, 8), "UTC")).toBe("15 окт., 11:41:08");
  });

  it("formatGapRu: время без секунд и длительность разрыва", () => {
    const at = Date.UTC(2026, 9, 16, 1, 42, 6);
    expect(formatGapRu(at, 13 * 3_600_000 + 56 * 60_000, "UTC")).toBe("пт, 16 окт., 01:42 (13 ч 56 мин)");
  });

  it("месяцы пишутся по-русски в сокращении", () => {
    expect(formatMinimapTimeRu(Date.UTC(2026, 0, 3, 0, 0, 0), "UTC")).toBe("3 янв., 00:00:00");
    expect(formatMinimapTimeRu(Date.UTC(2026, 4, 3, 0, 0, 0), "UTC")).toBe("3 мая, 00:00:00");
    expect(formatMinimapTimeRu(Date.UTC(2026, 8, 3, 0, 0, 0), "UTC")).toBe("3 сент., 00:00:00");
  });

  it("для неверного времени даёт прочерк", () => {
    expect(formatClockRu(Number.NaN, "UTC")).toBe(EMPTY_VALUE);
    expect(formatEventDateTimeRu(Number.NaN, "UTC")).toBe(EMPTY_VALUE);
    expect(formatMinimapTimeRu(Number.NaN, "UTC")).toBe(EMPTY_VALUE);
    expect(formatGapRu(Number.NaN, 1000, "UTC")).toBe(EMPTY_VALUE);
  });
});
