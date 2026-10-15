// Скриншоты перекрашенной консоли конструктора агентов (DDC).
//
// Запуск (сервер уже поднят на SQLite с AUTH_DISABLED=1, порт 8787):
//   nice -n 15 node scripts/ddc-shots.mjs seed     # демо-данные через API
//   nice -n 15 node scripts/ddc-shots.mjs shoot    # скриншоты
//   nice -n 15 node scripts/ddc-shots.mjs all      # оба шага
//
// Результат: docs/reports/screenshots/ddc-console/<экран>-<ширина>-<тема>.png
// и список проблем в problems.json рядом со снимками.
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outDir = join(repoRoot, "docs", "reports", "screenshots", "ddc-console");
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const BETAS = [
  "managed-agents-2026-04-01",
  "skills-2025-10-02",
  "agent-memory-2026-07-22",
  "files-api-2025-04-14",
].join(",");

/* ---------------------------------------------------------------- API --- */

async function api(method, path, body) {
  const headers = { "anthropic-beta": BETAS };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

const warnings = [];
async function tryStep(label, fn) {
  try {
    const r = await fn();
    console.log(`ok   ${label}`);
    return r;
  } catch (e) {
    console.log(`FAIL ${label}: ${e.message}`);
    warnings.push(`seed: ${label}: ${e.message}`);
    return null;
  }
}

/* --------------------------------------------------------------- seed --- */

const SKILLS = [
  {
    dir: "incoming-correspondence",
    title: "Регистрация входящей корреспонденции",
    body: `---
name: incoming-correspondence
description: Регистрирует входящее письмо в системе документооборота и определяет исполнителя по теме обращения.
---

# Регистрация входящей корреспонденции

1. Прочитайте письмо и выделите отправителя, тему и срок ответа.
2. Определите тип документа: обращение, запрос, уведомление.
3. Зарегистрируйте документ и назначьте исполнителя по справочнику ответственных.
4. Сообщите согласующему, что запись ожидает подтверждения.
`,
  },
  {
    dir: "onboarding-checklist",
    title: "Чек-лист выхода сотрудника на работу",
    body: `---
name: onboarding-checklist
description: Ведёт чек-лист оформления нового сотрудника: документы, доступы, оборудование, знакомство с командой.
---

# Чек-лист выхода сотрудника

- Собрать пакет документов и сверить его с перечнем.
- Заказать рабочее место, пропуск и учётные записи.
- Назначить наставника и запланировать первую неделю.
`,
  },
];

async function seed() {
  const existing = await api("GET", "/v1/agents");
  if (existing.data?.length) {
    console.log(`seed пропущен: уже есть ${existing.data.length} агентов`);
    return;
  }

  const envA = await tryStep("environment: Рабочая среда", () =>
    api("POST", "/v1/environments", {
      name: "Рабочая среда",
      description: "Основная облачная среда для сотрудников, сеть без ограничений.",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    }),
  );
  await tryStep("environment: Проверка регламентов", () =>
    api("POST", "/v1/environments", {
      name: "Проверка регламентов",
      description: "Изолированная среда для проверки новых плейбуков.",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    }),
  );

  const skillIds = [];
  for (const s of SKILLS) {
    const form = new FormData();
    form.append("files[]", new File([s.body], `${s.dir}/SKILL.md`, { type: "text/markdown" }));
    form.append("display_title", s.title);
    const sk = await tryStep(`skill: ${s.title}`, () => api("POST", "/v1/skills", form));
    if (sk?.id) skillIds.push(sk.id);
  }

  const vault = await tryStep("vault: Доступы документооборота", () =>
    api("POST", "/v1/vaults", { display_name: "Доступы документооборота" }),
  );
  await tryStep("vault: Кадровые системы", () =>
    api("POST", "/v1/vaults", { display_name: "Кадровые системы" }),
  );
  if (vault?.id) {
    await tryStep("credential: Documentolog", () =>
      api("POST", `/v1/vaults/${vault.id}/credentials`, {
        display_name: "Documentolog, сервисная учётная запись",
        auth: {
          type: "static_bearer",
          mcp_server_url: "https://mcp.demo.example/documentolog",
          token: "demo-token-not-a-real-secret",
        },
      }),
    );
  }

  const store = await tryStep("memory store: Регламенты компании", () =>
    api("POST", "/v1/memory_stores", {
      name: "Регламенты компании",
      description: "Общие правила работы с документами и согласованием.",
    }),
  );
  await tryStep("memory store: Заметки по проектам", () =>
    api("POST", "/v1/memory_stores", {
      name: "Заметки по проектам",
      description: "Договорённости и решения по текущим проектам.",
    }),
  );
  if (store?.id) {
    const notes = [
      ["/согласование.md", "Договоры свыше 500 000 рублей согласует финансовый директор. Остальные согласует руководитель подразделения."],
      ["/сроки-ответа.md", "Ответ на входящее обращение готовится в течение 5 рабочих дней. Срочные обращения помечаются отдельно."],
      ["/наставники.md", "Наставника новому сотруднику назначает руководитель отдела. Список наставников обновляется раз в квартал."],
    ];
    for (const [path, content] of notes) {
      await tryStep(`memory: ${path}`, () =>
        api("POST", `/v1/memory_stores/${store.id}/memories`, { path, content }),
      );
    }
  }

  const cards = [
    { provider: "ollama", model_id: "claude-sonnet-4-6", model: "claude-sonnet-4-6", base_url: "http://127.0.0.1:11434/v1", is_default: true },
    { provider: "vllm", model_id: "qwen-local", model: "qwen2.5-72b-instruct", base_url: "http://127.0.0.1:8000/v1", is_default: false },
  ];
  for (const c of cards) {
    await tryStep(`model card: ${c.model_id}`, () =>
      api("POST", "/v1/oma/model_cards", { ...c, api_key: "demo-key-not-real" }),
    );
  }

  const agents = [
    {
      name: "Документовед",
      description: "Регистрирует входящую и исходящую корреспонденцию, ведёт сроки и назначает исполнителей.",
      system: "Ты документовед. Регистрируй документы, проверяй сроки ответа и назначай исполнителей по справочнику. Если запись требует подтверждения, назови согласующего и сообщи, что запись ещё не выполнена.",
      skills: skillIds.slice(0, 1),
    },
    {
      name: "Ассистент HR",
      description: "Помогает оформить выход нового сотрудника: документы, доступы, оборудование и наставник.",
      system: "Ты ассистент отдела кадров. Веди чек-лист выхода сотрудника и напоминай о недостающих документах.",
      skills: skillIds.slice(1, 2),
    },
    {
      name: "Помощник проекта",
      description: "Собирает статусы по задачам проекта, готовит сводку для руководителя и напоминает о сроках.",
      system: "Ты помощник руководителя проекта. Собирай статусы, готовь краткие сводки и отмечай риски по срокам.",
      skills: [],
    },
    {
      name: "Аналитик договоров",
      description: "Сверяет условия договора с регламентом и выделяет пункты, которые требуют согласования.",
      system: "Ты аналитик договоров. Сверяй условия с регламентом компании и отмечай отклонения.",
      skills: [],
    },
  ];
  const agentIds = [];
  for (const a of agents) {
    const body = {
      name: a.name,
      description: a.description,
      model: "claude-sonnet-4-6",
      system: a.system,
      tools: [{ type: "agent_toolset_20260401" }],
    };
    if (a.skills.length) body.skills = a.skills.map((id) => ({ type: "custom", skill_id: id }));
    const created = await tryStep(`agent: ${a.name}`, () => api("POST", "/v1/agents", body));
    if (created?.id) agentIds.push(created.id);
  }

  if (envA?.id) {
    const titles = ["Входящее письмо от поставщика", "Выход нового сотрудника", "Сводка по проекту за неделю"];
    for (let i = 0; i < titles.length && i < agentIds.length; i++) {
      await tryStep(`session: ${titles[i]}`, () =>
        api("POST", "/v1/sessions", { agent: agentIds[i], environment_id: envA.id, title: titles[i] }),
      );
    }
  }
}

/* -------------------------------------------------------------- shoot --- */

const WIDTHS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["light", "dark"];

function pickChromium() {
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  const fallbacks = [];
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      fallbacks.push(join(cache, d, "chrome-linux64", "chrome"));
    }
  }
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  return fallbacks.find((p) => existsSync(p));
}

