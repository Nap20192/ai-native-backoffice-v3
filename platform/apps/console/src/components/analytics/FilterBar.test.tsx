import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterBar, FilterButton, FilterDivider } from "./FilterBar";

afterEach(() => vi.unstubAllGlobals());

describe("FilterBar", () => {
  it("собирает фильтры в одну группу", () => {
    render(
      <FilterBar showReset={false} onReset={vi.fn()}>
        <FilterButton label="Период" value="30 дней" />
        <FilterDivider />
        <FilterButton label="Группировать по" value="Модель" />
      </FilterBar>,
    );
    const group = screen.getByRole("group", { name: "Фильтры" });
    expect(group).toContainElement(screen.getByRole("button", { name: "Период: 30 дней" }));
    expect(group).toContainElement(screen.getByRole("button", { name: "Группировать по: Модель" }));
  });

  it("«Сбросить» видна только при отличии от умолчаний", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const { rerender } = render(
      <FilterBar showReset={false} onReset={onReset}>
        <FilterButton label="Период" value="30 дней" />
      </FilterBar>,
    );
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
    rerender(
      <FilterBar showReset onReset={onReset}>
        <FilterButton label="Период" value="7 дней" />
      </FilterBar>,
    );
    await user.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("кнопка «Скачать CSV» есть только когда есть выгрузка", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    const { rerender } = render(
      <FilterBar showReset={false} onReset={vi.fn()}>
        <FilterButton label="Период" value="30 дней" />
      </FilterBar>,
    );
    expect(screen.queryByRole("button", { name: "Скачать CSV" })).toBeNull();
    rerender(
      <FilterBar showReset={false} onReset={vi.fn()} onExport={onExport}>
        <FilterButton label="Период" value="30 дней" />
      </FilterBar>,
    );
    await user.click(screen.getByRole("button", { name: "Скачать CSV" }));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it("пока файл готовится, вместо значка индикатор и кнопка занята", () => {
    render(
      <FilterBar showReset={false} onReset={vi.fn()} onExport={vi.fn()} exporting>
        <FilterButton label="Период" value="30 дней" />
      </FilterBar>,
    );
    const button = screen.getByRole("button", { name: "Скачать CSV" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("липкая панель прилипает к верху, а фон получает только когда прилипла", () => {
    let notify: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(
      <FilterBar showReset={false} onReset={vi.fn()} sticky>
        <FilterButton label="Период" value="7 дней" />
      </FilterBar>,
    );
    const wrapper = screen.getByRole("group", { name: "Фильтры" }).parentElement as HTMLElement;
    expect(wrapper).toHaveClass("sticky", "top-0");
    expect(wrapper).not.toHaveClass("bg-ddc-shell");
    act(() => notify([{ isIntersecting: false }]));
    expect(wrapper).toHaveClass("bg-ddc-shell", "border-b");
    act(() => notify([{ isIntersecting: true }]));
    expect(wrapper).not.toHaveClass("bg-ddc-shell");
  });

  it("без sticky панель обычная, без наблюдателя прокрутки", () => {
    render(
      <FilterBar showReset={false} onReset={vi.fn()}>
        <FilterButton label="Период" value="7 дней" />
      </FilterBar>,
    );
    expect(screen.getByRole("group", { name: "Фильтры" }).parentElement).not.toHaveClass("sticky");
  });

  it("правый слот держит подпись «Данные на …»", () => {
    render(
      <FilterBar showReset={false} onReset={vi.fn()} trailing={<span>Данные на 16 окт., 09:12 UTC</span>}>
        <FilterButton label="Период" value="7 дней" />
      </FilterBar>,
    );
    expect(screen.getByText("Данные на 16 окт., 09:12 UTC")).toBeInTheDocument();
  });

  it("кнопка фильтра 32 px высотой и без значения пишет только подпись", () => {
    render(
      <FilterBar showReset={false} onReset={vi.fn()}>
        <FilterButton label="Период" />
      </FilterBar>,
    );
    const button = screen.getByRole("button", { name: "Период" });
    expect(button).toHaveClass("h-8");
  });
});
