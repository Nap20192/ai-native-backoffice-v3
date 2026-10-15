import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

describe("table head follows the DDC .th", () => {
  it("is muted, semibold, uppercase 12px with wide tracking, not dark body text", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Название</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Документовед</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const head = screen.getByRole("columnheader", { name: "Название" });
    expect(head).toHaveClass(
      "text-xs",
      "font-semibold",
      "uppercase",
      "tracking-wider",
      "text-ddc-text-muted",
    );
    expect(head.className).not.toContain("text-foreground");
    expect(head.className).not.toContain("font-medium");
  });

  it("paints list column labels explicitly so no utility on the cell can darken them", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(styles).toMatch(
      /\.console-data-head th\s*\{[^}]*color: var\(--fg-subtle\);[^}]*font-weight: 600;/,
    );
  });
});
