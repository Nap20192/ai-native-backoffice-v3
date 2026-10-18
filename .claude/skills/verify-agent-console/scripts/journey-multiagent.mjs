#!/usr/bin/env node
// Сценарий «multiagent» verify-agent-console: шаги 1, Б и 2 плана docs/plans/multiagent.md.
// Playwright, консоль на русском, фейковая модель (маркеры VERIFY_DELEGATE и VERIFY_AGENT_RUN).
// План называл доказательство шага 1 скриптом journey-subagent-confirm.mjs: это он.
//   исходные объекты по API: окружение «Без ограничений», субагент «проверяющий» с bash на
//     always_ask, основной агент с блоком coordinator, агент для предела;
//   шаг 1 (сессия из консоли, реплика из консоли): основной агент передаёт задачу субагенту, bash
//     субагента ждёт человека (ma.subagent_waits); страница сессии показывает «Разрешить» в потоке
//     субагента (ma.ui_subagent_confirm), иначе «Разрешить» идёт по API с session_thread_id;
//     вызов исполняется один раз в потоке субагента (ma.subagent_allow_once), основной поток
//     получает agent.thread_message_received и модель читает отчёт (ma.subagent_report),
//     второе «Разрешить» ничего не запускает (ma.subagent_repeat_allow_none);
//   шаг Б: счётчики _oma.limits растут по всем потокам (ma.limits_count, ma.limits_grow), сессия с
//     max_tokens 1 встаёт на budget_reached (ma.limit_stop), реплику по API сервер не берёт
//     (ma.limit_refuses_message), шапка пишет заметку без чисел и кнопку «Поднять предел»
//     (ma.limit_ui_note, снимки 1280 и 390), отправка из консоли не уходит (ma.limit_ui_send_refused),
//     кнопка поднимает предел вдвое и ход продолжается без повтора bash (ma.limit_raise);
//   шаг 2: агент с блоком multiagent_20261001 по API, умолчания и закрепление ссылок
//     (ma.block_api), три отказа 400 (ma.block_invalid), вкладка «Мультиагентность» формы на 1280 и
//     390 и сохранение без потери блока (ma.block_form), сессия копирует тип (ma.block_session_copy),
//     делегирование идёт как у coordinator (ma.block_delegation).
// Журнал основного потока сессии с делегированием читается из SQLite прогона (managed_session_events):
// GET /v1/sessions/:id/events на такой сессии отвечает 500 (находка 5 ревью, см. features/multiagent.md).
// Запуск: scripts/journey.sh --run <RUN_ID> --scenario multiagent. Итог: $EVIDENCE_DIR/summary.md.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------- прогон ---
const SKILL_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const RUN_DIR = (() => {
  const dir = process.env.VERIFY_RUN_DIR ?? "";
  if (!dir || !existsSync(join(dir, ".verify-agent-console-run"))) {
    throw new Error("прогон не задан: VERIFY_RUN_DIR=<папка прогона> (scripts/journey.sh --run <RUN_ID> --scenario multiagent задаёт её сам)");
  }
  return dir;
})();
const run = Object.fromEntries(
  readFileSync(join(RUN_DIR, "run.env"), "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const user = JSON.parse(readFileSync(join(RUN_DIR, "state", "test-user.json"), "utf8"));
const EV = run.EVIDENCE_DIR;
for (const sub of ["screens", "aria", "api", "logs"]) mkdirSync(join(EV, sub), { recursive: true });
const BASE = run.BASE_URL;
const MODEL = run.AGENT_MODEL;
const VIEW = { width: 1280, height: 860 };
const NARROW = { width: 390, height: 844 };
const MAX_SHOT_HEIGHT = 6000;
const TURN_TIMEOUT = Number(process.env.VERIFY_TURN_TIMEOUT_MS ?? 600_000);
const KEEP_SESSION = process.env.VERIFY_KEEP_SESSION === "1";
const BETAS = ["managed-agents-2026-04-01", "files-api-2025-04-14", "skills-2025-10-02", "agent-memory-2026-07-22"].join(",");
if (run.MODEL_MODE !== "fake") throw new Error("сценарий multiagent идёт на экземпляре в режиме fake (VERIFY_MODEL_MODE=fake)");
if (!run.DB_PATH || !existsSync(run.DB_PATH)) throw new Error(`нет базы прогона ${run.DB_PATH}`);

const nonce = randomBytes(4).toString("hex");
const names = {
  env: `ma-env-${nonce}`,
  child: `ma-checker-${nonce}`,
  coordinator: `ma-coordinator-${nonce}`,
  block: `ma-block-${nonce}`,
  limited: `ma-limited-${nonce}`,
  sessionA: `ma-coordinator-session-${nonce}`,
  sessionB: `ma-block-session-${nonce}`,
  sessionL: `ma-limit-session-${nonce}`,
};
const turns = { coordinator: `${nonce}c1`, block: `${nonce}b1`, limit: `${nonce}l1` };
// Fake отвечает на каждый запрос с usage 10 на входе и 5 на выходе (scripts/fake-model.mjs, sse).
const TOKENS_PER_REQUEST = 15;
const LIMIT_NOTE = "Предел работы сессии исчерпан, агент остановился.";
const WAITING_TEXT = "The subagent is waiting for a tool confirmation. Its report will arrive as a separate message.";
// Слова расхода из тестов консоли (SessionHeader.test.tsx) и из session.ui_no_usage главного сценария.
const USAGE_WORDS = /токен|стоимост|бюджет|нет цены|кэш|\$|₽|руб|цент/i;
const ids = {};
const created = { sessions: [], agents: [], environments: [] };
const covered = new Set();
const cover = (...list) => list.forEach((id) => covered.add(id));

const require = createRequire(join(run.PLATFORM_DIR, "package.json"));
const { chromium } = require("@playwright/test");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.log(new Date().toTimeString().slice(0, 8), ...parts);

// --------------------------------------------------------------- проверки ---
const checks = [];
const plain = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
function record(id, title, status, evidence = "", note = "") {
  checks.push({ id, title, status, evidence: plain(evidence), note: plain(note) });
  log(`${status.padEnd(12)} ${id}: ${title}${note ? ` (${plain(note)})` : ""}`);
}
async function check(id, title, fn) {
  try {
    record(id, title, "проверено", (await fn()) ?? "");
    return true;
  } catch (error) {
    record(id, title, "провал", "", error.message);
    if (page) await shot(`fail-${id}`).catch(() => {});
    return false;
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ----------------------------------------------------------- доказательства ---
let shotN = 0;
let page;
let context;
let browser;
const screens = [];
let lastStepShot = null;
const duplicateShots = [];
async function hiddenScrollHeight(p) {
  return p.evaluate(() => {
    let extra = 0;
    for (const el of document.querySelectorAll("main")) extra = Math.max(extra, el.scrollHeight - el.clientHeight);
    return extra;
  }).catch(() => 0);
}
async function shot(name, p = page) {
  const file = `screens/${String(++shotN).padStart(2, "0")}-ma-${name}.png`;
  const size = p.viewportSize() ?? VIEW;
  const modal = await p.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
  const extra = size.width >= 1000 && !modal ? await hiddenScrollHeight(p) : 0;
  const tall = extra > 4;
  if (tall) {
    await p.setViewportSize({ width: size.width, height: Math.min(size.height + extra, MAX_SHOT_HEIGHT) });
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  let buffer;
  try {
    buffer = await p.screenshot({ path: join(EV, file), fullPage: true });
  } finally {
    if (tall) await p.setViewportSize(size);
  }
  const sha = createHash("sha256").update(buffer).digest("hex");
  const isStep = !/^(fail-|abort$)/.test(name);
  if (isStep && lastStepShot?.sha === sha) duplicateShots.push(`${lastStepShot.file} = ${file}`);
  if (isStep) lastStepShot = { file, sha };
  screens.push({ file, sha, tall: tall ? Math.min(size.height + extra, MAX_SHOT_HEIGHT) : 0 });
  return file;
}
async function aria(name, locator) {
  const file = `aria/${String(shotN).padStart(2, "0")}-ma-${name}.yml`;
  writeFileSync(join(EV, file), await (locator ?? page.locator("body")).ariaSnapshot());
  return file;
}
function saveJson(name, data) {
  const file = `api/ma-${name}.json`;
  writeFileSync(join(EV, file), JSON.stringify(data, null, 2));
  return file;
}
function saveCreated() {
  writeFileSync(join(RUN_DIR, "state", "created.json"), JSON.stringify(created, null, 2));
}
/** Горизонтальная прокрутка страницы и её частей на узком экране. */
async function horizontalOverflow(selectors) {
  return page.evaluate((list) => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`страница ${doc.scrollWidth} > ${doc.clientWidth}`);
    for (const selector of list) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${selector} ${el.scrollWidth} > ${el.clientWidth}`);
      }
    }
    return out;
  }, selectors);
}

// -------------------------------------------------------------------- API ---
function parseBody(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}
async function apiRaw(method, path, body) {
  const res = await context.request.fetch(BASE + path, {
    method,
    headers: { "anthropic-beta": BETAS, origin: BASE, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    data: body === undefined ? undefined : JSON.stringify(body),
    failOnStatusCode: false,
  });
  const text = await res.text();
  return { status: res.status(), json: parseBody(text), text };
}
async function api(method, path, body) {
  const r = await apiRaw(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}
async function listPages(path) {
  const all = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "100", order: "asc" });
    if (cursor) q.set("page", cursor);
    const r = await apiRaw("GET", `${path}?${q}`);
    if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${r.text.slice(0, 300)}`);
    all.push(...(r.json.data ?? []));
    if (!r.json.next_page) break;
    cursor = r.json.next_page;
  }
  return all;
}
const listEvents = (sessionId) => listPages(`/v1/sessions/${sessionId}/events`);
const threadEvents = (sessionId, threadId) => listPages(`/v1/sessions/${sessionId}/threads/${threadId}/events`);
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n");
}
async function waitFor(what, probe, timeout = 60_000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - t0 > timeout) throw new Error(`нет за ${Math.round(timeout / 1000)} с: ${what}`);
    await sleep(every);
  }
}
/** Первый session.status_idle после события с индексом from, по API (сессии без делегирования). */
async function waitIdle(sessionId, from, label) {
  let events = [];
  let lastLog = 0;
  const t0 = Date.now();
  const idle = await waitFor(`session.status_idle (${label})`, async () => {
    events = await listEvents(sessionId);
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`${label}: ждём конец хода, событий ${events.length}, последнее ${events.at(-1)?.type ?? "нет"}, ${Math.round((Date.now() - t0) / 1000)} с`);
    }
    return events.slice(from).find((e) => e.type === "session.status_idle" || e.type === "session.status_terminated");
  }, TURN_TIMEOUT, 1000);
  return { idle, stop: idle.stop_reason?.type ?? null, events, after: events.slice(from) };
}

