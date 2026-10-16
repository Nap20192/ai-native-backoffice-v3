import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { SessionProposalCard } from "./SessionProposalCard";
import { errorBody, mockPlatformMcp, proposalItem, renderInRouter } from "./test-fixtures";

const PREVIEW = {
  tool: "create_session",
  preview_digest: "se1",
  operations: [
    {
      index: 0,
      tool: "create_session",
      kind: "session",
      name: "Проверка",
      class: "create",
      after_yaml: "agent: agent_1\nenvironment_id: env_1\n",
    },
  ],
  session: {
    agent_id: "agent_1",
    agent_name: "Сводка PR",
    agent_version: 3,
    environment_id: "env_1",
    environment_name: "Песок",
    title: "Проверка",
    files: [{ file_id: "file_1", filename: "data.csv", mount_path: "/mnt/data.csv" }],
    tools: ["bash", "web_fetch"],
    mcp_servers: ["github"],
    skills: ["pdf"],
    network: "ограничена: pypi.org",
  },
};

describe("SessionProposalCard", () => {
  const item = proposalItem({ tool: "create_session" });

  it("показывает агента, окружение, название и файлы", async () => {
    mockPlatformMcp([PREVIEW]);
    renderInRouter(<SessionProposalCard item={item} sessionId="s1" />);
    expect(await screen.findByText("Создать сессию")).toBeInTheDocument();
    expect(screen.getByText("Сводка PR, версия 3")).toBeInTheDocument();
    expect(screen.getByText("Песок")).toBeInTheDocument();
    expect(screen.getByText("Проверка", { selector: "dd" })).toBeInTheDocument();
    const files = screen.getByRole("list", { name: "Файлы сессии" });
    expect(files.textContent).toBe("data.csv → /mnt/data.csv");
  });

  it("показывает, с чем сессия будет работать: инструменты, MCP, навыки, сеть", async () => {
    mockPlatformMcp([PREVIEW]);
    renderInRouter(<SessionProposalCard item={item} sessionId="s1" />);
    await screen.findByText("Создать сессию");
    expect(screen.getByText("bash, web_fetch")).toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("ограничена: pypi.org")).toBeInTheDocument();
  });

  it("предупреждает, что сессия пуста до первого сообщения", async () => {
    mockPlatformMcp([PREVIEW]);
    renderInRouter(<SessionProposalCard item={item} sessionId="s1" />);
    expect(
      await screen.findByText("Сессия создаётся пустой. Агент начнёт работу после первого сообщения"),
    ).toBeInTheDocument();
  });

  it("кнопка «Создать» шлёт отпечаток", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([PREVIEW]);
    renderInRouter(<SessionProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Создать" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ result: "allow", preview_digest: "se1" });
  });

  it("без данных о том, что получит сессия, не выдумывает их", async () => {
    mockPlatformMcp([{ ...PREVIEW, session: { ...PREVIEW.session, tools: [], mcp_servers: [], skills: [], network: null } }]);
    renderInRouter(<SessionProposalCard item={item} sessionId="s1" />);
    await screen.findByText("Создать сессию");
    expect(screen.getAllByText("нет")).toHaveLength(3);
    expect(screen.getByText("не указана")).toBeInTheDocument();
  });

  it("вне v1 (агент ассистент): кнопка выключена", async () => {
    const user = userEvent.setup();
    mockPlatformMcp([PREVIEW], () => ({ status: 409, body: errorBody("class") }));
    renderInRouter(<SessionProposalCard item={item} sessionId="s1" />);
    await user.click(await screen.findByRole("button", { name: "Создать" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });
});
