import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../../i18n";
import { server } from "../../mocks/server";
import { DeploymentDetail } from "./DeploymentDetail";
import { DeploymentsList } from "./DeploymentsList";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: "depl_1",
    type: "deployment",
    name: "Утренний отчёт",
    description: null,
    agent: { id: "agent_1", type: "agent", version: 2 },
    environment_id: "env_1",
    initial_events: [{ type: "user.message", content: [{ type: "text", text: "Собери отчёт" }] }],
    metadata: {},
    resources: [],
    vault_ids: [],
    status: "active",
    paused_reason: null,
    schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Moscow", upcoming_runs_at: ["2026-10-19T06:00:00.000Z"] },
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-15T10:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

let deployments: ReturnType<typeof deployment>[];
let calls: Array<{ method: string; path: string; ifMatch: string | null }>;

beforeEach(() => {
  localStorage.clear();
  calls = [];
  deployments = [
    deployment(),
    deployment({ id: "depl_2", name: "Старый отчёт", archived_at: "2026-10-15T12:00:00.000Z", status: "paused", paused_reason: { type: "manual" }, schedule: null }),
  ];
  const record = (request: Request, path: string) =>
    calls.push({ method: request.method, path, ifMatch: request.headers.get("if-match") });
  server.use(
    http.get("*/v1/deployments", () => HttpResponse.json({ data: deployments, next_page: null })),
    http.get("*/v1/agents", () => HttpResponse.json({ data: [{ id: "agent_1", name: "Аналитик" }], next_page: null })),
    http.get("*/v1/agents/agent_1", () => HttpResponse.json({ id: "agent_1", name: "Аналитик" })),
    http.get("*/v1/environments/env_1", () => HttpResponse.json({ id: "env_1", name: "Основное" })),
    http.get("*/v1/deployments/:id", ({ params }) =>
      HttpResponse.json(deployments.find((item) => item.id === params.id), { headers: { ETag: '"5"' } }),
    ),
    http.get("*/v1/deployment_runs", () =>
      HttpResponse.json({
        data: [
          { id: "drun_1", type: "deployment_run", deployment_id: "depl_1", session_id: "sesn_9", error: null, created_at: "2026-10-16T06:00:00.000Z", trigger_context: { type: "schedule", scheduled_at: "2026-10-16T06:00:00.000Z" }, agent: { id: "agent_1", type: "agent", version: 2 } },
        ],
        next_page: null,
      }),
    ),
    http.get("*/v1/oma/dependencies/deployment/:id", () =>
      HttpResponse.json({ blocking: [], affected: [{ kind: "session", id: "sesn_9", name: "Прогон", status: "running", note: "ход остановится" }], truncated: false }),
    ),
    http.post("*/v1/deployments/:id/unarchive", ({ request, params }) => {
      record(request, `unarchive ${String(params.id)}`);
      return HttpResponse.json(deployment({ id: params.id, status: "paused", archived_at: null }));
    }),
    http.post("*/v1/deployments/:id/archive", ({ request, params }) => {
      record(request, `archive ${String(params.id)}`);
      return HttpResponse.json(deployment({ id: params.id, archived_at: "2026-10-16T00:00:00.000Z" }));
    }),
    http.post("*/v1/deployments/:id/pause", ({ request, params }) => {
      record(request, `pause ${String(params.id)}`);
      return HttpResponse.json(deployment({ id: params.id, status: "paused" }));
    }),
  );
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
          <Routes>
            <Route path="/deployments" element={<DeploymentsList />} />
            <Route path="/deployments/:id" element={<DeploymentDetail />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("страница деплойментов", () => {
  it("показывает строки со статусом, триггером и именем агента", async () => {
    renderAt("/deployments");
    const table = await screen.findByRole("table", { name: "Деплойменты" });
    const row = (await within(table).findByText("Утренний отчёт")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Активен")).toBeInTheDocument();
    expect(within(row).getByText("По расписанию, 0 9 * * 1-5 (Europe/Moscow)")).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText("Аналитик")).toBeInTheDocument());
    const archivedRow = within(table).getByText("Старый отчёт").closest("tr") as HTMLElement;
    expect(within(archivedRow).getByText("В архиве")).toBeInTheDocument();
    expect(within(archivedRow).getByText("Вручную")).toBeInTheDocument();
  });

  it("у архивной строки есть пункт «Вернуть из архива» и нет «Запустить»", async () => {
    renderAt("/deployments");
    const table = await screen.findByRole("table", { name: "Деплойменты" });
    fireEvent.contextMenu(await within(table).findByText("Старый отчёт"));
    expect(screen.queryByRole("menuitem", { name: "Запустить" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Вернуть из архива" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "unarchive depl_2", ifMatch: null }));
  });

  it("ставит активный деплоймент на паузу из меню строки", async () => {
    renderAt("/deployments");
    const table = await screen.findByRole("table", { name: "Деплойменты" });
    fireEvent.contextMenu(await within(table).findByText("Утренний отчёт"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Пауза" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("pause depl_1"));
  });

  it("архивирует через окно со списком «Затронет» и шлёт If-Match из ETag", async () => {
    renderAt("/deployments");
    const table = await screen.findByRole("table", { name: "Деплойменты" });
    fireEvent.contextMenu(await within(table).findByText("Утренний отчёт"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "В архив" }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    expect(within(dialog).getByText(/ход остановится/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: "archive depl_1", ifMatch: '"5"' }));
  });
});

describe("карточка деплоймента", () => {
  it("показывает свойства, ближайшие запуски и вкладку прогонов со ссылкой на сессию", async () => {
    renderAt("/deployments/depl_1");
    expect(await screen.findByRole("heading", { level: 1, name: /Утренний отчёт/ })).toBeInTheDocument();
    expect(await screen.findByText("Ближайшие запуски")).toBeInTheDocument();
    expect(screen.getByText("Собери отчёт")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Прогоны" }));
    const link = await screen.findByRole("link", { name: "sesn_9" });
    expect(link).toHaveAttribute("href", "/sessions/sesn_9");
  });

  it("у архивного деплоймента вместо кнопок состояния стоит «Вернуть из архива»", async () => {
    renderAt("/deployments/depl_2");
    expect(await screen.findByRole("button", { name: "Вернуть из архива" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Запустить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    expect(screen.getByText("Поставлен на паузу вручную")).toBeInTheDocument();
  });

  it("на паузе «Запустить» выключена с подсказкой: сервер запускает только активный деплоймент", async () => {
    deployments.push(deployment({ id: "depl_3", name: "Ночной отчёт", status: "paused", paused_reason: { type: "manual" } }));
    renderAt("/deployments/depl_3");
    const run = await screen.findByRole("button", { name: "Запустить" });
    expect(run).toBeDisabled();
    expect(run).toHaveAttribute("title", "Сначала продолжите деплоймент");
    expect(screen.getByRole("button", { name: "Продолжить" })).toBeEnabled();
  });
});

describe("меню строки деплоймента на паузе", () => {
  it("пункт «Запустить» выключен, «Продолжить» доступен", async () => {
    deployments.push(deployment({ id: "depl_3", name: "Ночной отчёт", status: "paused", paused_reason: { type: "manual" } }));
    renderAt("/deployments");
    const table = await screen.findByRole("table", { name: "Деплойменты" });
    fireEvent.contextMenu(await within(table).findByText("Ночной отчёт"));
    const run = await screen.findByRole("menuitem", { name: "Запустить" });
    expect(run).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Продолжить" })).not.toHaveAttribute("data-disabled");
  });
});
