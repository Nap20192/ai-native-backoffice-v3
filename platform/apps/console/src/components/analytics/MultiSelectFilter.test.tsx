import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { MultiSelectFilter, type FilterOption } from "./MultiSelectFilter";

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

const options: FilterOption[] = [
  { value: "a", label: "claude-sonnet" },
  { value: "b", label: "verify-fake" },
  { value: "c", label: "gpt-x" },
];

function Host({ initial = [] as string[], onChange = vi.fn() }) {
  const [selected, setSelected] = useState(initial);
  return (
    <MultiSelectFilter
      label="Модель"
      options={options}
      selected={selected}
      onChange={(next) => {
        onChange(next);
        setSelected(next);
      }}
    />
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /^Модель/ }));
  return user;
}

describe("MultiSelectFilter", () => {
  it("по умолчанию показывает «Все» и отмечает все значения", async () => {
    render(<Host />);
    expect(screen.getByRole("button", { name: "Модель: Все" })).toBeInTheDocument();
    await openMenu();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).toBeChecked();
    expect(screen.getByRole("button", { name: "Выбрать всё" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Очистить" })).toBeEnabled();
  });

  it("снятая галочка даёт список остальных значений", async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    const user = await openMenu();
    await user.click(screen.getByRole("checkbox", { name: "verify-fake" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "c"]);
    expect(screen.getByRole("button", { name: "Модель: 2 из 3" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "verify-fake" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Выбрать всё" })).toBeEnabled();
  });

  it("единственное значение показано по названию", () => {
    render(<Host initial={["b"]} />);
    expect(screen.getByRole("button", { name: "Модель: verify-fake" })).toBeInTheDocument();
  });

  it("«Очистить» снимает все галочки, выбор начинается с нуля", async () => {
    const onChange = vi.fn();
    render(<Host onChange={onChange} />);
    const user = await openMenu();
    await user.click(screen.getByRole("button", { name: "Очистить" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "gpt-x" }));
    expect(onChange).toHaveBeenLastCalledWith(["c"]);
    expect(screen.getByRole("checkbox", { name: "gpt-x" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "claude-sonnet" })).not.toBeChecked();
  });

  it("«Выбрать всё» возвращает фильтр «Все»", async () => {
    const onChange = vi.fn();
    render(<Host initial={["a"]} onChange={onChange} />);
    const user = await openMenu();
    await user.click(screen.getByRole("button", { name: "Выбрать всё" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("button", { name: "Модель: Все" })).toBeInTheDocument();
  });

  it("если вернули все значения вручную, фильтр снова «Все»", async () => {
    const onChange = vi.fn();
    render(<Host initial={["a", "c"]} onChange={onChange} />);
    const user = await openMenu();
    await user.click(screen.getByRole("checkbox", { name: "verify-fake" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("поиск оставляет подходящие значения и пишет, если ничего нет", async () => {
    render(<Host />);
    const user = await openMenu();
    await user.type(screen.getByRole("searchbox", { name: "Поиск" }), "fake");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "verify-fake" })).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Поиск" }));
    await user.type(screen.getByRole("searchbox", { name: "Поиск" }), "zzz");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("значение из адреса, которого нет среди вариантов, остаётся в списке", async () => {
    render(<Host initial={["old-model"]} />);
    await openMenu();
    const box = screen.getByRole("checkbox", { name: "old-model" });
    expect(box).toBeChecked();
    expect(within(screen.getByRole("dialog")).getAllByRole("checkbox")).toHaveLength(4);
  });

  it("отключённый фильтр не открывается", () => {
    render(
      <MultiSelectFilter label="Модель" options={options} selected={[]} onChange={vi.fn()} disabled />,
    );
    expect(screen.getByRole("button", { name: "Модель: Все" })).toBeDisabled();
  });
});
