import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Outlet, RouterProvider, createMemoryRouter, type UIMatch } from "react-router";

import { AppBreadcrumb } from "../components/AppBreadcrumb";
import { I18nProvider } from "../i18n";
import { crumbName, setCrumbName, useCrumbName } from "./crumb-names";

const AGENT_ID = "agent_TBrG-CIn0FodxFzdjDJlg";

function AgentPage({ loaded }: { loaded: boolean }) {
  useCrumbName(AGENT_ID, loaded ? "Документовед" : undefined);
  return <div>Страница агента</div>;
}

function Shell() {
  return (
    <>
      <AppBreadcrumb />
      <Outlet />
    </>
  );
}

function renderAgent(loaded: boolean) {
  const router = createMemoryRouter(
    [
      {
        path: "agents",
        element: <Shell />,
        handle: { crumb: "Агенты" },
        children: [
          {
            path: ":id",
            element: <AgentPage loaded={loaded} />,
            handle: { crumb: (m: UIMatch) => crumbName(m.params.id, "Агент") },
          },
        ],
      },
    ],
    { initialEntries: [`/agents/${AGENT_ID}`] },
  );
  return act(async () => {
    render(
      <I18nProvider>
        <RouterProvider router={router} />
      </I18nProvider>,
    );
  });
}

describe("breadcrumb names", () => {
  it("falls back to the word for the record type, never to the raw id", () => {
    expect(crumbName("agent_unknown", "Агент")).toBe("Агент");
    expect(crumbName(undefined, "Агент")).toBe("Агент");
    setCrumbName("agent_known", "Помощник проекта");
    expect(crumbName("agent_known", "Агент")).toBe("Помощник проекта");
  });

  it("shows the record name in the last crumb once the page has loaded it", async () => {
    await renderAgent(true);

    expect(screen.getByText("Документовед")).toBeInTheDocument();
    expect(screen.queryByText(AGENT_ID)).toBeNull();
  });
});
