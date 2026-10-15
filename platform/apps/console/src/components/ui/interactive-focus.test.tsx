import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";
import { Badge } from "./badge";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { RadioGroup, RadioGroupItem } from "./radio-group";
import { ScrollArea } from "./scroll-area";
import {
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
} from "./sidebar";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

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
        <Accordion type="single" collapsible>
          <AccordionItem value="one">
            <AccordionTrigger>Section one</AccordionTrigger>
            <AccordionContent>Contents</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Badge asChild>
          <a href="#badge">Badge link</a>
        </Badge>
        <ScrollArea className="size-20">Scrollable contents</ScrollArea>
      </>,
    );

    const controls = [
      screen.getByRole("button", { name: "Save" }),
      screen.getByRole("checkbox", { name: "Enabled" }),
      screen.getByRole("radio", { name: "Option one" }),
      screen.getByRole("tab", { name: "Tab one" }),
      screen.getByRole("button", { name: /Section one/ }),
      screen.getByRole("link", { name: "Badge link" }),
      document.querySelector('[data-slot="scroll-area-viewport"]'),
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

  it("keeps sidebar navigation focus to the same one-pixel treatment", () => {
    render(
      <SidebarProvider>
        <SidebarGroupLabel asChild>
          <button type="button">Group label</button>
        </SidebarGroupLabel>
        <SidebarGroupAction aria-label="Group action" />
        <SidebarMenuButton>Menu item</SidebarMenuButton>
        <SidebarMenuAction aria-label="Menu action" />
        <SidebarMenuSubButton href="#sub-item">
          Sub item
        </SidebarMenuSubButton>
      </SidebarProvider>,
    );

    for (const control of [
      screen.getByRole("button", { name: "Group label" }),
      screen.getByRole("button", { name: "Group action" }),
      screen.getByRole("button", { name: "Menu item" }),
      screen.getByRole("button", { name: "Menu action" }),
      screen.getByRole("link", { name: "Sub item" }),
    ]) {
      expect(control.className).toContain("focus-visible:ring-1");
      expect(control.className).not.toContain("focus-visible:ring-2");
    }
  });
});
