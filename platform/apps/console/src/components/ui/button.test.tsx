import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";

describe("<Button />", () => {
  it("renders children", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("fires onClick on user interaction", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("suppresses clicks when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disables itself and sets aria-busy while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("swaps children for loadingLabel when loading", () => {
    render(
      <Button loading loadingLabel="Saving…">
        Save
      </Button>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Saving…");
    expect(screen.queryByText("Save")).not.toBeInTheDocument();
  });

  it("keeps the label and shows a spinner in place of the icon while busy", () => {
    render(
      <Button loading>
        <svg data-testid="own-icon" />
        Save
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Save");
    expect(within(button).getByRole("status", { name: "Загрузка" })).toBeInTheDocument();
    expect(button.className).toContain("[&>svg:not([data-slot=spinner])]:hidden");
  });

  it("takes its height from the size so controls of one row match (40 / 36 / 32 / 44)", () => {
    render(
      <>
        <Button size="lg">Large</Button>
        <Button>Default</Button>
        <Button size="sm">Small</Button>
        <Button size="xs">Dense</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Large" })).toHaveClass("h-11");
    expect(screen.getByRole("button", { name: "Default" })).toHaveClass("h-10");
    expect(screen.getByRole("button", { name: "Small" })).toHaveClass("h-9");
    expect(screen.getByRole("button", { name: "Dense" })).toHaveClass("h-8");
  });

  it("paints variants with the DDC semantic tokens", () => {
    render(
      <>
        <Button>Primary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Danger</Button>
        <Button variant="danger-ghost">Remove</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Primary" })).toHaveClass(
      "bg-ddc-primary",
      "text-ddc-on-primary",
    );
    expect(screen.getByRole("button", { name: "Outline" })).toHaveClass(
      "border-ddc-border-strong",
      "bg-ddc-outline-bg",
    );
    expect(screen.getByRole("button", { name: "Ghost" })).toHaveClass("text-ddc-ghost-text");
    expect(screen.getByRole("button", { name: "Danger" })).toHaveClass("bg-ddc-danger", "text-white");
    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass("text-ddc-danger-text");
  });

  it("does not hide the global focus ring", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).className).not.toContain("outline-none");
  });
});