// ---------------------------------------------------------- журнал из SQLite ---
// GET /v1/sessions/:id/events отвечает 500 на сессии с call_agent_* (находка 5 ревью), поэтому
// журнал основного потока таких сессий читается из базы прогона, только чтением (sqlite3 -readonly).
// Документы там во внутреннем виде: поля camelCase (stopReason.eventIds, toolUseId, fromSessionThreadId).
// Сервер пишет в ту же базу: на занятой базе sqlite3 ждёт до 5 с (.timeout) и повторяет запрос.
function dbEvents(sessionId) {
  assert(/^session_[A-Za-z0-9_-]+$/.test(sessionId), `странный id сессии ${sessionId}`);
  const query = `SELECT thread_id, type, document FROM managed_session_events WHERE session_id = '${sessionId}' ORDER BY processed_at, rowid`;
  let out;
  for (let attempt = 1; ; attempt++) {
    try {
      out = execFileSync("sqlite3", ["-readonly", "-json", "-cmd", ".timeout 5000", run.DB_PATH, query],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      break;
    } catch (error) {
      if (attempt >= 5 || !/locked|busy/i.test(String(error.stderr ?? error.message))) throw error;
      execFileSync("sleep", ["0.5"]);
    }
  }
  const rows = out.trim() ? JSON.parse(out) : [];
  return rows.map((row) => {
    const doc = JSON.parse(row.document);
    const thread = doc.sessionThreadId ?? (row.thread_id && row.thread_id !== "sthr_primary" ? row.thread_id : "sthr_primary");
    return { ...doc, type: row.type, thread };
  });
}
async function waitIdleDb(sessionId, from, label) {
  let events = [];
  let lastLog = 0;
  const t0 = Date.now();
  const idle = await waitFor(`session.status_idle (${label})`, async () => {
    events = dbEvents(sessionId);
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(`${label}: ждём конец хода, событий ${events.length}, последнее ${events.at(-1)?.type ?? "нет"}, ${Math.round((Date.now() - t0) / 1000)} с`);
    }
    return events.slice(from).find((e) => e.type === "session.status_idle" || e.type === "session.status_terminated");
  }, TURN_TIMEOUT, 1000);
  return { idle, stop: idle.stopReason?.type ?? null, events, after: events.slice(from) };
}
const primary = (events) => events.filter((e) => e.thread === "sthr_primary");
const ofThread = (events, threadId) => events.filter((e) => e.thread === threadId);

