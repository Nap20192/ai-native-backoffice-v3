import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zipSync } from "fflate";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { SkillsList } from "./SkillsList";

const CUSTOM_SKILL = {
  type: "skill",
  id: "skill_review",
  display_title: "code-review",
  source: "custom",
  latest_version: "1792068333531000",
  created_at: "2026-10-01T12:00:00.000Z",
  updated_at: "2026-10-02T12:00:00.000Z",
};

const managed = vi.hoisted(() => ({
  skills: {
    retrieve: vi.fn(),
    delete: vi.fn(),
    versions: { retrieve: vi.fn(), list: vi.fn(), download: vi.fn(), delete: vi.fn() },
  },
}));
const feed = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [CUSTOM_SKILL],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: feed.refresh,
    error: null,
  }),
}));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const TWO_VERSIONS = [
  { version: "1792068333531000", created_at: "2026-10-02T12:00:00.000Z" },
  { version: "1791000000000000", created_at: "2026-10-01T12:00:00.000Z" },
];

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };
let operations: string[];

beforeEach(() => {
  dependencies = { blocking: [], affected: [], truncated: false };
  operations = [];
  feed.refresh.mockReset();
  managed.skills.retrieve.mockReset().mockResolvedValue(CUSTOM_SKILL);
  managed.skills.delete.mockReset().mockResolvedValue({ id: "skill_review", type: "skill_deleted" });
  managed.skills.versions.delete.mockReset().mockResolvedValue({ id: "1791000000000000", type: "skill_version_deleted" });
  managed.skills.versions.retrieve.mockReset().mockResolvedValue({
    type: "skill_version",
    skill_id: "skill_review",
    name: "code-review",
    description: "Проверка кода",
    version: "1792068333531000",
    created_at: "2026-10-02T12:00:00.000Z",
  });
  managed.skills.versions.list.mockReset().mockResolvedValue({ data: TWO_VERSIONS });
  managed.skills.versions.download.mockReset().mockResolvedValue(
    new Response(zipSync({ "code-review/SKILL.md": Uint8Array.from(new TextEncoder().encode("---\nname: code-review\n---\n")) }) as Uint8Array<ArrayBuffer>),
  );
  server.use(
    http.get("*/v1/oma/dependencies/skill/:id", ({ request }) => {
      operations.push(`skill:${new URL(request.url).searchParams.get("operation")}`);
      return HttpResponse.json(dependencies);
    }),
    http.get("*/v1/oma/dependencies/skill_version/:id", ({ request }) => {
      const url = new URL(request.url);
      operations.push(`version:${url.searchParams.get("operation")}:${url.searchParams.get("version")}`);
      return HttpResponse.json(dependencies);
    }),
    http.get("*/v1/skills/:id", () => HttpResponse.json(CUSTOM_SKILL, { headers: { ETag: '"9"' } })),
    http.get("*/v1/oma/skills/:id/versions/:v", () => HttpResponse.json({ files: [] })),
  );
});

function show() {
  render(
    <MemoryRouter>
      <I18nProvider>
        <SkillsList />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("SkillsList: удаление навыка", () => {
  it("агент мешает удалению навыка: кнопка выключена", async () => {
    dependencies = {
      blocking: [{ kind: "agent", id: "agent_1", name: "Юрист", status: null, note: null }],
      affected: [],
      truncated: false,
    };
    show();
    await waitFor(() => {
      fireEvent.contextMenu(screen.getByText("code-review"));
      expect(screen.getByRole("menuitem", { name: "Удалить" })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("menuitem", { name: "Удалить" }));

    const dialog = await screen.findByRole("dialog", { name: "Удалить навык «code-review»?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(operations).toEqual(["skill:delete"]);
  });

  it("без зависимостей удаляет навык с If-Match из ETag", async () => {
    show();
    await waitFor(() => {
      fireEvent.contextMenu(screen.getByText("code-review"));
      expect(screen.getByRole("menuitem", { name: "Удалить" })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole("menuitem", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить навык «code-review»?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(managed.skills.delete).toHaveBeenCalledWith("skill_review", { ifMatch: '"9"' }));
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled());
  });
});

describe("SkillsList: удаление версии", () => {
  async function openVersions() {
    show();
    await userEvent.click(await screen.findByText("code-review"));
    return await screen.findByRole("dialog", { name: /code-review/ });
  }

  it("у каждой версии есть «Удалить версию», окно читает зависимости версии", async () => {
    const detail = await openVersions();

    await userEvent.click(await within(detail).findByRole("button", { name: "Удалить версию v1" }));

    const dialog = await screen.findByRole("dialog", { name: "Удалить версию v1?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    await waitFor(() => expect(operations).toEqual(["version:delete:1791000000000000"]));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() =>
      expect(managed.skills.versions.delete).toHaveBeenCalledWith(
        "1791000000000000",
        { skill_id: "skill_review" },
        { ifMatch: '"9"' },
      ),
    );
  });

  it("закреплённый агент мешает удалению версии", async () => {
    dependencies = {
      blocking: [{ kind: "agent", id: "agent_2", name: "Ревьюер", status: null, note: "закреплён на версии" }],
      affected: [],
      truncated: false,
    };
    const detail = await openVersions();

    await userEvent.click(await within(detail).findByRole("button", { name: "Удалить версию v1" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить версию v1?" });

    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("единственную версию удалить нельзя: подсказка «Удалите навык целиком»", async () => {
    managed.skills.versions.list.mockResolvedValue({ data: [TWO_VERSIONS[0]] });
    const detail = await openVersions();

    const button = await within(detail).findByRole("button", { name: "Удалить версию v1" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Это последняя версия. Удалите навык целиком.");
  });
});
