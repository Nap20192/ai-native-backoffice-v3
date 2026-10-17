#!/usr/bin/env node
// Сценарий «mcp-ask» verify-agent-console: инструмент MCP-сервера без явной политики ждёт
// «Разрешить» на странице сессии (docs/plans/cma-wave-1.md, функция 3.1). Playwright, консоль
// на русском, фейковая модель (маркер VERIFY_TOOL) и фейковый MCP-сервер fake-mcp.mjs.
//   исходные объекты по API: окружение «Без ограничений», хранилище с токеном Bearer для fake-mcp;
//   консоль: агент из формы со своим MCP-сервером (политику пишет форма), сессия с хранилищем;
//   ход 1: write_act. Ход должен встать на requires_action, над полем ввода блок «Ожидает
//     подтверждения», в журнале fake-mcp ни одного tools/call write_act (mcp.write_waits);
//   «Разрешить»: write_act ушёл ровно один раз и после клика, ход закончился ответом (mcp.allow_once);
//   второе «Разрешить» на тот же вызов по API: write_act не уходит снова, модель не просыпается,
//     во «Инструментах» у write_act 1 вызов (mcp.repeat_allow_none, решение 4 владельца);
//   ход 2: write_act, «Отклонить» с причиной: вызов не ушёл, модель получила отказ (mcp.deny_none);
//   форма агента: поле «Разрешение» сервера, предупреждение у «Всегда разрешать», исключение
//     read_report «Всегда разрешать», снимки вкладки на 1280 и 390 (mcp.exception_form, срез 6);
//   ход 3 в новой сессии: read_report из исключений идёт без карточки (mcp.exception_read);
//   старый агент (набор MCP с явным always_allow, как писала консоль до 3.1): карточка пишет
//     «без подтверждения», правка имени в форме набор не меняет (mcp.old_agent_marked, mcp.old_agent_kept).
// Если mcp.write_waits провален, вызов уже ушёл без человека и карточки нет: шаги «Разрешить»
// и «Отклонить» пишутся строками «не проверено», второй вызов write_act не делается.
// Запуск: scripts/journey.sh --run <RUN_ID> --scenario mcp-ask. Итог: $EVIDENCE_DIR/summary.md.
import { createRequire } from "node:module";
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
    throw new Error("прогон не задан: VERIFY_RUN_DIR=<папка прогона> (scripts/journey.sh --run <RUN_ID> --scenario mcp-ask задаёт её сам)");
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
const MAX_SHOT_HEIGHT = 6000;
const TURN_TIMEOUT = Number(process.env.VERIFY_TURN_TIMEOUT_MS ?? 600_000);
const KEEP_SESSION = process.env.VERIFY_KEEP_SESSION === "1";
const BETAS = ["managed-agents-2026-04-01", "files-api-2025-04-14", "skills-2025-10-02", "agent-memory-2026-07-22"].join(",");
if (run.MODEL_MODE !== "fake") throw new Error("сценарий mcp-ask идёт на экземпляре в режиме fake (VERIFY_MODEL_MODE=fake)");
if (!run.FAKE_MCP_URL || !run.FAKE_MCP_REQUESTS) throw new Error("в run.env нет FAKE_MCP_URL: прогон поднят launch.sh без фейкового MCP-сервера, запустите launch.sh заново");

const nonce = randomBytes(4).toString("hex");
const MCP_URL = `${run.FAKE_MCP_URL}/mcp`;
const names = {
  env: `vm-env-${nonce}`,
  vault: `vm-vault-${nonce}`,
  credential: `vm-cred-${nonce}`,
  agent: `vm-agent-${nonce}`,
  oldAgent: `vm-old-agent-${nonce}`,
  session: `vm-session-${nonce}`,
  server: `verify-${nonce}`,
  oldServer: `verify-${nonce}-old`,
};
// Токен только этого прогона: в журнал fake-mcp попадает лишь его sha256.
const TOKEN = `verify-mcp-${nonce}`;
const TOKEN_SHA = createHash("sha256").update(TOKEN).digest("hex").slice(0, 12);
const turns = { allow: `${nonce}a1`, deny: `${nonce}d1`, read: `${nonce}r1` };
const DENY_REASON = `Проверка отказа ${nonce}`;
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
  const file = `screens/${String(++shotN).padStart(2, "0")}-vm-${name}.png`;
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
  const file = `aria/${String(shotN).padStart(2, "0")}-vm-${name}.yml`;
  writeFileSync(join(EV, file), await (locator ?? page.locator("body")).ariaSnapshot());
  return file;
}
function saveJson(name, data) {
  const file = `api/vm-${name}.json`;
  writeFileSync(join(EV, file), JSON.stringify(data, null, 2));
  return file;
}
function saveCreated() {
  writeFileSync(join(RUN_DIR, "state", "created.json"), JSON.stringify(created, null, 2));
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
async function listEvents(sessionId) {
  const all = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const q = new URLSearchParams({ limit: "100", order: "asc" });
    if (cursor) q.set("page", cursor);
    const r = await apiRaw("GET", `/v1/sessions/${sessionId}/events?${q}`);
    if (r.status !== 200) throw new Error(`GET events ${sessionId} -> ${r.status}`);
    all.push(...(r.json.data ?? []));
    if (!r.json.next_page) break;
    cursor = r.json.next_page;
  }
  return all;
}
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
/** Первый session.status_idle после события с индексом from. */
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
const toolUse = (events, tool, n) => events.find((e) =>
  e.type === "agent.mcp_tool_use" && String(e.name).endsWith(`__${tool}`) && e.input?.nonce === n);
const toolResult = (events, useId) => events.find((e) => e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === useId);
const agentTexts = (events) => events.filter((e) => e.type === "agent.message").map((e) => textOf(e.content));
/** JSON с ключами по алфавиту: сравнение записей API не зависит от порядка ключей. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const mcpToolsetOf = (agent, server) =>
  (agent?.tools ?? []).find((t) => t.type === "mcp_toolset" && t.mcp_server_name === server);

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
const mcpJournal = () => jsonl(run.FAKE_MCP_REQUESTS);
/** Вызовы инструмента в журнале fake-mcp; с n только вызовы этого хода. */
const mcpCalls = (tool, n) => mcpJournal().filter((r) =>
  r.rpc_method === "tools/call" && r.tool === tool && (n === undefined || r.arguments?.nonce === n));