// ------------------------------------------------------------ журналы фейков ---
function jsonl(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { unparsed: line };
    }
  });
}
const modelRequests = (n) => jsonl(run.FAKE_REQUESTS).filter((r) => r.nonce === n);
const callAgentTool = (agentId) => `call_agent_${agentId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
const outputFile = (n) => `sub-${n}.txt`;
const delegatePrompt = (n, agentId) => [
  `VERIFY_DELEGATE nonce=${n}`,
  `Агент: ${agentId}`,
  `Команда субагента: echo VERIFY_OK_${n} >> /mnt/session/outputs/${outputFile(n)}; cat /mnt/session/outputs/${outputFile(n)}`,
].join("\n");
const limitPrompt = (n) => [
  `VERIFY_AGENT_RUN nonce=${n}`,
  `Команда: echo VERIFY_OK_${n} >> /mnt/session/outputs/${outputFile(n)}; cat /mnt/session/outputs/${outputFile(n)}`,
].join("\n");
/** Строки файла, который bash записал в /mnt/session/outputs; null, если файла на хосте нет. */
function outputLines(sessionId, n) {
  const file = join(run.SESSION_OUTPUTS_DIR, user.tenant_id, sessionId, outputFile(n));
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}
async function limitsOf(sessionId) {
  return (await api("GET", `/v1/sessions/${sessionId}`))?._oma?.limits ?? null;
}

// --------------------------------------------------------------- браузер ---
function pickChromium() {
  if (process.env.VERIFY_CHROMIUM) return process.env.VERIFY_CHROMIUM;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  const cache = join(os.homedir(), ".cache", "ms-playwright");
  const revs = existsSync(cache)
    ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))
    : [];
  const complete = revs.filter((d) => existsSync(join(cache, d, "INSTALLATION_COMPLETE")));
  for (const d of [...complete, ...revs]) {
    const exe = join(cache, d, "chrome-linux64", "chrome");
    if (existsSync(exe)) return exe;
  }
  if (existsSync("/usr/bin/google-chrome-stable")) return "/usr/bin/google-chrome-stable";
  throw new Error("не найден Chromium: задайте VERIFY_CHROMIUM или выполните в platform: pnpm exec playwright install chromium");
}
function procStat(pid) {
  try {
    const rest = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ");
    return { ppid: Number(rest[1]), start: rest[19] };
  } catch {
    return null;
  }
}
function recordJourneyChildren() {
  const lines = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const chain = [];
    for (let p = pid; p > 1 && chain.length < 32; ) {
      chain.push(p);
      const st = procStat(p);
      if (!st) break;
      p = st.ppid;
    }
    if (!chain.slice(1).includes(process.pid)) continue;
    const st = procStat(pid);
    if (st) lines.push(`journey-child ${pid} ${st.start}`);
  }
  if (lines.length) appendFileSync(join(RUN_DIR, "state", "pids"), lines.join("\n") + "\n");
  return lines.length;
}

// --------------------------------------------------------------- страницы ---
const main = () => page.getByRole("main");
const nav = () => page.getByRole("navigation", { name: "Разделы консоли" });
async function openSection(link, emptyText) {
  await nav().getByRole("link", { name: link, exact: true }).click();
  await main().getByRole("heading", { level: 1, name: link, exact: true }).waitFor();
  await page.getByText(emptyText, { exact: true })
    .or(page.locator('[data-testid="data-body-table"] tr[data-slot="table-row"]')).first().waitFor();
}
async function pickCombobox(dialog, index, id) {
  const box = dialog.getByRole("combobox").nth(index);
  await box.click();
  const option = page.locator('[data-slot="command-item"]').filter({ hasText: id }).first();
  await option.waitFor({ timeout: 15_000 });
  await option.click();
  await box.filter({ hasText: id }).waitFor({ timeout: 10_000 });
}
// Блок над полем ввода (ToolConfirmationRequests.tsx). Консоль показывает в нём вызовы выбранного потока.
const confirmations = () => page.getByRole("group", { name: "Ожидает подтверждения" });
const confirmationItem = (tool) => confirmations().getByRole("listitem").filter({ hasText: tool });
async function sendMessage(text) {
  const box = page.getByRole("textbox", { name: "Сообщение" });
  await box.fill(text);
  const send = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await send.click();
  for (let i = 0; i < 20 && (await box.inputValue()) !== ""; i++) await sleep(250);
}
const inspector = () => page.getByRole("complementary", { name: "Инспектор сессии" });
const sessionHeader = () => main().locator("header", { has: page.getByRole("heading", { level: 1 }) }).first();
const limitNote = () => page.locator('[data-session-note="limit"]');
/** Ответы консоли на GET /v1/sessions/:id/events: на сессии с делегированием там 500 (находка 5). */
const eventResponses = [];

// ------------------------------------------------------------------- шаги ---
async function stepLogin() {
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (/^\/v1\/sessions\/[^/]+\/events$/.test(url.pathname) && response.request().method() === "GET") {
      eventResponses.push({ session: url.pathname.split("/")[3], status: response.status() });
    }
  });
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Продолжить с почтой" }).click();
  await page.locator("#auth-email").fill(user.email);
  await page.locator("#auth-password").fill(user.password);
  await page.getByRole("group", { name: "Действия входа" }).getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await nav().waitFor();
  const me = await api("GET", "/v1/oma/me");
  await check("ma.auth", "вход в консоль тестовой учёткой", () => {
    assert(me.user?.id === user.user_id && me.tenant?.id === user.tenant_id, `me ${me.user?.id} ${me.tenant?.id}`);
    return "GET /v1/oma/me";
  });
}

/** Исходные объекты по API: окружение и агентов из формы проверяют главный сценарий и mcp-ask. */
async function stepSeed() {
  ids.env = (await api("POST", "/v1/environments", { name: names.env, config: { type: "cloud", networking: { type: "unrestricted" } } })).id;
  created.environments.push(ids.env);
  saveCreated();
  const child = await api("POST", "/v1/agents", {
    name: names.child,
    model: MODEL,
    description: "Проверяющий: выполняет присланную команду в bash",
    system: "Ты проверяющий агент. Выполни присланную команду в bash и перескажи итог.",
    tools: [{ type: "agent_toolset_20260401", configs: [{ name: "bash", permission_policy: { type: "always_ask" } }] }],
  });
  ids.child = child.id;
  ids.childVersion = child.version;
  const coordinator = await api("POST", "/v1/agents", {
    name: names.coordinator,
    model: MODEL,
    system: "Ты основной агент. Передавай проверку субагенту и перескажи его отчёт.",
    tools: [{ type: "agent_toolset_20260401" }],
    multiagent: { type: "coordinator", agents: [{ type: "agent", id: ids.child }] },
  });
  ids.coordinator = coordinator.id;
  const limited = await api("POST", "/v1/agents", {
    name: names.limited,
    model: MODEL,
    system: "Ты агент проверки. Выполняй присланную команду в bash.",
    tools: [{ type: "agent_toolset_20260401" }],
  });
  ids.limited = limited.id;
  created.agents.push(ids.child, ids.coordinator, ids.limited);
  saveCreated();
  const file = saveJson("01-seed-agents", { child, coordinator, limited });
  await check("ma.seed", "исходные объекты по API: окружение «Без ограничений», субагент с bash на always_ask, основной агент с блоком coordinator, агент для предела", () => {
    const bash = (child.tools ?? []).flatMap((t) => t.configs ?? []).find((c) => c.name === "bash");
    assert(bash?.permission_policy?.type === "always_ask", `политика bash субагента: ${JSON.stringify(bash ?? null)}`);
    assert(coordinator.multiagent?.type === "coordinator", `multiagent основного агента: ${JSON.stringify(coordinator.multiagent)}`);
    const listed = (coordinator.multiagent.agents ?? []).map((a) => (typeof a === "string" ? a : a.id));
    assert(listed.includes(ids.child), `субагента нет в списке coordinator: ${JSON.stringify(coordinator.multiagent.agents)}`);
    return `окружение ${ids.env}, субагент ${ids.child}, основной ${ids.coordinator}, для предела ${ids.limited}; ${file}`;
  });
}

/**
 * Факты делегирования с ожиданием: поток субагента, его bash, остановка потока и сессии.
 * events это журнал из базы, childEvents это журнал потока по API.
 */
function delegationWaitFacts({ n, agentId, turn, childThread, childEvents, sessionNow, sessionId }) {
  const facts = [];
  const bash = childEvents.find((e) => e.type === "agent.tool_use" && e.name === "bash");
  const threadIdle = childEvents.filter((e) => e.type === "session.thread_status_idle").at(-1);
  if (!childThread) facts.push("в GET /threads нет потока субагента");
  if (!bash) facts.push("в потоке субагента нет agent.tool_use bash");
  else if (bash.evaluated_permission !== "ask") facts.push(`evaluated_permission bash ${bash.evaluated_permission ?? "нет"}, ожидалось ask`);
  if (bash && childEvents.some((e) => e.type === "agent.tool_result" && e.tool_use_id === bash.id)) facts.push("у bash уже есть agent.tool_result: вызов ушёл без человека");
  if (threadIdle?.stop_reason?.type !== "requires_action") facts.push(`поток субагента встал с ${threadIdle?.stop_reason?.type ?? "нет session.thread_status_idle"}, ожидался requires_action`);
  else if (JSON.stringify(threadIdle.stop_reason.event_ids) !== JSON.stringify([bash?.id])) facts.push(`event_ids потока ${JSON.stringify(threadIdle.stop_reason.event_ids)}, ожидался [${bash?.id}]`);
  if (turn.stop !== "requires_action") facts.push(`сессия встала с ${turn.stop}, ожидался requires_action`);
  else if (JSON.stringify(turn.idle.stopReason.eventIds) !== JSON.stringify([bash?.id])) facts.push(`event_ids сессии ${JSON.stringify(turn.idle.stopReason.eventIds)}, ожидался [${bash?.id}]`);
  const main = primary(turn.events);
  const call = main.find((e) => e.type === "agent.tool_use" && e.name === callAgentTool(agentId));
  const callResult = call && main.find((e) => e.type === "agent.tool_result" && e.toolUseId === call.id);
  if (!call) facts.push(`в основном потоке нет agent.tool_use ${callAgentTool(agentId)}`);
  else if (!textOf(callResult?.content).includes(WAITING_TEXT)) facts.push(`результат call_agent: ${textOf(callResult?.content).slice(0, 160) || "нет"}`);
  if (!main.some((e) => e.type === "agent.message" && textOf(e.content).includes(`VERIFY_DELEGATE_WAITING_${n}`))) facts.push(`нет ответа VERIFY_DELEGATE_WAITING_${n} основного агента`);
  if (sessionNow.status !== "idle") facts.push(`GET /v1/sessions/:id status ${sessionNow.status}`);
  if (outputLines(sessionId, n) !== null) facts.push(`файл ${outputFile(n)} уже есть на хосте: bash исполнился до подтверждения`);
  return { facts, bash };
}

/** Счётчики предела против журнала: 15 токенов на запрос к фейку, ход на каждый запуск потока субагента. */
function limitFacts(limits, events, nonces) {
  const requests = nonces.flatMap((n) => modelRequests(n)).length;
  const childRuns = events.filter((e) => e.type === "session.thread_status_running" && e.thread !== "sthr_primary").length;
  const facts = [];
  if (!limits) facts.push("в GET /v1/sessions/:id нет _oma.limits");
  else {
    if (limits.used_tokens !== TOKENS_PER_REQUEST * requests) facts.push(`used_tokens ${limits.used_tokens}, а запросов к фейку ${requests} по ${TOKENS_PER_REQUEST}`);
    if (limits.used_child_turns !== childRuns) facts.push(`used_child_turns ${limits.used_child_turns}, а session.thread_status_running потоков субагентов ${childRuns}`);
  }
  return { facts, requests, childRuns };
}

/** Шаг 1: основной агент передаёт задачу, bash субагента ждёт человека. Сессия и реплика из консоли. */
async function stepDelegateWaits() {
  const n = turns.coordinator;
  await openSection("Сессии", "Сессий пока нет");
  await page.getByRole("button", { name: "Новая сессия" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новая сессия" });
  await dialog.waitFor();
  await pickCombobox(dialog, 0, ids.coordinator);
  await pickCombobox(dialog, 1, ids.env);
  await dialog.locator("#session-title").fill(names.sessionA);
  const dialogShot = await shot("coordinator-session-dialog");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  ids.sessionA = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.sessions.push(ids.sessionA);
  saveCreated();
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  const before = dbEvents(ids.sessionA).length;
  await sendMessage(delegatePrompt(n, ids.child));
  const turn = await waitIdleDb(ids.sessionA, before, "делегирование");
  const threads = (await api("GET", `/v1/sessions/${ids.sessionA}/threads?limit=100`)).data ?? [];
  const childThread = threads.find((t) => t.agent?.id === ids.child || t.agent?.name === names.child);
  ids.threadA = childThread?.id ?? null;
  const childEvents = ids.threadA ? await threadEvents(ids.sessionA, ids.threadA) : [];
  const sessionNow = await api("GET", `/v1/sessions/${ids.sessionA}`);
  const files = [
    saveJson("10-coordinator-db-events", turn.events),
    saveJson("10b-coordinator-threads", threads),
    saveJson("10c-coordinator-child-thread-events", childEvents),
    saveJson("10d-coordinator-session", sessionNow),
  ];
  const { facts, bash } = delegationWaitFacts({ n, agentId: ids.child, turn, childThread, childEvents, sessionNow, sessionId: ids.sessionA });
  ids.bashA = bash?.id ?? null;
  const waits = await check("ma.subagent_waits", "реплика из консоли: основной агент (coordinator) вызывает call_agent, bash субагента на always_ask ждёт человека: поток субагента встал на requires_action с event_ids [bash], сессия тоже, call_agent вернул текст ожидания, файла в /mnt/session/outputs нет", () => {
    assert(facts.length === 0, facts.join("; "));
    return `${dialogShot}, ${files.join(", ")}; поток ${ids.threadA}, вызов ${ids.bashA}`;
  });
  const limits = await limitsOf(ids.sessionA);
  ids.limitsA1 = limits;
  const counted = limitFacts(limits, turn.events, [n]);
  const limitsFile = saveJson("10e-coordinator-limits-turn1", limits);
  await check("ma.limits_count", "_oma.limits после хода с делегированием: used_tokens считает запросы основного потока и субагента (15 на запрос фейка), used_child_turns равен числу запусков потока субагента", () => {
    assert(counted.facts.length === 0, counted.facts.join("; "));
    return `${limitsFile}: used_tokens ${limits.used_tokens} (${counted.requests} запросов), used_child_turns ${limits.used_child_turns}, max_tokens ${limits.max_tokens}, max_child_turns ${limits.max_child_turns}`;
  });
  if (ids.bashA && ids.threadA) {
    const wrong = await apiRaw("POST", `/v1/sessions/${ids.sessionA}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: ids.bashA, result: "allow", session_thread_id: "sthr_primary" }],
    });
    const wrongFile = saveJson("10f-wrong-thread-response", { status: wrong.status, body: wrong.json });
    await check("ma.subagent_wrong_thread", "«Разрешить» с чужим session_thread_id (sthr_primary для вызова субагента) получает 400 invalid_request_error и ничего не запускает", async () => {
      assert(wrong.status === 400 && wrong.json?.error?.type === "invalid_request_error", `ответ ${wrong.status} ${wrong.text.slice(0, 200)}`);
      assert(String(wrong.json.error.message).includes(ids.threadA), `в отказе нет потока вызова: ${wrong.json.error.message}`);
      await sleep(1500);
      assert(!dbEvents(ids.sessionA).some((e) => e.type === "user.tool_confirmation"), "в журнале появился user.tool_confirmation");
      return `${wrongFile}: ${wrong.json.error.message}`;
    });
  }
  if (waits) cover("subagent-confirm-waits");
  return waits;
}

