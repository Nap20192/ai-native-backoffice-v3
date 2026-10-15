import { describe, expect, it } from "vitest";

import { dayStartIndices, logPosition, logTicks, niceTicks, pickLabelIndices } from "./axis";

describe("niceTicks", () => {
  it("для 1 450 000 деления 0, 500 тыс., 1 млн, 1,5 млн", () => {
    expect(niceTicks(1_450_000)).toEqual({ ticks: [0, 500_000, 1_000_000, 1_500_000], max: 1_500_000 });
  });

  it("берёт шаги 1, 2, 2,5 и 5 на степень десяти, не больше пяти делений", () => {
    expect(niceTicks(7).ticks).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(100).ticks).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(30_000).ticks).toEqual([0, 10_000, 20_000, 30_000]);
  });

  it("дробные значения без хвостов плавающей запятой", () => {
    expect(niceTicks(0.0127).ticks).toEqual([0, 0.005, 0.01, 0.015]);
  });

  it("пустой ряд даёт ось от 0 до 1", () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], max: 1 });
  });
});

describe("logTicks", () => {
  it("ось окупаемости 0,5, 1, 2, 5, 10 покрывает диапазон", () => {
    expect(logTicks(0.8, 7.2)).toEqual([0.5, 1, 2, 5, 10]);
  });

  it("одно значение растягивается на соседние деления", () => {
    expect(logTicks(1, 1)).toEqual([0.5, 1, 2]);
  });

  it("позиция на логарифмической шкале от 0 до 1", () => {
    expect(logPosition(1, 0.5, 2)).toBeCloseTo(0.5, 6);
    expect(logPosition(0.5, 0.5, 2)).toBeCloseTo(0, 6);
    expect(logPosition(2, 0.5, 2)).toBeCloseTo(1, 6);
  });
});

describe("подписи оси X", () => {
  it("не больше шести подписей, первая на месте", () => {
    const indices = pickLabelIndices(30, 6);
    expect(indices.length).toBeLessThanOrEqual(6);
    expect(indices[0]).toBe(0);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("мало столбцов: подписаны все", () => {
    expect(pickLabelIndices(3, 6)).toEqual([0, 1, 2]);
  });

  it("часовой ряд: подпись на первой точке и на каждой полуночи UTC", () => {
    const start = Date.parse("2026-10-09T10:00:00.000Z");
    const hours = Array.from({ length: 168 }, (_, i) => new Date(start + i * 3_600_000).toISOString());
    expect(dayStartIndices(hours)).toEqual([0, 14, 38, 62, 86, 110, 134, 158]);
  });
});
