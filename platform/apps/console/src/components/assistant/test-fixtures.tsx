import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";

import { server } from "../../mocks/server";
import type { ThreadItem } from "../../lib/assistant/events";

/** Общие подставные данные для тестов карточек ассистента. */

export type ProposalItem = Extract<ThreadItem, { kind: "proposal" }>;

export function proposalItem(over: Partial<ProposalItem> & { tool: string }): ProposalItem {
  return { kind: "proposal", id: "tu_1", input: {}, phase: "pending", ...over };
}

export function renderInRouter(ui: ReactElement, initialEntries: string[] = ["/"]) {
  return render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>);
}

export interface PlatformMcpMock {
  previews: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
}

/**
 * Подставной сервер: `previews` отдаются по очереди (последний повторяется),
 * `decide` решает, что ответит `confirm`.
 */
export function mockPlatformMcp(
  previews: Array<Record<string, unknown> | { status: number; body: unknown }>,
  decide: (body: Record<string, unknown>) => { status: number; body: unknown } = () => ({ status: 200, body: {} }),
): PlatformMcpMock {
  const seen: PlatformMcpMock = { previews: [], decisions: [] };
  let i = 0;
  server.use(
    http.post("*/v1/oma/platform-mcp/preview", async ({ request }) => {
      seen.previews.push((await request.json()) as Record<string, unknown>);
      const next = previews[Math.min(i, previews.length - 1)];
      i += 1;
      if ("status" in next && "body" in next && typeof next.status === "number") {
        return HttpResponse.json(next.body as object, { status: next.status });
      }
      return HttpResponse.json(next);
    }),
    http.post("*/v1/oma/platform-mcp/confirm", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      seen.decisions.push(body);
      const out = decide(body);
      return HttpResponse.json(out.body as object, { status: out.status });
    }),
  );
  return seen;
}

export function errorBody(type: string, message = "x") {
  return { type: "error", error: { type, message } };
}

export const AGENT_EDIT_PREVIEW = {
  tool: "update_agent",
  preview_digest: "d1",
  can_confirm: true,
  operations: [
    {
      index: 0,
      tool: "update_agent",
      kind: "agent",
      target_id: "agent_1",
      name: "Сводка PR",
      class: "edit",
      version_from: 3,
      version_to: 4,
      before_yaml: "name: Сводка PR\nsystem: старый промпт\nmodel: qwen\n",
      after_yaml: "name: Сводка PR\nsystem: новый промпт\nmodel: qwen\n",
      warnings: [],
    },
  ],
};

export const SKILL_CREATE_PREVIEW = {
  tool: "create_skill",
  preview_digest: "s1",
  can_confirm: true,
  operations: [
    {
      index: 0,
      tool: "create_skill",
      kind: "skill",
      name: "Навык PR",
      class: "create",
      before_yaml: null,
      after_yaml: "display_title: Навык PR\nfiles:\n  - path: SKILL.md\n",
      warnings: ["Навык получит доступ к окружению «Песок»"],
      access: ["окружение «Песок»", "файлы: 2"],
    },
  ],
};