/**
 * Страница сессии с делегированием: в потоке субагента должен быть блок «Ожидает подтверждения» с
 * bash и кнопкой «Разрешить». Сначала живая страница, затем свежая загрузка. Если блок есть, клик
 * «Разрешить» и есть подтверждение шага 1; если нет, шаг «разрешить» идёт по API.
 */
async function stepUiSubagent() {
  const n = turns.coordinator;
  ids.allowBefore = dbEvents(ids.sessionA).length;
  const findBlock = async () => {
    await inspector().getByRole("tab", { name: "Потоки", exact: true }).click();
    const table = inspector().getByRole("table", { name: "Потоки" });
    await table.waitFor({ timeout: 15_000 });
    const row = table.locator("tbody tr").filter({ hasText: names.child }).first();
    const rowSeen = await row.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    if (rowSeen) await row.click();
    const block = await confirmationItem("bash").first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    return { rowSeen, block };
  };
  const live = await findBlock();
  const liveShot = await shot("coordinator-page-live");
  let reload = null;
  let reloadShot = null;
  if (!live.block) {
    eventResponses.length = 0;
    await page.goto(`${BASE}/sessions/${encodeURIComponent(ids.sessionA)}`);
    await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
    const conversation = await page.getByText(`VERIFY_DELEGATE nonce=${n}`).first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    reload = { ...(await findBlock()), conversation };
    reloadShot = await shot("coordinator-page-reload");
  }
  const block = live.block || reload?.block;
  if (block) {
    await confirmationItem("bash").first().getByRole("button", { name: "Разрешить", exact: true }).click();
    ids.allowPath = "консоль";
  }
  const listed = await apiRaw("GET", `/v1/sessions/${ids.sessionA}/events?limit=100&order=asc`);
  const listedFile = saveJson("11-coordinator-events-list-response", { status: listed.status, body: listed.json });
  const ok = await check("ma.ui_subagent_confirm", "страница сессии с делегированием показывает ход, а в потоке субагента (вкладка «Потоки») блок «Ожидает подтверждения» с bash и кнопкой «Разрешить»: живьём после реплики и после свежей загрузки", () => {
    const facts = [];
    if (!live.block) facts.push(`живьём: строка потока ${live.rowSeen ? "есть" : "нет"}, блока «Ожидает подтверждения» с bash в потоке нет`);
    if (reload && !reload.block) facts.push(`после загрузки: реплики VERIFY_DELEGATE в ленте ${reload.conversation ? "есть" : "нет"}, блока с bash нет`);
    const failed = eventResponses.filter((r) => r.session === ids.sessionA && r.status >= 400);
    if (failed.length) facts.push(`консоль получила ${failed.map((r) => r.status).join(", ")} на GET /v1/sessions/:id/events`);
    if (listed.status !== 200) facts.push(`GET /v1/sessions/:id/events -> ${listed.status}: ${String(listed.json?.error?.message ?? listed.text).slice(0, 220)}`);
    assert(block && listed.status === 200, `${facts.join("; ")}. Находка 5 ревью: Pi пишет свой agent.thread_message_sent с to_thread_id (apps/agent/src/harness/tool-events.ts), и схема ответа его не принимает; убрать это событие должен срез 2 шага 3.3 плана`);
    return `${liveShot}${reloadShot ? `, ${reloadShot}` : ""}, ${listedFile}`;
  });
  if (ok) cover("subagent-confirm-ui");
  return ok;
}

