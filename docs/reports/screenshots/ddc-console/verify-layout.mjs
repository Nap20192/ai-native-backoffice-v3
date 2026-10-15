// Проверка вёрстки консоли в браузере по всем экранам, обе ширины и обе темы.
//
// Дополняет platform/scripts/ddc-shots.mjs. Скрипт съёмки меряет горизонтальную
// прокрутку по document.documentElement, но у html, body и #root стоит
// overflow: hidden, и прокручивается только <main>. Поэтому переполнение на
// 390px он не находит. Здесь меряется сама прокручиваемая область (main и
// область строк списка) и ищутся элементы, выходящие за правый край окна.
//
// Запуск (сервер уже поднят на SQLite с AUTH_DISABLED=1, демо-данные созданы
// командой `node scripts/ddc-shots.mjs seed`):
//   cd platform && nice -n 15 node ../docs/reports/screenshots/ddc-console/verify-layout.mjs
//
// Результат: layout-check.json рядом со скриптом и краткий вывод в консоль.
// Скрипт ничего не пишет на сервер и снимков не делает.
import { createRequire } from "node:module";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const require = createRequire(join(repoRoot, "platform", "package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const BETAS = [
  "managed-agents-2026-04-01",
  "skills-2025-10-02",
  "agent-memory-2026-07-22",
  "files-api-2025-04-14",
].join(",");

async function api(path) {
  const res = await fetch(BASE + path, { headers: { "anthropic-beta": BETAS } });
  return res.json();
}

function pickChromium() {
  const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
  for (const d of readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
    const p = join(cache, d, "chrome-linux64", "chrome");
    if (existsSync(p)) return p;
  }
  return chromium.executablePath();
}

/* При AUTH_DISABLED консоль без сессии уходит на страницу входа: подменяем в
   браузере только ответ /auth/get-session, учётная запись не создаётся. */
async function mockAuth(page) {
  const now = () => new Date().toISOString();
  await page.route("**/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "check-session",
          token: "check-token",
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
    }),
  );
}

const [agents, sessions, envs, vaults, stores] = await Promise.all([
  api("/v1/agents"),
  api("/v1/sessions"),
  api("/v1/environments"),
  api("/v1/vaults"),
  api("/v1/memory_stores"),
]);

const routes = [
  ["/", "home"],
  ["/agents", "agents"],
  [agents.data?.[0] && `/agents/${agents.data[0].id}`, "agent-detail"],
  ["/sessions", "sessions"],
  [sessions.data?.[0] && `/sessions/${sessions.data[0].id}`, "session-detail"],
  ["/files", "files"],
  ["/evals", "evals"],
  ["/environments", "environments"],
  [envs.data?.[0] && `/environments/${envs.data[0].id}`, "environment-detail"],
  ["/skills", "skills"],
  ["/vaults", "vaults"],
  [vaults.data?.[0] && `/vaults/${vaults.data[0].id}`, "vault-detail"],
  ["/memory", "memory"],
  [stores.data?.[0] && `/memory/${stores.data[0].id}`, "memory-detail"],
  ["/model-cards", "model-cards"],
  ["/members", "members"],
  ["/api-keys", "api-keys"],
  ["/runtimes", "runtimes"],
].filter(([path]) => Boolean(path));

const DETAIL = /detail$/;
const browser = await chromium.launch({ executablePath: pickChromium(), args: ["--disable-gpu"] });
const results = [];

for (const [width, height] of [
  [1280, 800],
  [390, 844],
]) {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      locale: "ru-RU",
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("theme", t);
      } catch {}
    }, theme);
    const page = await context.newPage();
    await mockAuth(page);

    for (const [path, name] of routes) {
      await page.goto(BASE + path, { waitUntil: "load" });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => {
        const main = document.querySelector("main");
        const grid = document.querySelector(".console-data-grid-viewport");
        const th = document.querySelector("thead th");
        const thStyle = th ? getComputedStyle(th) : null;
        const outside = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            if (rect.right <= window.innerWidth + 1) return false;
            for (let p = el.parentElement; p; p = p.parentElement) {
              const style = getComputedStyle(p);
              if (p.classList.contains("console-sidebar-rail")) return false;
              if (style.position === "fixed" && p.getBoundingClientRect().right > window.innerWidth) return false;
              const clips = /(auto|scroll|hidden)/.test(style.overflowX);
              if (clips && p !== document.body && p !== document.documentElement) {
                if (p.getBoundingClientRect().right <= window.innerWidth + 1) return false;
              }
            }
            return true;
          })
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
        return {
          headings: [...document.querySelectorAll("h1")].map((el) => el.textContent.trim()),
          crumb: document.querySelector(".console-breadcrumb [aria-current=page]")?.textContent?.trim() ?? "",
          mainOverflowX: main ? main.scrollWidth - main.clientWidth : null,
          gridOverflowX: grid ? grid.scrollWidth - grid.clientWidth : null,
          headColor: thStyle?.color ?? null,
          headWeight: thStyle?.fontWeight ?? null,
          outside,
          integrationsText: /Linear|GitHub|Slack|Feishu/.test(document.body.innerText),
          rawIdText: /\b(agent|session|env|vlt|memstore|mdl)_[A-Za-z0-9_-]{6,}/.test(document.body.innerText),
        };
      });
      results.push({ screen: name, width, theme, ...info });
    }
    await context.close();
  }
}
await browser.close();

const problems = [];
for (const r of results) {
  const own = [];
  if (r.headings.length !== 1) own.push(`h1 на странице: ${JSON.stringify(r.headings)}`);
  if (r.mainOverflowX > 1) own.push(`горизонтальная прокрутка страницы +${r.mainOverflowX}px`);
  if (r.gridOverflowX > 1) own.push(`горизонтальная прокрутка списка +${r.gridOverflowX}px`);
  if (r.outside.length) own.push(`за правым краем окна: ${r.outside.join(", ")}`);
  if (r.integrationsText && r.screen !== "session-detail") own.push("на экране есть слова об интеграциях");
  if (r.rawIdText && !DETAIL.test(r.screen)) own.push("в тексте сырой id");
  if (/(agent|session|env|vlt|memstore)_/.test(r.crumb)) own.push(`в хлебной крошке сырой id: ${r.crumb}`);
  if (own.length) problems.push(`${r.screen}-${r.width}-${r.theme}: ${own.join("; ")}`);
}

writeFileSync(join(here, "layout-check.json"), JSON.stringify({ checked: results.length, problems, results }, null, 2));
console.log(`проверено экранов: ${results.length}`);
console.log(problems.length ? "проблемы:\n- " + problems.join("\n- ") : "проблем нет");
