import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import type { HarnessEntry, ModelOption } from "../../lib/catalog-api";
import { HarnessPicker } from "./HarnessPicker";

beforeAll(() => {
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

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
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
    ...overrides,
  };
}

const PI = entry({
  id: "pi",
  label: "Pi agent-core",
  runtime_harness: null,
  protocols: ["*"],
  supports: { effort: true, speed: true, platform_tools: true, mcp: true },
  acp: null,
});
const CLAUDE = entry();
const CODEX = entry({
  id: "codex-acp",
  label: "Codex",
  status: "unverified",
  protocols: ["openai-responses"],
});
const GEMINI = entry({
  id: "gemini",
  label: "Gemini CLI",
  status: "unavailable",
  reason: "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
  protocols: ["gemini"],
});
const CARD = entry({
  id: "aider-local",
  source: "card",
  label: "Aider через ACP",
  status: "unverified",
  protocols: ["openai-chat"],
  card_id: "hcard_1",
});

const ANTHROPIC_MODEL: ModelOption = {
  handle: "verify-fake",
  label: "Claude Sonnet 4.6",
  source: "card",
  card_id: "mc_1",
  is_default: true,
  provider: "anthropic",
  wire_model: "claude-sonnet-4-6",
  api: "anthropic-messages",
  protocols: ["anthropic-messages"],
  context_window: 200000,
  max_output_tokens: 64000,
  effort_levels: [],
  speed_fast: false,
  harnesses: ["pi", "claude-acp"],
};

function renderPicker(props: Partial<React.ComponentProps<typeof HarnessPicker>> = {}) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <HarnessPicker
        id="harness"
        value="pi"
        entries={[PI, CLAUDE, CODEX, GEMINI, CARD]}
        options={[ANTHROPIC_MODEL]}
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

describe("HarnessPicker", () => {
  it("называет выбранный вариант по-русски и показывает его ID моноширинным шрифтом", () => {
    renderPicker({ value: "claude-acp" });

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Claude Code в песочнице");
    expect(within(trigger).getByText("claude-acp")).toHaveClass("font-mono");
  });

  it("делит список на готовые, непроверенные, недоступные и свои", async () => {
    renderPicker();
    await open();

    const headings = Array.from(document.querySelectorAll("[cmdk-group-heading]")).map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(["Готово", "Не проверено", "Недоступно", "Свои"]);
    expect(screen.getByRole("option", { name: /Встроенный цикл/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Aider через ACP/ })).toHaveTextContent("aider-local");
  });

  it("ставит чип «Не проверено» у непроверенных и не ставит у готовых", async () => {
    renderPicker();
    await open();

    expect(within(screen.getByRole("option", { name: /Codex в песочнице/ })).getByText("Не проверено"))
      .toBeInTheDocument();
    expect(within(screen.getByRole("option", { name: /Aider через ACP/ })).getByText("Не проверено"))
      .toBeInTheDocument();
    expect(
      within(screen.getByRole("option", { name: /Claude Code в песочнице/ })).queryByText("Не проверено"),
    ).toBeNull();
  });

  it("выключает недоступную запись и называет причину сервера", async () => {
    const { onChange } = renderPicker();
    await open();

    const row = screen.getByRole("option", { name: /Gemini CLI в песочнице/ });
    const reason = "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET";
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveAttribute("title", reason);
    expect(row).toHaveTextContent(reason);
    const describedBy = row.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)).toHaveTextContent(reason);

    await userEvent.click(row);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("выключает запись, к которой нет ни одной совместимой модели", async () => {
    const { onChange } = renderPicker();
    await open();

    const row = screen.getByRole("option", { name: /Codex в песочнице/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("Нет подходящих моделей: нужна модель с протоколом openai-responses");

    await userEvent.click(row);
    expect(onChange).not.toHaveBeenCalled();
    // Встроенный цикл и Claude Code с подходящей моделью выбираются.
    expect(screen.getByRole("option", { name: /Claude Code в песочнице/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("выбор записи зовёт onChange с ней и закрывает список", async () => {
    const { onChange } = renderPicker();
    await open();

    await userEvent.click(screen.getByRole("option", { name: /Claude Code в песочнице/ }));

    expect(onChange).toHaveBeenCalledWith(CLAUDE);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ищет по подписи и по ID", async () => {
    renderPicker({ options: undefined });
    await open();

    await userEvent.type(screen.getByPlaceholderText("Поиск…"), "aider");
    expect(screen.getByRole("option", { name: /Aider через ACP/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Встроенный цикл/ })).toBeNull();
  });

  it("предлагает добавить свой harness", async () => {
    renderPicker();
    await open();

    expect(screen.getByRole("link", { name: "Добавить свой harness" })).toHaveAttribute(
      "href",
      "/harnesses",
    );
  });

  it("агент с ai-sdk показывает «AI SDK (устарел)», а выбрать его снова нельзя", async () => {
    renderPicker({ value: "ai-sdk" });

    expect(screen.getByRole("combobox")).toHaveTextContent("AI SDK (устарел)");
    await open();
    expect(screen.queryByRole("option", { name: /AI SDK/ })).toBeNull();
  });

  it("для id не из каталога показывает сам id", () => {
    renderPicker({ value: "my-old-harness" });

    expect(screen.getByRole("combobox")).toHaveTextContent("my-old-harness");
  });

  it("пока каталог грузится, называет известный id по-русски и пишет о загрузке", async () => {
    renderPicker({ value: "claude-acp", entries: undefined, loading: true });

    expect(screen.getByRole("combobox")).toHaveTextContent("Claude Code в песочнице");
    await open();
    expect(screen.getByText("Загрузка…")).toBeInTheDocument();
  });
});