/** «Разрешить» в потоке субагента: клик в консоли, если блок был, иначе API с session_thread_id. */
async function stepAllow() {
  const n = turns.coordinator;
  assert(ids.bashA && ids.threadA, "нет вызова bash субагента или его потока");
  const before = ids.allowBefore ?? dbEvents(ids.sessionA).length;
  let sent = null;
  if (ids.allowPath !== "консоль") {
    sent = await apiRaw("POST", `/v1/sessions/${ids.sessionA}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: ids.bashA, result: "allow", session_thread_id: ids.threadA }],
    });
    saveJson("12-allow-response", { status: sent.status, body: sent.json });
    assert(sent.status < 300, `«Разрешить» по API: ${sent.status} ${sent.text.slice(0, 200)}`);
    ids.allowPath = "API с session_thread_id";
  }
  const turn = await waitIdleDb(ids.sessionA, before, "ход после «Разрешить»");
  await sleep(1500);
  const all = dbEvents(ids.sessionA);
  const childEvents = await threadEvents(ids.sessionA, ids.threadA);
  const files = [saveJson("12b-coordinator-db-events-allow", all), saveJson("12c-coordinator-child-thread-allow", childEvents)];
  const results = all.filter((e) => e.type === "agent.tool_result" && e.toolUseId === ids.bashA);
  const confirmation = all.find((e) => e.type === "user.tool_confirmation" && e.toolUseId === ids.bashA);
  const childRuns = modelRequests(n).filter((r) => r.kind === "AGENT_RUN");
  const lines = outputLines(ids.sessionA, n);
  const ok = await check("ma.subagent_allow_once", `«Разрешить» (${ids.allowPath}) исполняет bash один раз в потоке субагента: один agent.tool_result с потоком субагента и VERIFY_OK, в файле одна строка, субагент продолжает ход без нового сообщения и кончает end_turn`, () => {
    assert(confirmation?.result === "allow" && confirmation.sessionThreadId === ids.threadA, `user.tool_confirmation: ${JSON.stringify(confirmation ?? null)}`);
    assert(results.length === 1, `agent.tool_result у bash ${ids.bashA}: ${results.length}`);
    assert(results[0].thread === ids.threadA, `agent.tool_result в потоке ${results[0].thread}, ожидался ${ids.threadA}`);
    assert(childEvents.some((e) => e.type === "agent.tool_result" && e.tool_use_id === ids.bashA), "в журнале потока по API нет agent.tool_result bash");
    assert(results[0].isError !== true && textOf(results[0].content).includes(`VERIFY_OK_${n}`), `результат bash: ${textOf(results[0].content).slice(0, 200)}`);
    assert(childRuns.filter((r) => r.decision === "tool_use").length === 1, `bash субагент просил ${childRuns.filter((r) => r.decision === "tool_use").length} раз`);
    assert(childRuns.some((r) => r.decision === "final_text" && r.tool_result_has_marker === true), "субагент не получил результат bash с VERIFY_OK");
    assert(JSON.stringify(lines) === JSON.stringify([`VERIFY_OK_${n}`]), `файл ${outputFile(n)} на хосте: ${JSON.stringify(lines)}`);
    const childAfter = childEvents.filter((e) => e.type === "session.thread_status_idle").at(-1);
    assert(childAfter?.stop_reason?.type === "end_turn", `поток субагента встал с ${childAfter?.stop_reason?.type}`);
    assert(childEvents.some((e) => e.type === "agent.message" && textOf(e.content).includes(`VERIFY_DONE_${n}`)), `в потоке субагента нет ответа VERIFY_DONE_${n}`);
    assert(!childEvents.some((e) => e.type === "user.message"), "в потоке субагента новое user.message");
    return `${files.join(", ")}; файл ${outputFile(n)}, logs/fake-model-requests.jsonl`;
  });
  const main = primary(turn.after);
  const received = main.find((e) => e.type === "agent.thread_message_received" && e.fromSessionThreadId === ids.threadA);
  const read = modelRequests(n).find((r) => r.kind === "DELEGATE" && r.decision === "report_read");
  const sessionNow = await api("GET", `/v1/sessions/${ids.sessionA}`);
  const report = await check("ma.subagent_report", "основной поток получает agent.thread_message_received от потока субагента с его ответом, основная модель просыпается и читает отчёт сообщением пользователя (last_user_text в журнале фейка), сессия кончает end_turn", () => {
    assert(received, `в основном потоке нет agent.thread_message_received от ${ids.threadA}: ${main.map((e) => e.type).join(", ")}`);
    assert(textOf(received.content).includes(`VERIFY_DONE_${n}`), `текст отчёта: ${textOf(received.content).slice(0, 200)}`);
    assert(read && String(read.last_user_text).includes(`VERIFY_DONE_${n}`), `запрос основной модели с отчётом: ${JSON.stringify(read ?? null).slice(0, 300)}`);
    assert(read.reply_text === `VERIFY_DELEGATE_REPORT_${n}`, `ответ фейка ${read.reply_text}`);
    assert(main.some((e) => e.type === "agent.message" && textOf(e.content) === `VERIFY_DELEGATE_REPORT_${n}`), "в основном потоке нет ответа VERIFY_DELEGATE_REPORT");
    assert(turn.stop === "end_turn", `stop_reason ${turn.stop}`);
    assert(sessionNow.status === "idle", `GET сессии status ${sessionNow.status}`);
    return `${files[0]}, logs/fake-model-requests.jsonl (n=${read.n})`;
  });
  const limits = await limitsOf(ids.sessionA);
  const counted = limitFacts(limits, all, [n]);
  const limitsFile = saveJson("12d-coordinator-limits-allow", limits);
  await check("ma.limits_grow", "_oma.limits растёт после хода субагента: used_tokens и used_child_turns больше, чем после первого хода, и сходятся с журналом", () => {
    assert(counted.facts.length === 0, counted.facts.join("; "));
    assert(limits.used_tokens > (ids.limitsA1?.used_tokens ?? 0), `used_tokens ${ids.limitsA1?.used_tokens} -> ${limits.used_tokens}`);
    assert(limits.used_child_turns > (ids.limitsA1?.used_child_turns ?? 0), `used_child_turns ${ids.limitsA1?.used_child_turns} -> ${limits.used_child_turns}`);
    return `${limitsFile}: used_tokens ${ids.limitsA1?.used_tokens} -> ${limits.used_tokens}, used_child_turns ${ids.limitsA1?.used_child_turns} -> ${limits.used_child_turns}`;
  });
  if (ok) cover("subagent-confirm-allow");
  if (report) cover("subagent-confirm-report");
  if (ok && report) cover("session-limit-count");
  return ok && report;
}

/** Второе «Разрешить» по API без session_thread_id: ничего не исполняется и не будит модель. */
async function stepRepeatAllow() {
  const n = turns.coordinator;
  const eventsBefore = dbEvents(ids.sessionA);
  const count = (events, type) => events.filter((e) => e.type === type).length;
  const modelBefore = jsonl(run.FAKE_REQUESTS).length;
  const sent = await apiRaw("POST", `/v1/sessions/${ids.sessionA}/events`, {
    events: [{ type: "user.tool_confirmation", tool_use_id: ids.bashA, result: "allow" }],
  });
  const sentFile = saveJson("13-repeat-allow-response", { status: sent.status, body: sent.json });
  const accepted = sent.status < 300;
  const turn = accepted ? await waitIdleDb(ids.sessionA, eventsBefore.length, "второе «Разрешить»") : null;
  await sleep(5000);
  const all = dbEvents(ids.sessionA);
  const after = all.slice(eventsBefore.length);
  const evFile = saveJson("13b-coordinator-db-events-repeat", all);
  const ok = await check("ma.subagent_repeat_allow_none", "второе «Разрешить» по API (без session_thread_id) на исполненный bash субагента: сервер берёт поток из вызова, bash не исполняется снова, отчёта и хода модели нет", () => {
    const woke = after.filter((e) => ["agent.message", "span.model_request_start", "agent.tool_use", "agent.tool_result",
      "agent.thread_message_received", "session.thread_status_running", "session.error"].includes(e.type));
    if (accepted) {
      const confirmation = after.find((e) => e.type === "user.tool_confirmation" && e.toolUseId === ids.bashA);
      assert(confirmation?.sessionThreadId === ids.threadA, `принятое подтверждение: ${JSON.stringify(confirmation ?? null)}`);
      assert(turn.stop === "end_turn", `stop_reason ${turn.stop}`);
    }
    assert(woke.length === 0, `после второго allow: ${woke.map((e) => `${e.type}@${e.thread}`).join(", ")}`);
    assert(jsonl(run.FAKE_REQUESTS).length === modelBefore, `запросов к фейку до ${modelBefore}, после ${jsonl(run.FAKE_REQUESTS).length}`);
    assert(count(all, "agent.thread_message_received") === count(eventsBefore, "agent.thread_message_received"), "новый agent.thread_message_received");
    assert(JSON.stringify(outputLines(ids.sessionA, n)) === JSON.stringify([`VERIFY_OK_${n}`]), `файл ${outputFile(n)}: ${JSON.stringify(outputLines(ids.sessionA, n))}`);
    return `POST events ${sent.status}${accepted ? `, stop_reason ${turn.stop}` : ""}; ${sentFile}, ${evFile}`;
  });
  if (ok) cover("subagent-confirm-repeat");
  return ok;
}

/** Шаг 2: блок multiagent_20261001 по API, умолчания, закрепление ссылок и отказы. */
async function stepBlockApi() {
  const block = (extra) => ({ name: `${names.block}-bad`, model: MODEL, multiagent: { type: "multiagent_20261001", ...extra } });
  const invalid = [
    ["агент со своим блоком в списке", block({ subagents: { type: "enabled", predefined_agents: [ids.coordinator] } }), "has its own multiagent block"],
    ["inline выключены при пустом списке", block({ subagents: { type: "enabled", inline_agents: { type: "disabled" } } }), "needs at least one agent"],
    ["советник без model", block({ advisor: { type: "enabled" } }), "multiagent.advisor.model"],
  ];
  const answers = [];
  for (const [what, body, expected] of invalid) {
    const r = await apiRaw("POST", "/v1/agents", body);
    answers.push({ what, status: r.status, body: r.json, expected });
  }
  const invalidFile = saveJson("20-block-invalid", answers);
  const bad = await check("ma.block_invalid", "блок multiagent_20261001 с ошибкой получает 400 invalid_request_error: агент со своим блоком в списке, inline выключены при пустом списке, советник без model", () => {
    const wrong = answers.filter((a) => a.status !== 400 || a.body?.error?.type !== "invalid_request_error" || !String(a.body.error.message).includes(a.expected));
    assert(wrong.length === 0, wrong.map((a) => `${a.what}: ${a.status} ${JSON.stringify(a.body).slice(0, 200)}`).join("; "));
    return `${invalidFile}`;
  });
  const createdAgent = await api("POST", "/v1/agents", {
    name: names.block,
    model: MODEL,
    system: "Ты основной агент нового типа. Передавай проверку субагенту и перескажи его отчёт.",
    tools: [{ type: "agent_toolset_20260401" }],
    multiagent: {
      type: "multiagent_20261001",
      subagents: { type: "enabled", predefined_agents: [ids.child] },
      workflows: { type: "enabled", predefined_agents: [{ type: "self" }] },
    },
  });
  ids.block = createdAgent.id;
  created.agents.push(ids.block);
  saveCreated();
  const read = await api("GET", `/v1/agents/${ids.block}`);
  const files = [saveJson("21-block-agent-created", createdAgent), saveJson("21b-block-agent-read", read)];
  ids.blockMultiagent = read.multiagent;
  const expected = {
    type: "multiagent_20261001",
    subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [{ type: "agent", id: ids.child, version: ids.childVersion }] },
    workflows: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [{ type: "agent", id: ids.block, version: createdAgent.version }] },
    advisor: { type: "disabled" },
  };
  const ok = await check("ma.block_api", "агент с блоком multiagent_20261001 по API: ответ создания и GET одинаковы, пропущенные поля получили умолчания (inline включены, советник выключен), строка с id закреплена версией, self в workflows читается как сам агент", () => {
    assert(stable(createdAgent.multiagent) === stable(read.multiagent), `создание и GET расходятся: ${JSON.stringify(createdAgent.multiagent)} / ${JSON.stringify(read.multiagent)}`);
    assert(stable(read.multiagent) === stable(expected), `блок ${JSON.stringify(read.multiagent)}, ожидался ${JSON.stringify(expected)}`);
    return files.join(", ");
  });
  if (ok && bad) cover("multiagent-block-api");
  return ok;
}

/** JSON с ключами по алфавиту: сравнение блоков не зависит от порядка ключей. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Блок агента, где запись самого агента заменена на «self»: форма шлёт self обратно как
 * {type: "self"} (находка 2 ревью), и сервер закрепляет его новой версией агента.
 */
function selfAware(agent) {
  const mark = (setting) => setting?.type !== "enabled" ? setting : {
    ...setting,
    predefined_agents: (setting.predefined_agents ?? []).map((entry) =>
      entry.id === agent.id && entry.version === agent.version ? { type: "self" } : entry),
  };
  const block = agent.multiagent;
  return block?.type === "multiagent_20261001" ? { ...block, subagents: mark(block.subagents), workflows: mark(block.workflows) } : block;
}

/** Шаг 2, срез 4: вкладка «Мультиагентность» формы на 1280 и 390, сохранение не теряет блок. */
async function stepBlockForm() {
  await page.goto(`${BASE}/agents/${encodeURIComponent(ids.block)}`);
  await page.getByRole("heading", { level: 1, name: names.block }).first().waitFor();
  const before = await api("GET", `/v1/agents/${ids.block}`);
  await page.getByRole("button", { name: "Изменить", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Изменение агента" });
  await dialog.waitFor();
  await dialog.getByRole("tab", { name: /^Мультиагентность/ }).click();
  const panel = dialog.getByRole("tabpanel");
  await panel.getByText("Фоновые запуски").waitFor();
  const panelText = plain(await panel.innerText());
  const self = panel.getByRole("checkbox", { name: "Сам агент", exact: true });
  const inline = panel.getByRole("checkbox", { name: "Агенты, которых описывает сам агент", exact: true });
  const state = {
    childListed: panelText.includes(names.child) || panelText.includes(ids.child),
    selfChecked: await self.getAttribute("aria-checked"),
    inlineChecked: await inline.getAttribute("aria-checked"),
    inlineDisabled: await inline.isDisabled(),
    advisor: await panel.locator("#agent-advisor").count(),
    later: panelText.includes("появятся позже"),
  };
  const wideShot = await shot("block-form-1280");
  const panelAria = await aria("block-form", panel);
  await page.setViewportSize(NARROW);
  await inline.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const narrowShot = await shot("block-form-390");
  // Окно прокручивается внутри себя: второй снимок на 390 показывает советника и фоновые запуски.
  await panel.getByText("Фоновые запуски").scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const narrowBottomShot = await shot("block-form-390-bottom");
  const overflow = await horizontalOverflow(['[role="dialog"]', '[role="tabpanel"]']);
  await page.setViewportSize(VIEW);
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  const saved = await dialog.waitFor({ state: "detached", timeout: 30_000 }).then(() => true).catch(() => false);
  const alert = saved ? null : plain(await dialog.getByRole("alert").first().textContent().catch(() => ""));
  if (!saved) await shot("block-form-save-error");
  const after = await api("GET", `/v1/agents/${ids.block}`);
  const files = [saveJson("22-block-agent-before-form", before), saveJson("22b-block-agent-after-form", after)];
  const ok = await check("ma.block_form", "форма агента нового типа: вкладка «Мультиагентность» показывает субагента списка, «Сам агент» снят, переключатель inline-агентов включён и доступен, поле «Советник», «Фоновые запуски» с «появятся позже»; на 390 нет прокрутки вбок; «Сохранить изменения» проходит, блок multiagent_20261001 и его списки не меняются, self в workflows остаётся самим агентом (его закрепляет новая версия)", () => {
    const facts = [];
    if (!state.childListed) facts.push(`субагента ${names.child} нет на вкладке`);
    if (state.selfChecked !== "false") facts.push(`«Сам агент» aria-checked ${state.selfChecked}`);
    if (state.inlineChecked !== "true" || state.inlineDisabled) facts.push(`inline-агенты: aria-checked ${state.inlineChecked}, выключен ${state.inlineDisabled}`);
    if (!state.advisor) facts.push("нет поля «Советник» (#agent-advisor)");
    if (!state.later) facts.push("нет пометки «появятся позже»");
    if (overflow.length) facts.push(`на 390 прокрутка вбок: ${overflow.join(", ")}`);
    if (!saved) facts.push(`окно не закрылось после «Сохранить изменения»: ${alert || "текста ошибки нет"}`);
    if (after.multiagent?.type !== "multiagent_20261001") facts.push(`тип блока после формы ${after.multiagent?.type}`);
    if (stable(selfAware(after)) !== stable(selfAware(before))) facts.push(`блок изменился: ${JSON.stringify(before.multiagent)} -> ${JSON.stringify(after.multiagent)}`);
    if (!(after.multiagent?.workflows?.predefined_agents ?? []).some((entry) => entry.id === ids.block && entry.version === after.version)) {
      facts.push(`self в workflows не читается как агент текущей версии ${after.version}: ${JSON.stringify(after.multiagent?.workflows)}`);
    }
    assert(facts.length === 0, facts.join("; "));
    return `${wideShot}, ${narrowShot}, ${narrowBottomShot}, ${panelAria}, ${files.join(", ")}; версия ${before.version} -> ${after.version}`;
  });
  if (ok) cover("multiagent-block-form");
  return ok;
}

/** Шаг 2: сессия копирует тип, делегирование агента нового типа идёт как у coordinator. */
async function stepBlockDelegation() {
  const n = turns.block;
  const session = await api("POST", "/v1/sessions", { agent: ids.block, environment_id: ids.env, title: names.sessionB });
  ids.sessionB = session.id;
  created.sessions.push(ids.sessionB);
  saveCreated();
  const read = await api("GET", `/v1/sessions/${ids.sessionB}`);
  const sessionFile = saveJson("23-block-session", read);
  const copy = await check("ma.block_session_copy", "сессия агента нового типа хранит тип multiagent_20261001, а субагент списка лежит в ней целиком (id, имя, закреплённая версия)", () => {
    const block = read.agent?.multiagent;
    assert(block?.type === "multiagent_20261001", `тип блока сессии ${block?.type}`);
    const listed = block.subagents?.predefined_agents ?? [];
    assert(listed.length === 1 && listed[0]?.id === ids.child && listed[0]?.name === names.child && listed[0]?.version === ids.childVersion,
      `subagents.predefined_agents ${JSON.stringify(listed).slice(0, 300)}`);
    return sessionFile;
  });
  const before = dbEvents(ids.sessionB).length;
  await api("POST", `/v1/sessions/${ids.sessionB}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: delegatePrompt(n, ids.child) }] }] });
  const turn = await waitIdleDb(ids.sessionB, before, "делегирование агента нового типа");
  const threads = (await api("GET", `/v1/sessions/${ids.sessionB}/threads?limit=100`)).data ?? [];
  const childThread = threads.find((t) => t.agent?.id === ids.child || t.agent?.name === names.child);
  ids.threadB = childThread?.id ?? null;
  const childEvents = ids.threadB ? await threadEvents(ids.sessionB, ids.threadB) : [];
  const sessionNow = await api("GET", `/v1/sessions/${ids.sessionB}`);
  const { facts, bash } = delegationWaitFacts({ n, agentId: ids.child, turn, childThread, childEvents, sessionNow, sessionId: ids.sessionB });
  let allowed = null;
  let report = null;
  let all = turn.events;
  if (facts.length === 0) {
    const sent = await apiRaw("POST", `/v1/sessions/${ids.sessionB}/events`, {
      events: [{ type: "user.tool_confirmation", tool_use_id: bash.id, result: "allow", session_thread_id: ids.threadB }],
    });
    if (sent.status >= 300) facts.push(`«Разрешить» по API: ${sent.status} ${sent.text.slice(0, 200)}`);
    else {
      allowed = await waitIdleDb(ids.sessionB, turn.events.length, "ход агента нового типа после «Разрешить»");
      await sleep(1500);
      all = dbEvents(ids.sessionB);
      const results = all.filter((e) => e.type === "agent.tool_result" && e.toolUseId === bash.id);
      if (results.length !== 1 || results[0].thread !== ids.threadB) facts.push(`agent.tool_result bash: ${results.length}, поток ${results[0]?.thread}`);
      const lines = outputLines(ids.sessionB, n);
      if (JSON.stringify(lines) !== JSON.stringify([`VERIFY_OK_${n}`])) facts.push(`файл ${outputFile(n)}: ${JSON.stringify(lines)}`);
      report = primary(allowed.after).find((e) => e.type === "agent.thread_message_received" && e.fromSessionThreadId === ids.threadB);
      if (!report || !textOf(report.content).includes(`VERIFY_DONE_${n}`)) facts.push(`отчёт в основном потоке: ${JSON.stringify(report ?? null).slice(0, 200)}`);
      const reportRead = modelRequests(n).find((r) => r.kind === "DELEGATE" && r.decision === "report_read");
      if (reportRead?.reply_text !== `VERIFY_DELEGATE_REPORT_${n}` || !String(reportRead.last_user_text).includes(`VERIFY_DONE_${n}`)) {
        facts.push(`основная модель после отчёта: ${JSON.stringify(reportRead ?? null).slice(0, 200)}`);
      }
      if (allowed.stop !== "end_turn") facts.push(`после «Разрешить» stop_reason ${allowed.stop}`);
    }
  }
  const files = [saveJson("24-block-db-events", all), saveJson("24b-block-child-thread-events", childEvents)];
  // Те же инструменты делегирования, что у coordinator: первый запрос основной модели каждой сессии.
  const toolsOf = (n2) => (modelRequests(n2).find((r) => r.kind === "DELEGATE")?.tools ?? []).filter((name) => String(name).startsWith("call_agent_")).sort();
  const coordinatorTools = toolsOf(turns.coordinator);
  const blockTools = toolsOf(n);
  const ok = await check("ma.block_delegation", "агент нового типа делегирует как coordinator: те же инструменты call_agent_* (только субагент из subagents, self из workflows не вызывается), bash субагента ждёт человека, «Разрешить» с session_thread_id исполняет его один раз, отчёт приходит в основной поток, ход кончается end_turn", () => {
    if (stable(coordinatorTools) !== stable(blockTools)) facts.push(`инструменты делегирования: coordinator ${JSON.stringify(coordinatorTools)}, новый тип ${JSON.stringify(blockTools)}`);
    if (stable(blockTools) !== stable([callAgentTool(ids.child)])) facts.push(`у нового типа ${JSON.stringify(blockTools)}, ожидался только ${callAgentTool(ids.child)}`);
    assert(facts.length === 0, facts.join("; "));
    return `${files.join(", ")}; инструменты ${blockTools.join(", ")}`;
  });
  if (ok && copy) cover("multiagent-block-delegation");
  return ok;
}

