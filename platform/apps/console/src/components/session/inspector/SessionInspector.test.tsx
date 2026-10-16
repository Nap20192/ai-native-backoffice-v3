import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  INSPECTOR_STORAGE_KEY,
  INSPECTOR_TABS,
  SessionInspector,
  clampInspectorWidth,
  parseInspectorTab,
  readInspectorPrefs,
  writeInspectorPrefs,
  type InspectorTab,
  type SessionInspectorProps,
} from "./SessionInspector";

function renderInspector(overrides: Partial<SessionInspectorProps> = {}) {
  const props: SessionInspectorProps = {
    layout: "side",
    tab: "session",
    onTabChange: vi.fn(),
    onClose: vi.fn(),
    width: INSPECTOR_DEFAULT_WIDTH,
    onWidthChange: vi.fn(),
    threadsMuted: false,
    children: <p>Содержимое вкладки</p>,
    ...overrides,
  };
  const view = render(<SessionInspector {...props} />);
  return { ...view, props };
}

describe("parseInspectorTab", () => {
  it("узнаёт пять вкладок из адреса", () => {
    for (const tab of INSPECTOR_TABS) expect(parseInspectorTab(tab)).toBe(tab);
    expect(INSPECTOR_TABS).toEqual(["session", "events", "tools", "resources", "thread"]);
  });

  it("неизвестное и пустое значение даёт вкладку «Сессия»", () => {
    expect(parseInspectorTab(null)).toBe("session");
    expect(parseInspectorTab("")).toBe("session");
    expect(parseInspectorTab("threads")).toBe("session");
    expect(parseInspectorTab("EVENTS")).toBe("session");
  });
});

describe("clampInspectorWidth", () => {
  it("держит ширину в пределах 360..720 px", () => {
    expect(INSPECTOR_MIN_WIDTH).toBe(360);
    expect(INSPECTOR_DEFAULT_WIDTH).toBe(480);
    expect(INSPECTOR_MAX_WIDTH).toBe(720);
    expect(clampInspectorWidth(100)).toBe(360);
    expect(clampInspectorWidth(500)).toBe(500);
    expect(clampInspectorWidth(900)).toBe(720);
  });

  it("мусор заменяет шириной по умолчанию", () => {
    expect(clampInspectorWidth(Number.NaN)).toBe(480);
    expect(clampInspectorWidth(Number.POSITIVE_INFINITY)).toBe(720);
  });
});

describe("настройки инспектора в localStorage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("пишут и читают открытость и ширину под ключом oma.session.inspector", () => {
    expect(INSPECTOR_STORAGE_KEY).toBe("oma.session.inspector");
    expect(readInspectorPrefs()).toBeNull();

    writeInspectorPrefs({ open: false, width: 560 });

    expect(JSON.parse(localStorage.getItem("oma.session.inspector") ?? "null")).toEqual({
      open: false,
      width: 560,
    });
    expect(readInspectorPrefs()).toEqual({ open: false, width: 560 });
  });

  it("при чтении возвращает ширину в пределах, а битую запись игнорирует", () => {
    localStorage.setItem(INSPECTOR_STORAGE_KEY, JSON.stringify({ open: true, width: 9000 }));
    expect(readInspectorPrefs()).toEqual({ open: true, width: 720 });

    localStorage.setItem(INSPECTOR_STORAGE_KEY, "{не json");
    expect(readInspectorPrefs()).toBeNull();

    localStorage.setItem(INSPECTOR_STORAGE_KEY, JSON.stringify({ open: "да" }));
    expect(readInspectorPrefs()).toEqual({ width: INSPECTOR_DEFAULT_WIDTH });
  });

  it("не падает, когда хранилище недоступно", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("закрыто");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("закрыто");
    });

    expect(readInspectorPrefs()).toBeNull();
    expect(() => writeInspectorPrefs({ open: true, width: 480 })).not.toThrow();
  });
});

