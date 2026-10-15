import { describe, expect, it } from "vitest";

import {
  assignSeriesColors,
  colorForKey,
  fnv1a,
  foldTail,
  OTHER_COLOR,
  SERIES_PALETTE,
  TOKEN_TYPE_COLORS,
} from "./series-colors";

describe("fnv1a", () => {
  it("совпадает с эталонными значениями FNV-1a на 32 бита", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
  });
});

describe("цвет ряда по ключу", () => {
  it("один ключ всегда одного цвета", () => {
    expect(colorForKey("verify-fake")).toBe(colorForKey("verify-fake"));
    expect(assignSeriesColors(["verify-fake"]).get("verify-fake")).toBe(colorForKey("verify-fake"));
  });

  it("в палитре восемь наборов классов на шкалах DDC со светлой ступенью для тёмной темы", () => {
    expect(SERIES_PALETTE).toHaveLength(8);
    expect(SERIES_PALETTE[0].bg).toContain("bg-brand-600");
    expect(SERIES_PALETTE[0].bg).toContain("dark:bg-brand-500");
    expect(SERIES_PALETTE[1].bg).toContain("bg-sky-500");
    expect(SERIES_PALETTE[2].bg).toContain("bg-amber-500");
    expect(SERIES_PALETTE[3].bg).toContain("bg-rose-500");
    for (const color of SERIES_PALETTE) {
      expect(color.fill.startsWith("fill-")).toBe(true);
      expect(color.stroke.startsWith("stroke-")).toBe(true);
    }
  });

  it("восемь ключей получают восемь разных цветов", () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const colors = assignSeriesColors(keys);
    expect(new Set(keys.map((k) => colors.get(k))).size).toBe(8);
  });

  it("при совпадении хеша второй ключ берёт следующий свободный цвет", () => {
    const byIndex = new Map<number, string[]>();
    for (let i = 0; i < 200; i += 1) {
      const key = `model-${i}`;
      const idx = fnv1a(key) % SERIES_PALETTE.length;
      byIndex.set(idx, [...(byIndex.get(idx) ?? []), key]);
    }
    const pair = [...byIndex.values()].find((keys) => keys.length >= 2);
    expect(pair).toBeDefined();
    const [first, second] = pair as string[];
    const colors = assignSeriesColors([first, second]);
    expect(colors.get(first)).toBe(colorForKey(first));
    expect(colors.get(second)).not.toBe(colors.get(first));
  });
});

describe("закреплённые цвета", () => {
  it("типы токенов: чтение кэша sky, запись amber, выход brand, вход ink", () => {
    expect(TOKEN_TYPE_COLORS.cache_read.bg).toContain("bg-sky-500");
    expect(TOKEN_TYPE_COLORS.cache_write.bg).toContain("bg-amber-500");
    expect(TOKEN_TYPE_COLORS.output.bg).toContain("bg-brand-600");
    expect(TOKEN_TYPE_COLORS.input.bg).toContain("bg-ink-400");
  });

  it("«Остальные» серым ink-300", () => {
    expect(OTHER_COLOR.bg).toContain("bg-ink-300");
  });
});

describe("foldTail", () => {
  it("ряды сверх семи уходят в хвост", () => {
    const { head, tail } = foldTail([1, 2, 3, 4, 5, 6, 7, 8, 9], 7);
    expect(head).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(tail).toEqual([8, 9]);
  });

  it("семь рядов остаются как есть", () => {
    const { head, tail } = foldTail([1, 2, 3, 4, 5, 6, 7], 7);
    expect(head).toHaveLength(7);
    expect(tail).toEqual([]);
  });
});
