import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SANDBOX_CATALOG_PATH } from "../lib/sandbox-catalog";
import { server } from "../mocks/server";
import {
  disabledCatalogFixture,
  sandboxCatalogFixture,
} from "../test/sandbox-catalog-fixture";
import { EnvironmentDetail } from "./EnvironmentDetail";

const state = vi.hoisted(() => ({ env: undefined as unknown }));
const update = vi.hoisted(() => vi.fn());

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: state.env, error: null }),
}));
vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => ({ environments: { update } }),
}));

beforeAll(() => {
  // Radix Select трогает API, которых в jsdom нет.
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

type Cloud = Record<string, unknown>;

function makeEnv(cloud: Cloud = {}, extra: Record<string, unknown> = {}) {
  return {
    id: "env-1",
    name: "Development",
    description: "Development environment",
    config: {
      type: "cloud",
      image: null,
      networking: { type: "unrestricted" },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      ...cloud,
    },
    type: "environment",
    metadata: {},
    archived_at: null,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    ...extra,
  };
}

function answerCatalog(catalog: unknown) {
  server.use(http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(catalog as never)));
}

function answerNoCatalog() {
  server.use(
    http.get(`*${SANDBOX_CATALOG_PATH}`, () =>
      HttpResponse.json({ error: "Маршрут не найден" }, { status: 404 }),
    ),
  );
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/environments/env-1"]}>
        <Routes>
          <Route path="/environments/:id" element={<EnvironmentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const sectionTitles = () =>
  screen.getAllByTestId("settings-section").map((section) => section.querySelector("h2")?.textContent);

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Сохранить изменения" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  return update.mock.calls[0] as [string, { name: string; config: Cloud; metadata: Record<string, unknown> }];
}

beforeEach(() => {
  state.env = makeEnv();
  update.mockReset().mockImplementation(async () => state.env);
  answerCatalog(sandboxCatalogFixture());
});

describe("EnvironmentDetail, раздел «Образ»", () => {
  it("ставит «Образ» после основного блока и перед сетью", async () => {
    show();

    await screen.findByRole("combobox", { name: "Образ" });
    expect(sectionTitles()).toEqual(["Образ", "Сеть", "Пакеты", "Метаданные"]);
  });

  it("показывает образ окружения, его дайджест и состав", async () => {
    state.env = makeEnv({ image: "workplace-office" });
    const user = userEvent.setup();
    show();

    expect(await screen.findByRole("combobox", { name: "Образ" })).toHaveTextContent(
      "Рабочее место с LibreOffice",
    );
    expect(screen.getByText("sha256:032d84…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Что есть в образе/ }));
    expect(screen.getByRole("group", { name: "Python и библиотеки" })).toBeInTheDocument();
  });

  it("сохраняет выбранный образ ключом каталога", async () => {
    state.env = makeEnv({ image: "workplace" });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByRole("combobox", { name: "Образ" }));
    await user.click(await screen.findByRole("option", { name: "Рабочее место с LibreOffice" }));
    const [id, body] = await save(user);

    expect(id).toBe("env-1");
    expect(body.config).toEqual({
      type: "cloud",
      image: "workplace-office",
      packages: { type: "packages" },
      networking: { type: "unrestricted" },
    });
  });

  it("сохраняет null, когда выбран образ по умолчанию", async () => {
    state.env = makeEnv({ image: "workplace" });
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByRole("combobox", { name: "Образ" }));
    await user.click(await screen.findByRole("option", { name: "По умолчанию: Node 22, прежний образ" }));
    const [, body] = await save(user);

    expect(body.config.image).toBeNull();
  });

  it("не трогает образ, когда пользователь его не менял", async () => {
    state.env = makeEnv({ image: "workplace" });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    const [, body] = await save(user);

    expect(body.config.image).toBe("workplace");
  });

  it("прячет раздел и не шлёт образ, пока на сервере нет каталога образов", async () => {
    answerNoCatalog();
    state.env = makeEnv();
    delete (state.env as { config: Cloud }).config.image;
    const user = userEvent.setup();
    show();

    await screen.findByRole("heading", { level: 1, name: /Development/ });
    await waitFor(() => expect(sectionTitles()).toEqual(["Сеть", "Пакеты", "Метаданные"]));
    const [, body] = await save(user);

    expect("image" in body.config).toBe(false);
  });

  it("прячет раздел, когда сервер отвечает без каталога образов", async () => {
    answerCatalog(disabledCatalogFixture());
    const user = userEvent.setup();
    show();

    await screen.findByRole("heading", { level: 1, name: /Development/ });
    await waitFor(() => expect(sectionTitles()).toEqual(["Сеть", "Пакеты", "Метаданные"]));
    const [, body] = await save(user);

    expect(body.config.image).toBeNull();
  });

  it("у окружения «Свой сервер» нет образа, сети и пакетов", async () => {
    state.env = makeEnv({}, { config: { type: "self_hosted" } });
    show();

    await screen.findByRole("heading", { level: 1, name: /Development/ });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Свой сервер");
    expect(sectionTitles()).toEqual(["Метаданные"]);
  });
});

describe("EnvironmentDetail, шаблон и метки платформы", () => {
  it("показывает в шапке чип с названием шаблона из каталога", async () => {
    state.env = makeEnv({}, { metadata: { oma_template: "documents" } });
    show();

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Шаблон «Документы и офис»"));
  });

  it("без каталога называет шаблон так, как называет его консоль", async () => {
    answerNoCatalog();
    state.env = makeEnv({}, { metadata: { oma_template: "documents" } });
    show();

    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Шаблон «Документы»"));
  });

  it("не рисует чип, когда окружение создано без шаблона", async () => {
    show();

    await screen.findByRole("combobox", { name: "Образ" });
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent("Шаблон");
  });

  it("не показывает метки oma_ в редакторе метаданных и не удаляет их при сохранении", async () => {
    state.env = makeEnv({}, { metadata: { oma_template: "documents", oma_created_by: "user_1", team: "ops" } });
    const user = userEvent.setup();
    show();

    await screen.findByRole("combobox", { name: "Образ" });
    expect(screen.getAllByRole("textbox", { name: "Ключ" })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "Ключ" })).toHaveValue("team");
    expect(screen.queryByDisplayValue("oma_template")).not.toBeInTheDocument();

    const [, body] = await save(user);

    expect(body.metadata).toEqual({ team: "ops" });
  });

  it("пишет «Метаданных нет», когда у окружения только метки платформы", async () => {
    state.env = makeEnv({}, { metadata: { oma_template: "basic" } });
    show();

    await screen.findByRole("combobox", { name: "Образ" });
    expect(screen.getByText("Метаданных нет.")).toBeInTheDocument();
  });

  it("не даёт назвать свой ключ на oma_ и выключает сохранение", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    await user.click(screen.getByRole("button", { name: "Добавить метку" }));
    await user.type(screen.getByRole("textbox", { name: "Ключ" }), "oma_template");

    expect(screen.getByText(/Платформа зарезервировала ключи/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить изменения" })).toBeDisabled();

    await user.clear(screen.getByRole("textbox", { name: "Ключ" }));
    await user.type(screen.getByRole("textbox", { name: "Ключ" }), "team");
    expect(screen.queryByText(/Платформа зарезервировала ключи/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сохранить изменения" })).toBeEnabled();
  });
});

describe("EnvironmentDetail, сохранение полей, которых нет в форме", () => {
  it("возвращает allow_web_search в ограниченной сети, а не сбрасывает его", async () => {
    state.env = makeEnv({
      image: "workplace",
      networking: {
        type: "limited",
        allow_mcp_servers: true,
        allow_package_managers: true,
        allow_web_search: true,
        allowed_hosts: ["example.org"],
      },
    });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    const [, body] = await save(user);

    expect(body.config.networking).toEqual({
      type: "limited",
      allow_mcp_servers: true,
      allow_package_managers: true,
      allow_web_search: true,
      allowed_hosts: ["example.org"],
    });
  });

  it("не придумывает allow_web_search, если сервер его не отдавал", async () => {
    answerNoCatalog();
    state.env = makeEnv({
      networking: {
        type: "limited",
        allow_mcp_servers: false,
        allow_package_managers: true,
        allowed_hosts: [],
      },
    });
    const user = userEvent.setup();
    show();
    await screen.findByRole("heading", { level: 1, name: /Development/ });

    const [, body] = await save(user);

    expect(body.config.networking).toEqual({
      type: "limited",
      allow_mcp_servers: false,
      allow_package_managers: true,
      allowed_hosts: [],
    });
  });
});

describe("EnvironmentDetail, подписи раздела «Пакеты»", () => {
  it("пустой список называет то, что есть в образе", async () => {
    show();

    await screen.findByRole("combobox", { name: "Образ" });
    expect(screen.getByText("Только то, что есть в образе.")).toBeInTheDocument();
  });

  it("с каталогом образов не предлагает cargo и go", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    await user.click(screen.getByRole("button", { name: "Добавить пакет" }));
    await user.click(screen.getByRole("combobox", { name: "Менеджер пакетов" }));

    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["apt", "npm", "pip"]);
  });

  it("без каталога предлагает те же менеджеры, что и раньше", async () => {
    answerNoCatalog();
    const user = userEvent.setup();
    show();
    await screen.findByRole("heading", { level: 1, name: /Development/ });
    await waitFor(() => expect(sectionTitles()).toHaveLength(3));

    await user.click(screen.getByRole("button", { name: "Добавить пакет" }));
    await user.click(screen.getByRole("combobox", { name: "Менеджер пакетов" }));

    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["apt", "cargo", "go", "npm", "pip"]);
  });

  it("с каталогом оставляет менеджер, который окружение уже использует", async () => {
    state.env = makeEnv({
      packages: { type: "packages", apt: [], cargo: ["ripgrep"], gem: [], go: [], npm: [], pip: [] },
    });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    await user.click(screen.getByRole("combobox", { name: "Менеджер пакетов" }));

    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["apt", "cargo", "npm", "pip"]);
  });
});

