import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), "src", file), "utf8");

describe("DDC token wiring", () => {
  const index = read("index.css");
  const bridge = read("styles/ddc-bridge.css");

  it("imports the DDC tokens after the OpenMA brand tokens and the console tokens", () => {
    const order = [
      '@import "@openma/common/brand/tokens.css";',
      '@import "./styles/console-tokens.css";',
      '@import "./styles/ddc-tokens.css";',
      '@import "./styles/ddc-bridge.css";',
      '@import "./styles/ddc-components.css";',
      '@import "./styles/console-shell.css";',
    ].map((line) => index.indexOf(line));

    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts the brand scale on the DDC green and keeps primary independent of dark-theme brand text", () => {
    const tokens = read("styles/ddc-tokens.css");

    expect(tokens).toContain("--color-brand-600: #00805e;");
    expect(bridge).toContain("--brand: var(--ddc-link);");
    expect(bridge).toContain("--brand-subtle: var(--ddc-selected-bg);");
    expect(bridge).toContain("--ring: var(--ddc-ring);");
    expect(index).toContain("--color-primary: var(--ddc-primary);");
    expect(index).toContain("--color-ring: var(--ddc-ring);");
  });

  it("maps surfaces, text, borders and statuses onto the DDC roles in both themes", () => {
    for (const mapping of [
      "--bg: var(--ddc-surface);",
      "--bg-sidebar: var(--ddc-bg);",
      "--bg-surface: var(--ddc-surface-muted);",
      "--fg: var(--ddc-text);",
      "--fg-muted: var(--ddc-label);",
      "--fg-subtle: var(--ddc-text-muted);",
      "--border: var(--ddc-divider);",
      "--border-strong: var(--ddc-border-strong);",
      "--success: var(--ddc-success-text);",
      "--warning: var(--ddc-warning-text);",
      "--danger: var(--ddc-danger-text);",
      "--info: var(--ddc-tone-info-fg);",
    ]) {
      expect(bridge).toContain(mapping);
    }
    // One block serves both themes: the --ddc-* variables switch on `.dark`.
    expect(bridge).toMatch(/:root,\s*\.dark\s*\{/);
  });

  it("uses the DDC control heights, radii and type scale", () => {
    for (const token of [
      "--control-h: 40px;",
      "--chip-h: 40px;",
      "--menu-action-row-h: 36px;",
      "--console-radius-card: 16px;",
      "--console-radius-popover: 16px;",
      "--console-type-label: 12px;",
      "--console-type-body: 14px;",
      "--type-line: 20px;",
    ]) {
      expect(bridge).toContain(token);
    }
    expect(index).toContain("--text-sm: 0.875rem;");
    expect(index).toContain("--text-xs: 0.75rem;");
    expect(index).toContain("--radius: 0.75rem;");
  });

  it("uses the system font stack only, with no web fonts", () => {
    expect(read("styles/ddc-tokens.css")).toContain(
      '--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;',
    );
    expect(index).not.toContain("Geist");
    expect(index).not.toContain("Source Serif");
    expect(index).not.toContain("JetBrains");
  });

  it("keeps motion on regardless of prefers-reduced-motion (DDC rule 6)", () => {
    for (const file of [
      "index.css",
      "styles/console-list.css",
      "styles/console-pages.css",
      "styles/ddc-bridge.css",
      "styles/ddc-components.css",
    ]) {
      expect(read(file), file).not.toMatch(/@media\s*\(prefers-reduced-motion/);
    }
  });
});

describe("нейтральный холст страницы", () => {
  it("красит оболочку фоном body портала без тонировки и градиента", () => {
    const shell = read("styles/console-shell.css");
    const tokens = read("styles/ddc-tokens.css");
    const shellRule = shell.match(/\.console-shell\s*\{[^}]*\}/)?.[0] ?? "";

    expect(shellRule).toContain("background-color: var(--ddc-bg);");
    expect(shellRule).not.toContain("gradient");
    expect(tokens.match(/@utility ddc-app-shell\s*\{[^}]*\}/)?.[0] ?? "").not.toContain("gradient");
  });
});