async function shoot() {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith(".png")) rmSync(join(outDir, f));
  const [agentsList, sessionsList, envsList, vaultsList, storesList] = await Promise.all([
    api("GET", "/v1/agents"),
    api("GET", "/v1/sessions"),
    api("GET", "/v1/environments"),
    api("GET", "/v1/vaults"),
    api("GET", "/v1/memory_stores"),
  ]);
  const firstAgent = agentsList.data?.find((a) => a.name === "Документовед") ?? agentsList.data?.[0];
  const firstSession = sessionsList.data?.[0];
  const firstEnv = envsList.data?.[0];
  const firstVault = vaultsList.data?.[0];
  const firstStore = storesList.data?.[0];

  const screens = [
    { name: "home", path: "/" },
    { name: "agents-list", path: "/agents" },
    { name: "agent-detail", path: firstAgent ? `/agents/${firstAgent.id}` : null },
    { name: "agent-create-dialog", path: "/agents", action: openAgentDialog },
    { name: "agent-create-form", path: "/agents", action: openAgentForm },
    { name: "sessions-list", path: "/sessions" },
    { name: "session-detail", path: firstSession ? `/sessions/${firstSession.id}` : null },
    { name: "environments", path: "/environments" },
    { name: "environment-detail", path: firstEnv ? `/environments/${firstEnv.id}` : null },
    { name: "skills", path: "/skills" },
    { name: "vaults", path: "/vaults" },
    { name: "vault-detail", path: firstVault ? `/vaults/${firstVault.id}` : null },
    { name: "memory", path: "/memory" },
    { name: "memory-detail", path: firstStore ? `/memory/${firstStore.id}` : null },
    { name: "model-cards", path: "/model-cards" },
    { name: "members", path: "/members" },
    { name: "members-stub", path: "/members", before: stubMembers },
    { name: "login", path: "/login" },
    { name: "mobile-menu", path: "/agents", only: "390", action: openMobileMenu },
  ];

  const exe = pickChromium();
  console.log(`chromium: ${exe}`);
  const browser = await chromium.launch({ executablePath: exe, args: ["--disable-gpu"] });
  const problems = [];
  const files = [];

  for (const theme of THEMES) {
    for (const w of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width: w.width, height: w.height },
        colorScheme: theme,
        locale: "ru-RU",
        deviceScaleFactor: 1,
      });
      await context.addInitScript((t) => {
        try {
          localStorage.setItem("theme", t);
        } catch {}
      }, theme);
      const page = await context.newPage();
      await mockAuth(page);
      let errors = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 240)}`);
      });
      page.on("response", (r) => {
        if (r.status() >= 400 && r.url().startsWith(BASE)) {
          errors.push(`http ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
        }
      });

      for (const s of screens) {
        const file = `${s.name}-${w.name}-${theme}.png`;
        if (s.only && s.only !== w.name) continue;
        if (!s.path) {
          problems.push(`${file}: нет данных для экрана (ресурс не создан), снимок пропущен`);
          continue;
        }
        errors = [];
        let cleanup = null;
        try {
          if (s.before) cleanup = await s.before(page);
          await page.goto(BASE + s.path, { waitUntil: "load", timeout: 30000 });
          // У страницы сессии открыт SSE-поток, сеть не затихает: ждём недолго.
          await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(900);
          await ensureTheme(page, theme);
          if (s.action) await s.action(page);
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(outDir, file), fullPage: false });
          files.push(file);
          const note = s.before ? "" : await diagnose(page, s, errors);
          if (note) problems.push(`${file}: ${note}`);
        } catch (e) {
          problems.push(`${file}: ${e.message.split("\n")[0]}`);
          try {
            await page.screenshot({ path: join(outDir, file), fullPage: false });
            files.push(file);
          } catch {}
        }
        if (cleanup) await cleanup();
      }
      await context.close();
    }
  }
  await browser.close();

  writeFileSync(join(outDir, "problems.json"), JSON.stringify({ files, problems }, null, 2));
  console.log(`\nснимков: ${files.length}`);
  console.log(problems.length ? "проблемы:\n- " + problems.join("\n- ") : "проблем нет");
}

