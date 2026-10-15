import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Avatar } from "./Avatar";

describe("Avatar sizes follow the DDC scale 24, 32, 40, 64, 96", () => {
  const cases = [
    ["xs", "size-6"],
    ["sm", "size-8"],
    ["md", "size-10"],
    ["lg", "size-16"],
    ["xl", "size-24"],
  ] as const;

  it.each(cases)("%s is %s", (size, cls) => {
    const { container } = render(<Avatar name="Документовед" size={size} />);

    expect(container.querySelector('[data-slot="avatar"]')).toHaveClass(cls);
  });

  it("shows the first letter of the name, and a question mark only when there is no name", () => {
    const { container, rerender } = render(<Avatar name="default" />);
    expect(container.textContent).toBe("D");

    rerender(<Avatar name="" />);
    expect(container.textContent).toBe("?");
  });
});
