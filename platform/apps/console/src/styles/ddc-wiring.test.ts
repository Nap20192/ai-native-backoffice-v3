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

describe("фон оболочки по разделу 2.4 DDC", () => {
  const shell = read("styles/console-shell.css");
  const tokens = read("styles/ddc-tokens.css");
  const index = read("index.css");

  it("несёт зелёный фон #EEF6F2 и два пятна brand в светлой теме, почти чёрный с пятнами в тёмной", () => {
    expect(tokens).toMatch(/:root\s*\{[^}]*--ddc-shell: #eef6f2;/);
    expect(tokens).toMatch(/:root\s*\{[^}]*--ddc-shell-glow-1: rgb\(110 205 171 \/ 0\.3\);/);
    expect(tokens).toMatch(/:root\s*\{[^}]*--ddc-shell-glow-2: rgb\(24 154 114 \/ 0\.14\);/);
    expect(tokens).toMatch(/\.dark\s*\{[^}]*--ddc-shell: #070a0e;/);
    expect(tokens).toMatch(/\.dark\s*\{[^}]*--ddc-shell-glow-1: rgb\(24 154 114 \/ 0\.12\);/);
    expect(tokens).toMatch(/\.dark\s*\{[^}]*--ddc-shell-glow-2: rgb\(0 128 94 \/ 0\.12\);/);
  });

  it("утилита ddc-app-shell красит фон цветом оболочки и двумя радиальными пятнами", () => {
    const rule = tokens.match(/@utility ddc-app-shell\s*\{[^}]*\}/)?.[0] ?? "";

    expect(rule).toContain("background-color: var(--ddc-shell);");
    expect(rule).toContain("radial-gradient(1100px 560px at 8% -12%, var(--ddc-shell-glow-1), transparent 62%)");
    expect(rule).toContain("radial-gradient(900px 520px at 100% 0%, var(--ddc-shell-glow-2), transparent 60%)");
  });

  it("корень консоли получает утилиту, а .console-shell не перекрывает её своим фоном", () => {
    const rule = shell.match(/\.console-shell\s*\{[^}]*\}/)?.[0] ?? "";
    const component = read("components/ConsoleShell.tsx");

    expect(component).toMatch(/className="console-shell ddc-app-shell"/);
    expect(rule).not.toMatch(/background(-color|-image)?:/);
  });

  it("при печати оболочка белая, без тонировки и пятен", () => {
    const print = index.slice(index.indexOf("@media print"));

    expect(print).toContain("--ddc-shell: #ffffff;");
    expect(print).toContain("--ddc-shell-glow-1: transparent;");
    expect(print).toContain("--ddc-shell-glow-2: transparent;");
  });

  it("не оставляет в стилях записи об отступлении от фона оболочки", () => {
    for (const [name, css] of [
      ["styles/ddc-tokens.css", tokens],
      ["styles/console-shell.css", shell],
      ["styles/console-list.css", read("styles/console-list.css")],
    ] as const) {
      expect(css, name).not.toMatch(/отступлени/i);
      expect(css, name).not.toMatch(/нейтральн\w* (холст|фон)/i);
      expect(css, name).not.toMatch(/без тонировки/i);
    }
  });
});