/*
 * Сервер запущен с AUTH_DISABLED=1: маршрута /auth/* нет, и консоль без сессии
 * всегда уходит на страницу входа. Все запросы API при этом идут от арендатора
 * default. Чтобы открыть экраны, подменяем в браузере только ответ
 * /auth/get-session (учётная запись не создаётся, код консоли не меняется).
 * Для страницы входа сессию не подменяем, а ответ /auth-info дополняем:
 * при AUTH_DISABLED сервер не объявляет ни одного способа входа и форма пустая.
 */
async function mockAuth(page) {
  const now = () => new Date().toISOString();
  await page.route("**/auth/get-session", (route) => {
    const onLogin = page.url().includes("/login");
    if (onLogin) return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "shots-session",
          token: "shots-token",
          userId: "default",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          createdAt: now(),
          updatedAt: now(),
        },
        user: {
          id: "default",
          name: "Default User",
          email: "default@local",
          emailVerified: true,
          image: null,
          createdAt: now(),
          updatedAt: now(),
        },
      }),
    });
  });
  await page.route("**/auth-info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [], oidc: [], email_password: true, turnstile_site_key: null }),
    }),
  );
}

async function ensureTheme(page, theme) {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  if ((theme === "dark") !== isDark) {
    await page.evaluate((t) => {
      document.documentElement.classList.toggle("dark", t === "dark");
    }, theme);
    await page.waitForTimeout(200);
  }
}

