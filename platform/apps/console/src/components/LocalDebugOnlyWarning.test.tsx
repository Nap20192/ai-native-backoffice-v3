import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { LocalDebugOnlyWarning } from "./LocalDebugOnlyWarning";

describe("LocalDebugOnlyWarning", () => {
  it("makes the direct-host credential boundary explicit", () => {
    render(<LocalDebugOnlyWarning />);

    expect(screen.getByRole("note", { name: "Только для локальной отладки" })).toBeInTheDocument();
    expect(screen.getByText(/Только для локальной отладки, высокий риск/)).toBeInTheDocument();
    const warning = screen.getByRole("note", { name: "Только для локальной отладки" });
    expect(warning).toHaveTextContent(/никогда не копируйте.*auth\.json.*токены OAuth/i);
    expect(warning).toHaveTextContent(/удалённые и управляемые песочницы/i);
    expect(warning).toHaveTextContent(/не подходят для рабочей среды/i);
  });
});
