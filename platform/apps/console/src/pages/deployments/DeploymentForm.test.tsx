import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../../i18n";
import { server } from "../../mocks/server";
import { DeploymentForm } from "./DeploymentForm";

// Выпадающий список ходит в API сам. Здесь важна форма вокруг него, поэтому
// подставляем текстовое поле, которое отдаёт введённое значение как выбранное.
vi.mock("../../components/Combobox", () => ({
  Combobox: ({
    value,
    onValueChange,
    placeholder,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <input aria-label={placeholder} value={value} onChange={(event) => onValueChange(event.target.value)} />
  ),
}));

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

let created: unknown[];
let updated: Array<{ id: string; body: unknown }>;

beforeEach(() => {
  created = [];
  updated = [];
  server.use(
    http.get("*/v1/files", () => HttpResponse.json({ data: [], has_more: false })),
    http.get("*/v1/memory_stores", () => HttpResponse.json({ data: [], next_page: null })),
    http.get("*/v1/deployments/depl_1", () =>
      HttpResponse.json({
        id: "depl_1",
        type: "deployment",
        name: "Утренний отчёт",
        agent: { id: "agent_1", type: "agent", version: 2 },
        environment_id: "env_1",
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "Собери отчёт" }] }],
        resources: [],
        vault_ids: [],
        status: "paused",
        paused_reason: { type: "manual" },
        schedule: null,
        metadata: {},
        created_at: "2026-10-14T10:00:00.000Z",
        updated_at: "2026-10-15T10:00:00.000Z",
        archived_at: null,
      }),
    ),
    http.post("*/v1/deployments", async ({ request }) => {
      const body = await request.json();
      created.push(body);
      return HttpResponse.json({ id: "depl_new", type: "deployment" });
    }),
    http.post("*/v1/deployments/:id", async ({ request, params }) => {
      updated.push({ id: String(params.id), body: await request.json() });
      return HttpResponse.json({ id: params.id, type: "deployment" });
    }),
  );
});

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <I18nProvider>
          <Routes>
            <Route path="/deployments/new" element={<DeploymentForm />} />
            <Route path="/deployments/:id/edit" element={<DeploymentForm />} />
            <Route path="/deployments/:id" element={<p>Карточка деплоймента</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("форма деплоймента", () => {
  it("подставляет агента из адреса и создаёт деплоймент на паузе", async () => {
    renderAt("/deployments/new?agent=agent_1");

    expect(await screen.findByLabelText("Выберите агента…")).toHaveValue("agent_1");
    await userEvent.type(screen.getByLabelText("Название"), "Утренний отчёт");
    await userEvent.type(screen.getByLabelText("Выберите окружение…"), "env_1");
    await userEvent.type(screen.getByLabelText("Начальное сообщение"), "Собери отчёт");
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      name: "Утренний отчёт",
      agent: "agent_1",
      environment_id: "env_1",
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "Собери отчёт" }] }],
      _oma: { paused: true },
    });
    expect(await screen.findByText("Карточка деплоймента")).toBeInTheDocument();
  });

  it("кнопка «Создать» выключена, пока нет сообщения", async () => {
    renderAt("/deployments/new?agent=agent_1");
    await screen.findByLabelText("Название");
    await userEvent.type(screen.getByLabelText("Название"), "Отчёт");
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });

  it("правка заполняет поля и шлёт только изменённого агента", async () => {
    renderAt("/deployments/depl_1/edit");

    const name = await screen.findByLabelText("Название");
    await waitFor(() => expect(name).toHaveValue("Утренний отчёт"));
    expect(screen.getByLabelText("Начальное сообщение")).toHaveValue("Собери отчёт");
    await userEvent.type(name, " v2");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(updated).toHaveLength(1));
    expect(updated[0]!.id).toBe("depl_1");
    expect(updated[0]!.body).toMatchObject({ name: "Утренний отчёт v2", environment_id: "env_1", schedule: null });
    expect(updated[0]!.body).not.toHaveProperty("agent");
    expect(updated[0]!.body).not.toHaveProperty("_oma");
  });
});