async function openAgentDialog(page) {
  const btn = page.getByRole("button", { name: /нов(ый|ого) агент|создать агента/i }).first();
  await btn.click({ timeout: 8000 });
  await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
}

async function openMobileMenu(page) {
  await page.getByRole("button", { name: "Показать меню" }).click({ timeout: 8000 });
  await page.waitForTimeout(600);
}

async function openAgentForm(page) {
  await openAgentDialog(page);
  await page.getByText("Пустой агент", { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[role="dialog"], [role="dialog"] *')) {
      if (el.scrollTop > 0) el.scrollTop = 0;
    }
  });
  await page.waitForTimeout(200);
}

/*
 * Без настоящего входа список участников даёт 403 (в режиме AUTH_DISABLED
 * у пользователя default нет записи участника). Чтобы увидеть саму вёрстку
 * экрана, отдельным снимком подменяем в браузере ответы двух маршрутов.
 * Данные выдуманные, на сервер ничего не пишется.
 */
async function stubMembers(page) {
  const members = "**/v1/oma/tenants/*/members";
  const invitations = "**/v1/oma/tenants/*/invitations";
  await page.route(members, (route) =>
    route.request().method() !== "GET"
      ? route.continue()
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            role: "owner",
            user_id: "default",
            data: [
              { user_id: "default", name: "Default User", email: "default@local", role: "owner" },
              { user_id: "u-2", name: "Ирина Соколова", email: "i.sokolova@example.test", role: "admin" },
              { user_id: "u-3", name: "Павел Орлов", email: "p.orlov@example.test", role: "member" },
              { user_id: "u-4", name: "Мария Белова", email: "m.belova@example.test", role: "member" },
            ],
          }),
        }),
  );
  await page.route(invitations, (route) =>
    route.request().method() !== "GET"
      ? route.continue()
      : route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: [{ id: "inv-1", role: "member", expires_at: Date.now() + 6 * 86_400_000 }],
          }),
        }),
  );
  return async () => {
    await page.unroute(members);
    await page.unroute(invitations);
  };
}

async function diagnose(page, screen, errors) {
  const notes = [];
  const info = await page.evaluate(() => {
    const root = document.getElementById("root");
    const text = (document.body.innerText || "").trim();
    return {
      rootEmpty: !root || root.children.length === 0,
      textLength: text.length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      boundary: /что-то пошло не так|something went wrong|ошибка отображения/i.test(text),
      snippet: text.slice(0, 120).replace(/\s+/g, " "),
    };
  });
  if (info.rootEmpty) notes.push("пустой корень приложения");
  if (info.textLength < 20) notes.push(`почти нет текста (${info.textLength} симв.)`);
  if (info.boundary) notes.push(`сработал ErrorBoundary: ${info.snippet}`);
  if (info.overflowX > 1) notes.push(`горизонтальная прокрутка страницы (+${info.overflowX}px)`);
  // /branding/branding.json: 404 ожидаем, CONSOLE_BRANDING_DIR не задан, берутся значения по умолчанию.
  const real = errors.filter((e) => !/branding\.json/i.test(e) && !/^console: Failed to load resource/.test(e));
  if (real.length) notes.push(`ошибки: ${[...new Set(real)].slice(0, 4).join(" | ")}`);
  return notes.join("; ");
}

/* --------------------------------------------------------------- main --- */

const cmd = process.argv[2] ?? "all";
if (cmd === "seed" || cmd === "all") await seed();
if (cmd === "shoot" || cmd === "all") await shoot();
if (warnings.length) console.log("\nпредупреждения seed:\n- " + warnings.join("\n- "));