const modelRequests = (n) => jsonl(run.FAKE_REQUESTS).filter((r) => r.nonce === n);
const promptFor = (n, tool) => [
  `VERIFY_TOOL nonce=${n}`,
  `Инструмент: ${tool}`,
  `Вход: ${JSON.stringify({ nonce: n, text: `Акт сверки ${n}` })}`,
].join("\n");

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
// Блок над полем ввода (ToolConfirmationRequests.tsx): вызовы с ask без решения.
const confirmations = () => page.getByRole("group", { name: "Ожидает подтверждения" });
const confirmationItem = (tool) => confirmations().getByRole("listitem").filter({ hasText: `__${tool}` });
async function cardVisible(tool, timeout) {
  try {
    await confirmationItem(tool).first().waitFor({ timeout });
    return true;
  } catch {
    return false;
  }
}
async function sendMessage(text) {
  const box = page.getByRole("textbox", { name: "Сообщение" });
  await box.fill(text);
  const send = page.getByRole("button", { name: /^(Отправить сообщение|Поставить сообщение в очередь)$/ }).first();
  await send.click();
  for (let i = 0; i < 20 && (await box.inputValue()) !== ""; i++) await sleep(250);
}

// ------------------------------------------------------------------- шаги ---
async function stepLogin() {
  await page.goto(`${BASE}/login`);
  await page.getByRole("button", { name: "Продолжить с почтой" }).click();
  await page.locator("#auth-email").fill(user.email);
  await page.locator("#auth-password").fill(user.password);
  await page.getByRole("group", { name: "Действия входа" }).getByRole("button", { name: "Войти", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await nav().waitFor();
  const me = await api("GET", "/v1/oma/me");
  await check("mcp.auth", "вход в консоль тестовой учёткой", () => {
    assert(me.user?.id === user.user_id && me.tenant?.id === user.tenant_id, `me ${me.user?.id} ${me.tenant?.id}`);
    return "GET /v1/oma/me";
  });
}

/** Исходные объекты по API: окружение и хранилище проверяют другие сценарии. */
async function stepSeed() {
  const health = await (await fetch(`${run.FAKE_MCP_URL}/health`)).json().catch(() => null);
  assert(health?.ok, `фейковый MCP-сервер ${run.FAKE_MCP_URL} не отвечает`);
  ids.env = (await api("POST", "/v1/environments", { name: names.env, config: { type: "cloud", networking: { type: "unrestricted" } } })).id;
  created.environments.push(ids.env);
  saveCreated();
  const vault = await api("POST", "/v1/vaults", { display_name: names.vault });
  ids.vault = vault.id;
  const credential = await api("POST", `/v1/vaults/${ids.vault}/credentials`, {
    display_name: names.credential,
    auth: { type: "static_bearer", token: TOKEN, mcp_server_url: MCP_URL },
  });
  ids.credential = credential.id;
  const saved = await api("GET", `/v1/vaults/${ids.vault}/credentials/${ids.credential}`);
  const file = saveJson("01-vault-credential", saved);
  await check("mcp.seed", "исходные объекты по API: окружение «Без ограничений», хранилище с токеном Bearer для адреса fake-mcp; токена нет в ответе API", () => {
    assert(saved.auth?.type === "static_bearer", `auth.type ${saved.auth?.type}`);
    assert(saved.auth?.mcp_server_url === MCP_URL, `mcp_server_url ${saved.auth?.mcp_server_url}`);
    assert(!JSON.stringify(saved).includes(TOKEN), "токен виден в ответе API");
    return `окружение ${ids.env}, хранилище ${ids.vault}, ${file}`;
  });
}

async function stepCreateAgent() {
  await openSection("Агенты", "Агентов пока нет");
  await page.getByRole("button", { name: "Новый агент" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новый агент" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /^Пустой агент/ }).click();
  await page.locator("#agent-name").fill(names.agent);
  await page.locator("#agent-system").fill("Ты агент проверки. Вызывай инструмент, который назовёт пользователь, с присланным входом.");
  const modelBox = dialog.getByRole("combobox", { name: "Модель", exact: true });
  await modelBox.click();
  const modelItem = page.locator(`[data-slot="command-item"][data-value^="${MODEL} "]`).first();
  await modelItem.waitFor({ timeout: 15_000 });
  await modelItem.click();
  await modelBox.filter({ hasText: MODEL }).waitFor({ timeout: 10_000 });
  await dialog.getByRole("tab", { name: /^MCP-серверы/ }).click();
  await dialog.getByRole("button", { name: "Свой сервер", exact: true }).click();
  await dialog.locator("#mcp-name-0").fill(names.server);
  await dialog.locator("#mcp-url-0").fill(MCP_URL);
  const formShot = await shot("agent-form-mcp");
  await dialog.getByRole("button", { name: "Создать агента", exact: true }).click();
  try {
    await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 30_000 });
  } catch {
    const alert = await dialog.getByRole("alert").first().textContent().catch(() => null);
    throw new Error(`агент не создан${alert ? `: ${alert}` : ""}`);
  }
  ids.agent = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.agents.push(ids.agent);
  saveCreated();
  await page.getByRole("heading", { level: 1, name: names.agent }).first().waitFor();
  const detailShot = await shot("agent-detail");
  const agent = await api("GET", `/v1/agents/${ids.agent}`);
  const file = saveJson("02-agent", agent);
  const toolset = (agent.tools ?? []).find((t) => t.type === "mcp_toolset" && t.mcp_server_name === names.server);
  ids.policy = toolset?.default_config?.permission_policy?.type ?? "нет";
  await check("mcp.agent_created", "агент из формы консоли («Свой сервер»): MCP-сервер с адресом fake-mcp и набор mcp_toolset для него", () => {
    const server = (agent.mcp_servers ?? []).find((s) => s.name === names.server);
    assert(server?.type === "url" && server.url === MCP_URL, `mcp_servers ${JSON.stringify(agent.mcp_servers)}`);
    assert(toolset, `нет mcp_toolset для ${names.server}: ${JSON.stringify(agent.tools)}`);
    return `${formShot}, ${detailShot}, ${file}; политика набора по умолчанию: ${ids.policy}`;
  });
}

async function stepCreateSession() {
  await openSection("Сессии", "Сессий пока нет");
  await page.getByRole("button", { name: "Новая сессия" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Новая сессия" });
  await dialog.waitFor();
  await pickCombobox(dialog, 0, ids.agent);
  await pickCombobox(dialog, 1, ids.env);
  const vaultBox = dialog.getByRole("checkbox", { name: new RegExp(names.vault) });
  await vaultBox.click();
  await waitFor("флажок хранилища", async () => (await vaultBox.getAttribute("aria-checked")) === "true" || undefined, 5000, 200);
  await dialog.locator("#session-title").fill(names.session);
  const dialogShot = await shot("session-create-dialog");
  const warning = plain(await dialog.locator(".callout-warning").allTextContents().then((t) => t.join(" ")));
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  ids.session = decodeURIComponent(new URL(page.url()).pathname.split("/").pop());
  created.sessions.push(ids.session);
  saveCreated();
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  const session = await api("GET", `/v1/sessions/${ids.session}`);
  const file = saveJson("03-session", session);
  await check("mcp.session_created", "сессия из окна «Новая сессия» с этим агентом, окружением и хранилищем; предупреждения о MCP без учётных данных нет", () => {
    assert(session.agent?.id === ids.agent, `agent ${session.agent?.id}`);
    assert(session.environment_id === ids.env, `environment_id ${session.environment_id}`);
    assert((session.vault_ids ?? []).includes(ids.vault), `vault_ids ${JSON.stringify(session.vault_ids)}`);
    assert(!warning.includes("без подходящих учётных данных"), `окно предупреждает: ${warning.slice(0, 200)}`);
    return `${dialogShot}, ${file}`;
  });
}

/** Ход 1: вызов write_act должен ждать человека. Возвращает false, если вызов ушёл сам. */
async function stepWriteWaits() {
  const n = turns.allow;
  const before = (await listEvents(ids.session)).length;
  await sendMessage(promptFor(n, "write_act"));
  await shot("write-sent");
  const turn = await waitIdle(ids.session, before, "ход write_act");
  const use = toolUse(turn.after, "write_act", n);
  ids.allowUse = use?.id ?? null;
  const card = await cardVisible("write_act", turn.stop === "requires_action" ? 20_000 : 5000);
  const turnShot = await shot("write-turn-stopped");
  const groupAria = card ? await aria("write-confirmation", confirmations()) : null;
  const evFile = saveJson("10-events-write", turn.events);
  const requests = modelRequests(n);
  const listed = requests.find((r) => r.decision === "tool_use")?.tools ?? requests[0]?.tools ?? [];
  await check("mcp.tools_listed", "MCP-сервер подключён к ходу: в запросе к модели есть read_report и write_act сервера агента", () => {
    for (const tool of ["read_report", "write_act"]) {
      assert(listed.includes(`mcp__${names.server}__${tool}`), `в запросе к модели нет mcp__${names.server}__${tool}: ${listed.join(", ") || "инструментов нет"}`);
    }
    return "logs/fake-model-requests.jsonl";
  });
  const journal = mcpJournal().filter((r) => r.path === "/mcp" && r.rpc_method);
  await check("mcp.vault_token", "токен для fake-mcp подставил прокси из хранилища сессии: у каждого запроса JSON-RPC sha256 токена этого прогона", () => {
    assert(journal.some((r) => r.rpc_method === "tools/list"), "в журнале fake-mcp нет tools/list");
    const foreign = journal.filter((r) => r.token_sha256 !== TOKEN_SHA);
    assert(foreign.length === 0, `запросов с другим токеном или без него: ${foreign.length} (${foreign.map((r) => `${r.rpc_method} ${r.token_sha256}`).slice(0, 3).join(", ")})`);
    return `logs/fake-mcp.jsonl, sha256 ${TOKEN_SHA}`;
  });
  const calls = mcpCalls("write_act", n);
  ids.writeCallsAtStop = calls.length;
  const waits = await check("mcp.write_waits", "вызов write_act без явного «Разрешить» ждёт человека: ход встал на requires_action, над полем ввода «Ожидает подтверждения», в журнале fake-mcp вызова write_act нет", () => {
    const facts = [];
    if (calls.length > 0) facts.push(`write_act ушёл без клика: в журнале fake-mcp ${calls.length} вызов tools/call write_act с nonce ${n} (${calls.map((c) => c.ts).join(", ")})`);
    if (turn.stop !== "requires_action") facts.push(`ход закончился stop_reason ${turn.stop ?? "нет"}, ожидался requires_action`);
    if (!use) facts.push("в журнале сессии нет agent.mcp_tool_use write_act");
    else if (use.evaluated_permission !== "ask") facts.push(`evaluated_permission ${use.evaluated_permission ?? "нет"}, ожидалось ask`);
    if (!card) facts.push("на странице нет блока «Ожидает подтверждения» с write_act");
    assert(facts.length === 0, `${facts.join("; ")}; политика набора агента ${ids.policy}`);
    return `${turnShot}, ${groupAria}, ${evFile}, logs/fake-mcp.jsonl`;
  });
  // Сессия ждёт человека: в CMA это status idle и stop_reason requires_action с id вызова.
  const sessionNow = await api("GET", `/v1/sessions/${ids.session}`);
  const sessionFile = saveJson("10b-session-waiting", sessionNow);
  const waitingIds = turn.idle?.stop_reason?.event_ids ?? [];
  await check("mcp.session_requires_action", "сессия ждёт человека: session.status_idle несёт stop_reason requires_action, в event_ids id вызова write_act, GET сессии отдаёт status idle", () => {
    assert(turn.stop === "requires_action", `stop_reason ${turn.stop ?? "нет"}`);
    assert(use && waitingIds.length === 1 && waitingIds[0] === use.id, `event_ids ${JSON.stringify(waitingIds)}, вызов write_act ${use?.id ?? "нет"}`);
    assert(sessionNow.status === "idle", `GET /v1/sessions/:id status ${sessionNow.status}`);
    return `${evFile}, ${sessionFile}`;
  });
  // Строка вызова в ходе. Ожидаемая подпись «Ждёт вас» (ToolStatus в CanonicalSessionTurn.tsx).
  // collectToolCalls (lib/session-stats.ts) закрывает вызов на session.status_idle и пишет «Прервано»:
  // дефект был до функции 3.1, поэтому строка «внимание», а не провал. Блок над полем ввода проверяет mcp.write_waits.
  if (use) {
    const row = page.locator(`[data-tool-call][data-event-id="${use.id}"]`).first();
    const rowText = await row.waitFor({ timeout: 10_000 }).then(() => row.innerText()).then(plain).catch(() => "");
    const label = rowText.includes("Ждёт вас") ? "Ждёт вас" : rowText.includes("Прервано") ? "Прервано" : rowText ? "без подписи" : "строки нет";
    record("mcp.ui_waiting_row", "строка вызова write_act в ходе подписана «Ждёт вас», пока вызов ждёт подтверждения",
      label === "Ждёт вас" ? "проверено" : "внимание", `${turnShot}; строка: ${rowText.slice(0, 160)}`,
      label === "Ждёт вас" ? "" : `подпись «${label}»: collectToolCalls (apps/console/src/lib/session-stats.ts) закрывает вызов на session.status_idle, дефект был до функции 3.1`);
  }
  if (waits) cover("mcp-ask-waits");
  return waits;
}

/** «Разрешить»: вызов уходит ровно один раз и после клика. */
async function stepAllow() {
  const n = turns.allow;
  const before = (await listEvents(ids.session)).length;
  const callsBefore = mcpCalls("write_act", n).length;
  const item = confirmationItem("write_act").first();
  const clickedAt = new Date().toISOString();
  await item.getByRole("button", { name: "Разрешить", exact: true }).click();
  const turn = await waitIdle(ids.session, before, "ход после «Разрешить»");
  await sleep(2000);
  const calls = mcpCalls("write_act", n);
  const all = await listEvents(ids.session);
  const result = toolResult(all, ids.allowUse);
  const confirmation = turn.after.find((e) => e.type === "user.tool_confirmation" && e.tool_use_id === ids.allowUse);
  const texts = agentTexts(turn.after);
  await page.getByText(`VERIFY_TOOL_DONE_${n}`).first().waitFor({ timeout: 30_000 }).catch(() => {});
  const cardLeft = await confirmationItem("write_act").count();
  const doneShot = await shot("allow-done");
  const evFile = saveJson("11-events-allow", all);
  const ok = await check("mcp.allow_once", "«Разрешить» исполняет write_act ровно один раз и после клика; результат с VERIFY_TOOL_OK доходит до модели, ход кончается ответом", async () => {
    assert(callsBefore === 0, `до клика в журнале fake-mcp уже ${callsBefore} вызов write_act`);
    assert(calls.length === 1, `вызовов write_act с nonce ${n}: ${calls.length}, ожидался 1`);
    assert(calls[0].ts >= clickedAt, `вызов ${calls[0].ts} раньше клика ${clickedAt}`);
    assert(confirmation?.result === "allow", `user.tool_confirmation: ${JSON.stringify(confirmation ?? null)}`);
    assert(result && result.is_error !== true, `agent.mcp_tool_result: ${JSON.stringify(result ?? null).slice(0, 300)}`);
    assert(textOf(result.content).includes(`VERIFY_TOOL_OK_${n}`), `в результате нет VERIFY_TOOL_OK_${n}`);
    assert(turn.stop === "end_turn", `stop_reason ${turn.stop}`);
    assert(texts.some((t) => t.includes(`VERIFY_TOOL_DONE_${n}`)), `ответ агента: ${texts.join(" | ").slice(0, 200)}`);
    assert(cardLeft === 0, "блок подтверждения write_act остался на странице");
    assert((await page.getByText(`VERIFY_TOOL_DONE_${n}`).count()) > 0, "ответа VERIFY_TOOL_DONE на странице нет");
    return `${doneShot}, ${evFile}, logs/fake-mcp.jsonl`;
  });
  if (ok) cover("mcp-ask-allow");
  return ok;
}

/**
 * Второе «Разрешить» на вызов, у которого уже есть результат (решение 4 владельца, находка 1
 * ревью). Кнопки в консоли после первого клика нет, поэтому событие идёт по API, как от клиента
 * SDK или второй вкладки. Вызов не уходит снова, и модель не просыпается: ход уже закончен.
 */
async function stepRepeatAllow() {
  const n = turns.allow;
  assert(ids.allowUse, "нет id вызова write_act первого хода");
  const eventsBefore = await listEvents(ids.session);
  const before = eventsBefore.length;
  const callsBefore = mcpCalls("write_act").length;
  const resultsOf = (events) => events.filter((e) => e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id === ids.allowUse).length;
  const resultsBefore = resultsOf(eventsBefore);
  const modelBefore = jsonl(run.FAKE_REQUESTS).length;
  const doneBefore = agentTexts(eventsBefore).filter((t) => t.includes(`VERIFY_TOOL_DONE_${n}`)).length;
  // Ответов на странице считаем на свежей загрузке до и после: живой поток рисует не так, как история.
  await page.goto(`${BASE}/sessions/${encodeURIComponent(ids.session)}`);
  await page.getByText(`VERIFY_TOOL_DONE_${n}`).first().waitFor({ timeout: 30_000 });
  const doneOnPageBefore = await page.getByText(`VERIFY_TOOL_DONE_${n}`).count();
  const sent = await apiRaw("POST", `/v1/sessions/${ids.session}/events`, {
    events: [{ type: "user.tool_confirmation", tool_use_id: ids.allowUse, result: "allow" }],
  });
  const sentFile = saveJson("11b-repeat-allow-response", { status: sent.status, body: sent.json });
  // Принятое событие запускает прогон раннера (status_running, затем status_idle). Отказ 4xx
  // тоже годится: тогда прогона нет совсем.
  const accepted = sent.status < 300;
  const turn = accepted ? await waitIdle(ids.session, before, "второе «Разрешить»") : null;
  // Окно для позднего хода модели: он оставил бы agent.message и запрос в журнале фейка.
  await sleep(5000);
  const all = await listEvents(ids.session);
  const after = all.slice(before);
  const evFile = saveJson("11c-events-repeat-allow", all);
  const woke = after.filter((e) => ["agent.message", "span.model_request_start", "agent.mcp_tool_use", "agent.tool_use",
    "agent.mcp_tool_result", "agent.tool_result", "session.error"].includes(e.type));
  const modelAfter = jsonl(run.FAKE_REQUESTS).length;
  // Консоль: вкладка «Инструменты» считает вызовы по журналу (computeToolStats).
  await page.goto(`${BASE}/sessions/${encodeURIComponent(ids.session)}?inspector=tools`);
  const inspector = page.getByRole("complementary", { name: "Инспектор сессии" });
  const table = inspector.getByRole("table", { name: "Инструменты" });
  await table.waitFor({ timeout: 15_000 });
  let rows = [];
  for (let i = 0; i < 20; i++) {
    rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((td) => td.innerText.trim())));
    if (rows.some((cells) => cells[0]?.includes("write_act") && cells[2] !== "0")) break;
    await sleep(250);
  }
  const writeRow = rows.find((cells) => cells[0]?.includes("write_act"));
  await page.getByText(`VERIFY_TOOL_DONE_${n}`).first().waitFor({ timeout: 30_000 }).catch(() => {});
  const doneOnPage = await page.getByText(`VERIFY_TOOL_DONE_${n}`).count();
  const toolsShot = await shot("repeat-allow-tools");
  const ok = await check("mcp.repeat_allow_none", "второе «Разрешить» на исполненный write_act (по API, кнопки в консоли уже нет): вызов не уходит снова, модель не просыпается (нет agent.message, span.model_request_start и запроса к фейку), во «Инструментах» у write_act 1 вызов", () => {
    const calls = mcpCalls("write_act");
    assert(calls.length === callsBefore && mcpCalls("write_act", n).length === 1,
      `write_act в журнале fake-mcp: до второго allow ${callsBefore}, после ${calls.length}; с nonce ${n}: ${mcpCalls("write_act", n).length}`);
    assert(resultsOf(all) === resultsBefore, `agent.mcp_tool_result вызова: до ${resultsBefore}, после ${resultsOf(all)}`);
    assert(woke.length === 0, `после второго allow в журнале сессии: ${woke.map((e) => e.type).join(", ")}`);
    assert(modelAfter === modelBefore, `запросов к фейковой модели до второго allow ${modelBefore}, после ${modelAfter}`);
    if (accepted) {
      assert(after.some((e) => e.type === "user.tool_confirmation" && e.tool_use_id === ids.allowUse && e.result === "allow"),
        "принятого user.tool_confirmation нет в журнале");
      assert(turn.stop === "end_turn", `stop_reason ${turn.stop}`);
    }
    assert(agentTexts(all).filter((t) => t.includes(`VERIFY_TOOL_DONE_${n}`)).length === doneBefore && doneBefore === 1,
      `ответов VERIFY_TOOL_DONE_${n} в журнале: до ${doneBefore}, после ${agentTexts(all).filter((t) => t.includes(`VERIFY_TOOL_DONE_${n}`)).length}`);
    assert(writeRow && writeRow[2] === "1" && writeRow[3] === "0", `строка write_act во «Инструментах»: ${JSON.stringify(writeRow ?? null)}; строки ${JSON.stringify(rows)}`);
    assert(doneOnPageBefore > 0 && doneOnPage === doneOnPageBefore, `ответ VERIFY_TOOL_DONE_${n} на странице: до второго allow ${doneOnPageBefore}, после ${doneOnPage}`);
    return `POST events ${sent.status}${accepted ? `, stop_reason ${turn.stop}` : ""}; ${sentFile}, ${evFile}, ${toolsShot}, logs/fake-mcp.jsonl`;
  });
  if (ok) cover("mcp-ask-repeat");
  // Следующий шаг шлёт реплику: страница без инспектора, как после «Разрешить».
  await page.goto(`${BASE}/sessions/${encodeURIComponent(ids.session)}`);
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  return ok;
}

/** Ход 2 и «Отклонить» с причиной: вызов не уходит, модель получает отказ. */
async function stepDeny() {
  const n = turns.deny;
  const before = (await listEvents(ids.session)).length;
  const totalBefore = mcpCalls("write_act").length;
  await sendMessage(promptFor(n, "write_act"));
  const turn = await waitIdle(ids.session, before, "ход write_act для отказа");
  const use = toolUse(turn.after, "write_act", n);
  assert(turn.stop === "requires_action" && use, `ход 2 не встал на подтверждение: stop_reason ${turn.stop}, agent.mcp_tool_use ${use?.id ?? "нет"}`);
  assert(await cardVisible("write_act", 20_000), "нет блока «Ожидает подтверждения» для хода 2");
  const item = confirmationItem("write_act").first();
  await item.getByRole("textbox").fill(DENY_REASON);
  await shot("deny-card");
  const afterStop = (await listEvents(ids.session)).length;
  await item.getByRole("button", { name: "Отклонить", exact: true }).click();
  const denied = await waitIdle(ids.session, afterStop, "ход после «Отклонить»");
  await sleep(2000);
  const all = await listEvents(ids.session);
  const result = toolResult(all, use.id);
  const confirmation = denied.after.find((e) => e.type === "user.tool_confirmation" && e.tool_use_id === use.id);
  const texts = agentTexts(denied.after);
  await page.getByText(`VERIFY_TOOL_NOT_OK_${n}`).first().waitFor({ timeout: 30_000 }).catch(() => {});
  const cardLeft = await confirmationItem("write_act").count();
  const denyShot = await shot("deny-done");
  const evFile = saveJson("12-events-deny", all);
  const ok = await check("mcp.deny_none", "«Отклонить» с причиной: write_act не уходит во внешнюю систему, модель получает отказ с причиной", async () => {
    assert(mcpCalls("write_act", n).length === 0, `в журнале fake-mcp есть write_act с nonce ${n}`);
    const total = mcpCalls("write_act").length;
    assert(total === totalBefore, `write_act в журнале fake-mcp: до хода ${totalBefore}, после отказа ${total}`);
    assert(confirmation?.result === "deny", `user.tool_confirmation: ${JSON.stringify(confirmation ?? null)}`);
    assert(result?.is_error === true, `agent.mcp_tool_result без is_error: ${JSON.stringify(result ?? null).slice(0, 300)}`);
    assert(textOf(result.content).includes(DENY_REASON), `в отказе нет причины: ${textOf(result.content).slice(0, 200)}`);
    assert(texts.some((t) => t.includes(`VERIFY_TOOL_NOT_OK_${n}`)), `ответ агента: ${texts.join(" | ").slice(0, 200)}`);
    assert(denied.stop === "end_turn", `stop_reason ${denied.stop}`);
    assert(cardLeft === 0, "блок подтверждения write_act остался на странице");
    return `${denyShot}, ${evFile}, logs/fake-mcp.jsonl`;
  });
  if (ok) cover("mcp-ask-deny");
}

/**
 * Срез 6 функции 3.1: в форме агента у сервера поле «Разрешение» и исключения по инструментам.
 * read_report получает «Всегда разрешать» и в новой сессии идёт без карточки подтверждения.
 */
async function stepException() {
  const n = turns.read;
  await page.goto(`${BASE}/agents/${encodeURIComponent(ids.agent)}`);
  await page.getByRole("heading", { level: 1, name: names.agent }).first().waitFor();
  await page.getByRole("button", { name: "Изменить", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Изменение агента" });
  await dialog.waitFor();
  await dialog.getByRole("tab", { name: /^MCP-серверы/ }).click();
  const permission = dialog.getByRole("combobox", { name: `Разрешение сервера ${names.server}`, exact: true });
  const permissionBefore = plain(await permission.textContent());
  const warning = dialog.locator(".callout-warning").filter({ hasText: "без подтверждения" });
  const warningBefore = await warning.count();
  await permission.click();
  await page.getByRole("option", { name: "Всегда разрешать", exact: true }).click();
  await warning.first().waitFor({ timeout: 5000 });
  const warningText = plain(await warning.first().textContent());
  const warnShot = await shot("agent-mcp-allow-warning");
  await permission.click();
  await page.getByRole("option", { name: "Всегда спрашивать", exact: true }).click();
  await warning.first().waitFor({ state: "detached", timeout: 5000 });
  await dialog.getByRole("button", { name: "Добавить исключение", exact: true }).click();
  await dialog.getByRole("textbox", { name: `Инструмент исключения 1 сервера ${names.server}`, exact: true }).fill("read_report");
  const exceptionPermission = plain(await dialog
    .getByRole("combobox", { name: `Разрешение исключения 1 сервера ${names.server}`, exact: true }).textContent());
  const wideShot = await shot("agent-mcp-exception-1280");
  await page.setViewportSize({ width: 390, height: 844 });
  // Окно прокручивается внутри себя: на 390 строка исключения ниже первого экрана.
  await dialog.getByRole("button", { name: "Добавить исключение", exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const narrowShot = await shot("agent-mcp-exception-390");
  const overflow = await page.evaluate(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) out.push(`страница ${doc.scrollWidth} > ${doc.clientWidth}`);
    for (const el of document.querySelectorAll('[role="dialog"], [role="tabpanel"]')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.getAttribute("role")} ${el.scrollWidth} > ${el.clientWidth}`);
    }
    return out;
  });
  const tabAria = await aria("agent-mcp-exception", dialog.getByRole("tabpanel"));
  await page.setViewportSize(VIEW);
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const agent = await api("GET", `/v1/agents/${ids.agent}`);
  const agentFile = saveJson("13-agent-exception", agent);
  const toolset = (agent.tools ?? []).find((t) => t.type === "mcp_toolset" && t.mcp_server_name === names.server);
  const toolsRow = plain(await page.getByText(`MCP: ${names.server}`).first().textContent());
  const detailShot = await shot("agent-detail-exception");
  await check("mcp.exception_form", "форма агента: у сервера «Разрешение» «Всегда спрашивать», у «Всегда разрешать» предупреждение, исключение read_report «Всегда разрешать» сохраняется в configs набора; на 390 нет прокрутки вбок", () => {
    assert(permissionBefore === "Всегда спрашивать", `«Разрешение» до правки: ${permissionBefore}`);
    assert(warningBefore === 0, "предупреждение видно при «Всегда спрашивать»");
    assert(warningText.includes("без подтверждения"), `предупреждение: ${warningText}`);
    assert(exceptionPermission === "Всегда разрешать", `новое исключение: ${exceptionPermission}`);
    assert(overflow.length === 0, `прокрутка вбок на 390: ${overflow.join("; ")}`);
    assert(toolset?.default_config?.permission_policy?.type === "always_ask", `default_config ${JSON.stringify(toolset?.default_config)}`);
    const configs = toolset?.configs ?? [];
    assert(configs.some((c) => c.name === "read_report" && c.permission_policy?.type === "always_allow"), `configs ${JSON.stringify(configs)}`);
    assert(!configs.some((c) => c.name === "write_act"), `write_act в configs: ${JSON.stringify(configs)}`);
    assert(agent.version > 1, `версия агента ${agent.version}`);
    assert(!toolsRow.includes("без подтверждения"), `карточка агента: ${toolsRow}`);
    return `${warnShot}, ${wideShot}, ${narrowShot}, ${tabAria}, ${detailShot}, ${agentFile}`;
  });

  // Сессия фиксирует версию агента при создании, поэтому исключение видит только новая сессия.
  const session = await api("POST", "/v1/sessions", {
    agent: ids.agent,
    environment_id: ids.env,
    vault_ids: [ids.vault],
    title: `${names.session}-read`,
  });
  ids.readSession = session.id;
  created.sessions.push(session.id);
  saveCreated();
  await page.goto(`${BASE}/sessions/${encodeURIComponent(session.id)}`);
  await page.getByRole("textbox", { name: "Сообщение" }).waitFor();
  const from = (await listEvents(session.id)).length;
  const readsBefore = mcpCalls("read_report", n).length;
  await sendMessage(promptFor(n, "read_report"));
  const turn = await waitIdle(session.id, from, "ход read_report");
  await sleep(1500);
  const all = await listEvents(session.id);
  const use = toolUse(all, "read_report", n);
  const result = use ? toolResult(all, use.id) : null;
  const confirmationsSent = all.filter((e) => e.type === "user.tool_confirmation");
  const texts = agentTexts(turn.after);
  await page.getByText(`VERIFY_TOOL_DONE_${n}`).first().waitFor({ timeout: 30_000 }).catch(() => {});
  const cards = await confirmations().count();
  const readShot = await shot("read-exception-done");
  const evFile = saveJson("14-events-read-exception", all);
  const calls = mcpCalls("read_report", n);
  const ok = await check("mcp.exception_read", "read_report из исключений идёт без карточки: ход без requires_action, вызов один и без подтверждения, ответ VERIFY_TOOL_DONE", () => {
    assert(readsBefore === 0, `до хода в журнале fake-mcp уже ${readsBefore} вызов read_report`);
    assert(use, "в журнале сессии нет agent.mcp_tool_use read_report");
    assert(use.evaluated_permission !== "ask", `evaluated_permission ${use.evaluated_permission}`);
    assert(turn.stop === "end_turn", `stop_reason ${turn.stop}`);
    assert(calls.length === 1, `вызовов read_report с nonce ${n}: ${calls.length}`);
    assert(confirmationsSent.length === 0, `user.tool_confirmation в сессии: ${confirmationsSent.length}`);
    assert(result && result.is_error !== true && textOf(result.content).includes(`VERIFY_TOOL_OK_${n}`), `agent.mcp_tool_result: ${JSON.stringify(result ?? null).slice(0, 300)}`);
    assert(texts.some((t) => t.includes(`VERIFY_TOOL_DONE_${n}`)), `ответ агента: ${texts.join(" | ").slice(0, 200)}`);
    assert(cards === 0, "на странице блок «Ожидает подтверждения»");
    return `${readShot}, ${evFile}, logs/fake-mcp.jsonl`;
  });
  if (ok) cover("mcp-ask-exception");
}

/**
 * Агент, сохранённый до функции 3.1. Консоль до неё писала набору MCP явный always_allow
 * (mergeToolsField в apps/console/src/pages/agents/agentFormCodec.ts на 9cb5bbf), такую же
 * запись даёт POST по API. Данные не мигрируются, поэтому карточка помечает сервер
 * «без подтверждения», а правка имени в форме отправляет набор как был.
 */
async function stepOldAgent() {
  const server = names.oldServer;
  const created0 = await api("POST", "/v1/agents", {
    name: names.oldAgent,
    model: MODEL,
    system: "Агент из старой консоли: набор MCP с явным always_allow.",
    mcp_servers: [{ type: "url", name: server, url: MCP_URL }],
    tools: [
      { type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } } },
      { type: "mcp_toolset", mcp_server_name: server, default_config: { permission_policy: { type: "always_allow" } } },
    ],
  });
  ids.oldAgent = created0.id;
  created.agents.push(ids.oldAgent);
  saveCreated();
  const agent0 = await api("GET", `/v1/agents/${ids.oldAgent}`);
  const agent0File = saveJson("15-old-agent", agent0);
  const toolset0 = mcpToolsetOf(agent0, server);

  await page.goto(`${BASE}/agents/${encodeURIComponent(ids.oldAgent)}`);
  await page.getByRole("heading", { level: 1, name: names.oldAgent }).first().waitFor();
  const label = page.getByText(`MCP: ${server}`).first();
  await label.waitFor({ timeout: 15_000 });
  const cardText = plain(await label.textContent());
  const cardShot = await shot("old-agent-card");

  await page.getByRole("button", { name: "Изменить", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Изменение агента" });
  await dialog.waitFor();
  const renamed = `${names.oldAgent}-renamed`;
  await dialog.locator("#agent-name").fill(renamed);
  await dialog.getByRole("tab", { name: /^MCP-серверы/ }).click();
  const permission = dialog.getByRole("combobox", { name: `Разрешение сервера ${server}`, exact: true });
  await permission.waitFor();
  const permissionText = plain(await permission.textContent());
  const warning = dialog.locator(".callout-warning").filter({ hasText: "без подтверждения" });
  const warningCount = await warning.count();
  const warningText = warningCount ? plain(await warning.first().textContent()) : "";
  const formShot = await shot("old-agent-form");
  const formAria = await aria("old-agent-mcp", dialog.getByRole("tabpanel"));
  await dialog.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  await page.getByRole("heading", { level: 1, name: renamed }).first().waitFor();
  const agent1 = await api("GET", `/v1/agents/${ids.oldAgent}`);
  const agent1File = saveJson("16-old-agent-renamed", agent1);
  const toolset1 = mcpToolsetOf(agent1, server);
  const label1 = page.getByText(`MCP: ${server}`).first();
  await label1.waitFor({ timeout: 15_000 });
  const cardAfter = plain(await label1.textContent());
  const afterShot = await shot("old-agent-renamed");

  const marked = await check("mcp.old_agent_marked", "старый агент (набор MCP с явным always_allow): карточка пишет «MCP: <сервер>, без подтверждения», в форме «Разрешение» «Всегда разрешать» и предупреждение", () => {
    assert(toolset0?.default_config?.permission_policy?.type === "always_allow", `набор в API: ${JSON.stringify(toolset0 ?? null)}`);
    assert(cardText.includes(`MCP: ${server}, без подтверждения`), `карточка агента: ${cardText}`);
    assert(permissionText === "Всегда разрешать", `«Разрешение» в форме: ${permissionText}`);
    assert(warningCount > 0 && warningText.includes("без подтверждения"), `предупреждение: ${warningText || "нет"}`);
    return `${cardShot}, ${formShot}, ${formAria}, ${agent0File}`;
  });
  const kept = await check("mcp.old_agent_kept", "правка имени старого агента в форме не трогает его набор MCP: запись набора та же, новая версия агента, карточка с пометкой «без подтверждения»", () => {
    assert(agent1.name === renamed, `имя ${agent1.name}`);
    assert(agent1.version > agent0.version, `версия до ${agent0.version}, после ${agent1.version}`);
    assert(toolset1 && stable(toolset1) === stable(toolset0), `набор до ${JSON.stringify(toolset0)}, после ${JSON.stringify(toolset1 ?? null)}`);
    assert(cardAfter.includes(`MCP: ${server}, без подтверждения`), `карточка после правки: ${cardAfter}`);
    return `${afterShot}, ${agent1File}`;
  });
  if (marked && kept) cover("mcp-ask-old-agent");
}

async function stepArchive() {
  if (KEEP_SESSION) return;
  for (const id of [ids.session, ids.readSession].filter(Boolean)) {
    await api("POST", `/v1/sessions/${id}/archive`);
  }
}

// -------------------------------------------------------------------- итог ---
function featureEntries() {
  const dir = join(SKILL_DIR, "features");
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    if (!text.includes("<!-- scenario: mcp-ask -->")) continue;
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
  const writes = mcpCalls("write_act");
  const lines = [
    `# verify-agent-console: сценарий mcp-ask (подтверждение MCP), прогон ${run.RUN_ID}`,
    "",
    `Итог: ${abortError ? "ПРЕРВАН" : failed.length ? "ПРОВАЛ" : "ПРОЙДЕН"} (проверок: ${checks.length}, провалов: ${failed.length}, подфункций сценария пройдено ${features.length - uncovered.length} из ${features.length}).`,
    abortError ? `Сценарий прерван: ${plain(abortError.message)}` : "",
    "",
    "## Экземпляр",
    "",
    `- URL: ${BASE}, фейковая модель ${run.FAKE_URL}, фейковый MCP-сервер ${MCP_URL}, git ${run.GIT_REV}; хэши изменений: консоль ${run.CONSOLE_TREE_HASH}, сервер ${run.SERVER_TREE_HASH}`,
    `- учётка ${user.email}, пространство ${user.tenant_id}; nonce ${nonce}, ходы ${turns.allow} («Разрешить») и ${turns.deny} («Отклонить»)`,
    `- окружение ${ids.env ?? "нет"}, хранилище ${ids.vault ?? "нет"}, агент ${ids.agent ?? "нет"} (сервер ${names.server}, политика набора по умолчанию: ${ids.policy ?? "нет"}), сессия ${ids.session ?? "нет"}`,
    `- журнал fake-mcp (logs/fake-mcp.jsonl): вызовов write_act ${writes.length}${writes.length ? ` (${writes.map((w) => `${w.arguments?.nonce} в ${w.ts}`).join(", ")})` : ""}, вызовов read_report ${mcpCalls("read_report").length}`,
    `- сессия хода read_report после исключения: ${ids.readSession ?? "нет"}, ход ${turns.read}`,
    `- старый агент с набором MCP always_allow: ${ids.oldAgent ?? "нет"} (сервер ${names.oldServer})`,
    "",
    "## Проверки",
    "",
    "| Проверка | Что доказывает | Статус | Доказательство |",
    "|---|---|---|---|",
    ...checks.map((c) => `| ${c.id} | ${cell(c.title)} | ${c.status} | ${cell([c.evidence, c.note].filter(Boolean).join("; "))} |`),
    "| mcp.seed_path | окружение и хранилище с токеном создаются по API: их создание через консоль проверяют главный сценарий и рецепт features/vaults-and-mcp.md | не проверено | нет |",
    ...uncovered.map((f) => `| feature.${f.id} | ${cell(f.desc)} | не проверено | рецепт: features/${f.file} |`),
    "",
    "## Скриншоты",
    "",
    ...screens.map((s) => `- ${s.file} (sha256 ${s.sha.slice(0, 12)}${s.tall ? `, высота ${s.tall}` : ""})`),
    "",
    "## Повтор",
    "",
    "RUN=\"$(scripts/launch.sh)\" && { scripts/doctor.sh --run \"$RUN\" && scripts/seed-user.sh --run \"$RUN\" && scripts/journey.sh --run \"$RUN\" --scenario mcp-ask; scripts/cleanup.sh --run \"$RUN\"; } (папка .claude/skills/verify-agent-console).",
    "",
  ];
  writeFileSync(join(EV, "summary.md"), lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n"));
}

function copyLogs() {
  for (const [from, to] of [
    [run.SERVER_LOG, "logs/main-node.journey.log"],
    [run.FAKE_LOG, "logs/fake-model.log"],
    [run.FAKE_REQUESTS, "logs/fake-model-requests.jsonl"],
    [run.FAKE_MCP_LOG, "logs/fake-mcp.log"],
    [run.FAKE_MCP_REQUESTS, "logs/fake-mcp.jsonl"],
  ]) if (from && existsSync(from)) copyFileSync(from, join(EV, to));
}

let abortError = null;
log(`прогон ${run.RUN_ID}, сценарий mcp-ask, nonce ${nonce}, доказательства ${EV}`);
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
    ["агент", stepCreateAgent, true],
    ["сессия", stepCreateSession, true],
    ["write_act ждёт", stepWriteWaits, true],
    ["разрешить", stepAllow, false, ["write_act ждёт"]],
    ["второе разрешить", stepRepeatAllow, false, ["write_act ждёт", "разрешить"]],
    ["отклонить", stepDeny, false, ["write_act ждёт"]],
    ["исключение read_report", stepException, false],
    ["старый агент", stepOldAgent, false],
    ["архив сессии", stepArchive, false],
  ]) {
    const missing = needs.filter((need) => failedSteps.has(need));
    if (missing.length > 0) {
      failedSteps.add(name);
      const why = missing.includes("write_act ждёт")
        ? "; вызов ушёл без человека, блока «Ожидает подтверждения» нет, нажать нечего, а новый write_act тоже ушёл бы сам"
        : "";
      record(`mcp.step_skipped.${name.replace(/[\s:]+/g, "_")}`, `шаг «${name}»`, "не проверено", "", `не выполнен шаг: ${missing.join(", ")}${why}`);
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
      record(`mcp.step_failed.${name.replace(/[\s:]+/g, "_")}`, `шаг «${name}» выполнен до конца`, "провал", "", error.message);
      await shot(`fail-step-${name.replace(/[\s:]+/g, "-")}`).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      await page.setViewportSize(VIEW).catch(() => {});
    }
  }
} catch (error) {
  abortError = error;
  record("mcp.abort", "сценарий дошёл до конца", "провал", "", error.message);
  if (page) await shot("abort").catch(() => {});
} finally {
  record("mcp.screens_distinct", "скриншоты соседних шагов различаются (sha256)",
    duplicateShots.length === 0 ? "проверено" : "провал", `скриншотов ${screens.length}`,
    duplicateShots.length === 0 ? "" : `совпали: ${duplicateShots.join("; ")}`);
  copyLogs();
  writeSummary(abortError);
  await browser?.close().catch(() => {});
}
const failedCount = checks.filter((c) => c.status === "провал").length;
log(`итог: ${abortError ? "ПРЕРВАН" : failedCount ? "ПРОВАЛ" : "ПРОЙДЕН"}, ${join(EV, "summary.md")}`);
process.exit(failedCount ? 1 : 0);
