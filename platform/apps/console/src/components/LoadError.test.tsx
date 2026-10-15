import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LoadError } from "./LoadError";

describe("LoadError", () => {
  it("shows one warning block with the reason and a retry button", async () => {
    const onRetry = vi.fn();
    const { container } = render(
      <LoadError
        title="Не удалось загрузить участников"
        message="Недостаточно прав в рабочем пространстве."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Не удалось загрузить участников")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Недостаточно прав в рабочем пространстве.");
    expect(container.querySelector(".size-14")).toHaveClass("bg-ddc-tone-warning-bg");
    expect(container.querySelector("svg.lucide-triangle-alert")).not.toBeNull();

    const retry = screen.getByRole("button", { name: "Повторить" });
    expect(retry.querySelector("svg.lucide-refresh-cw")).not.toBeNull();
    await userEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("can show a second action next to retry", () => {
    render(
      <LoadError
        title="Не удалось загрузить хранилище"
        message="Сервер недоступен"
        onRetry={() => undefined}
        extra={<button type="button">К хранилищам</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "К хранилищам" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
  });
});
