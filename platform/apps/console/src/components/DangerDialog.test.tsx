import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { ApiError } from "../lib/api";
import { server } from "../mocks/server";
import { DangerDialog } from "./DangerDialog";

const BLOCKING = {
  blocking: [
    { kind: "deployment", id: "depl_1", name: "Утренний отчёт", status: "active", note: "запуски упадут" },
  ],
  affected: [{ kind: "session", id: "sesn_1", name: "Сессия 1", status: "idle", note: null }],
  truncated: false,
};
const EMPTY = { blocking: [], affected: [], truncated: false };

function dialog(overrides: Partial<React.ComponentProps<typeof DangerDialog>> = {}) {
  const props = {
    open: true,
    operation: "delete" as const,
    target: { kind: "environment" as const, id: "env_1" },
    title: "Удалить окружение?",
    run: vi.fn().mockResolvedValue({}),
    onDone: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<DangerDialog {...props} />);
  return props;
}

describe("DangerDialog", () => {
  it("lists blocking and affected dependencies and disables the delete button", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/environment/env_1", ({ request }) => {
        expect(new URL(request.url).searchParams.get("operation")).toBe("delete");
        return HttpResponse.json(BLOCKING);
      }),
    );
    dialog();

    expect(await screen.findByText("Мешает")).toBeInTheDocument();
    expect(screen.getByText("Затронет")).toBeInTheDocument();
    expect(screen.getByText(/Утренний отчёт/)).toBeInTheDocument();
    expect(screen.getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("enables the button without blocking dependencies and runs the action", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/environment/env_1", () => HttpResponse.json(EMPTY)),
    );
    const props = dialog();

    const button = await screen.findByRole("button", { name: "Удалить" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    await waitFor(() => expect(props.onDone).toHaveBeenCalled());
    expect(props.run).toHaveBeenCalledWith({});
  });

  it("sends the ETag read next to the dependency list as If-Match", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/environment/env_1", () => HttpResponse.json(EMPTY)),
      http.get("*/v1/environments/env_1", () =>
        HttpResponse.json({ id: "env_1" }, { headers: { ETag: '"4"' } }),
      ),
    );
    const props = dialog({ operation: "archive", etagPath: "/v1/environments/env_1" });

    await waitFor(() => expect(screen.getByRole("button", { name: "В архив" })).toBeEnabled());
    expect(screen.getByText(/Можно вернуть из архива/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "В архив" }));

    await waitFor(() => expect(props.run).toHaveBeenCalledWith({ ifMatch: '"4"' }));
  });

  it("prefers a known revision over the ETag lookup", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/agent/agent_1", () => HttpResponse.json(EMPTY)),
    );
    const props = dialog({
      operation: "archive",
      target: { kind: "agent", id: "agent_1" },
      ifMatch: '"3"',
    });
    const button = await screen.findByRole("button", { name: "В архив" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(props.run).toHaveBeenCalledWith({ ifMatch: '"3"' }));
  });

  it("shows the list of a 409 answer and keeps the dialog open", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/environment/env_1", () => HttpResponse.json(EMPTY)),
    );
    const conflict = new ApiError({
      code: "dependency_conflict_error",
      message: "Действие невозможно",
      status: 409,
      dependencies: BLOCKING,
    });
    const props = dialog({ run: vi.fn().mockRejectedValue(conflict) });

    const button = await screen.findByRole("button", { name: "Удалить" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    expect(await screen.findByText("Мешает")).toBeInTheDocument();
    expect(screen.getByText(/Утренний отчёт/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it("asks to refresh the page on 412", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/environment/env_1", () => HttpResponse.json(EMPTY)),
    );
    const stale = new ApiError({ code: "", message: "Объект изменили, обновите страницу.", status: 412 });
    dialog({ run: vi.fn().mockRejectedValue(stale) });

    const button = await screen.findByRole("button", { name: "Удалить" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);

    expect(await screen.findByText("Объект изменили, обновите страницу.")).toBeInTheDocument();
  });

  it("lets the server check when the list cannot be read", async () => {
    server.use(
      http.get("*/v1/oma/dependencies/environment/env_1", () =>
        HttpResponse.json({ error: "boom" }, { status: 500 }),
      ),
    );
    dialog();
    expect(await screen.findByText(/Не удалось проверить зависимости/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Удалить" })).toBeEnabled();
  });
});
