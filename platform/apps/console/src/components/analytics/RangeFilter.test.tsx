import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { RangeState } from "./analytics-params";
import { RangeFilter } from "./RangeFilter";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const NOW = new Date("2026-10-16T09:15:00.000Z");

function Host({ initial, onChange = vi.fn() }: { initial: RangeState; onChange?: (r: RangeState) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <RangeFilter
      value={value}
      now={NOW}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe("RangeFilter", () => {
  it("показывает выбранный период на кнопке", () => {
    render(<Host initial={{ kind: "preset", preset: "30d" }} />);
    expect(screen.getByRole("button", { name: "Период: 30 дней" })).toBeInTheDocument();
  });

  it("в меню пять пунктов, выбранный отмечен", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ kind: "preset", preset: "30d" }} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["С начала месяца", "7 дней", "30 дней", "Прошлый месяц", "Свой период"]);
    expect(screen.getByRole("option", { name: "30 дней" })).toHaveAttribute("aria-selected", "true");
  });

  it("выбор готового периода отдаёт его наверх и закрывает меню", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial={{ kind: "preset", preset: "30d" }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    await user.click(screen.getByRole("option", { name: "7 дней" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "preset", preset: "7d" });
    expect(screen.queryByRole("option", { name: "7 дней" })).toBeNull();
    expect(screen.getByRole("button", { name: "Период: 7 дней" })).toBeInTheDocument();
  });

  it("«Свой период» раскрывает два поля даты с текущим диапазоном", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ kind: "preset", preset: "7d" }} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    await user.click(screen.getByRole("option", { name: "Свой период" }));
    expect(screen.getByLabelText("С")).toHaveValue("2026-10-10");
    expect(screen.getByLabelText("По")).toHaveValue("2026-10-16");
  });

  it("верный свой период уходит наверх и попадает на кнопку", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial={{ kind: "preset", preset: "7d" }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    await user.click(screen.getByRole("option", { name: "Свой период" }));
    fireEvent.change(screen.getByLabelText("С"), { target: { value: "2026-10-01" } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "custom", from: "2026-10-01", to: "2026-10-16" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /^Период/ })).toHaveTextContent("с 1 окт. 2026 по 16 окт. 2026");
  });

  it("ошибка видна под полями, пока период неверный", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Host initial={{ kind: "preset", preset: "7d" }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    await user.click(screen.getByRole("option", { name: "Свой период" }));
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("С"), { target: { value: "2026-10-20" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Начало периода позже конца.");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("С"), { target: { value: "2026-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Период не больше 92 дней.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("свой период из адреса открывает меню сразу с полями", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ kind: "custom", from: "2026-10-01", to: "2026-10-05" }} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    expect(screen.getByLabelText("С")).toHaveValue("2026-10-01");
    expect(screen.getByLabelText("По")).toHaveValue("2026-10-05");
  });

  it("Escape закрывает меню", async () => {
    const user = userEvent.setup();
    render(<Host initial={{ kind: "preset", preset: "30d" }} />);
    await user.click(screen.getByRole("button", { name: /^Период/ }));
    expect(screen.getByRole("option", { name: "7 дней" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option", { name: "7 дней" })).toBeNull();
  });

  it("зафиксированный период виден, но недоступен", () => {
    render(<RangeFilter value={{ kind: "preset", preset: "7d" }} onChange={vi.fn()} disabled now={NOW} />);
    expect(screen.getByRole("button", { name: "Период: 7 дней" })).toBeDisabled();
  });
});