describe("EnvironmentDetail, подпись под флажком менеджеров пакетов", () => {
  it("предупреждает, что код пакетов видит файлы сессии и может вывести данные через реестры", async () => {
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    const toggle = screen.getByRole("switch", { name: "Разрешить сетевой доступ менеджерам пакетов" });

    expect(toggle).toHaveAccessibleDescription(
      "Агент сможет сам ставить пакеты из реестров. Код пакетов увидит файлы сессии. " +
        "Через PyPI и npm такой код может вывести данные, например опубликовать их как пакет.",
    );
  });

  it("не вешает подпись на флажок MCP-серверов", async () => {
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    const toggle = screen.getByRole("switch", { name: "Разрешить сетевой доступ MCP-серверам" });

    expect(toggle).not.toHaveAccessibleDescription();
  });

  it("не меняет имя флажка: по нему находят его скрипты проверки", async () => {
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    expect(
      screen.getByRole("switch", { name: "Разрешить сетевой доступ менеджерам пакетов" }),
    ).toHaveAttribute("aria-checked", "false");
  });
});

describe("EnvironmentDetail, предупреждение о смене сети", () => {
  const limited = {
    type: "limited",
    allow_mcp_servers: false,
    allow_package_managers: false,
    allow_web_search: false,
    allowed_hosts: [],
  };

  it("молчит, пока сеть не тронули", async () => {
    state.env = makeEnv({ networking: limited });
    show();

    await screen.findByRole("combobox", { name: "Образ" });
    expect(screen.queryByText(/Сеть изменена/)).not.toBeInTheDocument();
  });

  it("предупреждает, что песочницы пересоздадутся, и гаснет, когда правку вернули", async () => {
    state.env = makeEnv({ networking: limited });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });
    const toggle = screen.getByRole("switch", { name: "Разрешить сетевой доступ MCP-серверам" });

    await user.click(toggle);

    const note = screen.getByText(/Сеть изменена/);
    expect(note).toHaveTextContent("Активные сессии этого окружения пересоздадут песочницу на следующем ходе.");
    expect(note).toHaveTextContent("Файлы вне /mnt/session/outputs пропадут.");

    await user.click(toggle);
    expect(screen.queryByText(/Сеть изменена/)).not.toBeInTheDocument();
  });

  it("замечает смену типа сети и список хостов", async () => {
    state.env = makeEnv({ networking: limited });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    await user.type(screen.getByRole("textbox", { name: "Разрешённые хосты" }), "example.org");
    expect(screen.getByText(/Сеть изменена/)).toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Разрешённые хосты" }));
    expect(screen.queryByText(/Сеть изменена/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Тип доступа" }));
    await user.click(await screen.findByRole("option", { name: "Без ограничений" }));
    expect(screen.getByText(/Сеть изменена/)).toBeInTheDocument();
  });

  it("не считает правкой флажки при сети без ограничений: они там ничего не меняют", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    await user.click(screen.getByRole("switch", { name: "Разрешить сетевой доступ MCP-серверам" }));

    expect(screen.queryByText(/Сеть изменена/)).not.toBeInTheDocument();
  });

  it("не мешает сохранению: кнопка остаётся рабочей, окон подтверждения нет", async () => {
    state.env = makeEnv({ networking: limited });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });

    await user.click(screen.getByRole("switch", { name: "Разрешить сетевой доступ MCP-серверам" }));
    await save(user);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("EnvironmentDetail, подсказка про самостоятельную установку", () => {
  it("следит за сетью, которую правят в форме", async () => {
    state.env = makeEnv({ image: "workplace" });
    const user = userEvent.setup();
    show();
    await screen.findByRole("combobox", { name: "Образ" });
    expect(screen.getByText(/Агент может сам ставить пакеты через pip/)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Тип доступа" }));
    await user.click(await screen.findByRole("option", { name: "Ограниченный" }));

    expect(await screen.findByText(/закрывает реестры пакетов/)).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Разрешить сетевой доступ менеджерам пакетов" }));
    expect(await screen.findByText(/Агент может сам ставить пакеты через pip/)).toBeInTheDocument();
    expect(screen.queryByText(/закрывает реестры пакетов/)).not.toBeInTheDocument();
  });
});