describe("SessionInspector: вкладки", () => {
  it("рисует пять вкладок по-русски и выделяет текущую", () => {
    renderInspector({ tab: "events" });

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Сессия",
      "События",
      "Инструменты",
      "Ресурсы",
      "Потоки",
    ]);
    expect(screen.getByRole("tab", { name: "События" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Сессия" })).toHaveAttribute("aria-selected", "false");
  });

  it("полоса вкладок высотой 32 px, вкладка 24 px", () => {
    renderInspector();

    expect(screen.getByRole("tablist")).toHaveClass("h-8");
    expect(screen.getByRole("tab", { name: "Сессия" })).toHaveClass("h-6");
  });

  it("клик по вкладке сообщает её значение для адреса", async () => {
    const { props } = renderInspector();

    await userEvent.click(screen.getByRole("tab", { name: "Инструменты" }));
    await userEvent.click(screen.getByRole("tab", { name: "Потоки" }));

    expect(props.onTabChange).toHaveBeenNthCalledWith(1, "tools");
    expect(props.onTabChange).toHaveBeenNthCalledWith(2, "thread");
  });

  it("«Потоки» приглушены, пока других потоков нет, но остаются нажимаемыми", async () => {
    const { props } = renderInspector({ threadsMuted: true });

    const threads = screen.getByRole("tab", { name: "Потоки" });
    expect(threads).toHaveClass("text-ddc-text-muted");
    expect(screen.getByRole("tab", { name: "Ресурсы" })).not.toHaveClass("text-ddc-text-muted");
    expect(threads).toBeEnabled();

    await userEvent.click(threads);
    expect(props.onTabChange).toHaveBeenCalledWith("thread");
  });

  it("стрелки переключают вкладки по кругу", async () => {
    const { props } = renderInspector({ tab: "thread" });

    const current = screen.getByRole("tab", { name: "Потоки" });
    current.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onTabChange).toHaveBeenLastCalledWith("session");

    await userEvent.keyboard("{ArrowLeft}");
    expect(props.onTabChange).toHaveBeenLastCalledWith("resources");
  });

  it("показывает содержимое активной вкладки в панели, связанной со вкладкой", () => {
    renderInspector({ tab: "resources" });

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("Содержимое вкладки");
    expect(panel).toHaveAttribute(
      "aria-labelledby",
      screen.getByRole("tab", { name: "Ресурсы" }).id,
    );
  });

  it("крестик закрывает инспектор", async () => {
    const { props } = renderInspector();

    await userEvent.click(screen.getByRole("button", { name: "Закрыть инспектор" }));

    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe("SessionInspector: ширина", () => {
  it("на десктопе занимает заданную ширину", () => {
    renderInspector({ width: 520 });

    const aside = screen.getByRole("complementary", { name: "Инспектор сессии" });
    expect(aside).toHaveStyle({ width: "520px" });
    expect(aside).toHaveAttribute("data-layout", "side");
  });

  it("ручка на левой кромке меняет ширину перетаскиванием и держит её в пределах", () => {
    const { props } = renderInspector({ width: 480 });

    const handle = screen.getByRole("separator", { name: "Изменить ширину инспектора" });
    expect(handle).toHaveAttribute("aria-valuenow", "480");
    expect(handle).toHaveAttribute("aria-valuemin", "360");
    expect(handle).toHaveAttribute("aria-valuemax", "720");

    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 940, pointerId: 1 });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(540);

    fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(720);

    fireEvent.pointerMove(window, { clientX: 1900, pointerId: 1 });
    expect(props.onWidthChange).toHaveBeenLastCalledWith(360);

    fireEvent.pointerUp(window, { pointerId: 1 });
    const calls = vi.mocked(props.onWidthChange).mock.calls.length;
    fireEvent.pointerMove(window, { clientX: 800, pointerId: 1 });
    expect(vi.mocked(props.onWidthChange).mock.calls.length).toBe(calls);
  });

  it("ручка работает и с клавиатуры: стрелка влево расширяет, вправо сужает", async () => {
    const { props } = renderInspector({ width: 480 });

    screen.getByRole("separator", { name: "Изменить ширину инспектора" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(props.onWidthChange).toHaveBeenLastCalledWith(496);

    await userEvent.keyboard("{ArrowRight}");
    expect(props.onWidthChange).toHaveBeenLastCalledWith(464);
  });

  it("нижний лист на узком экране без ручки и без фиксированной ширины", () => {
    renderInspector({ layout: "sheet", width: 520 });

    const aside = screen.getByRole("complementary", { name: "Инспектор сессии" });
    expect(aside).toHaveAttribute("data-layout", "sheet");
    expect(aside.style.width).toBe("");
    // Лист занимает место ленты под мини-картой: его рамку задаёт страница.
    expect(aside).toHaveClass("h-full", "border-t");
    expect(aside).not.toHaveClass("fixed");
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

describe("типы", () => {
  it("InspectorTab совпадает со значениями адреса", () => {
    const tab: InspectorTab = parseInspectorTab("thread");
    expect(tab).toBe("thread");
  });
});
