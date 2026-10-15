import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolOutput } from "./tool";

describe("ToolOutput", () => {
  it("показывает текст со скобкой в начале как текст, а не как JSON", () => {
    const { container } = render(
      <ToolOutput errorText={undefined} output={"[1/3] сборка\nготово"} />,
    );

    const box = container.querySelector("[data-tool-output]");
    expect(box).not.toBeNull();
    expect(box).toHaveClass("whitespace-pre-wrap");
    expect(box!.textContent).toBe("[1/3] сборка\nготово");
  });

  it("настоящий JSON в строке по-прежнему идёт в блок кода", () => {
    const { container } = render(
      <ToolOutput errorText={undefined} output={'{"rows":3}'} />,
    );

    const box = container.querySelector("[data-tool-output]");
    expect(box).not.toBeNull();
    expect(box).not.toHaveClass("whitespace-pre-wrap");
    expect(box!.textContent).toContain("rows");
  });

  it("текст ошибки без вывода показан один раз и с переносами строк", () => {
    const { container } = render(
      <ToolOutput errorText={"сбой запуска\nкод 127"} output={undefined} />,
    );

    const box = container.querySelector("[data-tool-output]");
    expect(box).not.toBeNull();
    expect(box).toHaveClass("whitespace-pre-wrap");
    expect(box!.textContent).toBe("сбой запуска\nкод 127");
  });

  it("ничего не рисует, когда нет ни вывода, ни ошибки", () => {
    const { container } = render(<ToolOutput errorText={undefined} output={undefined} />);

    expect(container.firstChild).toBeNull();
  });
});
