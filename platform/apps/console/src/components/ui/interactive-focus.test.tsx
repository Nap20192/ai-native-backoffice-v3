import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./badge";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

describe("interactive control focus treatment", () => {
  it("keeps text-link buttons unboxed while preserving keyboard focus", () => {
    render(<Button variant="link">Forgot password?</Button>);

    const linkButton = screen.getByRole("button", {
      name: "Forgot password?",
    });
    expect(linkButton).toHaveClass("focus-visible:underline");
    expect(linkButton.className).not.toContain("outline-none");
    expect(linkButton.className).not.toContain("focus-visible:ring-3");
  });

  it("leaves the focus ring of shared controls to the single global :focus-visible rule", () => {
    render(
      <>
        <Button>Save</Button>
        <Checkbox aria-label="Enabled" />
        <RadioGroup>
          <RadioGroupItem value="one" aria-label="Option one" />
        </RadioGroup>
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">Tab one</TabsTrigger>
          </TabsList>
        </Tabs>
        <Badge asChild>
          <a href="#badge">Badge link</a>
        </Badge>
      </>,
    );

    const controls = [
      screen.getByRole("button", { name: "Save" }),
      screen.getByRole("checkbox", { name: "Enabled" }),
      screen.getByRole("radio", { name: "Option one" }),
      screen.getByRole("tab", { name: "Tab one" }),
      screen.getByRole("link", { name: "Badge link" }),
    ];

    for (const control of controls) {
      expect(control).not.toBeNull();
      // outline-none / outline-hidden would hide the global DDC ring.
      expect(control?.className).not.toContain("outline-none");
      expect(control?.className).not.toContain("outline-hidden");
      expect(control?.className).not.toContain("focus-visible:ring-3");
      expect(control?.className).not.toContain("focus-visible:ring-[3px]");
    }
  });

  it("selects the active tab through the Radix data-state attribute", () => {
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">Tab one</TabsTrigger>
        </TabsList>
      </Tabs>,
    );

    const tab = screen.getByRole("tab", { name: "Tab one" });
    expect(tab).toHaveAttribute("data-state", "active");
    expect(tab.className).toContain("data-[state=active]:bg-ddc-selected-bg");
    expect(tab.className).toContain("data-[state=active]:text-ddc-selected-text");
  });
});
