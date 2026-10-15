import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { parseBranding, resetBrandingForTests } from "../lib/branding";
import { Logo } from "./Logo";

afterEach(() => resetBrandingForTests());

describe("Logo", () => {
  it("draws nothing when the deployment has no logo", () => {
    expect(renderToStaticMarkup(<Logo />)).toBe("");
    expect(renderToStaticMarkup(<Logo size="lg" className="mx-auto" />)).toBe("");
  });

  it("does not draw the OpenMA mark in any size", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const markup = renderToStaticMarkup(<Logo size={size} />);
      expect(markup).not.toContain("<svg");
      expect(markup).not.toContain("<path");
      expect(markup).not.toMatch(/openma/i);
    }
  });

  it("shows the logo image the deployment supplies", () => {
    resetBrandingForTests(
      parseBranding({ product_name: "Acme Agents", logo_url: "/branding/logo.svg" }),
    );
    const markup = renderToStaticMarkup(<Logo size="lg" className="mx-auto" />);

    expect(markup).toContain('src="/branding/logo.svg"');
    expect(markup).toContain('alt="Acme Agents"');
    expect(markup).toContain("mx-auto");
    expect(markup).not.toContain("<svg");
  });

  it("switches between the light and dark logo when both are supplied", () => {
    resetBrandingForTests(
      parseBranding({
        product_name: "Acme Agents",
        logo_url: "/branding/logo.svg",
        logo_dark_url: "/branding/logo-dark.svg",
      }),
    );
    const markup = renderToStaticMarkup(<Logo />);

    expect(markup).toContain('src="/branding/logo.svg"');
    expect(markup).toContain('src="/branding/logo-dark.svg"');
    expect(markup.match(/<img/g)).toHaveLength(2);
  });
});
