import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfigPreviewPanel } from "./ConfigPreviewPanel";
import { describeReducer, initialDescribeState, type DescribeState } from "./describe-state";

const YAML_A = "name: Сводка заявок\ndescription: Старое\nmodel: qwen3.6-35b\nsystem: Пиши сводку\n";
const YAML_B =
  "name: Сводка заявок\ndescription: Старое\nmodel: qwen3.6-35b\nsystem: Пиши короткую сводку\ntools:\n  - type: agent_toolset_20260401\nmcp_servers:\n  - name: crm\n    url: https://crm.example/mcp\nskills:\n  - skill_id: sk_1\n";

function stateOf(...yamls: string[]): DescribeState {
  return yamls.reduce(
    (s, yaml, i) =>
      describeReducer(s, { type: "draft", draft: { toolUseId: `t${i}`, yaml, warnings: [], name: null } }),
    initialDescribeState,
  );
}

function setup(state: DescribeState, over: Partial<Parameters<typeof ConfigPreviewPanel>[0]> = {}) {
  const props = {
    state,
    error: null,
    onEdit: vi.fn(),
    onField: vi.fn(),
    onFormat: vi.fn(),
    ...over,
  };
  render(<ConfigPreviewPanel {...props} />);
  return props;
}

describe("ConfigPreviewPanel", () => {
  it("без черновика пишет, что он появится после ответа ассистента", () => {
    setup(initialDescribeState);
    expect(screen.getByRole("heading", { name: "Конфигурация агента" })).toBeTruthy();
    expect(screen.getByText(/Черновик появится/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("по умолчанию форма: имя, описание, модель, промпт, инструменты, MCP и навыки", () => {
    setup(stateOf(YAML_B));
    expect((screen.getByLabelText("Название") as HTMLInputElement).value).toBe("Сводка заявок");
    expect((screen.getByLabelText("Описание") as HTMLInputElement).value).toBe("Старое");
    expect(screen.getByText("qwen3.6-35b")).toBeTruthy();
    expect((screen.getByLabelText("Системный промпт") as HTMLTextAreaElement).value).toBe("Пиши короткую сводку");
    expect(screen.getByText(/agent_toolset_20260401/)).toBeTruthy();
    expect(screen.getByText(/crm/)).toBeTruthy();
    expect(screen.getByText(/sk_1/)).toBeTruthy();
  });

  it("правка поля формы уходит в onField", async () => {
    const props = setup(stateOf(YAML_A));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Другое" } });
    expect(props.onField).toHaveBeenCalledWith("name", "Другое");
    fireEvent.change(screen.getByLabelText("Системный промпт"), { target: { value: "Новый" } });
    expect(props.onField).toHaveBeenCalledWith("system", "Новый");
  });

  it("переключатель Форма | YAML показывает редактор YAML, правка уходит в onEdit", () => {
    const props = setup(stateOf(YAML_A));
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    const area = screen.getByLabelText("Конфигурация в виде текста") as HTMLTextAreaElement;
    expect(area.value).toBe(YAML_A);
    fireEvent.change(area, { target: { value: YAML_A + "x: 1\n" } });
    expect(props.onEdit).toHaveBeenCalledWith(YAML_A + "x: 1\n");
    fireEvent.click(screen.getByRole("tab", { name: "Форма" }));
    expect(screen.getByLabelText("Название")).toBeTruthy();
  });

  it("выбор формата вызывает onFormat, JSON показывает JSON", () => {
    const props = setup(stateOf(YAML_A));
    fireEvent.change(screen.getByLabelText("Формат"), { target: { value: "json" } });
    expect(props.onFormat).toHaveBeenCalledWith("json");
  });

  it("в формате JSON редактор показывает JSON", () => {
    const s = describeReducer(stateOf(YAML_A), { type: "format", format: "json" });
    setup(s);
    fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
    const text = (screen.getByLabelText("Конфигурация в виде текста") as HTMLTextAreaElement).value;
    expect(JSON.parse(text).name).toBe("Сводка заявок");
  });

  it("подпись вкладки следует за форматом: JSON вместо YAML", () => {
    const s = describeReducer(stateOf(YAML_A), { type: "format", format: "json" });
    setup(s);
    expect(screen.getByRole("tab", { name: "JSON" })).toBeTruthy();
  });

  it("«Копировать» кладёт текст в буфер и подтверждает", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup(stateOf(YAML_A));
    await userEvent.click(screen.getByRole("button", { name: "Копировать" }));
    expect(writeText).toHaveBeenCalledWith(YAML_A);
    expect(await screen.findByRole("button", { name: "Скопировано" })).toBeTruthy();
  });

  it("строка «Изменилось» называет ключи и пропадает без изменений", () => {
    const { unmount } = render(
      <ConfigPreviewPanel state={stateOf(YAML_A, YAML_B)} error={null} onEdit={vi.fn()} onField={vi.fn()} onFormat={vi.fn()} />,
    );
    expect(screen.getByText("Изменилось: system, tools, mcp_servers, skills")).toBeTruthy();
    unmount();
    setup(stateOf(YAML_A));
    expect(screen.queryByText(/Изменилось/)).toBeNull();
  });

  it("изменённые поля формы помечены", () => {
    setup(stateOf(YAML_A, YAML_B));
    expect(screen.getByLabelText("Системный промпт").closest("[data-changed]")?.getAttribute("data-changed")).toBe("true");
    expect(screen.getByLabelText("Название").closest("[data-changed]")?.getAttribute("data-changed")).toBe("false");
  });

  it("«Показать разницу» выключен, пока нет прошлого черновика", () => {
    setup(stateOf(YAML_A));
    expect((screen.getByRole("switch", { name: "Показать разницу" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("«Показать разницу» рисует построчную разницу с прошлым черновиком", async () => {
    setup(stateOf(YAML_A, YAML_B));
    await userEvent.click(screen.getByRole("switch", { name: "Показать разницу" }));
    const diff = screen.getByRole("group", { name: "Разница" });
    expect(within(diff).getByText("system: Пиши сводку")).toBeTruthy();
    expect(within(diff).getByText("system: Пиши короткую сводку")).toBeTruthy();
    expect(diff.querySelectorAll('[data-diff="add"]').length).toBeGreaterThan(0);
    expect(diff.querySelectorAll('[data-diff="del"]').length).toBe(1);
  });

  it("предупреждения сервера и ошибка проверки видны", () => {
    const s = { ...stateOf(YAML_A), warnings: ["Нет описания навыка"] };
    setup(s, { error: "Укажите название агента" });
    expect(screen.getByText("Нет описания навыка")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Укажите название агента");
  });

  it("если YAML не читается, форма заменяется подсказкой, редактор остаётся", () => {
    const s = describeReducer(stateOf(YAML_A), { type: "edit", text: "name: [" });
    setup(s, { error: "Некорректный YAML" });
    expect(screen.getByText(/Форма недоступна/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "YAML" }));
    expect((screen.getByLabelText("Конфигурация в виде текста") as HTMLTextAreaElement).value).toBe("name: [");
  });

  it("выключенная панель не даёт править", () => {
    setup(stateOf(YAML_A), { disabled: true });
    expect((screen.getByLabelText("Название") as HTMLInputElement).disabled).toBe(true);
  });
});
