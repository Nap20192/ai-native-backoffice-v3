import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";
import { Input } from "./input";
import { InputGroup, InputGroupInput } from "./input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { Textarea } from "./textarea";

function renderControls() {
  return render(
    <>
      <Input aria-label="Email" />
      <Textarea aria-label="Notes" />
      <Select defaultValue="one">
        <SelectTrigger aria-label="Choice">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>
      <InputGroup>
        <InputGroupInput aria-label="Search" />
      </InputGroup>
    </>,
  );
}

describe("form control focus treatment", () => {
  it("draws the DDC two-pixel brand ring instead of the heavy three-pixel ring", () => {
    renderControls();

    for (const control of [
      screen.getByRole("textbox", { name: "Email" }),
      screen.getByRole("textbox", { name: "Notes" }),
      screen.getByRole("combobox", { name: "Choice" }),
    ]) {
      expect(control.className).toContain("focus-visible:ring-2");
      expect(control.className).toContain("focus-visible:border-ddc-ring");
      expect(control.className).toContain("focus-visible:ring-ddc-ring/30");
      expect(control.className).not.toContain("focus-visible:ring-3");
    }

    const inputGroup = screen
      .getByRole("textbox", { name: "Search" })
      .closest('[data-slot="input-group"]');
    expect(inputGroup).toHaveClass(
      "has-[[data-slot=input-group-control]:focus-visible]:ring-2",
    );
    expect(inputGroup?.className).not.toContain(
      "has-[[data-slot=input-group-control]:focus-visible]:ring-3",
    );
  });

  it("marks invalid fields with the DDC rose border instead of a destructive ring", () => {
    render(<Input aria-label="Email" aria-invalid="true" />);

    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input.className).toContain("aria-invalid:border-rose-400");
    expect(input.className).toContain("aria-invalid:focus-visible:ring-rose-500/30");
    expect(input.className).not.toContain("aria-invalid:ring-3");
  });

  it("keeps controls of one row the same 40px height", () => {
    renderControls();
    render(<Button>Save</Button>);

    expect(screen.getByRole("textbox", { name: "Email" })).toHaveClass("h-10");
    expect(screen.getByRole("combobox", { name: "Choice" }).className).toContain(
      "data-[size=default]:h-10",
    );
    expect(
      screen.getByRole("textbox", { name: "Search" }).closest('[data-slot="input-group"]'),
    ).toHaveClass("h-10");
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("h-10");
  });

  it("leaves a single global focus ring and does not override it in the base layer", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/ddc-tokens.css"), "utf8");
    const index = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

    expect(tokens).toMatch(
      /:focus-visible\s*\{[^}]*outline: 2px solid var\(--ddc-ring\);[^}]*outline-offset: 2px;/,
    );
    expect(index).not.toMatch(/\*:focus-visible/);
  });
});
