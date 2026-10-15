import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
