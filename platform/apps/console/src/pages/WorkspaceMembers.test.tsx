import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { WorkspaceMembers, JoinWorkspace } from "./WorkspaceMembers";
const state = vi.hoisted(() => ({
  role: "owner",
  failRemove: false,
  forbidMembers: false,
  acceptHeader: undefined as string | undefined,
  calls: [] as string[],
}));
vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.role = "owner";
  state.failRemove = false;
  state.forbidMembers = false;
  state.calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      state.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "DELETE" && state.failRemove)
        return Response.json({ error: "Removal failed" }, { status: 409 });
      if (path.endsWith("/me"))
        return Response.json({ tenant: { id: "t", name: "Team" } });
      if (path.endsWith("/members") && state.forbidMembers)
        return Response.json(
          { type: "error", error: { type: "permission_error", message: "Insufficient workspace permissions" } },
          { status: 403 },
        );
      if (path.endsWith("/members"))
        return Response.json({
          role: state.role,
          user_id: "u",
          data: [
            {
              user_id: "u",
              name: "Alice",
              email: "alice@test.dev",
              role: state.role,
            },
            { user_id: "b", name: "Bob", role: "member" },
          ],
        });
      if (path.endsWith("/invitations") && init?.method === "POST")
        return Response.json({
          token: "secret",
          id: "inv",
          expires_at: Date.now() + 1000,
        });
      if (path.endsWith("/accept"))
        state.acceptHeader = (init?.headers as Record<string, string>)?.[
          "x-active-tenant"
        ];
      if (path.endsWith("/accept"))
        return Response.json({ error: "Invitation expired" }, { status: 410 });
      return Response.json({ data: [] });
    }),
  );
});
function show(element: React.ReactNode, path = "/members") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>{element}</I18nProvider>
    </MemoryRouter>,
  );
}
it("shows identities and creates a shareable invitation", async () => {
  show(<WorkspaceMembers />);
  expect(await screen.findByText("Alice")).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Создать ссылку-приглашение" }),
  );
  expect(
    ((await screen.findByLabelText("Ссылка-приглашение")) as HTMLInputElement)
      .value,
  ).toContain("/join#secret");
});
it("renders the members page in Russian with a page header and role labels", async () => {
  show(<WorkspaceMembers />);
  expect(
    await screen.findByRole("heading", { level: 1, name: "Участники" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/Team · Кто имеет доступ/)).toBeInTheDocument();
  expect(screen.getByText("Владелец")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Создать ссылку-приглашение" }),
  ).toBeInTheDocument();
});

it("hides membership management for ordinary members", async () => {
  state.role = "member";
  show(<WorkspaceMembers />);
  await screen.findByText("Alice");
  expect(
    screen.queryByRole("button", { name: "Создать ссылку-приглашение" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Удалить Bob" }),
  ).not.toBeInTheDocument();
});
it("keeps failed invitation acceptance actionable", async () => {
  show(<JoinWorkspace />, "/join#expired");
  await userEvent.click(
    await screen.findByRole("button", { name: "Присоединиться к рабочему пространству" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Срок действия приглашения истёк",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Присоединиться к рабочему пространству" }),
    ).toBeEnabled(),
  );
});

it("shows removal failures inside the confirmation dialog", async () => {
  state.failRemove = true;
  show(<WorkspaceMembers />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Удалить Bob" }),
  );
  const dialog = screen.getByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Конфликт: запись уже существует или была изменена.",
  );
});

it("accepts invitations independently of a stale active workspace", async () => {
  localStorage.setItem("oma_active_tenant_id", "removed-workspace");
  show(<JoinWorkspace />, "/join#expired");
  await userEvent.click(
    await screen.findByRole("button", { name: "Присоединиться к рабочему пространству" }),
  );
  await screen.findByRole("alert");
  expect(state.acceptHeader).toBe("");
  localStorage.removeItem("oma_active_tenant_id");
});

it("reports a failed page load once, in Russian, with a retry button and no toast", async () => {
  state.forbidMembers = true;
  const toastError = vi.spyOn(toast, "error");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  show(<WorkspaceMembers />);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Недостаточно прав в рабочем пространстве.");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByText(/Insufficient workspace permissions/)).not.toBeInTheDocument();
  expect(screen.getByText("Не удалось загрузить участников")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
  expect(toastError).not.toHaveBeenCalled();

  state.forbidMembers = false;
  await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Alice")).toBeInTheDocument();
});
