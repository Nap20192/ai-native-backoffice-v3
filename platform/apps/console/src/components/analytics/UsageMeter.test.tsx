import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageMeter } from "./UsageMeter";

const LABEL = "Claude Sonnet 4.6, токены на входе, пиковая загрузка";

describe("UsageMeter", () => {
  it("рисует role=meter с границами 0..100 и подписью для скринридера", () => {
    render(<UsageMeter ratio={0.04} label={LABEL} />);
    const meter = screen.getByRole("meter", { name: LABEL });
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(meter).toHaveAttribute("aria-valuenow", "4");
  });

  it("до 80 % заливка brand-600", () => {
    render(<UsageMeter ratio={0.79} label={LABEL} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-level", "ok");
    expect(meter.firstElementChild).toHaveClass("bg-brand-600");
    expect(meter.firstElementChild).toHaveStyle({ width: "79%" });
  });

  it("от 80 % заливка amber-500", () => {
    render(<UsageMeter ratio={0.8} label={LABEL} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-level", "warning");
    expect(meter.firstElementChild).toHaveClass("bg-amber-500");
  });

  it("от 100 % заливка rose-500, а значение не выходит за 100", () => {
    render(<UsageMeter ratio={1.35} label={LABEL} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("data-level", "full");
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter.firstElementChild).toHaveClass("bg-rose-500");
    expect(meter.firstElementChild).toHaveStyle({ width: "100%" });
  });

  it("дорожка ink-100, малое значение остаётся видимым пятном", () => {
    render(<UsageMeter ratio={0.001} label={LABEL} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveClass("bg-ink-100");
    expect(meter.firstElementChild).toHaveClass("min-w-1");
  });

  it("нулевая загрузка без пятна", () => {
    render(<UsageMeter ratio={0} label={LABEL} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(meter.firstElementChild).not.toHaveClass("min-w-1");
  });
});