/** Шаг Б: сессия с max_tokens 1 встаёт на budget_reached, консоль пишет заметку без чисел. */
async function stepLimitStop() {
  const n = turns.limit;
  const session = await api("POST", "/v1/sessions", {
    agent: ids.limited, environment_id: ids.env, title: names.sessionL, _oma: { limits: { max_tokens: 1 } },
  });
  ids.sessionL = session.id;
  created.sessions.push(ids.sessionL);
  saveCreated();
  const limits0 = await limitsOf(ids.sessionL);
  await page.goto(`${BASE}/sessions/${encodeURIComponent(ids.sessionL)}`);
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  await sendMessage(limitPrompt(n));
  const turn = await waitIdle(ids.sessionL, 0, "ход до предела");
  await sleep(1500);
  const events = await listEvents(ids.sessionL);
  const limits1 = await limitsOf(ids.sessionL);
  ids.limitUsed = limits1?.used_tokens;
  const files = [saveJson("30-limit-session-created", { session, limits: limits0 }), saveJson("30b-limit-events-stop", events), saveJson("30c-limit-limits-stop", limits1)];
  const requests = modelRequests(n);
  const stop = await check("ma.limit_stop", "сессия с _oma.limits.max_tokens 1: первый запрос модели идёт, bash исполняется, второй запрос не уходит, ход встаёт на budget_reached без повтора и без session.error; used_tokens больше предела", () => {
    const types = events.map((e) => e.type);
    assert(stable(limits0) === stable({ max_tokens: 1, max_child_turns: limits0?.max_child_turns, used_tokens: 0, used_child_turns: 0 }) && limits0.max_child_turns > 0,
      `_oma.limits новой сессии ${JSON.stringify(limits0)}`);
    assert(turn.stop === "budget_reached", `stop_reason ${turn.stop}`);
    const bashUse = events.findIndex((e) => e.type === "agent.tool_use" && e.name === "bash");
    const bashResult = events.findIndex((e) => e.type === "agent.tool_result");
    const idle = events.findIndex((e) => e.type === "session.status_idle");
    assert(bashUse >= 0 && bashResult > bashUse && idle > bashResult, `порядок событий: ${types.join(", ")}`);
    assert(!events.slice(bashResult).some((e) => e.type === "span.model_request_start"), "после результата bash есть span.model_request_start");
    assert(!types.includes("session.error") && !types.includes("session.status_rescheduled"), `в журнале ${types.filter((t) => t.startsWith("session.error") || t === "session.status_rescheduled").join(", ")}`);
    assert(requests.length === 1, `запросов к фейку для ${n}: ${requests.length}`);
    assert(limits1?.used_tokens === TOKENS_PER_REQUEST && limits1.max_tokens === 1, `_oma.limits после хода ${JSON.stringify(limits1)}`);
    return files.join(", ");
  });
  const refused = await apiRaw("POST", `/v1/sessions/${ids.sessionL}/events`, { events: [{ type: "user.message", content: [{ type: "text", text: "Ещё одно задание" }] }] });
  const refusedFile = saveJson("31-limit-message-refused", { status: refused.status, body: refused.json });
  await check("ma.limit_refuses_message", "на пределе user.message по API получает 400 с подсказкой: разрешены подтверждения и прерывание, поднять _oma.limits; в журнале новой реплики нет", async () => {
    assert(refused.status === 400, `ответ ${refused.status} ${refused.text.slice(0, 200)}`);
    const message = String(refused.json?.error?.message ?? "");
    assert(message.includes("_oma.limits") && message.includes("user.tool_confirmation"), `текст отказа: ${message}`);
    const now = await listEvents(ids.sessionL);
    assert(now.length === events.length, `событий было ${events.length}, стало ${now.length}`);
    return `${refusedFile}: ${message.slice(0, 160)}`;
  });
  // Заметка в шапке: только текст и кнопка, чисел и слов о расходе нет.
  const note = limitNote();
  const noteSeen = await note.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
  const noteText = noteSeen ? plain(await note.innerText()) : "";
  const headerText = plain(await sessionHeader().innerText().catch(() => ""));
  const button = note.getByRole("button", { name: "Поднять предел", exact: true });
  const wideShot = await shot("limit-note-1280");
  const noteAria = noteSeen ? await aria("limit-note", note) : null;
  await page.setViewportSize(NARROW);
  await note.scrollIntoViewIfNeeded().catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const narrowSeen = await note.isVisible().catch(() => false);
  const narrowButton = await button.isVisible().catch(() => false);
  const narrowShot = await shot("limit-note-390");
  const overflow = await horizontalOverflow(['[data-session-note="limit"]']);
  await page.setViewportSize(VIEW);
  const ui = await check("ma.limit_ui_note", "шапка сессии на пределе: заметка «Предел работы сессии исчерпан, агент остановился.» и кнопка «Поднять предел», в заметке нет чисел, в шапке нет токенов, денег и бюджета; на 390 заметка и кнопка видны без прокрутки вбок", async () => {
    const facts = [];
    if (!noteSeen) facts.push("заметки [data-session-note=\"limit\"] нет");
    if (noteText !== `${LIMIT_NOTE} Поднять предел`) facts.push(`текст заметки «${noteText}»`);
    if (/\d/.test(noteText)) facts.push(`в заметке числа: «${noteText}»`);
    if (!(await button.count())) facts.push("нет кнопки «Поднять предел»");
    const hits = headerText.match(new RegExp(USAGE_WORDS.source, "gi"));
    if (hits) facts.push(`в шапке ${[...new Set(hits)].join(", ")}: «${headerText.slice(0, 200)}»`);
    if (!narrowSeen || !narrowButton) facts.push(`на 390 заметка ${narrowSeen ? "видна" : "не видна"}, кнопка ${narrowButton ? "видна" : "не видна"}`);
    if (overflow.length) facts.push(`на 390 прокрутка вбок: ${overflow.join(", ")}`);
    assert(facts.length === 0, facts.join("; "));
    return `${wideShot}, ${narrowShot}, ${noteAria}`;
  });
  // Отправка из консоли на пределе: консоль объясняет причину и реплику не шлёт.
  const box = page.getByRole("textbox", { name: "Сообщение" });
  await box.fill("Ещё одно задание из консоли");
  await page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first().click();
  const toast = page.getByText("Предел работы сессии исчерпан. Сначала поднимите предел.").first();
  const toastSeen = await toast.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const toastShot = await shot("limit-send-refused");
  await sleep(1500);
  const afterSend = await listEvents(ids.sessionL);
  await check("ma.limit_ui_send_refused", "отправка реплики из консоли на пределе: уведомление «Предел работы сессии исчерпан. Сначала поднимите предел.», user.message на сервер не уходит", () => {
    assert(toastSeen, "уведомления нет");
    assert(afterSend.length === events.length, `событий было ${events.length}, стало ${afterSend.length}: ${afterSend.slice(events.length).map((e) => e.type).join(", ")}`);
    return toastShot;
  });
  await box.fill("");
  await page.keyboard.press("Escape").catch(() => {});
  if (stop) cover("session-limit-stop");
  if (ui) cover("session-limit-ui");
  return stop && noteSeen;
}

