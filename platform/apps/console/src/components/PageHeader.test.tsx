import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { PageHeader } from "./PageHeader";

describe("PageHeader (DDC rule 7)", () => {
  it("draws the title as the page h1 with the description and actions beside it", () => {
    render(
      <PageHeader
        title="Агенты"
        description="Агенты выполняют задачи по вашим инструкциям."
        actions={<button type="button">Новый агент</button>}
      />,
    );

    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1, name: "Агенты" })).toBeInTheDocument();
    expect(within(header).getByText("Агенты выполняют задачи по вашим инструкциям.")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Новый агент" })).toBeInTheDocument();
  });

  it("sits on the page background: no surface of its own, 24px below it", () => {
    render(<PageHeader title="Сводка" />);

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("mb-6");
    expect(header.className).not.toMatch(/\bbg-/);
    expect(header.className).not.toMatch(/\bborder/);
  });

  it("wraps a long title instead of cutting it off", () => {
    render(<PageHeader title="Регламенты компании и общие правила согласования" />);

    const title = screen.getByRole("heading", { level: 1 });
    expect(title).toHaveClass("prose-wrap", "text-2xl", "font-bold", "tracking-tight");
    expect(title.className).not.toContain("truncate");
  });

  it("renders without a description or actions", () => {
    render(<PageHeader title="Участники" />);

    expect(screen.getByRole("heading", { level: 1, name: "Участники" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
