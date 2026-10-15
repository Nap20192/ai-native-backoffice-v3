import { describe, expect, it } from "vitest";

import {
  formatAmortization,
  formatAxisDay,
  formatAxisHour,
  formatCompact,
  formatDataAsOf,
  formatDateRange,
  formatDayUtc,
  formatHourUtc,
  formatLatency,
  formatPercent,
  formatRelative,
  formatTimeUtc,
  formatTokens,
  formatUsd,
  pluralRu,
} from "./analytics-format";

/** Intl ставит неразрывные пробелы, в проверках сравниваем с обычными. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("деньги из микродолларов", () => {
  it("до доллара четыре знака, от доллара два", () => {
    expect(plain(formatUsd(12720))).toBe("$0,0127");
    expect(plain(formatUsd(12_400_000))).toBe("$12,40");
    expect(plain(formatUsd(210))).toBe("$0,0002");
    expect(plain(formatUsd(1_234_567_890))).toBe("$1 234,57");
  });

  it("ноль, пограничное значение и доли меньше четвёртого знака", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(plain(formatUsd(999_999))).toBe("$1,00");
    expect(formatUsd(5)).toBe("<$0,0001");
  });

  it("без цены пишет «нет цены»", () => {
    expect(formatUsd(null)).toBe("нет цены");
  });
});

describe("числа", () => {
  it("токены в плитке с разделителем тысяч", () => {
    expect(plain(formatTokens(1_611_100))).toBe("1 611 100");
    expect(formatTokens(0)).toBe("0");
  });

  it("компактная запись для осей и таблиц", () => {
    expect(plain(formatCompact(0))).toBe("0");
    expect(plain(formatCompact(999))).toBe("999");
    expect(plain(formatCompact(1_200))).toBe("1,2 тыс.");
    expect(plain(formatCompact(20_600))).toBe("20,6 тыс.");
    expect(plain(formatCompact(30_000))).toBe("30 тыс.");
    expect(plain(formatCompact(500_000))).toBe("500 тыс.");
    expect(plain(formatCompact(1_000_000))).toBe("1 млн");
    expect(plain(formatCompact(1_500_000))).toBe("1,5 млн");
    expect(plain(formatCompact(1_611_100))).toBe("1,6 млн");
    expect(plain(formatCompact(2_500_000_000))).toBe("2,5 млрд");
    expect(plain(formatCompact(999_999))).toBe("1 млн");
  });

  it("доля через Intl, меньше половины процента это «<1 %»", () => {
    expect(plain(formatPercent(0.869))).toBe("86,9 %");
    expect(plain(formatPercent(1))).toBe("100 %");
    expect(plain(formatPercent(0))).toBe("0 %");
    expect(plain(formatPercent(0.004))).toBe("<1 %");
    expect(plain(formatPercent(0.0375, 0))).toBe("4 %");
    expect(formatPercent(null)).toBe("нет");
  });

  it("окупаемость записи с крестиком", () => {
    expect(plain(formatAmortization(6.8966))).toBe("6,9×");
    expect(plain(formatAmortization(10))).toBe("10×");
    expect(formatAmortization(null)).toBe("нет");
  });

  it("задержка: две цифры в таблице, три в карточке записи", () => {
    expect(plain(formatLatency(3020))).toBe("3,02 с");
    expect(plain(formatLatency(3020, 3))).toBe("3,020 с");
    expect(formatLatency(null)).toBe("нет");
  });

  it("склоняет слова по числу", () => {
    const form = (n: number) => pluralRu(n, "запрос", "запроса", "запросов");
    expect(form(1)).toBe("запрос");
    expect(form(2)).toBe("запроса");
    expect(form(5)).toBe("запросов");
    expect(form(11)).toBe("запросов");
    expect(form(21)).toBe("запрос");
    expect(form(0)).toBe("запросов");
  });
});

describe("даты и время по UTC", () => {
  it("подпись дня на оси и в подсказке", () => {
    expect(formatAxisDay("2026-10-16T00:00:00.000Z")).toBe("16 окт.");
    expect(formatDayUtc("2026-10-16T00:00:00.000Z")).toBe("16 окт. 2026 (UTC)");
  });

  it("час в подсказке и на оси", () => {
    expect(formatHourUtc("2026-10-16T09:00:00.000Z")).toBe("16 окт., 09:00 UTC");
    expect(formatAxisHour("2026-10-16T09:00:00.000Z")).toBe("09:00");
  });

  it("не зависит от пояса браузера: поздний вечер по UTC остаётся тем же днём", () => {
    expect(formatAxisDay("2026-10-16T23:30:00.000Z")).toBe("16 окт.");
  });

  it("подпись «Данные на» и время на момент", () => {
    expect(formatDataAsOf("2026-10-16T09:12:03.120Z")).toBe("16 окт., 09:12 UTC");
    expect(formatTimeUtc("2026-10-16T09:15:00.000Z")).toBe("09:15 UTC");
  });

  it("период словами", () => {
    expect(formatDateRange("2026-09-17", "2026-10-16")).toBe("с 17 сент. 2026 по 16 окт. 2026");
    expect(formatDateRange("2026-10-15", "2026-10-15")).toBe("15 окт. 2026");
  });

  it("относительное время в журнале", () => {
    const now = new Date("2026-10-16T09:30:00.000Z");
    expect(formatRelative("2026-10-16T09:10:00.000Z", now)).toBe("20 минут назад");
    expect(formatRelative("2026-10-16T09:29:00.000Z", now)).toBe("1 минуту назад");
    expect(formatRelative("2026-10-15T19:30:00.000Z", now)).toBe("14 часов назад");
    expect(formatRelative("2026-10-14T09:30:00.000Z", now)).toBe("2 дня назад");
    expect(formatRelative("2026-10-16T09:29:45.000Z", now)).toBe("только что");
  });
});