/** Кнопка «Поднять предел»: оба предела вдвое, ход продолжается с места остановки без повтора bash. */
async function stepLimitRaise() {
  const n = turns.limit;
  const before = (await listEvents(ids.sessionL)).length;
  const limitsBefore = await limitsOf(ids.sessionL);
  await limitNote().getByRole("button", { name: "Поднять предел", exact: true }).click();
  const toastSeen = await page.getByText("Предел поднят").first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const turn = await waitIdle(ids.sessionL, before, "ход после подъёма предела");
  await page.getByText(`VERIFY_DONE_${n}`).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await sleep(1000);
  const noteLeft = await limitNote().count();
  const doneShot = await shot("limit-raised");
  const events = await listEvents(ids.sessionL);
  const limits = await limitsOf(ids.sessionL);
  const files = [saveJson("32-limit-events-raised", events), saveJson("32b-limit-limits-raised", { before: limitsBefore, after: limits })];
  const requests = modelRequests(n);
  const ok = await check("ma.limit_raise", "«Поднять предел» поднимает max_tokens и max_child_turns вдвое (от большего из предела и израсходованного), ход продолжается без новой реплики и кончается ответом с VERIFY_DONE, bash не повторяется, заметка уходит", async () => {
    const facts = [];
    const double = (max, used) => Math.max(1, 2 * Math.max(max, used));
    if (!toastSeen) facts.push("нет уведомления «Предел поднят»");
    if (limits?.max_tokens !== double(limitsBefore.max_tokens, limitsBefore.used_tokens)) facts.push(`max_tokens ${limitsBefore.max_tokens} -> ${limits?.max_tokens}, used ${limitsBefore.used_tokens}`);
    if (limits?.max_child_turns !== double(limitsBefore.max_child_turns, limitsBefore.used_child_turns)) facts.push(`max_child_turns ${limitsBefore.max_child_turns} -> ${limits?.max_child_turns}`);
    if (turn.stop !== "end_turn") facts.push(`stop_reason ${turn.stop}`);
    if (turn.after.some((e) => e.type === "user.message")) facts.push("ход после подъёма начался с новой реплики");
    if (!turn.after.some((e) => e.type === "agent.message" && textOf(e.content).includes(`VERIFY_DONE_${n}`))) facts.push(`нет ответа VERIFY_DONE_${n}`);
    if (events.filter((e) => e.type === "agent.tool_use" && e.name === "bash").length !== 1 || events.filter((e) => e.type === "agent.tool_result").length !== 1) {
      facts.push(`bash: agent.tool_use ${events.filter((e) => e.type === "agent.tool_use").length}, agent.tool_result ${events.filter((e) => e.type === "agent.tool_result").length}`);
    }
    if (requests.length !== 2) facts.push(`запросов к фейку для ${n}: ${requests.length}, ожидалось 2`);
    if (limits?.used_tokens !== TOKENS_PER_REQUEST * requests.length) facts.push(`used_tokens ${limits?.used_tokens}`);
    const lines = outputLines(ids.sessionL, n);
    if (JSON.stringify(lines) !== JSON.stringify([`VERIFY_OK_${n}`])) facts.push(`файл ${outputFile(n)}: ${JSON.stringify(lines)}`);
    if (noteLeft) facts.push("заметка о пределе осталась");
    if (!(await page.getByText(`VERIFY_DONE_${n}`).count())) facts.push("ответа VERIFY_DONE на странице нет");
    assert(facts.length === 0, facts.join("; "));
    return `${doneShot}, ${files.join(", ")}; max_tokens ${limitsBefore.max_tokens} -> ${limits.max_tokens}, max_child_turns ${limitsBefore.max_child_turns} -> ${limits.max_child_turns}`;
  });
  if (ok) cover("session-limit-raise");
  return ok;
}

