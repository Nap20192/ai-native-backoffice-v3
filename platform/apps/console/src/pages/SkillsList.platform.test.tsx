import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zipSync } from "fflate";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { SkillsList } from "./SkillsList";

const PLATFORM_SKILL = {
  type: "skill",
  id: "docx",
  display_title: "Word (docx)",
  source: "anthropic",
  latest_version: "3f9a1c2b4d5e",
  created_at: "2026-10-16T12:00:00.000Z",
  updated_at: "2026-10-16T12:00:00.000Z",
};
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
  retrieve: vi.fn(),
  list: vi.fn(),
  download: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [PLATFORM_SKILL, CUSTOM_SKILL],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    error: null,
  }),
}));
vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => ({
    skills: {
      delete: managed.remove,
      versions: { retrieve: managed.retrieve, list: managed.list, download: managed.download },
    },
  }),
}));

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

beforeEach(() => {
  managed.retrieve.mockResolvedValue({
    type: "skill_version",
    id: "skv_builtin_docx_3f9a1c2b4d5e",
    skill_id: "docx",
    name: "docx",
    description: "Create, read, edit Word files.",
    directory: "docx",
    version: "3f9a1c2b4d5e",
    created_at: "2026-10-16T12:00:00.000Z",
  });
  managed.list.mockResolvedValue({
    data: [{ version: "3f9a1c2b4d5e", created_at: "2026-10-16T12:00:00.000Z" }],
  });
  const zip = zipSync({
    "docx/SKILL.md": Uint8Array.from(new TextEncoder().encode("---\nname: docx\n---\nSKILL_BODY_MARK\n")),
    "docx/scripts/docx_create.py": Uint8Array.from(new TextEncoder().encode("print('ok')\n")),
  });
  managed.download.mockResolvedValue(new Response(zip as Uint8Array<ArrayBuffer>));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Not found" }, { status: 404 })),
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

function rowOf(text: string): HTMLElement {
  return screen.getByText(text).closest("tr") as HTMLElement;
}

describe("SkillsList platform skills", () => {
  it("uses the Claude console columns and marks platform skills", async () => {
    show();
    await screen.findByText("Word (docx)");
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
    expect(headers).toEqual(
      expect.arrayContaining(["ID", "Имя", "Источник", "Последняя версия", "Обновлено"]),
    );

    const platform = rowOf("Word (docx)");
    expect(within(platform).getByText("docx")).toBeInTheDocument();
    expect(within(platform).getByText("Платформа")).toBeInTheDocument();
    expect(within(platform).getByText("3f9a1c2b4d5e")).toBeInTheDocument();
    expect(within(platform).getByText("16.10.2026")).toBeInTheDocument();

    const custom = rowOf("code-review");
    expect(within(custom).getByText("Пользовательский")).toBeInTheDocument();
    expect(within(custom).getByText("02.10.2026")).toBeInTheDocument();
  });

  it("shows the ID column even when a saved layout hid the generic id column", async () => {
    localStorage.setItem("dt-cols:v2:/", JSON.stringify({ id: false }));
    try {
      show();
      await screen.findByText("Word (docx)");
      expect(screen.getByRole("columnheader", { name: "ID" })).toBeInTheDocument();
    } finally {
      localStorage.removeItem("dt-cols:v2:/");
    }
  });

  it("offers row actions for workspace skills only", async () => {
    show();
    await screen.findByText("Word (docx)");
    expect(rowOf("Word (docx)")).not.toHaveAttribute("data-context-menu");
    expect(rowOf("code-review")).toHaveAttribute("data-context-menu", "true");
  });

  it("filters by the Платформа source", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: /Источник/ }));
    expect(await screen.findByRole("option", { name: "Платформа" })).toBeInTheDocument();
  });

  it("opens a platform skill read-only, with attach snippet and archive files", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByText("Word (docx)"));
    const dialog = await screen.findByRole("dialog");

    expect(await within(dialog).findByText("SKILL.md")).toBeInTheDocument();
    expect(within(dialog).getByText(/SKILL_BODY_MARK/)).toBeInTheDocument();
    expect(within(dialog).getByText("scripts/docx_create.py")).toBeInTheDocument();
    expect(managed.download).toHaveBeenCalledWith("3f9a1c2b4d5e", { skill_id: "docx" });

    expect(within(dialog).getByText(/Встроенный навык платформы/)).toBeInTheDocument();
    expect(within(dialog).getByText(/"type": "anthropic", "skill_id": "docx"/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Новая версия" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });
});
