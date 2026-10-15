import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { Toaster } from "./sonner";

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ effective: "light" }),
}));

describe("Toaster presentation", () => {
  afterEach(() => {
    toast.dismiss();
  });

  it("expands notifications instead of rendering collapsed card shells", async () => {
    render(<Toaster />);
    toast.error("HTTP 500");

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toast]')).toHaveAttribute(
        "data-expanded",
        "true",
      );
    });
  });

  it("draws a white card with a coloured icon instead of a tinted rich-colour plate", async () => {
    render(<Toaster />);
    toast.error("HTTP 500");

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toast]')).not.toBeNull();
    });
    expect(document.querySelector('[data-sonner-toast]')).not.toHaveAttribute(
      "data-rich-colors",
      "true",
    );

    const toaster = document.querySelector<HTMLElement>(
      '[data-sonner-toaster]',
    );
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe("var(--bg)");
    expect(toaster?.style.getPropertyValue("--normal-text")).toBe("var(--fg)");
    expect(toaster?.style.getPropertyValue("--normal-border")).toBe("var(--border)");
    expect(toaster?.style.getPropertyValue("--error-bg")).toBe("");
    expect(toaster?.style.getPropertyValue("--error-text")).toBe("");
    expect(document.querySelector('[data-sonner-toast] svg')).toHaveClass("text-ddc-danger-text");
  });

  it("sits below the page header row: 9rem from the top, like the DDC portal", async () => {
    render(<Toaster />);
    toast.success("Сохранено");

    await waitFor(() => {
      expect(document.querySelector('[data-sonner-toaster]')).not.toBeNull();
    });
    const toaster = document.querySelector<HTMLElement>('[data-sonner-toaster]');
    expect(toaster?.style.getPropertyValue("--offset-top")).toBe("9rem");
  });
});
