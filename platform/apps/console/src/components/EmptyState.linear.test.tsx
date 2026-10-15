import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { EmptyState } from "./EmptyState";

describe("EmptyState composition", () => {
  it("accepts rich body copy without nesting paragraphs", () => {
    const { container } = render(
      <EmptyState title="No agents yet" body={<p>Create your first agent.</p>} />,
    );

    expect(container.querySelector("p p")).toBeNull();
  });

  it("draws the DDC plate: 56px rounded-2xl brand tile above a semibold title", () => {
    const { container } = render(
      <EmptyState title="Агентов пока нет" body="Создайте первого агента" />,
    );

    const plate = container.querySelector(".size-14");
    expect(plate).toHaveClass("rounded-2xl", "bg-ddc-tone-brand-bg", "text-ddc-tone-brand-fg");
    expect(plate?.querySelector("svg")).toHaveClass("size-6");
    expect(screen.getByText("Агентов пока нет")).toHaveClass("text-base", "font-semibold");
    expect(screen.getByText("Создайте первого агента")).toHaveClass("text-sm", "text-ddc-text-muted");
  });

  it("keeps actions in a wrapping row with gap-2", () => {
    render(<EmptyState title="Пусто" action={<button>Создать</button>} />);

    expect(screen.getByRole("button", { name: "Создать" }).parentElement).toHaveClass(
      "flex",
      "flex-wrap",
      "justify-center",
      "gap-2",
    );
  });

  it("shows a labelled spinner instead of an icon while loading", () => {
    render(<EmptyState title="Загрузка списка" loading />);

    expect(screen.getByRole("status", { name: "Загрузка списка" })).toHaveClass("animate-spin");
  });

  it("can switch the plate to a status tone", () => {
    const { container } = render(<EmptyState title="Ошибка" tone="warning" />);

    expect(container.querySelector(".size-14")).toHaveClass(
      "bg-ddc-tone-warning-bg",
      "text-ddc-tone-warning-fg",
    );
  });

  it("takes the section icon from the sidebar set (lucide), not a hand-drawn SVG", () => {
    const { container } = render(<EmptyState title="Агентов пока нет" kind="agent" />);

    const icon = container.querySelector(".size-14 svg");
    expect(icon).toHaveClass("lucide", "lucide-bot", "size-6");
  });
});