async function stepArchive() {
  if (KEEP_SESSION) return;
  for (const id of [ids.sessionA, ids.sessionB, ids.sessionL].filter(Boolean)) {
    await api("POST", `/v1/sessions/${id}/archive`);
  }
}

// -------------------------------------------------------------------- итог ---
function featureEntries() {
  const dir = join(SKILL_DIR, "features");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    if (!text.includes("<!-- scenario: multiagent -->")) continue;
    const section = text.split(/^## /m).find((s) => s.startsWith("Sub-features"));
    for (const line of (section ?? "").split("\n")) {
      const m = line.match(/^- `([a-z0-9-]+)`(?: —|:) (.+)$/);
      if (m) out.push({ id: m[1], desc: m[2], file });
    }
  }
  return out;
}

function writeSummary(abortError) {
  const failed = checks.filter((c) => c.status === "провал");
  const features = featureEntries();
  const uncovered = features.filter((f) => !covered.has(f.id));
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    `# verify-agent-console: сценарий multiagent (подтверждение в потоке субагента, предел сессии, блок multiagent_20261001), прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций сценария пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, фейковая модель ${run.FAKE_URL}, git ${run.GIT_REV}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- учётка ${user.email}, пространство ${user.tenant_id}; nonce ${nonce}, ходы ${turns.coordinator} (coordinator), ${turns.block} (multiagent_20261001), ${turns.limit} (предел)`,
    `- окружение ${ids.env ?? "нет"}, субагент ${ids.child ?? "нет"}, основной coordinator ${ids.coordinator ?? "нет"}, агент нового типа ${ids.block ?? "нет"}, агент для предела ${ids.limited ?? "нет"}`,
    `- сессия coordinator ${ids.sessionA ?? "нет"} (поток субагента ${ids.threadA ?? "нет"}, вызов bash ${ids.bashA ?? "нет"}, «Разрешить»: ${ids.allowPath ?? "нет"}), сессия нового типа ${ids.sessionB ?? "нет"} (поток ${ids.threadB ?? "нет"}), сессия предела ${ids.sessionL ?? "нет"}`,
    "- журнал основного потока сессий с делегированием прочитан из managed_session_events базы прогона (sqlite3 -readonly): GET /v1/sessions/:id/events на них отвечает 500 (находка 5 ревью)",
    "",
    "## Проверки",
    "",
    "| Проверка | Что доказывает | Статус | Доказательство |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.status} | ${cell([c.evidence, c.note].filter(Boolean).join("; "))} |`),
    "| ma.seed_path | окружение, субагент, основной агент и агент для предела создаются по API: форму агента и окно окружения проверяют главный сценарий и mcp-ask | не проверено | нет |",
    "| ma.limit_seed_path | сессия с max_tokens 1 создаётся по API: консоль предел не задаёт, его задаёт сервер по умолчанию (OMA_SESSION_MAX_TOKENS) | не проверено | нет |",
    ...uncovered.map((f) => `| feature.${f.id} | ${cell(f.desc)} | не проверено | рецепт: features/${f.file} |`),
    "",
    "## Скриншоты",
    "",
    ...screens.map((s) => `- ${s.file} (sha256 ${s.sha.slice(0, 12)}${s.tall ? `, высота ${s.tall}` : ""})`),
    "",
    "## Повтор",
    "",
    "RUN=\"$(VERIFY_PORT=8801 VERIFY_FAKE_PORT=8802 VERIFY_FAKE_MCP_PORT=8803 scripts/launch.sh)\" && { scripts/doctor.sh --run \"$RUN\" && scripts/seed-user.sh --run \"$RUN\" && scripts/journey.sh --run \"$RUN\" --scenario multiagent; scripts/cleanup.sh --run \"$RUN\"; } (папка .claude/skills/verify-agent-console).",
    "",
  ];
  writeFileSync(join(EV, "summary.md"), lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n"));
}

function copyLogs() {
  for (const [from, to] of [
    [run.SERVER_LOG, "logs/main-node.journey.log"],
    [run.FAKE_LOG, "logs/fake-model.log"],
    [run.FAKE_REQUESTS, "logs/fake-model-requests.jsonl"],
  ]) if (from && existsSync(from)) copyFileSync(from, join(EV, to));
}

let abortError = null;
log(`прогон ${run.RUN_ID}, сценарий multiagent, nonce ${nonce}, доказательства ${EV}`);
try {
  const health = await (await fetch(`${BASE}/health`)).json();
  if (health?.backends?.db !== `sqlite ${run.DB_PATH}`) throw new Error(`на ${BASE} не экземпляр этого прогона (db: ${health?.backends?.db})`);
  const fh = await (await fetch(`${run.FAKE_URL}/health`)).json().catch(() => null);
  if (!fh?.ok) throw new Error(`фейковая модель ${run.FAKE_URL} не отвечает`);
  browser = await chromium.launch({ executablePath: pickChromium(), headless: process.env.VERIFY_HEADED !== "1", args: ["--disable-gpu"] });
  context = await browser.newContext({ baseURL: BASE, viewport: VIEW, locale: "ru-RU" });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  log(`процессов браузера записано в state/pids: ${recordJourneyChildren()}`);
  const failedSteps = new Set();
  for (const [name, fn, critical, needs = []] of [
    ["вход", stepLogin, true],
    ["исходные объекты", stepSeed, true],
    ["делегирование ждёт", stepDelegateWaits, false],
    ["страница сессии с делегированием", stepUiSubagent, false, ["делегирование ждёт"]],
    ["разрешить в потоке субагента", stepAllow, false, ["делегирование ждёт"]],
    ["второе разрешить", stepRepeatAllow, false, ["делегирование ждёт", "разрешить в потоке субагента"]],
    ["блок multiagent_20261001", stepBlockApi, false],
    ["форма блока", stepBlockForm, false, ["блок multiagent_20261001"]],
    ["делегирование агента нового типа", stepBlockDelegation, false, ["блок multiagent_20261001"]],
    ["предел сессии", stepLimitStop, false],
    ["поднять предел", stepLimitRaise, false, ["предел сессии"]],
    ["архив сессий", stepArchive, false],
  ]) {
    const missing = needs.filter((need) => failedSteps.has(need));
    // Провал страницы консоли не мешает шагу API: «Разрешить» тогда идёт по API.
    const blocking = missing.filter((need) => need !== "страница сессии с делегированием");
    if (blocking.length > 0) {
      failedSteps.add(name);
      record(`ma.step_skipped.${name.replace(/[\s:]+/g, "_")}`, `шаг «${name}»`, "не проверено", "", `не выполнен шаг: ${blocking.join(", ")}`);
      continue;
    }
    log(`== шаг: ${name}`);
    if (critical) {
      if ((await fn()) === false) failedSteps.add(name);
      continue;
    }
    try {
      if ((await fn()) === false) failedSteps.add(name);
    } catch (error) {
      failedSteps.add(name);
      record(`ma.step_failed.${name.replace(/[\s:]+/g, "_")}`, `шаг «${name}» выполнен до конца`, "провал", "", error.message);
      await shot(`fail-step-${name.replace(/[\s:]+/g, "-")}`).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.setViewportSize(VIEW).catch(() => {});
    }
  }
} catch (error) {
  abortError = error;
  record("ma.abort", "сценарий дошёл до конца", "провал", "", error.message);
  if (page) await shot("abort").catch(() => {});
} finally {
  record("ma.screens_distinct", "скриншоты соседних шагов различаются (sha256)",
    duplicateShots.length === 0 ? "проверено" : "провал", `скриншотов ${screens.length}`,
    duplicateShots.length === 0 ? "" : `совпали: ${duplicateShots.join("; ")}`);
  copyLogs();
  writeSummary(abortError);
  await browser?.close().catch(() => {});
}
const failedCount = checks.filter((c) => c.status === "провал").length;
log(`итог: ${abortError ? "ПРЕРВАН" : failedCount ? "ПРОВАЛ" : "ПРОЙДЕН"}, ${join(EV, "summary.md")}`);
process.exit(failedCount ? 1 : 0);
