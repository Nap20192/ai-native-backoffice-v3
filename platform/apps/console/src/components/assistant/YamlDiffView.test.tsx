import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { YamlBlock, YamlDiffView, buildHunks, lineDiff } from "./YamlDiffView";

describe("lineDiff", () => {
  it("одинаковый текст: только общие строки", () => {
    expect(lineDiff(["a", "b"], ["a", "b"]).map((l) => l.type)).toEqual(["ctx", "ctx"]);
  });

  it("замена строки: удалённая, затем новая", () => {
    const d = lineDiff(["a", "b", "c"], ["a", "B", "c"]);
    expect(d.map((l) => `${l.type}:${l.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c"]);
  });

  it("вставка и удаление", () => {
    expect(lineDiff(["a"], ["a", "b"]).map((l) => l.type)).toEqual(["ctx", "add"]);
    expect(lineDiff(["a", "b"], ["a"]).map((l) => l.type)).toEqual(["ctx", "del"]);
  });

  it("пустые стороны", () => {
    expect(lineDiff([], ["x"]).map((l) => l.type)).toEqual(["add"]);
    expect(lineDiff(["x"], []).map((l) => l.type)).toEqual(["del"]);
  });
});

describe("buildHunks", () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`);

  it("оставляет по 3 строки вокруг изменения и прячет остальное", () => {
    const before = numbered(20);
    const after = numbered(20);
    after[9] = "ИЗМЕНЕНО";
    const hunks = buildHunks(lineDiff(before, after), 3);
    expect(hunks).toHaveLength(1);
    const texts = hunks[0].lines.map((l) => l.text);
    expect(texts).toEqual(["l7", "l8", "l9", "l10", "ИЗМЕНЕНО", "l11", "l12", "l13"]);
    expect(hunks[0].hiddenBefore).toBe(6);
    expect(hunks[0].hiddenAfter).toBe(7);
  });

  it("два далёких изменения дают два блока", () => {
    const before = numbered(30);
    const after = numbered(30);
    after[2] = "A";
    after[27] = "B";
    expect(buildHunks(lineDiff(before, after), 3)).toHaveLength(2);
  });

  it("близкие изменения склеиваются", () => {
    const before = numbered(12);
    const after = numbered(12);
    after[2] = "A";
    after[6] = "B";
    expect(buildHunks(lineDiff(before, after), 3)).toHaveLength(1);
  });

  it("без изменений блоков нет", () => {
    expect(buildHunks(lineDiff(["a"], ["a"]), 3)).toEqual([]);
  });
});

describe("YamlDiffView", () => {
  it("рисует удалённое и новое с подписями для чтения без цвета", () => {
    render(<YamlDiffView before={"a: 1\nb: 2\n"} after={"a: 1\nb: 3\n"} />);
    const removed = screen.getByText("b: 2");
    const added = screen.getByText("b: 3");
    expect(removed.closest("[data-diff='del']")).not.toBeNull();
    expect(added.closest("[data-diff='add']")).not.toBeNull();
    expect(screen.getByText("Удалено", { selector: ".sr-only" })).toBeInTheDocument();
    expect(screen.getByText("Добавлено", { selector: ".sr-only" })).toBeInTheDocument();
  });

  it("если различий нет, пишет об этом", () => {
    render(<YamlDiffView before="a: 1" after="a: 1" />);
    expect(screen.getByText("Изменений нет")).toBeInTheDocument();
  });

  it("«Показать целиком» открывает колонки «Сейчас» и «Станет»", async () => {
    const user = userEvent.setup();
    render(<YamlDiffView before={"a: 1\nb: 2\n"} after={"a: 1\nb: 3\n"} />);
    await user.click(screen.getByRole("button", { name: "Показать целиком" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Сейчас")).toBeInTheDocument();
    expect(within(dialog).getByText("Станет")).toBeInTheDocument();
    expect(within(dialog).getByText("b: 2")).toBeInTheDocument();
    expect(within(dialog).getByText("b: 3")).toBeInTheDocument();
  });
});

describe("YamlBlock", () => {
  it("короткий YAML показывает целиком", () => {
    render(<YamlBlock yaml={"a: 1\nb: 2"} />);
    expect(screen.getByText(/a: 1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Показать целиком" })).toBeNull();
  });

  it("после 20 строк сворачивает и разворачивает", async () => {
    const user = userEvent.setup();
    const yaml = Array.from({ length: 30 }, (_, i) => `k${i + 1}: v`).join("\n");
    render(<YamlBlock yaml={yaml} />);
    expect(screen.getByText(/k20: v/)).toBeInTheDocument();
    expect(screen.queryByText(/k21: v/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Показать целиком" }));
    expect(screen.getByText(/k30: v/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(screen.queryByText(/k21: v/)).toBeNull();
  });
});
