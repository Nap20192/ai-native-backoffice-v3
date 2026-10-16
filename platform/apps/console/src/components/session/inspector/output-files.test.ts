import { describe, expect, it } from "vitest";

import {
  MAX_PREVIEW_BYTES,
  officeAppFor,
  outputBlobType,
  outputPreviewKind,
  sessionOutputPath,
} from "./output-files";

describe("output-files", () => {
  it("адрес файла кодирует и сессию, и имя", () => {
    expect(sessionOutputPath("s 1", "отчёт 1.md")).toBe(
      "/v1/sessions/s%201/outputs/%D0%BE%D1%82%D1%87%D1%91%D1%82%201.md",
    );
  });

  it("вид просмотра по расширению, регистр не важен", () => {
    expect(outputPreviewKind("Свод.PDF")).toBe("pdf");
    expect(outputPreviewKind("chart.JPG")).toBe("image");
    expect(outputPreviewKind("data.csv")).toBe("text");
    expect(outputPreviewKind("page.html")).toBe("text");
    expect(outputPreviewKind("logo.svg")).toBe("text");
    expect(outputPreviewKind("итоги.xlsx")).toBe("none");
    expect(outputPreviewKind("Makefile")).toBe("none");
  });

  it("большой файл не показывается, даже если формат знаком", () => {
    expect(outputPreviewKind("scan.pdf", MAX_PREVIEW_BYTES)).toBe("pdf");
    expect(outputPreviewKind("scan.pdf", MAX_PREVIEW_BYTES + 1)).toBe("none");
  });

  it("тип blob задаётся только для PDF и растровых картинок: SVG со скриптом не получает адреса в origin консоли", () => {
    expect(outputBlobType("a.pdf")).toBe("application/pdf");
    expect(outputBlobType("a.png")).toBe("image/png");
    expect(outputBlobType("a.svg")).toBeNull();
    expect(outputBlobType("a.html")).toBeNull();
  });

  it("офисный файл подсказывает программу", () => {
    expect(officeAppFor("отчёт.docx")).toBe("Word");
    expect(officeAppFor("итоги.xlsx")).toBe("Excel");
    expect(officeAppFor("обзор.pptx")).toBe("PowerPoint");
    expect(officeAppFor("notes.txt")).toBeNull();
  });
});
