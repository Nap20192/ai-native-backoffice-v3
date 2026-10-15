import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Skeleton, SkeletonRows } from "./Skeleton";

describe("Skeleton", () => {
  it("is hidden from assistive tech and shimmers over an ink-100 base", () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);

    const block = container.firstElementChild;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block).toHaveClass("bg-ddc-surface-sunken", "rounded-lg", "h-4", "w-32");
    expect(block?.className).toContain("before:animate-shimmer");
  });

  it("lets the caller choose the radius", () => {
    const { container } = render(<Skeleton className="size-8" rounded="full" />);

    expect(container.firstElementChild).toHaveClass("rounded-full");
    expect(container.firstElementChild).not.toHaveClass("rounded-lg");
  });

  it("marks a group of rows busy and announces the loading text", () => {
    const { container } = render(<SkeletonRows count={3} />);

    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Загрузка…")).toHaveClass("sr-only");
  });
});
