import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBranding, resetBrandingForTests } from "../lib/branding";
import { CliLogin } from "./CliLogin";

vi.mock("../lib/api", () => ({
  useApi: () => ({ api: vi.fn() }),
}));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: undefined, error: null, isLoading: false }),
}));

afterEach(() => resetBrandingForTests());

describe("CliLogin", () => {
  it("captions the page without the product name", () => {
    const { container } = render(<CliLogin />);

    expect(screen.getByRole("heading", { name: "Авторизация CLI" })).toBeInTheDocument();
    expect(screen.getByText("Клиент командной строки")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/openma/i);
    expect(container.querySelector("svg[viewBox='240 244 548 454']")).toBeNull();
  });

  it("shows the logo a deployment supplies", () => {
    resetBrandingForTests(
      parseBranding({ product_name: "Acme Agents", logo_url: "/branding/logo.svg" }),
    );
    render(<CliLogin />);

    expect(screen.getByRole("img", { name: "Acme Agents" })).toHaveAttribute("src", "/branding/logo.svg");
    expect(screen.getByText("Клиент командной строки")).toBeInTheDocument();
  });
});
