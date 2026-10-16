import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import type { HarnessEntry, ModelOption } from "../../lib/catalog-api";
import { ModelPicker } from "./ModelPicker";

beforeAll(() => {
  // cmdk и Radix измеряют и прокручивают элементы, а в jsdom этого нет.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});

function option(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    handle: "verify-fake",
    label: "Claude Sonnet 4.6",
    source: "card",
    card_id: "mc_1",
    is_default: false,
    provider: "anthropic",
    wire_model: "claude-sonnet-4-6",
    api: "anthropic-messages",
    protocols: ["anthropic-messages"],
    context_window: 200000,
    max_output_tokens: 64000,
    effort_levels: ["low", "high"],
    speed_fast: true,
    harnesses: ["pi", "claude-acp"],
    ...overrides,
  };
}

const CARD = option({ is_default: true });
const OPENAI_CARD = option({
  handle: "verify-oai",
  label: "GPT 5",
  card_id: "mc_2",
  provider: "openai",
  protocols: ["openai-chat", "openai-responses"],
  context_window: 400000,
});
const BUILTIN = option({
  handle: "claude-haiku-4-5",
  label: "Claude Haiku 4.5",
  source: "builtin",
  card_id: null,
  context_window: null,
});

const CLAUDE: HarnessEntry = {
  id: "claude-acp",
  source: "builtin",
  label: "Claude Agent",
  status: "ready",
  reason: null,
  runtime_harness: "acp-sandbox",
  protocols: ["anthropic-messages"],
  supports: { effort: false, speed: false, platform_tools: false, mcp: false },
  acp: { agent: { id: "claude-acp", command: "sh" } },
  install: { npm: [], pip: [] },
  install_hint: null,
  allowed_env: null,
  card_id: null,
};

function renderPicker(props: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <ModelPicker
        id="model"
        value="verify-fake"
        options={[CARD, OPENAI_CARD, BUILTIN]}
        onChange={onChange}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onChange };
}

async function open() {
  await userEvent.click(screen.getByRole("combobox"));
}

describe("ModelPicker", () => {
  it("показывает выбранную модель названием и handle моноширинным шрифтом", () => {
    renderPicker();

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Claude Sonnet 4.6");
    expect(within(trigger).getByText("verify-fake")).toHaveClass("font-mono");
  });

  it("без названия, отличного от handle, не дублирует его", () => {
    renderPicker({
      value: "same",
      options: [option({ handle: "same", label: "same" })],
    });

    expect(screen.getAllByText("same")).toHaveLength(1);
  });

  it("для модели, которой нет в списке, показывает её handle как есть", () => {
    renderPicker({ value: "typed-by-hand" });

    expect(screen.getByRole("combobox")).toHaveTextContent("typed-by-hand");
  });

  it("делит список на карточки моделей и ключ сервера, у строки есть источник и контекст", async () => {
    renderPicker();
    await open();

    expect(screen.getByText("Карточки моделей")).toBeInTheDocument();
    expect(screen.getByText("Ключ сервера", { selector: "[cmdk-group-heading]" })).toBeInTheDocument();
    const row = screen.getByRole("option", { name: /GPT 5/ });
    expect(row).toHaveTextContent("verify-oai");
    expect(row).toHaveTextContent("Карточка · OpenAI · 400 тыс. токенов");
    const builtin = screen.getByRole("option", { name: /Claude Haiku 4\.5/ });
    expect(builtin).toHaveTextContent("Ключ сервера · Anthropic");
    expect(screen.getByRole("option", { name: /Claude Sonnet 4\.6/ })).toHaveTextContent(
      "По умолчанию",
    );
  });

  it("ищет по handle и по названию", async () => {
    renderPicker();
    await open();

    await userEvent.type(screen.getByPlaceholderText("Поиск…"), "haiku");
    expect(screen.getByRole("option", { name: /Claude Haiku 4\.5/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT 5/ })).toBeNull();

    await userEvent.clear(screen.getByPlaceholderText("Поиск…"));
    await userEvent.type(screen.getByPlaceholderText("Поиск…"), "verify-oai");
    expect(screen.getByRole("option", { name: /GPT 5/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Haiku/ })).toBeNull();
  });

  it("выбор модели зовёт onChange с записью и закрывает список", async () => {
    const { onChange } = renderPicker();
    await open();

    await userEvent.click(screen.getByRole("option", { name: /GPT 5/ }));

    expect(onChange).toHaveBeenCalledWith(OPENAI_CARD);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("выключает несовместимую модель: причина видна в строке и связана через aria-describedby", async () => {
    const { onChange } = renderPicker({ harness: CLAUDE });
    await open();

    const row = screen.getByRole("option", { name: /GPT 5/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    const reason =
      "Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели verify-oai: openai-chat, openai-responses";
    expect(row).toHaveTextContent(reason);
    expect(row).toHaveAttribute("title", reason);
    const describedBy = row.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent(reason);

    await userEvent.click(row);
    expect(onChange).not.toHaveBeenCalled();
    // Совместимые модели выбираются как обычно.
    expect(screen.getByRole("option", { name: /Claude Haiku 4\.5/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("предлагает добавить карточку модели", async () => {
    renderPicker();
    await open();

    expect(screen.getByRole("link", { name: "Добавить карточку модели" })).toHaveAttribute(
      "href",
      "/model-cards",
    );
  });

  it("с emptyLabel первым пунктом идёт «Нет», он снимает выбор", async () => {
    const { onChange } = renderPicker({ value: "", emptyLabel: "Нет" });

    expect(screen.getByRole("combobox")).toHaveTextContent("Нет");
    await open();
    const none = screen.getAllByRole("option")[0];
    expect(none).toHaveTextContent("Нет");

    await userEvent.click(none);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("пока модели грузятся, говорит об этом, а список без моделей называет причину", async () => {
    const { onChange } = renderPicker({ options: undefined, loading: true });
    await open();
    expect(screen.getByText("Загрузка…")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("без единой модели пишет, что выбирать нечего", async () => {
    renderPicker({ value: "", options: [] });
    await open();

    expect(screen.getByText("Моделей нет")).toBeInTheDocument();
  });
});
