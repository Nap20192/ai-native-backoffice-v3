import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OutputLinkContext } from "../lib/output-links";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("не пробрасывает служебный проп node в DOM блока кода", () => {
    const { container } = render(<Markdown>{"```python\nprint('Hello')\n```"}</Markdown>);

    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    expect(code!.hasAttribute("node")).toBe(false);
    expect(container.innerHTML).not.toContain("[object Object]");
  });

  it("не пробрасывает node в код без указания языка и во встроенный код", () => {
    const { container } = render(
      <Markdown>{"```\nplain\n```\n\nи `inline` код"}</Markdown>,
    );

    for (const code of container.querySelectorAll("code")) {
      expect(code.hasAttribute("node")).toBe(false);
    }
  });

  it("сохраняет подсветку и текст блока кода", () => {
    const { container } = render(<Markdown>{"```bash\necho hi\n```"}</Markdown>);

    const code = container.querySelector("pre code");
    expect(code?.className).toContain("language-bash");
    expect(code?.className).toContain("hljs");
    expect(code?.textContent).toContain("echo hi");
  });
});

describe("Markdown: ссылки на файлы агента", () => {
  function withViewer(text: string) {
    const open = vi.fn();
    render(
      <OutputLinkContext.Provider value={open}>
        <Markdown>{text}</Markdown>
      </OutputLinkContext.Provider>,
    );
    return open;
  }

  it("ссылка на /mnt/session/outputs открывает просмотр файла, а не страницу", async () => {
    const open = withViewer("Готово: [demo.pdf](/mnt/session/outputs/demo.pdf)");

    expect(screen.queryByRole("link")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "demo.pdf" }));

    expect(open).toHaveBeenCalledWith("demo.pdf");
  });

  it("адрес sandbox: тоже ведёт в просмотр", async () => {
    const open = withViewer("[отчёт](sandbox:/mnt/session/outputs/отчёт.docx)");

    await userEvent.click(screen.getByRole("button", { name: "отчёт" }));

    expect(open).toHaveBeenCalledWith("отчёт.docx");
  });

  it("внешняя ссылка остаётся ссылкой", () => {
    withViewer("[сайт](https://example.com/a)");

    expect(screen.getByRole("link", { name: "сайт" })).toHaveAttribute("href", "https://example.com/a");
  });

  it("без страницы сессии ссылка на файл агента остаётся обычной ссылкой", () => {
    render(<Markdown>{"[demo.pdf](/mnt/session/outputs/demo.pdf)"}</Markdown>);

    expect(screen.getByRole("link", { name: "demo.pdf" })).toHaveAttribute("href", "/mnt/session/outputs/demo.pdf");
  });
});
