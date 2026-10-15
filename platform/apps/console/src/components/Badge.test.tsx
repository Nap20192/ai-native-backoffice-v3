import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { StatusPill } from "./Badge";

describe("StatusPill", () => {
  it("is a 20px rounded-md chip with a Russian label for known statuses", () => {
    render(<StatusPill status="running" />);

    const pill = screen.getByText("Выполняется");
    expect(pill).toHaveClass("h-5", "rounded-md", "text-xs", "font-medium");
  });

  it("paints each status with one of the DDC tones", () => {
    render(
      <>
        <StatusPill status="idle" />
        <StatusPill status="running" />
        <StatusPill status="rescheduling" />
        <StatusPill status="completed" />
        <StatusPill status="error" />
        <StatusPill status="terminated" />
      </>,
    );

    expect(screen.getByText("Ожидает")).toHaveClass("bg-ddc-tone-neutral-bg");
    expect(screen.getByText("Выполняется")).toHaveClass("bg-ddc-tone-info-bg", "ring-1", "ring-inset");
    expect(screen.getByText("Перезапуск")).toHaveClass("bg-ddc-tone-warning-bg");
    expect(screen.getByText("Завершено")).toHaveClass("bg-ddc-tone-success-bg");
    expect(screen.getByText("Ошибка")).toHaveClass("bg-ddc-tone-danger-bg");
    expect(screen.getByText("Остановлено")).toHaveClass("bg-ddc-tone-danger-bg");
  });

  it("does not draw a dot inside a toned badge", () => {
    const { container } = render(<StatusPill status="running" />);

    expect(container.querySelector("span span")).toBeNull();
  });

  it("falls back to the neutral tone and keeps an unknown status readable", () => {
    render(<StatusPill status="pending" />);

    expect(screen.getByText("Pending")).toHaveClass("bg-ddc-tone-neutral-bg");
  });

  it("prefers the label passed by the caller", () => {
    render(<StatusPill status="completed" label="Готово" />);

    expect(screen.getByText("Готово")).toHaveClass("bg-ddc-tone-success-bg");
  });
});
