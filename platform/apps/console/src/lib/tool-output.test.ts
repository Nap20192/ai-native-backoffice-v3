import { describe, expect, it } from "vitest";

import { formatToolOutput } from "./tool-output";

describe("formatToolOutput", () => {
  it("отдаёт строку как есть", () => {
    expect(formatToolOutput("готово")).toBe("готово");
  });

  it("собирает текст из content-блоков и склеивает блоки переносом строки", () => {
    expect(
      formatToolOutput([
        { type: "text", text: "первая\nстрока" },
        { type: "text", text: "вторая" },
      ]),
    ).toBe("первая\nстрока\nвторая");
  });

  it("убирает управляющие последовательности ANSI", () => {
    expect(formatToolOutput("\u001b[2m12:00\u001b[0m \u001b[33m WARN\u001b[0m x")).toBe("12:00  WARN x");
    expect(formatToolOutput([{ type: "text", text: "\u001b[1;31mошибка\u001b[0m" }])).toBe("ошибка");
  });

  it("не трогает обычные квадратные скобки в тексте", () => {
    expect(formatToolOutput("[1/3] сборка")).toBe("[1/3] сборка");
  });

  it("показывает JSON, если в массиве есть не только текстовые блоки", () => {
    const blocks = [
      { type: "text", text: "снимок" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
    ];
    expect(formatToolOutput(blocks)).toBe(JSON.stringify(blocks, null, 2));
  });

  it("показывает JSON для объектов и пустого массива", () => {
    expect(formatToolOutput({ rows: 3 })).toBe('{\n  "rows": 3\n}');
    expect(formatToolOutput([])).toBe("[]");
  });
});
