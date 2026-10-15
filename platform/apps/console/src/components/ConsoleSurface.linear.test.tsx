import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ConsolePanel, DashboardLayout, KpiCard } from "./ConsoleSurface";

describe("console page surfaces", () => {
  it("keeps dashboard intro, KPI row, and activity grid in stable slots", () => {
    render(
      <DashboardLayout
        intro={<h1>Operations</h1>}
        kpis={<KpiCard label="Agents" value={12} onClick={() => undefined} />}
      >
        <ConsolePanel title="Recent sessions">Activity</ConsolePanel>
      </DashboardLayout>,
    );

    const layout = screen.getByTestId("dashboard-layout");
    const slots = Array.from(layout.children).map((node) => node.getAttribute("data-dashboard-slot"));
    expect(slots).toEqual(["intro", "kpis", "activity"]);
    expect(within(layout).getByRole("button", { name: /Agents/i })).toHaveTextContent("12");
  });
  it("переносит длинную подпись KPI вместо обрезки многоточием", () => {
    render(
      <>
        <KpiCard label="Хранилища секретов" value={3} onClick={() => undefined} />
        <KpiCard compact label="Карточки моделей" value={6} onClick={() => undefined} />
      </>,
    );

    for (const name of ["Хранилища секретов", "Карточки моделей"]) {
      const label = screen.getByText(name);
      expect(label, name).toHaveClass("kpi-label");
      expect(label, name).toHaveClass("break-words");
      expect(label, name).not.toHaveClass("truncate");
      expect(label, name).not.toHaveAttribute("title");
    }
  });
});
