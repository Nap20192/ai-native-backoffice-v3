import { describe, expect, it } from "vitest";

import { keepOutputUrl, outputFileFromHref } from "./output-links";

describe("outputFileFromHref", () => {
  it("находит имя файла агента в абсолютном пути и в адресах sandbox: и file://", () => {
    expect(outputFileFromHref("/mnt/session/outputs/demo.pdf")).toBe("demo.pdf");
    expect(outputFileFromHref("sandbox:/mnt/session/outputs/%D0%BE%D1%82%D1%87%D1%91%D1%82.docx")).toBe("отчёт.docx");
    expect(outputFileFromHref("file:///mnt/session/outputs/итоги.xlsx")).toBe("итоги.xlsx");
  });

  it("всё остальное не считает файлом агента", () => {
    expect(outputFileFromHref("/mnt/session/outputs/")).toBeNull();
    expect(outputFileFromHref("https://example.com/mnt/session/outputs/a.pdf")).toBeNull();
    expect(outputFileFromHref("/mnt/session/uploads/a.pdf")).toBeNull();
    expect(outputFileFromHref(undefined)).toBeNull();
  });
});

describe("keepOutputUrl", () => {
  it("оставляет адреса файлов агента, остальное отдаёт обычной проверке react-markdown", () => {
    expect(keepOutputUrl("sandbox:/mnt/session/outputs/a.pdf")).toBe("sandbox:/mnt/session/outputs/a.pdf");
    expect(keepOutputUrl("file:///mnt/session/outputs/a.pdf")).toBe("file:///mnt/session/outputs/a.pdf");
    expect(keepOutputUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(keepOutputUrl("javascript:alert(1)")).toBe("");
  });
});
