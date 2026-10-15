import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  agents: { retrieve: vi.fn() },
}));

vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => api }));

import { AgentChip, EnvironmentChip, VaultChip } from "./Panels";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  vi.useRealTimers();
  api.agents.retrieve.mockReset().mockResolvedValue({
    id: "agent_01ABCDEFGH",
    created_at: new Date(Date.now() - 14 * 3_600_000).toISOString(),
  });
});

function renderInRouter(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

const agent = {
  id: "agent_01ABCDEFGH",
  name: "Глубокий исследователь",
  version: 1,
  description: "Ищет источники и собирает отчёт с цитатами.",
  model: { id: "claude-opus-5", effort: { type: "low" as const } },
};

describe("AgentChip", () => {
  it("рисует имя агента ссылкой на его страницу", () => {
    renderInRouter(<AgentChip agent={agent} />);

    expect(screen.getByRole("link", { name: /Глубокий исследователь/ })).toHaveAttribute(
      "href",
      "/agents/agent_01ABCDEFGH",
    );
  });

  it("при наведении показывает карточку: короткий id, версию, описание, модель, усилие и возраст", async () => {
    renderInRouter(<AgentChip agent={agent} />);

    await userEvent.hover(screen.getByRole("link", { name: /Глубокий исследователь/ }));

    expect(await screen.findByText("Агент")).toBeInTheDocument();
    expect(screen.getByText("agent_01…FGH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Открыть/ })).toHaveAttribute(
      "href",
      "/agents/agent_01ABCDEFGH",
    );
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("Ищет источники и собирает отчёт с цитатами.")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("Низкое усилие")).toBeInTheDocument();
    expect(await screen.findByText("Создан 14 ч назад")).toBeInTheDocument();
    expect(api.agents.retrieve).toHaveBeenCalledWith("agent_01ABCDEFGH");
  });

  it("не падает, если дату создания получить не удалось", async () => {
    api.agents.retrieve.mockRejectedValue(new Error("нет"));
    renderInRouter(<AgentChip agent={agent} />);

    await userEvent.hover(screen.getByRole("link", { name: /Глубокий исследователь/ }));

    expect(await screen.findByText("claude-opus-5")).toBeInTheDocument();
    await waitFor(() => expect(api.agents.retrieve).toHaveBeenCalled());
    expect(screen.queryByText(/^Создан /)).toBeNull();
  });
});

describe("EnvironmentChip", () => {
  const environment = {
    id: "env_01ZXCVBNM",
    name: "qwe",
    scope: "organization" as const,
    config: { type: "cloud" as const },
    created_at: new Date(Date.now() - 14 * 3_600_000).toISOString(),
  };

  it("рисует имя окружения ссылкой на его страницу", () => {
    renderInRouter(<EnvironmentChip id="env_01ZXCVBNM" environment={environment} />);

    expect(screen.getByRole("link", { name: /qwe/ })).toHaveAttribute(
      "href",
      "/environments/env_01ZXCVBNM",
    );
  });

  it("при наведении показывает тип, область и возраст", async () => {
    renderInRouter(<EnvironmentChip id="env_01ZXCVBNM" environment={environment} />);

    await userEvent.hover(screen.getByRole("link", { name: /qwe/ }));

    expect(await screen.findByText("Окружение")).toBeInTheDocument();
    expect(screen.getByText("env_01ZX…BNM")).toBeInTheDocument();
    expect(screen.getByText("Тип")).toBeInTheDocument();
    expect(screen.getByText("Облако")).toBeInTheDocument();
    expect(screen.getByText("Область")).toBeInTheDocument();
    expect(screen.getByText("Организация")).toBeInTheDocument();
    expect(screen.getByText("Создано")).toBeInTheDocument();
    expect(screen.getByText("14 ч назад")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Открыть/ })).toHaveAttribute(
      "href",
      "/environments/env_01ZXCVBNM",
    );
  });

  it("пока окружение не загрузилось, подписывает чип коротким id", () => {
    renderInRouter(<EnvironmentChip id="env_01ZXCVBNM" environment={null} />);

    expect(screen.getByRole("link", { name: /env_01ZX…BNM/ })).toHaveAttribute(
      "href",
      "/environments/env_01ZXCVBNM",
    );
  });

  it("своя инфраструктура и личная область называются по-русски", async () => {
    renderInRouter(
      <EnvironmentChip
        id="env_2"
        environment={{
          ...environment,
          scope: "account",
          config: { type: "self_hosted" },
        }}
      />,
    );

    await userEvent.hover(screen.getByRole("link", { name: /qwe/ }));

    expect(await screen.findByText("Свой сервер")).toBeInTheDocument();
    expect(screen.getByText("Личная")).toBeInTheDocument();
  });
});

describe("VaultChip", () => {
  it("называет хранилище по имени и ведёт на его страницу", () => {
    renderInRouter(<VaultChip vault={{ id: "vlt_1", name: "Ключи прод" }} />);

    expect(screen.getByRole("link", { name: /Ключи прод/ })).toHaveAttribute("href", "/vaults/vlt_1");
  });

  it("без имени берёт короткий id", () => {
    renderInRouter(<VaultChip vault={{ id: "vlt_0123456789ABC" }} />);

    expect(screen.getByRole("link", { name: /vlt_0123…ABC/ })).toHaveAttribute(
      "href",
      "/vaults/vlt_0123456789ABC",
    );
  });
});
